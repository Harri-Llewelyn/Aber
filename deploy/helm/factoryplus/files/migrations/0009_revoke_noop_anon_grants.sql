-- =============================================================================================
-- 0009 — Withdraw the residual function grants to `anon` and `authenticated`.
--
-- Filed as tech-debt ("an anon privilege review returns noise instead of an empty set"). It is
-- not. ONE OF THE GRANTS IS A PRIVILEGE ESCALATION, and it was reachable from the network:
--
--   POST /rest/v1/rpc/ensure_cron_job
--   {"p_name":"…","p_schedule":"…","p_command":"<any SQL>"}
--
-- answered **HTTP 204** with nothing but the anon key, and the job appeared in `cron.job`.
-- Confirmed against the running stack before this migration was written, with a job scheduled for
-- 31 February so it could never fire, then unscheduled.
--
-- WHY IT IS SERIOUS. `ensure_cron_job` is SECURITY DEFINER with no authorisation check of any
-- kind — its whole body is `cron.unschedule` then `cron.schedule` — so it executes as its owner,
-- `postgres`. That role is not a superuser in this image, which sounds reassuring and is not:
--
--     rolsuper = false, rolbypassrls = TRUE, rolcreaterole = TRUE
--
-- A scheduled command therefore runs past every RLS policy on every table, and can create roles.
-- `digital_thread`'s append-only trigger exempts `postgres` explicitly (0003), so the audit trail
-- is rewritable from there too. "Not a superuser" bounds this barely at all.
--
-- The anon key is not a secret: it is a published Supabase demo value committed in `.env.example`,
-- which the documented quickstart copies verbatim (see the open issue on per-install credentials).
-- On any deployment that kept the defaults, this was arbitrary SQL as the database owner for
-- anyone who could reach the gateway. `authenticated` held it too, so it was also available to
-- every signed-in Operator and Auditor regardless of the key.
--
-- HOW IT GOT HERE, because the mechanism will do this again. `0001` is a pg_dump baseline, and
-- **pg_dump records only positive grants** — the original chain's REVOKEs did not survive the
-- squash. 0001's header already documents this and adds an explicit privilege reset for TABLES
-- and SEQUENCES. Functions were not covered, and the ACL block reads:
--
--     REVOKE ALL ON FUNCTION public.ensure_cron_job(...) FROM PUBLIC;   -- line 2118
--     GRANT  ALL ON FUNCTION public.ensure_cron_job(...) TO anon;       -- line 2120
--
-- The revoke is undone two lines later by the dump's own restatement of the grant. Reading that
-- block top-to-bottom gives exactly the wrong impression, which is why the check at the end of
-- this file asserts the OUTCOME rather than trusting the statements.
--
-- WHAT REMAINS EXECUTABLE, deliberately: `fork_schema`, `publish_schema_version` and `has_role`
-- stay available to `authenticated`. They are SECURITY DEFINER *on purpose* — schema versioning is
-- routed through them rather than forbidden — and they carry their own checks. `ensure_cron_job`
-- is different in kind: it is a migration-time helper that no application path calls. Only 0002
-- calls it, as `postgres`, and an owner always retains EXECUTE regardless of what is revoked here.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. The escalation. Revoked from every application role AND from PUBLIC.
--
-- PUBLIC is included because a grant to PUBLIC would reach any role created later, including one
-- added by an operator who never read this file.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Everything else `anon` can reach in `public` — DERIVED, never enumerated.
--
-- The rest are inert: five are trigger functions, which PostgreSQL will not let you call directly
-- from SQL, and two are pure helpers over data `anon` cannot read. None was exploitable. They are
-- still withdrawn, because that is the actual point of the issue — an `anon` review returning
-- eight rows of harmless noise is one a real finding hides in, and one just did.
--
-- THE FIRST VERSION OF THIS SECTION WAS A HAND-WRITTEN LIST OF THOSE SEVEN, AND IT WAS WRONG ON A
-- FRESH DATABASE. The self-check below caught `enforce_digital_thread_append_only()` — created by
-- 0003, which is *after* the list was derived from 0001, and which explicitly revokes it from
-- PUBLIC before something later re-creates it and restores the default. A list written today
-- cannot know what migration 0012 will add, and the failure would be silent on exactly the
-- installs nobody inspects: fresh ones.
--
-- So the set is computed. Two facts make that necessary rather than clever:
--
--   * PostgreSQL grants EXECUTE on every new function to PUBLIC by default, so `anon` holds most
--     of these by INHERITANCE, not by name. Revoking `FROM anon` alone achieves nothing — the
--     first draft did that and left six of eight executable.
--   * `CREATE OR REPLACE` preserves ACLs but a DROP+CREATE does not, so a function can silently
--     regain the default years after someone revoked it.
--
-- `authenticated` AND `service_role` KEEP EXACTLY WHAT THEY HAD. Revoking PUBLIC would otherwise
-- withdraw privileges from them too, wherever PUBLIC was their only grant path — so what they can
-- execute is snapshotted first and re-granted explicitly afterwards. The effective privilege of a
-- logged-in user does not change by one function; only `anon` loses, which is the question this
-- issue asks. Tightening `authenticated` is a real question too, and a separate one.
--
-- REVOKING A TRIGGER FUNCTION DOES NOT DISARM ITS TRIGGER. EXECUTE is checked at CREATE TRIGGER,
-- not when it fires. Verified after applying, because a wrong answer would silently disable the
-- metric-catalog immutability guard and the digital-thread audit trigger — failures that look like
-- nothing at all until someone renames a metric.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  fn         oid;
  keep_auth  oid[] := ARRAY[]::oid[];
  keep_svc   oid[] := ARRAY[]::oid[];
  all_fns    oid[];
BEGIN
  SELECT coalesce(array_agg(p.oid), ARRAY[]::oid[]) INTO all_fns
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public';

  FOREACH fn IN ARRAY all_fns LOOP
    IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN
      keep_auth := keep_auth || fn;
    END IF;
    IF has_function_privilege('service_role', fn, 'EXECUTE') THEN
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
END $$;

-- Re-applied AFTER the restore above, which would otherwise hand `ensure_cron_job` straight back
-- to whichever roles held it a moment ago. Order matters here and nowhere else in this file.
REVOKE ALL ON FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Assert the OUTCOME, not the statements.
--
-- Every migration replays on every boot, so 0001 re-issues its grants and this file re-withdraws
-- them; the end state is what matters and it is what is checked. Written as a raise rather than a
-- notice: a database where `anon` can still reach a SECURITY DEFINER function must not come up
-- reporting success. db-init runs with ON_ERROR_STOP=1, so this stops the stack.
--
-- The allow-list is EMPTY. If a future migration legitimately needs to expose a function to
-- `anon`, add it here explicitly — that is a decision worth making visible in a diff.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', '
                    ORDER BY p.proname)
    INTO leaked
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
    AND p.proname <> ALL (ARRAY[]::text[]);

  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      '0009 self-check FAILED: anon can still EXECUTE in public: %. Every function grant to anon '
      'must be withdrawn or listed in this migration''s allow-list.', leaked;
  END IF;

  IF has_function_privilege(
       'authenticated',
       'public.ensure_cron_job(text,text,text)'::regprocedure,
       'EXECUTE') THEN
    RAISE EXCEPTION
      '0009 self-check FAILED: authenticated can still EXECUTE public.ensure_cron_job. It is '
      'SECURITY DEFINER with no authorisation check and schedules SQL as the database owner.';
  END IF;

  RAISE NOTICE '0009 self-check passed: anon holds no EXECUTE in public; ensure_cron_job is '
               'owner-only.';
END $$;
