-- 0224: aas-api and the Factory+ Directory accept a machine identity's token.
--
-- Both edge functions checked each caller with GoTrue's getUser(), which refuses a token with no
-- `aud` claim. A machine identity's token carries none, so the Read-only API client could read
-- neither. They now check the caller with one PostgREST call made as the caller, as the i3X server
-- does, and revocation reaches them through auth_pre_request().
--
--   * auth_probe(): returns true, and only `authenticated` may run it. The call succeeds when
--     PostgREST accepts the token's signature and expiry and auth_pre_request() finds neither the
--     token, its identity nor its session withdrawn. anon is refused, so the publishable key is
--     refused; service_role is refused, so a function that holds no service-role key is never
--     handed one's reach by a caller presenting the secret key. plpgsql and STABLE, so no plan
--     folds the call away and skips its EXECUTE check. i3X keeps its own i3x_auth_probe().
--
-- Reasoning: supabase/README.md, "aas-api and the Directory accept a machine identity's token
-- (0224)". Idempotent.

CREATE OR REPLACE FUNCTION public.auth_probe() RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
BEGIN
  RETURN true;
END;
$$;

ALTER FUNCTION public.auth_probe() OWNER TO postgres;

COMMENT ON FUNCTION public.auth_probe() IS
  'aas-api and fplus-directory call this as the caller to authenticate a request, through '
  'supabase/functions/_shared/callerCheck.ts: it succeeds only when PostgREST accepts the token '
  'and auth_pre_request() finds neither its jti, its sub nor its session withdrawn. authenticated '
  'alone may run it, so the publishable and secret keys are refused. plpgsql and STABLE so no plan '
  'folds the call away: its EXECUTE check runs on every call (0224).';

REVOKE ALL ON FUNCTION public.auth_probe() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.auth_probe() TO authenticated;

DO $check$
DECLARE
  v_probe CONSTANT regprocedure := 'public.auth_probe()'::regprocedure;
BEGIN
  IF NOT has_function_privilege('authenticated', v_probe, 'EXECUTE') THEN
    RAISE EXCEPTION '0224: authenticated cannot execute auth_probe(), so aas-api and the Directory refuse every token';
  END IF;
  IF has_function_privilege('anon', v_probe, 'EXECUTE') THEN
    RAISE EXCEPTION '0224: anon can execute auth_probe(), so aas-api and the Directory accept the publishable key';
  END IF;
  IF has_function_privilege('service_role', v_probe, 'EXECUTE') THEN
    RAISE EXCEPTION '0224: service_role can execute auth_probe(), so aas-api and the Directory accept the secret key';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                  WHERE p.oid = v_probe AND l.lanname = 'plpgsql' AND p.provolatile <> 'i') THEN
    RAISE EXCEPTION '0224: auth_probe() is not plpgsql, or is IMMUTABLE: the planner may fold the call and skip its EXECUTE check';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
