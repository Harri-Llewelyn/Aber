-- =============================================================================================
-- TimescaleDB compression and retention policy reconciliation
--
-- Applied on every boot by the chart's maintenance hook Job,
-- against a database that already holds the hypertable. It takes these psql variables:
--
--     -v compress_after='7 days'      -v retain_after='90 days'
--     -v compress_after='never'       -v retain_after='never'      (policy removed)
--     -v chunk_interval='12 hours'    optional; absent or empty leaves the interval as it is
--
-- Not in /docker-entrypoint-initdb.d: the postgres entrypoint runs initdb scripts only on an
-- empty data directory, so a policy defined there could never be changed on a running stack.
-- Running on every boot means the value in `.env` (or values.yaml) is the policy. Not pg_cron:
-- that runs inside the Supabase database and reaches this one only over the read-only FDW link;
-- TimescaleDB has its own job scheduler.
-- =============================================================================================

\set ON_ERROR_STOP on

-- Hand the psql variables to PL/pgSQL through GUCs: psql interpolates `:'var'` while lexing and
-- does not descend into dollar-quoted strings.
SELECT set_config('aber.compress_after', :'compress_after', false);
SELECT set_config('aber.retain_after',   :'retain_after',   false);
\if :{?chunk_interval}
SELECT set_config('aber.chunk_interval', :'chunk_interval', false);
\else
SELECT set_config('aber.chunk_interval', '', false);
\endif

