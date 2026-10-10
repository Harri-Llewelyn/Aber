-- 0173: The platform database records its own physical backup, as the historian records its.
--
-- supabaseDb.physicalBackup runs pgBackRest beside this database (supabase/db/pgbackrest/
-- platform-backup.sh): a full backup weekly, a differential daily and every WAL segment archived, so
-- a restore reaches any moment inside the retained backups. The sidecar records each run here,
-- through the same functions timescaledb/physical_backup.sql gives the historian, under the same
-- names and with the same bodies: the exporter reads the table for Platform Database Backup Stale,
-- and the Backups page reads platform_backup_state(). Empty while physical backup is off.
--
-- No table for requests: Take a backup already dumps this database, which the historian's dump
-- skips while pgBackRest backs it up. Reasoning: supabase/db/README.md.

-- -------------------------------------------------------------------------------------------------
-- The runs
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.physical_backup_runs (
    id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- full, diff or incr for a backup (as pgBackRest took it, which is full when no full exists
    -- to differ from), check for the archive check the sidecar runs at start.
    kind            text        NOT NULL CHECK (kind IN ('full', 'diff', 'incr', 'check')),
    started_at      timestamptz NOT NULL,
    finished_at     timestamptz NOT NULL DEFAULT now(),
    succeeded       boolean     NOT NULL,
    -- The tail of pgBackRest's output for a run that failed.
    detail          text,
    -- For a backup that succeeded: its label, the database bytes it covers, and the bytes it added
    -- to the repository after compression.
    label           text,
    database_bytes  bigint,
    backup_bytes    bigint,
    -- Every backup of this database the repository holds after this run, WAL excluded.
    repo_bytes      bigint
);

CREATE INDEX IF NOT EXISTS physical_backup_runs_finished_at
    ON public.physical_backup_runs (finished_at);

ALTER TABLE public.physical_backup_runs OWNER TO postgres;
ALTER TABLE public.physical_backup_runs ENABLE ROW LEVEL SECURITY;
-- Written by the sidecar as the superuser, read by the exporter (metrics_reader, a member of
-- pg_monitor) and by platform_backup_state().
REVOKE ALL ON TABLE public.physical_backup_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.physical_backup_runs TO pg_monitor;
DROP POLICY IF EXISTS physical_backup_runs_select_monitor ON public.physical_backup_runs;
CREATE POLICY physical_backup_runs_select_monitor ON public.physical_backup_runs
    FOR SELECT TO pg_monitor USING (true);

COMMENT ON TABLE public.physical_backup_runs IS
  'One row per run of the platform database''s pgBackRest sidecar (supabaseDb.physicalBackup), '
  'written only through physical_backup_record(). Read by the database exporter for Platform '
  'Database Backup Stale and by platform_backup_state() for the Backups page. Rows older than 90 '
  'days are deleted as each run is recorded.';

