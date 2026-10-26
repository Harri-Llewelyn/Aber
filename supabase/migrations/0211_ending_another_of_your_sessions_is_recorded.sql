-- 0211: Ending another of your own sessions is recorded in the Audit Trail.
--
-- The Profile page's Security tab ends a person's other sessions two ways: End, one session, and
-- Sign Out of All Other Sessions, every one but the session in use. Each now writes the
-- SESSIONS_ENDED row an Administrator's End Sessions writes (0207), in the person's lane, with the
-- person in changed_by.
--
--   * end_my_session() (0206) writes one row as it deletes a session: a count of 1, and what the
--     Sessions list said of the session (its service's name, its user agent, when it started and
--     when it was last active). Never the address, the tag or anything that refreshes a token.
--   * end_my_other_sessions() deletes every session the caller holds except the one their token
--     names, writes one row with how many ended, and returns that number. It writes nothing when
--     none ended. A token naming no session of the caller's is refused, so it never ends them all.
--     Sign Out of All Other Sessions calls it instead of GoTrue's /logout?scope=others, which
--     deleted the same rows and left the Audit Trail without one.
--   * Both keep 0206's caller check: any person role; no caller and every machine identity are
--     refused. Sign Out writes no row: it ends the session in the browser in use.
--
-- Reasoning: supabase/README.md, "Ending another of your sessions is recorded (0211)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Ending one of them, recorded
-- -------------------------------------------------------------------------------------------------
-- 0206's checks and delete, unchanged. The session's facts are read through list_my_sessions()
-- before the delete, so the row records what the Sessions list showed and nothing it does not.
CREATE OR REPLACE FUNCTION public.end_my_session(p_session_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_current text := auth.jwt() ->> 'session_id';
  v_session jsonb;
  v_email   text;
BEGIN
  IF v_caller IS NULL OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Operator', 'Auditor']) THEN
    RAISE EXCEPTION 'insufficient privileges to end a session: sign in as a person with a role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_current ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND p_session_id = v_current::uuid THEN
    RAISE EXCEPTION 'This is the session you are using. Sign Out ends this one.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT jsonb_build_object('service_name', s.service_name, 'user_agent', s.user_agent,
                            'created_at', s.created_at, 'last_active_at', s.last_active_at)
    INTO v_session
    FROM public.list_my_sessions() s
   WHERE s.id = p_session_id;

  DELETE FROM auth.sessions WHERE id = p_session_id AND user_id = v_caller;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('session %s not found', coalesce(p_session_id::text, 'NULL')));
  END IF;

  SELECT u.email::text INTO v_email FROM auth.users u WHERE u.id = v_caller;
  INSERT INTO public.audit_trail (
      entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
      causation_id, recorded_at
  ) VALUES (
      'user_roles', v_caller, 'SESSIONS_ENDED', NULL,
      jsonb_build_object('email', v_email, 'sessions_ended', 1, 'session', v_session),
      v_caller, public.audit_actor_source(), txid_current(), now()
  );
END
$$;

