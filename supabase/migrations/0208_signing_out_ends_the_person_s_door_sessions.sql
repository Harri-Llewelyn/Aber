-- 0208: Signing out of the dashboard ends the person's Studio and forge door sessions.
--
-- Each door (the gateway's studio and forge listeners) signs in through GoTrue as an OAuth client,
-- and holds a GoTrue session of its own: an auth.sessions row with the door's oauth_client_id.
-- The dashboard's Sign Out ends the dashboard's session in that browser (scope local), and its
-- beacons cannot always clear the doors' cookies, which are another site's on a stack whose hosts
-- share no registrable domain. Both doors refresh their token, so a door session left alive keeps
-- that browser signed in to Studio or the forge.
--
--   * end_my_door_sessions() deletes the caller's sessions whose oauth_client_id is the Studio
--     door's or the forge door's (seeded by 0002), and returns how many it ended. The browser
--     cannot name its own door session, because the door's code exchange happens on the server, so
--     it ends every one the person holds. A door in another browser signs in again by itself while
--     the dashboard is signed in there, through the consent already given.
--   * A person calls it for themselves; a machine identity or no caller is refused. No audit row:
--     it is a sign-out.
--
-- Reasoning: supabase/README.md, "Signing out ends the person's door sessions (0208)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Ending the caller's door sessions
-- -------------------------------------------------------------------------------------------------
-- PL/pgSQL so the body is resolved when it runs: auth.sessions is GoTrue's, and GoTrue may create
-- it after this file first replays. GoTrue's refresh tokens and MFA claims for a session go with
-- its row (ON DELETE CASCADE), as at GoTrue's own sign-out.
CREATE OR REPLACE FUNCTION public.end_my_door_sessions() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_caller uuid := auth.uid();
    v_ended  integer;
BEGIN
    IF v_caller IS NULL OR public.is_machine_principal(v_caller) THEN
        RAISE EXCEPTION 'insufficient privileges to end door sessions: sign in as a person'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- The Studio door's client, then the forge door's (0002).
    DELETE FROM auth.sessions
     WHERE user_id = v_caller
       AND oauth_client_id IN ('c0ffee00-0000-4000-8000-000000000003'::uuid,
                               'c0ffee00-0000-4000-8000-000000000004'::uuid);
    GET DIAGNOSTICS v_ended = ROW_COUNT;
    RETURN v_ended;
END
$$;

ALTER FUNCTION public.end_my_door_sessions() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.end_my_door_sessions() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.end_my_door_sessions() TO authenticated;

COMMENT ON FUNCTION public.end_my_door_sessions() IS
  'Ends every GoTrue session the caller holds through the Studio or forge door (oauth_client_id '
  'c0ffee00-...-0003 or -0004), and returns how many. The dashboard calls it at Sign Out, before '
  'ending its own session. A machine identity or no caller is 42501. Other sessions, the '
  'dashboard''s and Grafana''s and Node-RED''s, are left alone. No audit row (0208).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn    regprocedure := 'public.end_my_door_sessions()'::regprocedure;
  v_owner name := (SELECT pg_get_userbyid(proowner) FROM pg_proc
                    WHERE oid = 'public.end_my_door_sessions()'::regprocedure);
  r       text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn
                  AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0208: end_my_door_sessions() lost SECURITY DEFINER or its search_path pin';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(r, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0208: % may execute end_my_door_sessions()', r;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0208: authenticated may not execute end_my_door_sessions(); the dashboard calls it';
  END IF;

  -- GoTrue creates auth.sessions. Before it has, there is nothing to delete from yet.
  IF to_regclass('auth.sessions') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'auth.sessions'::regclass
                    AND attname = 'oauth_client_id' AND NOT attisdropped) THEN
      RAISE EXCEPTION '0208: auth.sessions has no oauth_client_id, so no door session can be told apart';
    END IF;
    IF NOT has_table_privilege(v_owner, 'auth.sessions', 'DELETE') THEN
      RAISE EXCEPTION '0208: % may not delete from auth.sessions, so end_my_door_sessions() would fail every Sign Out', v_owner;
    END IF;
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
