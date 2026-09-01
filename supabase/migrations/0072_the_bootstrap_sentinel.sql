-- =============================================================================================
-- Migration: 0072_the_bootstrap_sentinel.sql
-- The conformance run started while the chain was still applying, and the gate said it was ready
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT WAS WRONG
--
-- On Kubernetes the e2e-validate Job is a plain manifest and `db-init` is a post-install hook, so
-- Helm creates the Job FIRST and the two run concurrently. The Job's own defence was an init
-- container waiting on:
--
--     SELECT 1 FROM public.devices LIMIT 1;
--
-- `public.devices` is created by 0001. That query starts succeeding once ONE migration of seventy
-- has run, and it keeps succeeding for the remaining sixty-nine. The gate proved the chain had
-- STARTED and was then satisfied for the whole of the rest of it.
--
-- Observed on CI run 33503395769, where validate.py began publishing while the chain was somewhere
-- in its fifties:
--
--     11:59:43 [ERROR] Error resolving device identity 'devfffffffffffffffffffff':
--              column devices.conformance_policy does not exist          <- 0050 had not run
--     11:59:43 [WARNING] DIRECTORY UNAVAILABLE: dropping DBIRTH without registering it
--     11:59:55 [INFO]  DEPRECATED IDENTITY: device matched by name       <- chain caught up
--
-- Checks 1, 1d, 1e and 1f failed; everything downstream of them passed, because by the time those
-- ran the column existed. The same window shows PGRST202 for `ingest_claim_capture_job` (0055) and
-- `ingest_claim_rebirth_requests` (0058).
--
-- IT PRESENTED AS FLAKE, NOT AS BREAKAGE. On a runner where db-init wins the race the whole suite
-- is green, so the failure moved with machine speed and looked like four unrelated quarantine bugs.
--
-- ---------------------------------------------------------------------------------------------
-- WHY A SENTINEL AND NOT ONE OF THE OTHER THREE FIXES
--
--   Wait on a LATE migration's artefact -- cheapest, and stale the moment 0073 lands. That is the
--     same trap as the current gate, moved forward fifty files.
--   Wait on the db-init Job through the Kubernetes API -- exact, but it needs a ServiceAccount and
--     a Role for `get jobs` on a container whose only job is to run one query.
--   Make the validate Job a hook at weight > 10 -- exact, and it overturns a decision recorded in
--     the template: *"A plain Job, not a hook: it is triggered on purpose"*. As a hook, a failing
--     conformance run becomes a failed `helm install`, which conflates "the stack deployed" with
--     "the stack conforms". Those must stay separate.
--
-- This table is the only option that neither goes stale as the chain grows nor collapses that
-- distinction. It records a FACT db-init already knows and previously threw away: that it reached
-- the end.
--
-- CLEARED AT THE START OF EVERY BOOT, not only written at the end. A row left complete by the
-- previous boot would satisfy the gate instantly while a `helm upgrade` replayed the chain -- the
-- identical race, one deployment later. `started_at`/`completed_at` is therefore a two-state flag,
-- and db-init clears it before the loop and stamps it after seed.sql. Both targets do this: the
-- race is Kubernetes-only, but a table that exists on one target and not the other is exactly the
-- drift scripts/check-compose-chart-parity.mjs was written to stop.
-- ---------------------------------------------------------------------------------------------

SET search_path TO public;

-- SINGLE-ROW BY CONSTRUCTION. `id` is a boolean pinned true by the CHECK and made the primary key,
-- so a second row is rejected by the database rather than by convention -- and `ON CONFLICT (id)`
-- in db-init has a key to conflict on.
CREATE TABLE IF NOT EXISTS public.schema_bootstrap (
  id           boolean     PRIMARY KEY DEFAULT true CHECK (id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

COMMENT ON TABLE public.schema_bootstrap IS
  'One row. completed_at IS NULL means db-init is part-way through the migration chain; a non-null '
  'completed_at means it reached the end of seed.sql on this boot. Written by db-init, not by a '
  'migration -- a migration cannot know whether the files after it succeeded.';

COMMENT ON COLUMN public.schema_bootstrap.completed_at IS
  'Cleared at the start of every boot and stamped after seed.sql. The e2e-validate Job gates on it.';

-- ---------------------------------------------------------------------------------------------
-- NO GRANTS, AND THE REVOKE IS NOT DECORATION.
--
-- This table is in `public`, so PostgREST would serve it to anyone the ACL admits. Nothing outside
-- db-init and the init container -- both of which connect as `postgres` -- has any business reading
-- it, and it is bootstrap state rather than application data: an operator reads it with psql.
--
-- It also has to land on the SAME ACL on a fresh install and on a replay. A default ACL granting
-- to `authenticated` at CREATE TABLE would show up in the first schema dump and not the second,
-- which is the exact shape of the divergence issue #117 already tracks. Revoking unconditionally
-- pins both runs to the same answer: nothing.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.schema_bootstrap ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.schema_bootstrap FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- SELF-CHECK
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
  v_rows    integer;
  v_granted text;
BEGIN
  SELECT count(*) INTO v_rows FROM public.schema_bootstrap;
  IF v_rows > 1 THEN
    RAISE EXCEPTION
      '0072 self-check: public.schema_bootstrap holds % rows. It is a one-row table and the gate '
      'reads it with an aggregate, so a second row makes "the chain finished" ambiguous.', v_rows;
  END IF;

  SELECT string_agg(grantee, ', ') INTO v_granted
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name   = 'schema_bootstrap'
     AND grantee IN ('PUBLIC', 'anon', 'authenticated');

  IF v_granted IS NOT NULL THEN
    RAISE EXCEPTION
      '0072 self-check: public.schema_bootstrap is readable by %. PostgREST serves this schema, and '
      'bootstrap state is not application data.', v_granted;
  END IF;

  RAISE NOTICE
    '0072 self-check passed: the bootstrap sentinel exists, holds at most one row, and is reachable '
    'by no API role.';
END;
$selfcheck$;
