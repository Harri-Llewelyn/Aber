-- =============================================================================================
-- Migration: 0071_the_anon_sweep_runs_after_the_functions_exist.sql
-- A fresh install was less secure than a restarted one, and only CI could see it
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT WAS WRONG, AND WHY IT WAS INVISIBLE FOR SIXTY MIGRATIONS
--
-- `0009` sweeps every function in `public` and revokes EXECUTE from PUBLIC and `anon`, restoring
-- only what `authenticated` and `service_role` already held. It is a good sweep. It runs at
-- position NINE.
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, and `anon` inherits it. So
-- every function created by a migration numbered above 0009 -- 0037's enrolment withdrawal, 0056's
-- playback guards, 0063's revocation trigger, 0070's audit-domain stamp, a dozen others -- is
-- anon-executable from the moment it is created, and 0009 has already run.
--
-- ON A RESTARTED STACK THAT SELF-CORRECTS, WHICH IS WHY NOBODY NOTICED. `CREATE OR REPLACE
-- FUNCTION` preserves the existing ACL, so the second boot's pass of 0009 revokes what the first
-- boot's pass of 0070 created, and every later replay keeps it revoked. The baseline is met from
-- boot two onward.
--
-- A FRESH INSTALL IS BOOT ONE. `validate.py`'s check 13a asserts that an anon privilege review
-- returns an EMPTY set -- *"that is what makes a real finding visible instead of hiding it among
-- harmless trigger functions"* -- and on a first boot it returned twelve. Every developer machine
-- had restarted often enough to look clean; CI builds a database from nothing every run and is the
-- only place the first-boot state is ever observed. It has been unable to report since before half
-- of those functions existed.
--
-- ---------------------------------------------------------------------------------------------
-- THE FIX IS ORDER, NOT A LONGER REVOKE LIST
--
-- Revoking the twelve by name would be correct today and wrong on the next migration that adds a
-- function. The sweep has to run AFTER the functions exist, which -- in a chain applied in filename
-- order with no ledger -- means it has to run last.
--
-- So the sweep becomes a FUNCTION, and this file calls it. A later migration that adds a function
-- ends with the same one-line call, and the self-check below fails loudly on the following boot if
-- somebody forgets. That is a worse guarantee than "impossible to get wrong" and a much better one
-- than "silently anon-executable until someone restarts".
--
-- THE DURABLE ANSWER IS AN EVENT TRIGGER on CREATE FUNCTION, which would revoke at the moment of
-- creation and need no call site at all. It is deliberately not taken here: event triggers in this
-- image are owned by `supabase_admin`, `0009`'s header already records what a restore does to
-- privileges it cannot see, and adding one belongs in a change about privilege management rather
-- than in a change fixing five CI failures. Recorded so the next person does not have to rediscover
-- that this is the shape of the real fix.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IS NOT TOUCHED
--
-- `authenticated` and `service_role` keep everything they hold. This narrows exactly one role, and
-- `anon` is the unauthenticated browser: it presents the publishable key at the gateway and holds
-- no session. A function it can execute is one an unauthenticated caller can execute.
--
-- Related: 0009 (the original sweep and why it exists), ingestion/validate.py check 13a,
--          0070 (two of the twelve were its).
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. The sweep, extracted so it has a name and a second caller
-- ---------------------------------------------------------------------------------------------
-- REPRODUCES 0009'S SHAPE DELIBERATELY, including the two-pass structure: remember what
-- `authenticated` and `service_role` hold, revoke from everyone, hand back what those two had.
-- A single `REVOKE ... FROM PUBLIC, anon` would not do -- a grant made TO PUBLIC is what
-- `authenticated` is reading through in some cases, so revoking it without restoring the explicit
-- grant takes the capability away from the roles that are supposed to have it.
CREATE OR REPLACE FUNCTION public.revoke_anon_function_privileges()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  fn        oid;
  all_fns   oid[];
  keep_auth oid[] := ARRAY[]::oid[];
  keep_svc  oid[] := ARRAY[]::oid[];
  v_before  int;
