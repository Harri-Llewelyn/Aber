-- The historian's physical backup runs, one row per run of the pgbackrest sidecar, written only by
-- physical_backup_record(), which only the superuser can execute. The exporter reads it for the
-- Historian Backup Stale alert. Empty while timescaledb.physicalBackup is off. Reconciled on every
-- boot, idempotent. Reasoning: timescaledb/README.md.
\set ON_ERROR_STOP on

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
    -- Every backup the repository holds after this run, WAL excluded.
    repo_bytes      bigint
);

CREATE INDEX IF NOT EXISTS physical_backup_runs_finished_at
    ON public.physical_backup_runs (finished_at);

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

-- EXECUTE is granted to PUBLIC on creation; the sidecar connects as the superuser.
REVOKE ALL ON FUNCTION public.physical_backup_record(text, timestamptz, boolean, text, jsonb)
  FROM PUBLIC;

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

REVOKE ALL ON FUNCTION public.physical_backup_missed_slot(integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.physical_backup_type(integer, timestamptz, jsonb, timestamptz)
  FROM PUBLIC;
