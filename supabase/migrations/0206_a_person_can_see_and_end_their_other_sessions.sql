-- 0206: A person can see and end their other sessions.
--
-- Every sign-in through GoTrue, to the dashboard or to a service (Grafana, Node-RED, Studio, the
-- forge), is one auth.sessions row. The Profile page's Security tab lists the caller's own and
-- ends one of them.
--
--   * list_my_sessions() returns the caller's sessions: the service a service session belongs to
--     (null for a dashboard session), the browser's user agent, when it started, when it was last
--     active, and which one the caller's token names. Never the address, the tag or anything that
--     refreshes a token.
--   * end_my_session() deletes one of the caller's sessions. GoTrue then refuses its refresh, and
--     auth_pre_request() (0205) refuses its access token at once. It refuses the session the
--     caller is using (Sign Out ends that one), and answers a session that is not the caller's
--     exactly as one that does not exist.
--   * Every person role may call both. A caller with no role is refused, so no machine identity
--     can. Ending your own session writes no Audit Trail row.
--
-- Reasoning: supabase/README.md, "A person can see and end their other sessions (0206)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Listing your own sessions
-- -------------------------------------------------------------------------------------------------
-- GoTrue writes refreshed_at without a time zone, in UTC. A session never refreshed has none, so
-- last_active_at falls back to updated_at and created_at. PL/pgSQL resolves auth.sessions and
-- auth.oauth_clients when the function runs: GoTrue creates both.
CREATE OR REPLACE FUNCTION public.list_my_sessions()
RETURNS TABLE(id uuid, service_name text, user_agent text, created_at timestamp with time zone,
              last_active_at timestamp with time zone, not_after timestamp with time zone,
              is_current boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_current text := auth.jwt() ->> 'session_id';
BEGIN
  IF v_caller IS NULL OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Operator', 'Auditor']) THEN
    RAISE EXCEPTION 'insufficient privileges to list sessions: sign in as a person with a role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_current !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_current := NULL;
  END IF;

  RETURN QUERY
  SELECT s.id,
         CASE WHEN s.oauth_client_id IS NOT NULL
              THEN coalesce(nullif(btrim(c.client_name), ''), 'OAuth client ' || s.oauth_client_id)
         END,
         s.user_agent,
         s.created_at,
         greatest(s.refreshed_at AT TIME ZONE 'UTC', s.updated_at, s.created_at),
         s.not_after,
         coalesce(s.id = v_current::uuid, false)
    FROM auth.sessions s
    LEFT JOIN auth.oauth_clients c ON c.id = s.oauth_client_id
   WHERE s.user_id = v_caller
   ORDER BY coalesce(s.id = v_current::uuid, false) DESC,
            greatest(s.refreshed_at AT TIME ZONE 'UTC', s.updated_at, s.created_at) DESC NULLS LAST,
            s.id;
END
$$;

ALTER FUNCTION public.list_my_sessions() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_my_sessions() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.list_my_sessions() TO authenticated;

COMMENT ON FUNCTION public.list_my_sessions() IS
  'The caller''s own GoTrue sessions, the one their token names first (is_current), then by '
  'last_active_at, newest first: the latest of refreshed_at (UTC), updated_at and created_at. '
  'service_name is the OAuth client''s name for a session a service started, null for a '
  'dashboard sign-in. Any person role; a caller with no role, a machine identity among them, is '
  '42501. Never returns the address, the tag or the refresh-token columns (0206).';

-- -------------------------------------------------------------------------------------------------
-- 2. Ending one of them
-- -------------------------------------------------------------------------------------------------
-- Deleting the row is what GoTrue's own sign-out does: the refresh tokens and MFA claims cascade.
-- A session that is not the caller's gets the not-found a missing one gets, so no answer says that
-- another person's session id exists. Not audited: a person ending their own sign-in.
CREATE OR REPLACE FUNCTION public.end_my_session(p_session_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_current text := auth.jwt() ->> 'session_id';
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

  DELETE FROM auth.sessions WHERE id = p_session_id AND user_id = v_caller;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('session %s not found', coalesce(p_session_id::text, 'NULL')));
  END IF;
END
$$;

ALTER FUNCTION public.end_my_session(p_session_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.end_my_session(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.end_my_session(uuid) TO authenticated;

COMMENT ON FUNCTION public.end_my_session(p_session_id uuid) IS
  'Ends one of the caller''s own GoTrue sessions by deleting its auth.sessions row: its refresh '
  'tokens go with it, and auth_pre_request() refuses its access token (0205). The session the '
  'caller''s token names is 22023 (Sign Out ends it). Another person''s session and one that does '
  'not exist are the same 404. Any person role; a caller with no role is 42501. Writes no Audit '
  'Trail row (0206).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_owner name := (SELECT pg_get_userbyid(proowner) FROM pg_proc
                    WHERE oid = 'public.end_my_session(uuid)'::regprocedure);
  v_role  text;
  f       text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.list_my_sessions()', 'public.end_my_session(uuid)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f::regprocedure
                    AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0206: % is not SECURITY DEFINER with its search_path pinned', f;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
      IF has_function_privilege(v_role, f, 'EXECUTE') THEN
        RAISE EXCEPTION '0206: % may execute %', v_role, f;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0206: authenticated may not execute %; the dashboard calls it', f;
    END IF;
  END LOOP;

  -- A request with no person behind it is refused before either function reads a session.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.list_my_sessions();
    RAISE EXCEPTION '0206: list_my_sessions() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.end_my_session(gen_random_uuid());
    RAISE EXCEPTION '0206: end_my_session() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- GoTrue creates both tables. Where they exist, the functions' owner must reach them, or every
  -- call fails instead of this boot. One privilege per call: has_table_privilege() answers true
  -- when ANY of a list is held.
  IF to_regclass('auth.sessions') IS NOT NULL THEN
    FOREACH f IN ARRAY ARRAY['SELECT', 'DELETE'] LOOP
      IF NOT has_table_privilege(v_owner, 'auth.sessions', f) THEN
        RAISE EXCEPTION '0206: % may not % auth.sessions', v_owner, f;
      END IF;
    END LOOP;
  END IF;
  IF to_regclass('auth.oauth_clients') IS NOT NULL
     AND NOT has_table_privilege(v_owner, 'auth.oauth_clients', 'SELECT') THEN
    RAISE EXCEPTION '0206: % may not read auth.oauth_clients, so no service session is named', v_owner;
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
