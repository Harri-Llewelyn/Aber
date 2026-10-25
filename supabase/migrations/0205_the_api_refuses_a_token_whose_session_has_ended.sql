-- 0205: The API refuses a token whose session has ended.
--
-- GoTrue names the session in every access token it issues (`session_id`), and deletes the
-- session's row in auth.sessions when the session ends: a Sign Out, a new password, Set New
-- Password. PostgREST checked only the token's signature, so the token went on reading until its
-- `exp` (supabaseAuth.jwtExpiry). auth_pre_request() now refuses a token whose session is gone,
-- with 401 and GoTrue's own code for it, session_not_found, so the dashboard offers Sign In Again.
-- A token that names no session (a minted service token, the publishable and service keys) is
-- served as before.
--
-- Reasoning: supabase/README.md, "The API refuses a token whose session has ended (0205)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- auth_pre_request(): the arm for an ended session
-- -------------------------------------------------------------------------------------------------
-- 0170's body unchanged but for the `session_id` claim it parses and the arm after the removed
-- person's. auth.sessions is keyed by id, so the arm is one primary-key probe for a request whose
-- token names a session. CREATE OR REPLACE keeps 0001's grants.
CREATE OR REPLACE FUNCTION public.auth_pre_request() RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_claims  text;
  v_jti     text;
  v_sub     text;
  v_session text;
BEGIN
  -- NO CLAIMS IS THE COMMON CASE, NOT AN ANOMALY. Every unauthenticated request arrives here with
  -- this GUC unset -- the `true` argument is what makes that return NULL instead of raising.
  v_claims := current_setting('request.jwt.claims', true);
  IF v_claims IS NULL OR v_claims = '' THEN
    RETURN;
  END IF;

  BEGIN
    v_jti     := (v_claims::jsonb) ->> 'jti';
    v_sub     := (v_claims::jsonb) ->> 'sub';
    v_session := (v_claims::jsonb) ->> 'session_id';
  EXCEPTION WHEN others THEN
    -- CLAIMS THAT WILL NOT PARSE ARE NOT THIS FUNCTION'S BUSINESS. PostgREST has already validated
    -- the signature to get here, so malformed JSON in this GUC is a PostgREST-side surprise rather
    -- than an attack this can meaningfully answer -- and raising would take the whole API down
    -- over a condition that has nothing to do with revocation.
    RETURN;
  END;

  -- ------------------------------------------------------------------------------------------
  -- The principal denylist, checked first
  -- ------------------------------------------------------------------------------------------
  -- The order is about the message: after a principal revocation both arms match, and "this
  -- identity has been revoked" is the fact that explains both. The cast is guarded because `sub`
  -- is a claim, and a bare cast on a malformed one would abort every request through this hook.
  IF v_sub IS NOT NULL AND v_sub <> '' THEN
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.revoked_service_principals WHERE principal_id = v_sub::uuid
      ) THEN
        RAISE EXCEPTION 'this identity has been revoked'
          USING ERRCODE = 'insufficient_privilege',
                DETAIL = 'principal ' || v_sub,
                HINT   = 'The service principal this token names was withdrawn by an '
                         'Administrator. Every token naming it is refused, including ones issued '
                         'afterwards, until the principal is reinstated.';
      END IF;
    EXCEPTION
      -- RE-RAISED, NOT SWALLOWED. Only the CAST is being guarded here; the refusal above must
      -- travel. Catching everything would make the control silently fail open, which is the one
      -- failure mode a denylist must not have.
      WHEN insufficient_privilege THEN RAISE;
      WHEN invalid_text_representation THEN NULL;
    END;
  END IF;

  -- ------------------------------------------------------------------------------------------
  -- A person whose access an Administrator removed (0170)
  -- ------------------------------------------------------------------------------------------
  -- Their role went at once, but a token issued before the removal is still signed and unexpired.
  -- restore_person_access() deletes the row, so the same token is served again straight away.
  -- A pattern test before the cast rather than an exception block: a second subtransaction on
  -- every request is the cost this arm avoids. GoTrue writes `sub` in this canonical form.
  IF v_sub ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    IF EXISTS (SELECT 1 FROM public.access_removals WHERE user_id = v_sub::uuid) THEN
      RAISE EXCEPTION 'this person''s access has been removed'
        USING ERRCODE = 'insufficient_privilege',
              DETAIL = 'user ' || v_sub,
              HINT   = 'An Administrator removed this person''s access on the People tab. Every '
                       'token naming them is refused until an Administrator restores it.';
    END IF;
  END IF;

  -- ------------------------------------------------------------------------------------------
  -- A session that has ended (0205)
  -- ------------------------------------------------------------------------------------------
  -- After the removal arm, whose message explains both when both match. Raised as
  -- raise_not_found() (0165) raises its 404: PostgREST answers the status in the detail, and
  -- the code in the message reaches the dashboard, which reads it as a session to sign in again.
  IF v_session ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND NOT EXISTS (SELECT 1 FROM auth.sessions WHERE id = v_session::uuid) THEN
    RAISE SQLSTATE 'PGRST'
      USING MESSAGE = json_build_object(
              'code', 'session_not_found',
              'message', 'this session has ended',
              'details', 'session ' || v_session,
              'hint', 'The session was signed out, or its password was changed. Sign in again '
                      'for a new token.')::text,
            DETAIL = json_build_object(
              'status', 401,
              'headers', json_build_object(
                'WWW-Authenticate',
                'Bearer error="invalid_token", error_description="the session has ended"'))::text;
  END IF;

  -- ------------------------------------------------------------------------------------------
  -- The token denylist (0074)
  -- ------------------------------------------------------------------------------------------
  -- A token with no `jti` (every human session, the anon and service_role keys) is unrevokable by
  -- this arm and must still be served. The subject arm above does not share that exemption.
  IF v_jti IS NOT NULL AND v_jti <> '' AND EXISTS (
    SELECT 1 FROM public.revoked_service_tokens
     WHERE jti = v_jti AND expires_at > now()
  ) THEN
    RAISE EXCEPTION 'this token has been revoked'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'jti ' || v_jti,
            HINT   = 'This credential was withdrawn by an Administrator. Minting a new token is '
                     'the only way back; the revoked one cannot be reinstated.';
  END IF;
