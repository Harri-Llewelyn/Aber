-- =============================================================================================
-- Migration: 0015_i3x_authenticates_with_a_call_the_planner_cannot_fold.sql
-- i3X's authentication probe is a function whose EXECUTE check runs on every call
-- =============================================================================================
--
-- i3X authenticates a request by calling one function through PostgREST as the caller. PostgREST
-- runs prepared statements, and a statement with no parameters runs from its generic plan. The
-- probe was `service_token_max_days()`, SQL and IMMUTABLE, which the planner folds to a constant:
-- the plan then holds no call, so the EXECUTE check made while planning for `authenticated` was
-- never repeated for an `anon` request that reused that plan on the same pooled connection.
--
-- `i3x_auth_probe()` is plpgsql, which the planner does not inline, and STABLE, which it does not
-- fold, so the call stays in the plan and its EXECUTE check runs on every execution
-- (supabase/README.md, "A call the planner can fold checks nobody").
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.i3x_auth_probe() RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path = ''
    AS $$
BEGIN
  RETURN true;
END;
$$;

ALTER FUNCTION public.i3x_auth_probe() OWNER TO postgres;

COMMENT ON FUNCTION public.i3x_auth_probe() IS
  'i3X calls this as the caller to authenticate a request: it succeeds only when PostgREST accepts '
  'the token and auth_pre_request() finds neither its jti nor its sub revoked. plpgsql and STABLE '
  'so no plan folds the call away: its EXECUTE check, which refuses anon, runs on every call.';

REVOKE ALL ON FUNCTION public.i3x_auth_probe() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.i3x_auth_probe() TO authenticated, service_role;

DO $check$
DECLARE
  v_lang text;
  v_volatility "char";
BEGIN
  IF has_function_privilege('anon', 'public.i3x_auth_probe()', 'EXECUTE') THEN
    RAISE EXCEPTION '0015: anon can execute public.i3x_auth_probe(), so i3X would accept anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.i3x_auth_probe()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.i3x_auth_probe()', 'EXECUTE') THEN
    RAISE EXCEPTION '0015: authenticated or service_role cannot execute public.i3x_auth_probe(), so i3X would refuse every token';
  END IF;
  SELECT l.lanname, p.provolatile INTO v_lang, v_volatility
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = 'public.i3x_auth_probe()'::regprocedure;
  IF v_lang <> 'plpgsql' OR v_volatility = 'i' THEN
    RAISE EXCEPTION '0015: public.i3x_auth_probe() is % and %: the planner may fold or inline the call and skip its EXECUTE check',
      v_lang, CASE v_volatility WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END;
  END IF;
END $check$;