-- p_info is `pgbackrest info --output=json` after the run: one stanza, backups oldest first.
CREATE OR REPLACE FUNCTION public.physical_backup_record(
    p_kind text, p_started timestamptz, p_succeeded boolean, p_detail text, p_info jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_backups jsonb := coalesce(p_info -> 0 -> 'backup', '[]'::jsonb);
  v_last    jsonb := CASE WHEN p_succeeded AND p_kind <> 'check'
                          THEN v_backups -> -1 END;
BEGIN
  INSERT INTO public.physical_backup_runs
    (kind, started_at, succeeded, detail, label, database_bytes, backup_bytes, repo_bytes)
  VALUES (
    coalesce(v_last ->> 'type', p_kind),
    p_started,
    p_succeeded,
    left(nullif(p_detail, ''), 4000),
    v_last ->> 'label',
    (v_last -> 'info' ->> 'size')::bigint,
    (v_last -> 'info' -> 'repository' ->> 'delta')::bigint,
    (SELECT sum((b -> 'info' -> 'repository' ->> 'delta')::bigint)
       FROM jsonb_array_elements(v_backups) b));

  DELETE FROM public.physical_backup_runs WHERE finished_at < now() - interval '90 days';
END
$$;

-- -------------------------------------------------------------------------------------------------
-- The schedule: the historian's two rules, which the sidecar asks every minute
-- -------------------------------------------------------------------------------------------------
-- The newest daily slot at p_hour UTC at or before p_now, when no backup has been attempted since
-- it; NULL otherwise. A failed run is an attempt: retrying is the stale alert's call, not the loop's.
CREATE OR REPLACE FUNCTION public.physical_backup_missed_slot(
    p_hour integer, p_now timestamptz DEFAULT now())
RETURNS timestamptz
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  WITH today AS (
    SELECT (date_trunc('day', p_now AT TIME ZONE 'UTC') + make_interval(hours => p_hour))
             AT TIME ZONE 'UTC' AS at
  ), slot AS (
    SELECT CASE WHEN at <= p_now THEN at ELSE at - interval '1 day' END AS at FROM today
  )
  SELECT s.at FROM slot s
   WHERE NOT EXISTS (SELECT 1 FROM public.physical_backup_runs r
                      WHERE r.kind IN ('full', 'diff', 'incr') AND r.started_at >= s.at);
$$;

-- The type to take for p_slot: full on p_full_on's weekday (0 = Sunday), or when the repository's
-- newest full stopped more than seven days before p_now, so retainFull can expire when Sundays are
-- missed. p_info is `pgbackrest info --output=json`; one that failed to read ('[]') leaves the
-- weekday rule alone.
CREATE OR REPLACE FUNCTION public.physical_backup_type(
    p_full_on integer, p_slot timestamptz, p_info jsonb, p_now timestamptz DEFAULT now())
RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
           WHEN extract(dow FROM p_slot AT TIME ZONE 'UTC') = p_full_on THEN 'full'
           WHEN p_info -> 0 -> 'backup' IS NULL THEN 'diff'
           WHEN f.newest IS NULL OR f.newest < p_now - interval '7 days' THEN 'full'
           ELSE 'diff'
         END
    FROM (SELECT to_timestamp(max((b -> 'timestamp' ->> 'stop')::bigint)) AS newest
            FROM jsonb_array_elements(coalesce(p_info -> 0 -> 'backup', '[]'::jsonb)) b
           WHERE b ->> 'type' = 'full') f;
$$;

-- The schedule the sidecar last started with, so the Backups page can say when the next backup is
-- due. One row, written at start through physical_backup_record_schedule().
CREATE TABLE IF NOT EXISTS public.physical_backup_schedule (
    singleton   boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
    hour_utc    integer     NOT NULL CHECK (hour_utc BETWEEN 0 AND 23),
    full_on     integer     NOT NULL CHECK (full_on BETWEEN 0 AND 6),
    recorded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.physical_backup_schedule OWNER TO postgres;
ALTER TABLE public.physical_backup_schedule ENABLE ROW LEVEL SECURITY;
-- Read through platform_backup_state() only.
REVOKE ALL ON TABLE public.physical_backup_schedule FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.physical_backup_schedule IS
  'The hourUtc and fullOn the platform database''s pgBackRest sidecar started with, one row, so '
  'the Backups page can say when its next backup is due.';

CREATE OR REPLACE FUNCTION public.physical_backup_record_schedule(p_hour integer, p_full_on integer)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.physical_backup_schedule (hour_utc, full_on) VALUES (p_hour, p_full_on)
  ON CONFLICT (singleton) DO UPDATE
    SET hour_utc = EXCLUDED.hour_utc, full_on = EXCLUDED.full_on, recorded_at = now();
$$;

-- The sidecar connects as the superuser; nobody else runs these.
ALTER FUNCTION public.physical_backup_record(text, timestamptz, boolean, text, jsonb) OWNER TO postgres;
ALTER FUNCTION public.physical_backup_missed_slot(integer, timestamptz) OWNER TO postgres;
ALTER FUNCTION public.physical_backup_type(integer, timestamptz, jsonb, timestamptz) OWNER TO postgres;
ALTER FUNCTION public.physical_backup_record_schedule(integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.physical_backup_record(text, timestamptz, boolean, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.physical_backup_missed_slot(integer, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.physical_backup_type(integer, timestamptz, jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.physical_backup_record_schedule(integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What the Backups page reads
-- -------------------------------------------------------------------------------------------------
-- One row: the schedule, the first recorded run, the last attempt and the last success with its
-- type and label, the newest full, the repository's size, and the last failure when it is newer
-- than the last success. The columns historian_backup_state() returns, without its request, so the
-- page reads both with one rule; first_recorded_at is the clock Platform Database Backup Stale
-- falls back to. No row for anybody but an Administrator; for one, a row of NULLs until the sidecar
-- records something.
CREATE OR REPLACE FUNCTION public.platform_backup_state()
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
    last_failure_detail text
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
          FROM public.physical_backup_runs r
    ), ok AS (
        SELECT b.* FROM runs b WHERE b.succeeded AND b.kind <> 'check'
         ORDER BY b.finished_at DESC LIMIT 1
    ), failed AS (
        SELECT b.* FROM runs b WHERE NOT b.succeeded AND b.kind <> 'check'
         ORDER BY b.finished_at DESC LIMIT 1
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
           failed.detail
      FROM (SELECT 1) one
      LEFT JOIN public.physical_backup_schedule s ON true
      LEFT JOIN ok ON true
      LEFT JOIN failed ON ok.finished_at IS NULL OR failed.finished_at > ok.finished_at;
END;
$$;

ALTER FUNCTION public.platform_backup_state() OWNER TO postgres;

COMMENT ON FUNCTION public.platform_backup_state() IS
  'The platform database''s physical backup for the Backups page: schedule, last success, '
  'repository size and a failure newer than the last success. Administrator only.';

REVOKE ALL ON FUNCTION public.platform_backup_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_backup_state() TO authenticated;

-- -------------------------------------------------------------------------------------------------
-- Self-check: what this file granted and revoked.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
    v_table text;
    v_fn    text;
BEGIN
    FOREACH v_table IN ARRAY ARRAY['public.physical_backup_runs', 'public.physical_backup_schedule'] LOOP
        IF has_table_privilege('anon', v_table, 'SELECT')
           OR has_table_privilege('authenticated', v_table, 'SELECT') THEN
            RAISE EXCEPTION '0173: % is readable past platform_backup_state()''s Administrator gate', v_table;
        END IF;
    END LOOP;
    IF NOT has_table_privilege('pg_monitor', 'public.physical_backup_runs', 'SELECT') THEN
        RAISE EXCEPTION '0173: the database exporter cannot read physical_backup_runs';
    END IF;

    FOREACH v_fn IN ARRAY ARRAY['public.physical_backup_record(text, timestamptz, boolean, text, jsonb)',
                                'public.physical_backup_missed_slot(integer, timestamptz)',
                                'public.physical_backup_type(integer, timestamptz, jsonb, timestamptz)',
                                'public.physical_backup_record_schedule(integer, integer)'] LOOP
        IF has_function_privilege('anon', v_fn, 'EXECUTE')
           OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
           OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
            RAISE EXCEPTION '0173: an API role may execute %, which only the backup sidecar runs', v_fn;
        END IF;
    END LOOP;

    IF has_function_privilege('anon', 'public.platform_backup_state()', 'EXECUTE') THEN
        RAISE EXCEPTION '0173: anon may call platform_backup_state()';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.platform_backup_state()', 'EXECUTE') THEN
        RAISE EXCEPTION '0173: the Backups page cannot call platform_backup_state()';
    END IF;
END $check$;
