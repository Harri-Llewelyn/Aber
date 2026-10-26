-- 0212: An Administrator sees which sessions a person holds, and ends one of them.
--
-- A person's drawer on Access Control › People counted their sessions (0207) and ended them all.
-- For a lost laptop that also ended their other browsers, a wall display and every service. The
-- drawer now lists the sessions, as the person's own Security tab does, and ends one.
--
--   * person_sessions() returns a person's sessions with the columns list_my_sessions() (0206)
--     returns, except is_current: the caller's token names the caller's session, never the
--     person's. Never the address, the tag or anything that refreshes a token. Administrator only.
--   * end_person_session() deletes one of them and writes one SESSIONS_ENDED row in the person's
--     lane, with the Administrator in changed_by: a count of 1 and the session as person_sessions()
--     returned it, the shape end_my_session() writes (0211). A session that is not that person's,
--     or does not exist, is refused with no row. end_person_sessions()'s rules: Administrator
--     only, not your own, and a removed person's may be ended.
--   * end_person_sessions() (0207) is redeclared unchanged but for its refusal of your own
--     sessions, which named Sign Out. Sign Out ends only the browser in use; Sign Out of All
--     Other Sessions on the Profile page's Security tab is the match.
--
-- Reasoning: supabase/README.md, "An Administrator ends one of a person's sessions (0212)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Listing a person's sessions
-- -------------------------------------------------------------------------------------------------
-- list_my_sessions()'s query for another person, without is_current. GoTrue writes refreshed_at
-- without a time zone, in UTC. PL/pgSQL resolves auth.sessions and auth.oauth_clients when the
-- function runs: GoTrue creates both.
CREATE OR REPLACE FUNCTION public.person_sessions(p_user_id uuid)
RETURNS TABLE(id uuid, service_name text, user_agent text, created_at timestamp with time zone,
              last_active_at timestamp with time zone, not_after timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to list a person''s sessions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT s.id,
         CASE WHEN s.oauth_client_id IS NOT NULL
              THEN coalesce(nullif(btrim(c.client_name), ''), 'OAuth client ' || s.oauth_client_id)
         END,
         s.user_agent,
         s.created_at,
         greatest(s.refreshed_at AT TIME ZONE 'UTC', s.updated_at, s.created_at),
         s.not_after
    FROM auth.sessions s
    LEFT JOIN auth.oauth_clients c ON c.id = s.oauth_client_id
   WHERE s.user_id = p_user_id
   ORDER BY greatest(s.refreshed_at AT TIME ZONE 'UTC', s.updated_at, s.created_at) DESC NULLS LAST,
            s.id;
END
$$;

ALTER FUNCTION public.person_sessions(p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.person_sessions(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.person_sessions(uuid) TO authenticated;

COMMENT ON FUNCTION public.person_sessions(p_user_id uuid) IS
  'Administrator only. A person''s GoTrue sessions, newest activity first, with the columns '
  'list_my_sessions() returns the person except is_current: service_name, user_agent, created_at, '
  'last_active_at (the latest of refreshed_at read as UTC, updated_at and created_at) and '
  'not_after. Never the address, the tag or the refresh-token columns. No rows for an id that '
  'holds none (0212).';

COMMENT ON FUNCTION public.person_session_summary(p_user_id uuid) IS
  'Administrator only. How many auth.sessions rows the person holds, and the latest time one was '
  'refreshed, updated or started; 0 and NULL for none (0207). person_sessions() lists them (0212).';

-- -------------------------------------------------------------------------------------------------
-- 2. Ending one of them, recorded
-- -------------------------------------------------------------------------------------------------
-- check_person_act() (0166) refuses anyone but an Administrator, an unknown person (404) and a
-- machine identity, under the lock every People act takes. The session's facts are read through
-- person_sessions() before the delete, so the row records what the drawer's list showed.
CREATE OR REPLACE FUNCTION public.end_person_session(p_user_id uuid, p_session_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_session jsonb;
  v_email   text;
BEGIN
  PERFORM public.check_person_act(p_user_id, 'end a person''s session');

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'you cannot end your own session here. End it on your Profile page''s Security tab.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT jsonb_build_object('service_name', s.service_name, 'user_agent', s.user_agent,
                            'created_at', s.created_at, 'last_active_at', s.last_active_at)
    INTO v_session
    FROM public.person_sessions(p_user_id) s
   WHERE s.id = p_session_id;

  DELETE FROM auth.sessions WHERE id = p_session_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('session %s not found: it has ended, or it is not this person''s',
                                          coalesce(p_session_id::text, 'NULL')));
  END IF;

  SELECT u.email::text INTO v_email FROM auth.users u WHERE u.id = p_user_id;
  INSERT INTO public.audit_trail (
      entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
      causation_id, recorded_at
  ) VALUES (
      'user_roles', p_user_id, 'SESSIONS_ENDED', NULL,
      jsonb_build_object('email', v_email, 'sessions_ended', 1, 'session', v_session),
      auth.uid(), public.audit_actor_source(), txid_current(), now()
  );
END
$$;

ALTER FUNCTION public.end_person_session(p_user_id uuid, p_session_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.end_person_session(uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.end_person_session(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.end_person_session(p_user_id uuid, p_session_id uuid) IS
  'Administrator only. Ends one of a person''s GoTrue sessions by deleting its auth.sessions row: '
  'its refresh tokens go with it, and auth_pre_request() refuses its access token (0205). Writes '
  'one SESSIONS_ENDED row in the person''s lane: their email, a count of 1 and the session as '
  'person_sessions() returned it (service_name, user_agent, created_at, last_active_at). A session '
  'that is not theirs and one that does not exist are the same 404, with no row. Refuses the '
  'caller''s own (42501) and a machine identity (22023); an unknown person is a 404. A removed '
  'person''s session may be ended (0212).';

-- -------------------------------------------------------------------------------------------------
-- 3. Ending all of them: the refusal of your own names the act that matches
-- -------------------------------------------------------------------------------------------------
-- 0207's function, unchanged but for that sentence.
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
        RAISE EXCEPTION 'you cannot end your own sessions here. Use Sign Out of All Other Sessions on your Profile page''s Security tab.'
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
  'that number. Refuses the caller''s own sessions (42501), which Sign Out of All Other Sessions '
  'ends, and a machine identity (22023); an unknown person is a 404. A removed person''s sessions '
  'may be ended (0207, 0212).';

COMMENT ON FUNCTION public.audit_actor_source() IS
  'The actor_source a function writing its own audit_trail row records: user for a person, '
  'ingestion for the ingestion principal, service for any other machine identity, migration for '
  'the owner''s session with no token. log_audit_trail_event()''s ladder without the X-Aber-Actor '
  'header (0193). Called by the capture and playback gates, by log_display_name_change() (0203), '
  'by end_person_sessions() and record_person_email_change() (0207), by end_my_session() and '
  'end_my_other_sessions() (0211), and by end_person_session() (0212).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_owner name := (SELECT pg_get_userbyid(proowner) FROM pg_proc
                    WHERE oid = 'public.end_person_session(uuid, uuid)'::regprocedure);
  v_role  text;
  f       text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.person_sessions(uuid)', 'public.end_person_session(uuid, uuid)',
                           'public.end_person_sessions(uuid)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f::regprocedure
                    AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0212: % is not SECURITY DEFINER with its search_path pinned', f;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
      IF has_function_privilege(v_role, f, 'EXECUTE') THEN
        RAISE EXCEPTION '0212: % may execute %', v_role, f;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0212: authenticated may not execute %; the dashboard calls it', f;
    END IF;
  END LOOP;

  -- An Administrator sees no more than the person sees: list_my_sessions()'s columns, in its order
  -- and of its types, but is_current.
  IF pg_get_function_result('public.person_sessions(uuid)'::regprocedure) IS DISTINCT FROM
     replace(pg_get_function_result('public.list_my_sessions()'::regprocedure), ', is_current boolean', '') THEN
    RAISE EXCEPTION '0212: person_sessions() returns %, not list_my_sessions()''s columns without is_current (%)',
      pg_get_function_result('public.person_sessions(uuid)'::regprocedure),
      pg_get_function_result('public.list_my_sessions()'::regprocedure);
  END IF;

  -- A request with no person behind it is refused before anything is read or ended.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.person_sessions(gen_random_uuid());
    RAISE EXCEPTION '0212: person_sessions() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.end_person_session(gen_random_uuid(), gen_random_uuid());
    RAISE EXCEPTION '0212: end_person_session() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- GoTrue creates these tables. Where they exist, the owner must reach them, or every call fails
  -- instead of this boot. One privilege per call: has_table_privilege() answers true when ANY of a
  -- list is held.
  IF to_regclass('auth.sessions') IS NOT NULL THEN
    FOREACH f IN ARRAY ARRAY['SELECT', 'DELETE'] LOOP
      IF NOT has_table_privilege(v_owner, 'auth.sessions', f) THEN
        RAISE EXCEPTION '0212: % may not % auth.sessions', v_owner, f;
      END IF;
    END LOOP;
  END IF;
  IF to_regclass('auth.oauth_clients') IS NOT NULL
     AND NOT has_table_privilege(v_owner, 'auth.oauth_clients', 'SELECT') THEN
    RAISE EXCEPTION '0212: % may not read auth.oauth_clients, so no service session is named', v_owner;
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
