-- Migration: 20260101000025_pg_cron_maintenance.sql
-- Description: Scheduled janitorial work, replacing jobs that would otherwise need a sidecar
--              container or a human.
--
-- SCOPE. These jobs are deliberately janitorial only -- pruning logs and honouring a retention
-- timer the user already set. No job in this file derives application state. Gateway staleness
-- in particular is a VIEW (migration 0024), not a cron writer; see that file for why.
--
-- OBSERVABILITY. A failing cron job is silent. There is no log line, no alert, nothing in the
-- UI. Check it explicitly:
--   SELECT j.jobname, d.status, d.return_message, d.start_time
--   FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--   WHERE d.status <> 'succeeded' ORDER BY d.start_time DESC;

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- pg_cron installs into the `cron` schema and can only be created in the database named by
-- the cron.database_name GUC (default 'postgres', which is this one). It is already present
-- in shared_preload_libraries in the supabase/postgres image -- verified in Phase 0.

-- Idempotency helper. supabase-db-init replays every migration on every stack start, and
-- cron.schedule() creates a duplicate job rather than replacing one, so a bare schedule()
-- call would accumulate a new copy of each job on every boot.
CREATE OR REPLACE FUNCTION public.ensure_cron_job(
  p_name TEXT, p_schedule TEXT, p_command TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = p_name) THEN
    PERFORM cron.unschedule(p_name);
  END IF;
  PERFORM cron.schedule(p_name, p_schedule, p_command);
END $$;

REVOKE ALL ON FUNCTION public.ensure_cron_job(TEXT, TEXT, TEXT) FROM PUBLIC;

COMMENT ON FUNCTION public.ensure_cron_job(TEXT, TEXT, TEXT) IS
  'Unschedule-then-schedule, so replaying this migration does not accumulate duplicate jobs.';


-- 1. Prune pg_net's response log ------------------------------------------------------------
--
-- pg_net records every response in net._http_response and never prunes it; left alone it grows
-- for the life of the database. Scheduled here rather than in Phase 4 so the janitor exists
-- before the thing it cleans up.
--
-- The guard matters: pg_net is not installed until Phase 4 (migration 0026), so an unguarded
-- DELETE would fail every 15 minutes until then and fill cron.job_run_details with errors --
-- the job would be generating exactly the noise it exists to remove. to_regclass() returns
-- NULL rather than raising for a missing relation, so this no-ops cleanly and starts working
-- by itself the moment the extension is created.
SELECT public.ensure_cron_job(
  'prune_net_responses',
  '*/15 * * * *',
  $job$
    DO $prune$
    BEGIN
      IF to_regclass('net._http_response') IS NOT NULL THEN
        DELETE FROM net._http_response WHERE created < NOW() - INTERVAL '6 hours';
      END IF;
    END $prune$;
  $job$
);

-- 2. Prune pg_cron's own run history --------------------------------------------------------
-- cron.job_run_details grows one row per job per run and is not self-limiting.
SELECT public.ensure_cron_job(
  'prune_cron_history',
  '0 3 * * *',
  $job$DELETE FROM cron.job_run_details WHERE end_time < NOW() - INTERVAL '7 days'$job$
);

-- 3. Honour the archive retention timer ------------------------------------------------------
--
-- This does NOT invent a retention policy. public.{cells,gateways,devices}.auto_delete_at
-- (migration 0001) is set per row by the Archive dialog when the user picks a retention
-- period, and the UI already tells them it will happen -- ArchivesTab renders
-- "Purges: <date>" and CellsTab renders "Retention purge timer active (auto-purges on
-- <date>)". Nothing has ever implemented it. This job is what makes that promise true.
--
-- auto_delete_at IS NULL means PERMANENT RETENTION -- the UI says so explicitly
-- ("Permanent retention active (no auto-purge)") -- so the NOT NULL test is load-bearing.
-- Purging on archived_at age instead would silently destroy rows the user deliberately
-- marked to keep forever.
--
-- These DELETEs do fire log_digital_thread_event(), by design: a permanent deletion is
-- exactly the kind of event the audit trail should record. That is the opposite of the
-- staleness-sweep case, where the writes carried no information.
--
-- Order matters. devices reference gateways which reference cells, so children go first;
-- a parent whose child is not yet due simply fails to delete this run and is retried the
-- next, rather than cascading a child out from under its own timer.
SELECT public.ensure_cron_job(
  'purge_expired_archives',
  '30 3 * * *',
  $job$
    DELETE FROM public.devices
      WHERE is_archived AND auto_delete_at IS NOT NULL AND auto_delete_at <= NOW();
    DELETE FROM public.gateways
      WHERE is_archived AND auto_delete_at IS NOT NULL AND auto_delete_at <= NOW();
    DELETE FROM public.cells
      WHERE is_archived AND auto_delete_at IS NOT NULL AND auto_delete_at <= NOW();
  $job$
);
