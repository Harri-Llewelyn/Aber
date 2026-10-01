-- =============================================================================================
-- Migration: 0011_grafana_sees_how_long_since_a_backup_succeeded.sql
-- How long since the platform backup last succeeded, for the Backup Stale alert rule (#474)
-- =============================================================================================
--
-- `backup_jobs` is Administrator-only under RLS, and Grafana reads this database as
-- `grafana_reader`, which may SELECT narrow views and no table. `backup_health` is at most one row:
-- when the last completed backup started, and the seconds since the clock started. The clock is
-- that start; before the first success, the first job recorded. With no job at all there is no
-- row, so a stack that has never run the backup service never raises the rule. The rule holds the
-- threshold, and the Backups page counts from the same clock (grafana/README.md, "Backup Stale").
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

-- Runs as its owner (security_invoker off), so SELECT on the view reads no backup_jobs row. The
-- aggregate always yields one row; the WHERE removes it while no job has been recorded.
CREATE OR REPLACE VIEW public.backup_health AS
SELECT now() AS collected_at,
       s.last_success_at,
       EXTRACT(EPOCH FROM (now() - coalesce(s.last_success_at, s.first_recorded_at)))::numeric AS age_seconds
  FROM (SELECT max(j.started_at) FILTER (WHERE j.status = 'COMPLETED') AS last_success_at,
               min(j.created_at) AS first_recorded_at
          FROM public.backup_jobs j) s
 WHERE s.first_recorded_at IS NOT NULL;

ALTER VIEW public.backup_health OWNER TO postgres;

COMMENT ON VIEW public.backup_health IS
  'How long since the platform backup last succeeded. last_success_at is when the newest COMPLETED '
  'backup_jobs row started (NULL before the first); age_seconds counts from it, or from the first '
  'job recorded while none has succeeded. No row while no job exists. Read by the Grafana rule '
  '"Backup Stale" as grafana_reader.';

REVOKE ALL ON public.backup_health FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.backup_health TO service_role;

-- Guarded: the role exists only where BI_READER_PASSWORD is set.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT SELECT ON public.backup_health TO grafana_reader';
  END IF;
END $grant$;

DO $check$
BEGIN
  IF has_table_privilege('anon', 'public.backup_health', 'SELECT')
     OR has_table_privilege('authenticated', 'public.backup_health', 'SELECT') THEN
    RAISE EXCEPTION '0011: backup_health is readable by anon or authenticated, past backup_jobs RLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader')
     AND NOT has_table_privilege('grafana_reader', 'public.backup_health', 'SELECT') THEN
    RAISE EXCEPTION '0011: grafana_reader cannot read backup_health, so the Backup Stale rule would sit in error';
  END IF;
END $check$;
