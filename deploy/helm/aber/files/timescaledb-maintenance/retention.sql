-- Chunk interval, columnstore and retention policy, reconciled on every boot. Variables:
--     -v chunk_interval='12 hours'    optional; absent or empty leaves the interval as it is
--     -v compress_after='7 days'      'never' removes the policy
--     -v retain_after='90 days'       'never' keeps raw telemetry indefinitely
-- On every boot because initdb scripts never reach an existing database; TimescaleDB's own scheduler
-- rather than pg_cron, which lives in the platform database. Reasoning: timescaledb/README.md.
\set ON_ERROR_STOP on

-- psql interpolates :'var' while lexing and does not descend into dollar quotes, so the variables
-- cross into PL/pgSQL as GUCs.
SELECT set_config('aber.compress_after', :'compress_after', false);
SELECT set_config('aber.retain_after',   :'retain_after',   false);
\if :{?chunk_interval}
SELECT set_config('aber.chunk_interval', :'chunk_interval', false);
\else
SELECT set_config('aber.chunk_interval', '', false);
\endif

-- One row: raw_window (NULL keeps raw telemetry indefinitely) and whether the cold archiver last
-- reported archiving on.
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

-- The archiver's only write here. SECURITY DEFINER so ingest_writer can report without UPDATE on
-- the window it must not change.
CREATE OR REPLACE FUNCTION public.cold_archive_report_armed(p_armed boolean)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
    UPDATE public.telemetry_raw_window
       SET archive_armed = p_armed, archive_reported_at = now();
$fn$;
REVOKE ALL ON FUNCTION public.cold_archive_report_armed(boolean) FROM PUBLIC;

-- The retention job. Drops the oldest run of chunks past raw_window and stops at the first it may
-- not drop: an export in flight, or, while archiving is armed, a chunk with no verified manifest
-- row. Verified rows are stamped dropped in the same transaction. The manifest is read dynamically
-- because a first boot creates it after this file.
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
  -- Several spellings of 'no policy': the chart's timescaledb.retention.compressAfter and
  -- retainFor are typed by hand.
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

  -- Parse both intervals before acting on either, so a typo stops the boot naming its setting.
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

  -- set_chunk_time_interval() applies to chunks created afterwards. The open chunk plus
  -- compress_after is the raw data held uncompressed whatever the policy says.
  SELECT d.time_interval INTO was_chunk
  FROM timescaledb_information.dimensions d
  WHERE d.hypertable_schema = 'public' AND d.hypertable_name = 'telemetry' AND d.column_name = 'time';

  IF v_chunk IS NOT NULL AND v_chunk IS DISTINCT FROM was_chunk THEN
    PERFORM set_chunk_time_interval('public.telemetry', v_chunk);
    RAISE NOTICE 'chunk interval: % (was %), for chunks created from now on', v_chunk, was_chunk;
  ELSE
    RAISE NOTICE 'chunk interval: % (unchanged)', was_chunk;
  END IF;

  -- The columnstore API (TimescaleDB 2.18+): CALL, enable_columnstore/segmentby/orderby; the job
  -- still reports as policy_compression. The SET is issued once, because re-issuing it with different
  -- segmentby columns raises once compressed chunks exist.
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

  -- Removed and re-added: with the policy present at a different interval, add_* emits a notice and
  -- does nothing.
  CALL remove_columnstore_policy('public.telemetry', if_exists => TRUE);

  IF v_compress IS NOT NULL THEN
    CALL add_columnstore_policy('public.telemetry', after => v_compress);
    RAISE NOTICE 'columnstore policy: chunks older than % are compressed', v_compress;
  ELSE
    -- Off means stop compressing new chunks; decompressing a history during a boot is not a
    -- configuration change's business.
    RAISE NOTICE 'columnstore policy: DISABLED (existing compressed chunks are left as they are)';
  END IF;

  -- Legal and almost certainly a mistake; a warning, because the configuration does what it says.
  IF v_retain IS NOT NULL AND v_compress IS NOT NULL AND v_retain < v_compress THEN
    RAISE WARNING
      'retention (%) is shorter than compression (%), so no chunk will ever be compressed '
      'before it is dropped.', v_retain, v_compress;
  END IF;

  UPDATE public.telemetry_raw_window
     SET raw_window = v_retain, updated_at = now()
   WHERE raw_window IS DISTINCT FROM v_retain;

  -- TimescaleDB's own retention policy knows nothing of the archive, so telemetry_raw_retention()
  -- replaces it; removed on every boot so an upgraded stack converges.
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

-- assets is deliberately not covered: one small row per device, and telemetry.asset_id references it.
END $$;