BEGIN
  SELECT coalesce(array_agg(p.oid), ARRAY[]::oid[]) INTO all_fns
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public';

  SELECT count(*) INTO v_before
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND has_function_privilege('anon', p.oid, 'EXECUTE');

  -- ---------------------------------------------------------------------------------------------
  -- A DIRECT GRANT, NOT AN EFFECTIVE PRIVILEGE (issue #117)
  --
  -- has_function_privilege() answers "can this role execute it", and that is TRUE when the only
  -- thing granting EXECUTE is PUBLIC -- which is precisely what the revoke loop below is about to
  -- take away. Asking it here made the sweep COPY the privilege it was removing: PUBLIC's implicit
  -- EXECUTE on a newly created function was captured as something `authenticated` held, PUBLIC was
  -- revoked, and `authenticated` was then handed an EXPLICIT grant it never had.
  --
  -- It only bit on a FIRST boot, which is why it went unseen. A function created earlier in the
  -- same boot still carries PUBLIC's grant when the sweep runs; on every later boot 0001's
  -- `REVOKE ALL ON ALL FUNCTIONS` has already stripped PUBLIC, so the same code kept nothing and
  -- the schema settled one grant narrower. Eleven trigger bodies -- audit_domain_for,
  -- stamp_audit_domain, log_role_assignment and the rest -- were `authenticated`-executable on a
  -- fresh install and not on a restarted one.
  --
  -- Reading the ACL directly is the whole fix: aclexplode() lists grants that were actually made
  -- to the role, and a NULL proacl (the untouched default) yields no rows, which is the right
  -- answer. A genuine RPC that a migration granted on purpose still matches and is still restored.
  -- ---------------------------------------------------------------------------------------------
  FOREACH fn IN ARRAY all_fns LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
                WHERE p.oid = fn AND a.grantee = 'authenticated'::regrole
                  AND a.privilege_type = 'EXECUTE') THEN
      keep_auth := keep_auth || fn;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
                WHERE p.oid = fn AND a.grantee = 'service_role'::regrole
                  AND a.privilege_type = 'EXECUTE') THEN
      keep_svc := keep_svc || fn;
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY all_fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn::regprocedure);
  END LOOP;

  FOREACH fn IN ARRAY keep_auth LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn::regprocedure);
  END LOOP;
  FOREACH fn IN ARRAY keep_svc LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn::regprocedure);
  END LOOP;

  -- The number this call actually corrected, so a boot log says whether it did anything. On a
  -- settled database it is 0 on every boot, which is the house rule for a replayed migration.
  RETURN v_before;
END;
$$;

COMMENT ON FUNCTION public.revoke_anon_function_privileges() IS
  'Revoke EXECUTE from PUBLIC and anon on every function in public, restoring what authenticated '
  'and service_role held. MUST BE CALLED BY THE LAST MIGRATION THAT CREATES A FUNCTION -- see '
  '0071. PostgreSQL grants EXECUTE to PUBLIC on creation, so a function added after the sweep is '
  'anon-executable until the next call.';

-- Not reachable over PostgREST by anyone. It is a privilege-management verb; a caller who can
-- reach it can revoke `authenticated`'s access to every function in the schema.
REVOKE ALL ON FUNCTION public.revoke_anon_function_privileges() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Run it
-- ---------------------------------------------------------------------------------------------
DO $sweep$
DECLARE
  v_corrected int;
BEGIN
  v_corrected := public.revoke_anon_function_privileges();
  IF v_corrected > 0 THEN
    RAISE NOTICE
      '0071: revoked anon EXECUTE on % function(s) in public. On a first boot this is every '
      'function created by a migration numbered above 0009; on a settled database it is 0.',
      v_corrected;
  END IF;
END;
$sweep$;

-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
-- THE SAME ASSERTION `validate.py` MAKES, moved to where it fails at db-init rather than at the
-- end of an end-to-end run. A migration that adds a function and forgets the call above now breaks
-- the boot that follows it, naming itself, instead of being reported an hour later by a check
-- whose message is about `anon` and not about the migration that caused it.
DO $selfcheck$
DECLARE
  v_leaked text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_leaked
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_leaked IS NOT NULL THEN
    RAISE EXCEPTION
      '0071 self-check: anon can still EXECUTE %. If you have just added a migration that creates '
      'a function, end it with `SELECT public.revoke_anon_function_privileges();` -- PostgreSQL '
      'grants EXECUTE to PUBLIC on creation and this sweep has already run.', v_leaked;
  END IF;

  RAISE NOTICE
    '0071 self-check passed: anon holds EXECUTE on no function in public.';
END;
$selfcheck$;