ALTER FUNCTION public.end_my_session(p_session_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.end_my_session(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.end_my_session(uuid) TO authenticated;

COMMENT ON FUNCTION public.end_my_session(p_session_id uuid) IS
  'Ends one of the caller''s own GoTrue sessions by deleting its auth.sessions row: its refresh '
  'tokens go with it, and auth_pre_request() refuses its access token (0205). Writes one '
  'SESSIONS_ENDED row in the caller''s lane: a count of 1 and the session as list_my_sessions() '
  'returned it (service_name, user_agent, created_at, last_active_at). The session the caller''s '
  'token names is 22023 (Sign Out ends it). Another person''s session and one that does not exist '
  'are the same 404. Any person role; a caller with no role is 42501 (0206, 0211).';

-- -------------------------------------------------------------------------------------------------
-- 2. Ending all of them but the one in use, recorded
-- -------------------------------------------------------------------------------------------------
-- GoTrue's /logout?scope=others runs the same DELETE. The session kept is the one the token names,
-- and it must be the caller's: through the API, auth_pre_request() (0205) has already refused a
-- token whose session has gone, so this guards a direct call. Never falls back to ending them all.
CREATE OR REPLACE FUNCTION public.end_my_other_sessions() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_current text := auth.jwt() ->> 'session_id';
  v_ended   integer;
  v_email   text;
BEGIN
  IF v_caller IS NULL OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Operator', 'Auditor']) THEN
    RAISE EXCEPTION 'insufficient privileges to end your other sessions: sign in as a person with a role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Two tests, not one OR: the cast must not run on a claim that is not a uuid.
  IF coalesce(v_current, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_current := NULL;
  ELSIF NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id = v_current::uuid AND s.user_id = v_caller) THEN
    v_current := NULL;
  END IF;
  IF v_current IS NULL THEN
    RAISE EXCEPTION 'Your sign-in names no session of yours to keep, so none was ended. Sign in again.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM auth.sessions WHERE user_id = v_caller AND id <> v_current::uuid;
  GET DIAGNOSTICS v_ended = ROW_COUNT;

  IF v_ended > 0 THEN
    SELECT u.email::text INTO v_email FROM auth.users u WHERE u.id = v_caller;
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'user_roles', v_caller, 'SESSIONS_ENDED', NULL,
        jsonb_build_object('email', v_email, 'sessions_ended', v_ended),
        v_caller, public.audit_actor_source(), txid_current(), now()
    );
  END IF;
  RETURN v_ended;
END
$$;

ALTER FUNCTION public.end_my_other_sessions() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.end_my_other_sessions() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.end_my_other_sessions() TO authenticated;

COMMENT ON FUNCTION public.end_my_other_sessions() IS
  'Ends every GoTrue session the caller holds except the one their token names, in every browser '
  'and service, as GoTrue''s /logout?scope=others does: the refresh tokens go with the rows, and '
  'auth_pre_request() refuses their access tokens (0205). Writes one SESSIONS_ENDED row in the '
  'caller''s lane with how many ended, none when nothing ended, and returns that number. A token '
  'naming no session of the caller''s is 22023, so it never ends them all. Any person role; a '
  'caller with no role is 42501 (0211).';

COMMENT ON FUNCTION public.audit_actor_source() IS
  'The actor_source a function writing its own audit_trail row records: user for a person, '
  'ingestion for the ingestion principal, service for any other machine identity, migration for '
  'the owner''s session with no token. log_audit_trail_event()''s ladder without the X-Aber-Actor '
  'header (0193). Called by the capture and playback gates, by log_display_name_change() (0203), '
  'by end_person_sessions() and record_person_email_change() (0207), and by end_my_session() and '
  'end_my_other_sessions() (0211).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_owner name := (SELECT pg_get_userbyid(proowner) FROM pg_proc
                    WHERE oid = 'public.end_my_other_sessions()'::regprocedure);
  v_role  text;
  f       text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.end_my_session(uuid)', 'public.end_my_other_sessions()'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f::regprocedure
                    AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0211: % is not SECURITY DEFINER with its search_path pinned', f;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
      IF has_function_privilege(v_role, f, 'EXECUTE') THEN
        RAISE EXCEPTION '0211: % may execute %', v_role, f;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0211: authenticated may not execute %; the dashboard calls it', f;
    END IF;
  END LOOP;

  -- A request with no person behind it is refused before anything is read or ended.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.end_my_other_sessions();
    RAISE EXCEPTION '0211: end_my_other_sessions() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- GoTrue creates these tables. Where they exist, the owner must reach them, or every call fails
  -- instead of this boot. One privilege per call: has_table_privilege() answers true when ANY of a
  -- list is held.
  IF to_regclass('auth.sessions') IS NOT NULL THEN
    FOREACH f IN ARRAY ARRAY['SELECT', 'DELETE'] LOOP
      IF NOT has_table_privilege(v_owner, 'auth.sessions', f) THEN
        RAISE EXCEPTION '0211: % may not % auth.sessions', v_owner, f;
      END IF;
    END LOOP;

    -- Ending a session must end its refresh tokens, as GoTrue's own sign-out does: GoTrue's
    -- foreign key deletes them with the session. Checked once GoTrue has added the column.
    IF to_regclass('auth.refresh_tokens') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('auth.refresh_tokens')
                    AND attname = 'session_id' AND NOT attisdropped)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conrelid = to_regclass('auth.refresh_tokens') AND contype = 'f'
                          AND confrelid = to_regclass('auth.sessions') AND confdeltype = 'c') THEN
      RAISE EXCEPTION '0211: auth.refresh_tokens.session_id does not cascade from auth.sessions, so an ended session''s refresh tokens would outlive it';
    END IF;
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
