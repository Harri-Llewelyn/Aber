-- 0207: An Administrator ends a person's sessions, and changes their email address.
--
-- Both are actions in a person's drawer on Access Control › People. This file is the database half
-- of each; GoTrue's admin API, which changes an address, is the manage-people edge function's.
--
--   * end_person_sessions() deletes every auth.sessions row the person holds: every browser and
--     every service. Their refresh tokens go with the rows (GoTrue's foreign keys cascade), so none
--     refreshes, and auth_pre_request() (0205) refuses each access token at the API on its next
--     request. One SESSIONS_ENDED row in the person's lane of the Audit Trail says who ended whose
--     sessions, and how many. Administrator only; your own are refused. A removed person's may be
--     ended.
--   * person_session_summary() says how many sessions a person holds and when one was last
--     active. A count and a time, never a list: the drawer names no device.
--   * check_person_email_change() and record_person_email_change() wrap GoTrue's change of
--     address, as record_person_password_set() (0167) wraps a new password. The first decides
--     before GoTrue changes anything, and returns the address the person has. The second, after
--     it, writes EMAIL_CHANGED (the old address and the new) and ends the person's sessions
--     through end_person_sessions(), in one transaction.
--
-- Reasoning: supabase/README.md, "An Administrator ends a person's sessions and changes their
-- email address (0207)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Ending a person's sessions
-- -------------------------------------------------------------------------------------------------
-- check_person_act() (0166) refuses anyone but an Administrator, an unknown person (404) and a
-- machine identity, under the lock every People act takes. auth.sessions is GoTrue's: PL/pgSQL
-- resolves it when the function first runs, so a database GoTrue has not reached yet still boots.
CREATE OR REPLACE FUNCTION public.end_person_sessions(p_user_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_email text;
    v_ended integer;
BEGIN
    PERFORM public.check_person_act(p_user_id, 'end a person''s sessions');

    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'you cannot end your own sessions here. Use Sign Out in the account menu.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    DELETE FROM auth.sessions WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_ended = ROW_COUNT;

    SELECT u.email::text INTO v_email FROM auth.users u WHERE u.id = p_user_id;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'user_roles', p_user_id, 'SESSIONS_ENDED', NULL,
        jsonb_build_object('email', v_email, 'sessions_ended', v_ended),
        auth.uid(), public.audit_actor_source(), txid_current(), now()
    );
    RETURN v_ended;
END
$$;

ALTER FUNCTION public.end_person_sessions(p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.end_person_sessions(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.end_person_sessions(uuid) TO authenticated;

COMMENT ON FUNCTION public.end_person_sessions(p_user_id uuid) IS
  'Administrator only. Deletes every auth.sessions row the person holds, in every browser and '
  'service, so no refresh token of theirs works and auth_pre_request() refuses their access tokens '
  'at the API. Writes one SESSIONS_ENDED row (the person''s email and how many ended) and returns '
  'that number. Refuses the caller''s own sessions (42501) and a machine identity (22023); an '
  'unknown person is a 404. A removed person''s sessions may be ended (0207).';

-- -------------------------------------------------------------------------------------------------
-- 2. How many sessions a person holds
-- -------------------------------------------------------------------------------------------------
-- A session is last active when GoTrue last refreshed it. refreshed_at is GoTrue's `timestamp`
-- without a zone, written in UTC; updated_at and created_at cover a session never refreshed.
CREATE OR REPLACE FUNCTION public.person_session_summary(p_user_id uuid)
RETURNS TABLE(open_sessions integer, last_active_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'insufficient privileges to read a person''s sessions'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN QUERY
    SELECT count(*)::integer,
           max(greatest(s.refreshed_at AT TIME ZONE 'UTC', s.updated_at, s.created_at))
      FROM auth.sessions s
     WHERE s.user_id = p_user_id;
END
$$;

ALTER FUNCTION public.person_session_summary(p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.person_session_summary(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.person_session_summary(uuid) TO authenticated;

COMMENT ON FUNCTION public.person_session_summary(p_user_id uuid) IS
  'Administrator only. How many auth.sessions rows the person holds, and the latest time one was '
  'refreshed, updated or started; 0 and NULL for none. No list: which browsers and services they '
  'are is the person''s own to see (0207).';

-- -------------------------------------------------------------------------------------------------
-- 3. Changing a person's email address
-- -------------------------------------------------------------------------------------------------
-- Before GoTrue: Administrator only, not your own, not a removed person, an address in the shape
-- ensure_first_administrator() (0163) and manage-people accept, a different one, and none another
-- account holds. GoTrue's unique index would refuse a taken address only as a 500, so it is
-- decided here. Returns the address the person has now, which the record below keeps.
CREATE OR REPLACE FUNCTION public.check_person_email_change(p_user_id uuid, p_email text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_email text := lower(btrim(p_email));
    v_old   text;
BEGIN
    PERFORM public.check_person_act(p_user_id, 'change a person''s email address');

    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'you cannot change your own email address. Ask another Administrator.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF public.person_access_is_removed(p_user_id) THEN
        RAISE EXCEPTION 'this person''s access is removed. Restore it first, then change their email address.'
            USING ERRCODE = 'raise_exception';
    END IF;

    IF v_email IS NULL OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' OR length(v_email) > 254 THEN
        RAISE EXCEPTION '% is not an email address', coalesce(quote_literal(p_email), 'NULL')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT u.email::text INTO v_old FROM auth.users u WHERE u.id = p_user_id;
    IF lower(v_old) = v_email THEN
        RAISE EXCEPTION 'that is already their email address'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = v_email AND u.id <> p_user_id) THEN
        RAISE EXCEPTION '% already belongs to another account', v_email
            USING ERRCODE = 'raise_exception';
    END IF;

    RETURN v_old;
END
$$;

ALTER FUNCTION public.check_person_email_change(p_user_id uuid, p_email text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_person_email_change(uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.check_person_email_change(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.check_person_email_change(p_user_id uuid, p_email text) IS
  'Administrator only, called by the manage-people edge function before GoTrue changes a person''s '
  'email address. Writes nothing. Refuses the caller''s own address (42501), a person whose access '
  'is removed (P0001), an address another account holds (P0001), the address they already have '
  'and one that is not an address (22023). Returns the address they have now (0207).';

-- After GoTrue: the account must hold the new address already, so a row is written only for a
-- change that was made. Then the person's sessions end, as end_person_sessions() ends them: their
-- access token still carries the old address, which stamp_proposal_author() would stamp.
CREATE OR REPLACE FUNCTION public.record_person_email_change(p_user_id uuid, p_old_email text, p_email text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_email text := lower(btrim(p_email));
    v_now   text;
BEGIN
    PERFORM public.check_person_act(p_user_id, 'change a person''s email address');

    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'you cannot change your own email address. Ask another Administrator.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT u.email::text INTO v_now FROM auth.users u WHERE u.id = p_user_id;
    IF v_email IS NULL OR lower(v_now) IS DISTINCT FROM v_email THEN
        RAISE EXCEPTION 'their email address is not %. Record a change after the sign-in service has made it.',
            coalesce(v_email, 'NULL')
            USING ERRCODE = 'raise_exception';
    END IF;
    IF p_old_email IS NULL OR lower(btrim(p_old_email)) = v_email THEN
        RAISE EXCEPTION 'the address they had before is needed, and must differ from the new one'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'user_roles', p_user_id, 'EMAIL_CHANGED',
        jsonb_build_object('email', p_old_email), jsonb_build_object('email', v_now),
        auth.uid(), public.audit_actor_source(), txid_current(), now()
    );

    RETURN public.end_person_sessions(p_user_id);
END
$$;

ALTER FUNCTION public.record_person_email_change(p_user_id uuid, p_old_email text, p_email text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_person_email_change(uuid, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_person_email_change(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.record_person_email_change(p_user_id uuid, p_old_email text, p_email text) IS
  'Administrator only, called by the manage-people edge function after GoTrue changed a person''s '
  'email address. Refuses unless the account now holds p_email. Writes one EMAIL_CHANGED row (the '
  'old and the new address), then ends every session the person holds through '
  'end_person_sessions(), which writes SESSIONS_ENDED in the same transaction. Returns how many '
  'sessions ended (0207).';

COMMENT ON FUNCTION public.audit_actor_source() IS
  'The actor_source a function writing its own audit_trail row records: user for a person, '
  'ingestion for the ingestion principal, service for any other machine identity, migration for '
  'the owner''s session with no token. log_audit_trail_event()''s ladder without the X-Aber-Actor '
  'header (0193). Called by the capture and playback gates, by log_display_name_change() (0203), '
  'and by end_person_sessions() and record_person_email_change() (0207).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  f       text;
  v_owner name;
  v_col   text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.end_person_sessions(uuid)', 'public.person_session_summary(uuid)',
                           'public.check_person_email_change(uuid, text)',
                           'public.record_person_email_change(uuid, text, text)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0207: anon may execute %', f;
    END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0207: authenticated may not execute %; the dashboard or manage-people calls it as the caller', f;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f::regprocedure
                    AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0207: % lost SECURITY DEFINER or its search_path pin', f;
    END IF;
  END LOOP;

  -- GoTrue creates auth.sessions. Before it has, there is nothing to read or end.
  IF to_regclass('auth.sessions') IS NOT NULL THEN
    v_owner := (SELECT pg_get_userbyid(proowner) FROM pg_proc
                 WHERE oid = 'public.end_person_sessions(uuid)'::regprocedure);
    IF NOT has_table_privilege(v_owner, 'auth.sessions', 'SELECT')
       OR NOT has_table_privilege(v_owner, 'auth.sessions', 'DELETE') THEN
      RAISE EXCEPTION '0207: % may not read and delete auth.sessions, so End Sessions would fail', v_owner;
    END IF;
    FOREACH v_col IN ARRAY ARRAY['user_id', 'created_at', 'updated_at', 'refreshed_at'] LOOP
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'auth' AND table_name = 'sessions' AND column_name = v_col) THEN
        RAISE EXCEPTION '0207: auth.sessions has no % column, which person_session_summary() reads', v_col;
      END IF;
    END LOOP;
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
