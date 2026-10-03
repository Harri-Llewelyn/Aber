-- =============================================================================================
-- Migration: 0026_the_backups_page_reads_the_historians_own_backup.sql
-- The historian's physical backup on the Backups page: its runs, its schedule and the backups the
-- page asked for, read over the FDW behind an Administrator-only function
-- =============================================================================================
--
-- While timescaledb.physicalBackup is on, the platform's backups skip the historian and pgBackRest
-- backs it up, recording every run in the historian's physical_backup_runs. Three foreign tables
-- project that table, the sidecar's one-row schedule and physical_backup_requests
-- (timescaledb/physical_backup.sql), and historian_backup_state() reads them as one row. An
-- unreachable historian yields no row rather than an error, and the page says it is unreachable.
-- Reasoning: supabase/README.md, "The historian on the Backups page".
--
-- Idempotent. 0001 drops the FDW server with CASCADE on every boot, which drops these tables;
-- this file makes them again.
-- =============================================================================================

SET search_path TO public;

CREATE FOREIGN TABLE IF NOT EXISTS timescale.physical_backup_runs (
    id bigint,
    kind text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    succeeded boolean,
    detail text,
    label text,
    database_bytes bigint,
    backup_bytes bigint,
    repo_bytes bigint
)
SERVER timescaledb_server
OPTIONS (schema_name 'public', table_name 'physical_backup_runs');

CREATE FOREIGN TABLE IF NOT EXISTS timescale.physical_backup_schedule (
    hour_utc integer,
    full_on integer,
    recorded_at timestamp with time zone
)
SERVER timescaledb_server
OPTIONS (schema_name 'public', table_name 'physical_backup_schedule');

CREATE FOREIGN TABLE IF NOT EXISTS timescale.physical_backup_requests (
    id bigint,
    requested_at timestamp with time zone,
    job_id text,
    claimed_at timestamp with time zone
)
SERVER timescaledb_server
OPTIONS (schema_name 'public', table_name 'physical_backup_requests');

ALTER FOREIGN TABLE timescale.physical_backup_runs OWNER TO postgres;
ALTER FOREIGN TABLE timescale.physical_backup_schedule OWNER TO postgres;
ALTER FOREIGN TABLE timescale.physical_backup_requests OWNER TO postgres;

-- Read only through historian_backup_state(), which runs as their owner.
REVOKE ALL ON timescale.physical_backup_runs, timescale.physical_backup_schedule,
              timescale.physical_backup_requests FROM PUBLIC, anon, authenticated;

-- One row: the schedule, the last success, the repository's size, the last failure when it is
-- newer than the last success, and the latest request with the run that answered it (the first
-- recorded after it was claimed). last_success_at is a run's finish and first_recorded_at the
-- first run's start: the clock the Historian Backup Stale alert reads. No row for anybody but an
-- Administrator, and none while the historian cannot be read.
CREATE OR REPLACE FUNCTION public.historian_backup_state()
RETURNS TABLE (
    hour_utc integer,
    full_on integer,
    first_recorded_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_success_kind text,
    last_success_label text,
    last_full_at timestamp with time zone,
    repo_bytes bigint,
    last_failure_at timestamp with time zone,
    last_failure_kind text,
    last_failure_detail text,
    request_at timestamp with time zone,
    request_claimed_at timestamp with time zone,
    request_finished_at timestamp with time zone,
    request_succeeded boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, pg_catalog
AS $$
#variable_conflict use_column
BEGIN
    -- Checked here: a hidden page is not a gate, and this runs as its owner.
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH runs AS (
        SELECT r.kind, r.started_at, r.finished_at, r.succeeded, r.detail, r.label, r.repo_bytes
          FROM timescale.physical_backup_runs r
    ), ok AS (
        SELECT b.* FROM runs b WHERE b.succeeded AND b.kind <> 'check'
         ORDER BY b.finished_at DESC LIMIT 1
    ), failed AS (
        SELECT b.* FROM runs b WHERE NOT b.succeeded AND b.kind <> 'check'
         ORDER BY b.finished_at DESC LIMIT 1
    ), request AS (
        SELECT q.requested_at, q.claimed_at FROM timescale.physical_backup_requests q
         ORDER BY q.id DESC LIMIT 1
    ), answer AS (
        SELECT b.finished_at, b.succeeded FROM runs b, request q
         WHERE b.kind <> 'check' AND b.finished_at >= q.claimed_at
         ORDER BY b.finished_at LIMIT 1
    )
    SELECT s.hour_utc,
           s.full_on,
           (SELECT min(b.started_at) FROM runs b),
           (SELECT max(b.started_at) FROM runs b WHERE b.kind <> 'check'),
           ok.finished_at,
           ok.kind,
           ok.label,
           (SELECT max(b.finished_at) FROM runs b WHERE b.succeeded AND b.kind = 'full'),
           (SELECT b.repo_bytes FROM runs b WHERE b.repo_bytes IS NOT NULL
             ORDER BY b.finished_at DESC LIMIT 1),
           failed.finished_at,
           failed.kind,
           failed.detail,
           request.requested_at,
           request.claimed_at,
           answer.finished_at,
           answer.succeeded
      FROM (SELECT 1) one
      LEFT JOIN timescale.physical_backup_schedule s ON true
      LEFT JOIN ok ON true
      LEFT JOIN failed ON ok.finished_at IS NULL OR failed.finished_at > ok.finished_at
      LEFT JOIN request ON true
      LEFT JOIN answer ON true;
EXCEPTION
    -- postgres_fdw raises on connect: an unreachable historian, or one whose tables are not made
    -- yet. That is "cannot be read", which the page must not show as nothing to report.
    WHEN OTHERS THEN
        RETURN;
END;
$$;

ALTER FUNCTION public.historian_backup_state() OWNER TO postgres;

COMMENT ON FUNCTION public.historian_backup_state() IS
  'The historian''s physical backup for the Backups page: schedule, last success, repository size, '
  'a failure newer than the last success, and the latest request with its answer. Administrator '
  'only. No row while the historian cannot be read, which the page reports as unreachable.';

REVOKE ALL ON FUNCTION public.historian_backup_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.historian_backup_state() TO authenticated;

DO $check$
DECLARE
    v_table text;
BEGIN
    FOREACH v_table IN ARRAY ARRAY['timescale.physical_backup_runs', 'timescale.physical_backup_schedule',
                                   'timescale.physical_backup_requests'] LOOP
        IF to_regclass(v_table) IS NULL THEN
            RAISE EXCEPTION '0026: % was not made', v_table;
        END IF;
        IF has_table_privilege('anon', v_table, 'SELECT')
           OR has_table_privilege('authenticated', v_table, 'SELECT') THEN
            RAISE EXCEPTION '0026: % is readable past historian_backup_state()''s Administrator gate', v_table;
        END IF;
    END LOOP;
    IF has_function_privilege('anon', 'public.historian_backup_state()', 'EXECUTE') THEN
        RAISE EXCEPTION '0026: anon may call historian_backup_state()';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.historian_backup_state()', 'EXECUTE') THEN
        RAISE EXCEPTION '0026: the Backups page cannot call historian_backup_state()';
    END IF;
END $check$;
