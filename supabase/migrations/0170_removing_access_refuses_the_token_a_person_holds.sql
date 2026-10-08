-- 0170: Removing a person's access refuses the access token they already hold.
--
-- remove_person_access() (0166) deletes the person's role and GoTrue bans the account, which
-- refuses a new sign-in and a token refresh. An access token issued before the removal stayed valid
-- at PostgREST until its `exp` (supabaseAuth.jwtExpiry), reading what RLS grants any signed-in
-- account. auth_pre_request() now refuses a subject with a row in access_removals, as it refuses a
-- withdrawn service principal, so the person's next API request is refused. Restore Access deletes
-- the row, and the same token works again at once.

-- -------------------------------------------------------------------------------------------------
-- auth_pre_request(): the arm for a removed person
-- -------------------------------------------------------------------------------------------------
-- 0001's body unchanged but for the arm before the token denylist. access_removals is keyed by
-- user_id, so the arm is one primary-key probe for a request whose token names a subject.
-- CREATE OR REPLACE keeps 0001's grants: anon, authenticated and service_role execute it.
CREATE OR REPLACE FUNCTION public.auth_pre_request() RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_claims text;
  v_jti    text;
  v_sub    text;
BEGIN
  -- NO CLAIMS IS THE COMMON CASE, NOT AN ANOMALY. Every unauthenticated request arrives here with
  -- this GUC unset -- the `true` argument is what makes that return NULL instead of raising.
  v_claims := current_setting('request.jwt.claims', true);
  IF v_claims IS NULL OR v_claims = '' THEN
    RETURN;
  END IF;

  BEGIN
    v_jti := (v_claims::jsonb) ->> 'jti';
    v_sub := (v_claims::jsonb) ->> 'sub';
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

COMMENT ON FUNCTION public.auth_pre_request() IS 'PostgREST db-pre-request hook: aborts the request when the caller''s JWT carries a revoked jti (0074), names a revoked service principal (0076), or names a person whose access an Administrator removed, until it is restored (0170). Returns quietly for every other condition -- no claims, unparseable claims, a token with no jti, a sub that is not a uuid -- because those are the ordinary majority and refusing them would take the whole API down.';

-- -------------------------------------------------------------------------------------------------
-- Self-check: the arm is there, the hook still runs for every API role, and a subject with no
-- removal passes. A broken hook refuses every request, so this boot fails instead of the API.
-- -------------------------------------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  IF position('public.access_removals' IN
              (SELECT prosrc FROM pg_proc WHERE oid = 'public.auth_pre_request()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0170: auth_pre_request() does not read access_removals';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.auth_pre_request()'::regprocedure) THEN
    RAISE EXCEPTION '0170: auth_pre_request() is not SECURITY DEFINER, so it cannot read access_removals';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT has_function_privilege(r, 'public.auth_pre_request()', 'EXECUTE') THEN
      RAISE EXCEPTION '0170: % may not execute auth_pre_request(); PostgREST would refuse every request', r;
    END IF;
  END LOOP;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid())::text, true);
  PERFORM public.auth_pre_request();
  PERFORM set_config('request.jwt.claims', '', true);
END
$$;