-- ---------------------------------------------------------------------------------------------
-- The raw window
-- ---------------------------------------------------------------------------------------------
-- One row. `raw_window` is written below from timescaledb.retention.retainFor (NULL keeps raw
-- telemetry indefinitely). `archive_armed` is reported by the cold archiver on every run from the
-- platform's `archive.enabled`, which this database cannot read; until it reports, it is false.
CREATE TABLE IF NOT EXISTS public.telemetry_raw_window (
    singleton           boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    raw_window          interval,
    archive_armed       boolean NOT NULL DEFAULT false,
    archive_reported_at timestamptz,
    updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.telemetry_raw_window (singleton) VALUES (true) ON CONFLICT DO NOTHING;

COMMENT ON TABLE public.telemetry_raw_window IS
  'How long raw telemetry is kept (raw_window, NULL = indefinitely) and whether the cold archiver '
  'last reported archiving on. Read by telemetry_raw_retention() and, over the FDW, the Cold '
  'Storage page.';

-- The archiver's only write here. SECURITY DEFINER so ingest_writer, which it runs as, can report
-- without holding UPDATE on the window it must not change.
CREATE OR REPLACE FUNCTION public.cold_archive_report_armed(p_armed boolean)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
    UPDATE public.telemetry_raw_window
       SET archive_armed = p_armed, archive_reported_at = now();
$fn$;
REVOKE ALL ON FUNCTION public.cold_archive_report_armed(boolean) FROM PUBLIC;

-- The retention job. Drops the oldest run of chunks that ended more than `raw_window` ago, and
-- stops at the first one it may not drop:
--   * a chunk whose export is in flight (a manifest row not yet verified), always;
--   * while archiving is armed, a chunk with no verified manifest row.
-- So an archive outage grows the volume, which the Archive Backlog alert reports, instead of the
-- window deleting what was never exported. Verified rows are stamped dropped in the same
-- transaction as the drop, as cold_tier_drop_verified() does. The manifest is read dynamically
-- because cold_archive.sql creates it after this file on a first boot.
CREATE OR REPLACE PROCEDURE public.telemetry_raw_retention(job_id integer, config jsonb)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $proc$
DECLARE
    v_window   interval;
    v_armed    boolean;
    v_manifest boolean := to_regclass('public.telemetry_archive_manifest') IS NOT NULL;
    v_boundary timestamptz;
    v_chunk    record;
    v_verified boolean;
    v_pending  boolean;
BEGIN
    SELECT w.raw_window, w.archive_armed INTO v_window, v_armed FROM public.telemetry_raw_window w;
    IF v_window IS NULL THEN
        RETURN;
    END IF;

    FOR v_chunk IN
        SELECT c.chunk_schema::text AS chunk_schema, c.chunk_name::text AS chunk_name, c.range_end
          FROM timescaledb_information.chunks c
         WHERE c.hypertable_schema = 'public' AND c.hypertable_name = 'telemetry'
           AND c.range_end <= now() - v_window
         ORDER BY c.range_end
    LOOP
        v_verified := false;
        v_pending  := false;
        IF v_manifest THEN
            EXECUTE
              'SELECT coalesce(bool_or(verified_at IS NOT NULL AND object_key IS NOT NULL), false),
                      coalesce(bool_or(verified_at IS NULL), false)
                 FROM public.telemetry_archive_manifest
                WHERE chunk_schema = $1 AND chunk_name = $2 AND dropped_at IS NULL'
              INTO v_verified, v_pending
              USING v_chunk.chunk_schema, v_chunk.chunk_name;
        END IF;
        EXIT WHEN v_pending;
        EXIT WHEN v_armed AND NOT v_verified;
        v_boundary := v_chunk.range_end;
    END LOOP;

    IF v_boundary IS NULL THEN
        RETURN;
    END IF;

    IF v_manifest THEN
        EXECUTE
          'UPDATE public.telemetry_archive_manifest m
              SET dropped_at = now()
             FROM timescaledb_information.chunks c
            WHERE c.hypertable_schema = ''public'' AND c.hypertable_name = ''telemetry''
              AND c.chunk_schema::text = m.chunk_schema AND c.chunk_name::text = m.chunk_name
              AND c.range_end <= $1
              AND m.verified_at IS NOT NULL AND m.dropped_at IS NULL'
          USING v_boundary;
    END IF;

    PERFORM public.drop_chunks('public.telemetry', older_than => v_boundary);
END $proc$;

DO $$
DECLARE
  -- `never`, `off`, `disabled`, `none` and the empty string all mean "no policy". Several
  -- spellings are accepted because this value is typed into a .env file by hand and a rejected
  -- one would take the boot down over a synonym.
  disabled  CONSTANT text[] := ARRAY['never', 'off', 'disabled', 'none', 'false', '0'];

  raw_compress text := btrim(coalesce(current_setting('aber.compress_after', true), ''));
  raw_retain   text := btrim(coalesce(current_setting('aber.retain_after',   true), ''));
  raw_chunk    text := btrim(coalesce(current_setting('aber.chunk_interval', true), ''));

  v_compress interval;
  v_retain   interval;
  v_chunk    interval;
  was_chunk  interval;
  compressed boolean;
  v_job      integer;
BEGIN
  IF to_regclass('public.telemetry') IS NULL THEN
    RAISE EXCEPTION
      'telemetry hypertable does not exist. It is created by timescaledb/init/001_schema.sql, '
      'which the postgres entrypoint runs only on an EMPTY data directory -- so this usually '
      'means the volume was initialised before that script existed.';
  END IF;

  -- Parse first, act second. A typo in either interval must stop the boot with a message naming
  -- the setting, not leave the stack running with one policy applied and the other silently
  -- absent.
  IF raw_compress <> '' AND NOT (lower(raw_compress) = ANY (disabled)) THEN
    BEGIN
      v_compress := raw_compress::interval;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION
        'timescaledb.retention.compressAfter=''%'' is not a PostgreSQL interval. Use a form like ''7 days'' '
        'or ''12 hours'', or ''never'' to run without compression.', raw_compress;
    END;
  END IF;

  IF raw_retain <> '' AND NOT (lower(raw_retain) = ANY (disabled)) THEN
    BEGIN
      v_retain := raw_retain::interval;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION
        'timescaledb.retention.retainFor=''%'' is not a PostgreSQL interval. Use a form like ''90 days'' or '
        '''5 years'', or ''never'' to keep telemetry indefinitely.', raw_retain;
    END;
  END IF;

  IF raw_chunk <> '' THEN
    BEGIN
      v_chunk := raw_chunk::interval;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION
        'timescaledb.retention.chunkInterval=''%'' is not a PostgreSQL interval. Use a form like '
        '''12 hours'' or ''1 day''.', raw_chunk;
    END;
    IF v_chunk < interval '1 minute' THEN
      RAISE EXCEPTION 'timescaledb.retention.chunkInterval=''%'' is below one minute.', raw_chunk;
    END IF;
  END IF;

  -- -------------------------------------------------------------------------------------------
  -- Chunk interval
  -- -------------------------------------------------------------------------------------------
  -- Compression never touches the open chunk, so its span plus compress_after is the raw data
  -- held uncompressed whatever the policy says. set_chunk_time_interval() applies to chunks
  -- created afterwards; existing chunks keep the span they were made with.
  SELECT d.time_interval INTO was_chunk
  FROM timescaledb_information.dimensions d
  WHERE d.hypertable_schema = 'public' AND d.hypertable_name = 'telemetry' AND d.column_name = 'time';

  IF v_chunk IS NOT NULL AND v_chunk IS DISTINCT FROM was_chunk THEN
    PERFORM set_chunk_time_interval('public.telemetry', v_chunk);
    RAISE NOTICE 'chunk interval: % (was %), for chunks created from now on', v_chunk, was_chunk;
  ELSE
    RAISE NOTICE 'chunk interval: % (unchanged)', was_chunk;
  END IF;

  -- -------------------------------------------------------------------------------------------
  -- Columnstore (Hypercore)
  -- -------------------------------------------------------------------------------------------
  -- segmentby: rows for one asset/metric series compress together (matching how the dashboard
  -- queries); orderby: time DESC matches the query order and the supporting index.
  --
  -- The columnstore API (TimescaleDB 2.18+), not the legacy compression one: the entry points are
  -- procedures reached with CALL (`PERFORM` fails), and the options are `enable_columnstore`,
  -- `segmentby`, `orderby`. The job still reports as `policy_compression` and the hypertable
  -- state as `compression_enabled`, which the guard below and the CI assertions read.
  --
  -- Applied only once: re-issuing the SET with different segmentby columns raises once compressed
  -- chunks exist, so this is guarded on the current state.
  SELECT h.compression_enabled INTO compressed
  FROM timescaledb_information.hypertables h
  WHERE h.hypertable_schema = 'public' AND h.hypertable_name = 'telemetry';

  IF v_compress IS NOT NULL AND NOT coalesce(compressed, false) THEN
    ALTER TABLE public.telemetry SET (
      timescaledb.enable_columnstore = true,
      timescaledb.segmentby          = 'asset_id, metric_name',
      timescaledb.orderby            = 'time DESC'
    );
  END IF;

  -- Removed and re-added rather than `if_not_exists => TRUE`: with the policy present at a
  -- different interval, add_* emits a notice and does nothing.
  CALL remove_columnstore_policy('public.telemetry', if_exists => TRUE);

  IF v_compress IS NOT NULL THEN
    -- `after =>`, not the legacy positional `compress_after`.
    CALL add_columnstore_policy('public.telemetry', after => v_compress);
    RAISE NOTICE 'columnstore policy: chunks older than % are compressed', v_compress;
  ELSE
    -- Existing compressed chunks are deliberately left compressed. Decompressing a history that
    -- may be hundreds of gigabytes, unprompted, during a boot, is not something a config change
    -- should do; turning the policy off means "stop compressing new chunks".
    RAISE NOTICE 'columnstore policy: DISABLED (existing compressed chunks are left as they are)';
  END IF;

  -- -------------------------------------------------------------------------------------------
  -- Retention
  -- -------------------------------------------------------------------------------------------
  -- A hard delete with no undo, by telemetry_raw_retention() above rather than TimescaleDB's
  -- add_retention_policy(): that policy drops on a timer with no knowledge of the archive, and
  -- whether archiving is on is decided at runtime on the Cold Storage page.
  IF v_retain IS NOT NULL AND v_compress IS NOT NULL AND v_retain < v_compress THEN
    -- Legal, and almost certainly a mistake: chunks would be dropped before they were ever
    -- compressed. A warning rather than an exception, because it is the operator's data and the
    -- configuration does exactly what it says.
    RAISE WARNING
      'retention (%) is shorter than compression (%), so no chunk will ever be compressed '
      'before it is dropped.', v_retain, v_compress;
  END IF;

  UPDATE public.telemetry_raw_window
     SET raw_window = v_retain, updated_at = now()
   WHERE raw_window IS DISTINCT FROM v_retain;

  -- The policy this job replaces, removed on every boot so an upgraded stack converges.
  PERFORM remove_retention_policy('public.telemetry', if_exists => TRUE);

  SELECT j.job_id INTO v_job FROM timescaledb_information.jobs j
   WHERE j.proc_schema = 'public' AND j.proc_name = 'telemetry_raw_retention'
   ORDER BY j.job_id LIMIT 1;
  IF v_job IS NULL THEN
    SELECT add_job('public.telemetry_raw_retention', '1 day') INTO v_job;
  END IF;

  IF v_retain IS NOT NULL THEN
    RAISE NOTICE 'retention (job %): raw chunks that ended more than % ago are DROPPED; while '
                 'archiving is on, only those the archive has verified', v_job, v_retain;
  ELSE
    RAISE NOTICE 'retention (job %): DISABLED -- raw telemetry is kept indefinitely and will grow '
                 'without bound. This is a valid choice; it is not an unconfigured one.', v_job;
  END IF;

  -- The `assets` dimension table is deliberately NOT covered by any of the above. It is small,
  -- holds one row per device, and telemetry.asset_id references it -- dropping an asset row
  -- would orphan history that has not yet aged out.
END $$;