END;
$$;

ALTER FUNCTION public.auth_pre_request() OWNER TO postgres;

COMMENT ON FUNCTION public.auth_pre_request() IS 'PostgREST db-pre-request hook: aborts the request when the caller''s JWT carries a revoked jti (0074), names a revoked service principal (0076), names a person whose access an Administrator removed, until it is restored (0170), or names a GoTrue session that has ended, with 401 session_not_found (0205). Returns quietly for every other condition -- no claims, unparseable claims, a token with no jti or session_id, a sub that is not a uuid -- because those are the ordinary majority and refusing them would take the whole API down.';

-- -------------------------------------------------------------------------------------------------
-- Self-check: both person arms are there, the hook still runs for every API role, a token naming
-- no session passes, and one naming a session that does not exist is refused with 401. A broken
-- hook refuses every request, so this boot fails instead of the API.
-- -------------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_src    text := (SELECT prosrc FROM pg_proc WHERE oid = 'public.auth_pre_request()'::regprocedure);
  v_owner  name := (SELECT pg_get_userbyid(proowner) FROM pg_proc
                     WHERE oid = 'public.auth_pre_request()'::regprocedure);
  v_msg    text;
  v_detail text;
  r        text;
BEGIN
  IF position('public.access_removals' IN v_src) = 0 THEN
    RAISE EXCEPTION '0205: auth_pre_request() no longer reads access_removals (0170)';
  END IF;
  IF position('auth.sessions' IN v_src) = 0 THEN
    RAISE EXCEPTION '0205: auth_pre_request() does not read auth.sessions';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.auth_pre_request()'::regprocedure) THEN
    RAISE EXCEPTION '0205: auth_pre_request() is not SECURITY DEFINER, so it cannot read auth.sessions';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT has_function_privilege(r, 'public.auth_pre_request()', 'EXECUTE') THEN
      RAISE EXCEPTION '0205: % may not execute auth_pre_request(); PostgREST would refuse every request', r;
    END IF;
  END LOOP;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid())::text, true);
  PERFORM public.auth_pre_request();

  -- GoTrue creates auth.sessions. Before it has, no token names a session, and there is nothing
  -- to probe.
  IF to_regclass('auth.sessions') IS NOT NULL THEN
    IF NOT has_table_privilege(v_owner, 'auth.sessions', 'SELECT') THEN
      RAISE EXCEPTION '0205: % may not read auth.sessions, so auth_pre_request() would fail every signed-in request', v_owner;
    END IF;
    BEGIN
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', gen_random_uuid(), 'session_id', gen_random_uuid())::text, true);
      PERFORM public.auth_pre_request();
      RAISE EXCEPTION '0205: auth_pre_request() served a token whose session does not exist';
    EXCEPTION WHEN SQLSTATE 'PGRST' THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
      IF (v_msg::jsonb ->> 'code') IS DISTINCT FROM 'session_not_found'
         OR (v_detail::jsonb ->> 'status') IS DISTINCT FROM '401' THEN
        RAISE EXCEPTION '0205: an ended session was refused with % %, not 401 session_not_found',
          v_detail, v_msg;
      END IF;
    END;
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);
END
$$;
