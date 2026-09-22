-- =============================================================================================
-- TimescaleDB compression and retention policy reconciliation
--
-- Applied on every boot by the chart's maintenance hook Job,
-- against a database that already holds the hypertable. It takes two psql variables:
--
--     -v compress_after='7 days'      -v retain_after='90 days'
--     -v compress_after='never'       -v retain_after='never'      (policy removed)
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

DO $$
DECLARE
  -- `never`, `off`, `disabled`, `none` and the empty string all mean "no policy". Several
  -- spellings are accepted because this value is typed into a .env file by hand and a rejected
  -- one would take the boot down over a synonym.
  disabled  CONSTANT text[] := ARRAY['never', 'off', 'disabled', 'none', 'false', '0'];

  raw_compress text := btrim(coalesce(current_setting('aber.compress_after', true), ''));
  raw_retain   text := btrim(coalesce(current_setting('aber.retain_after',   true), ''));

  v_compress interval;
  v_retain   interval;
  compressed boolean;
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
        'TIMESCALE_COMPRESS_AFTER=''%'' is not a PostgreSQL interval. Use a form like ''7 days'' '
        'or ''12 hours'', or ''never'' to run without compression.', raw_compress;
    END;
  END IF;

  IF raw_retain <> '' AND NOT (lower(raw_retain) = ANY (disabled)) THEN
    BEGIN
      v_retain := raw_retain::interval;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION
        'TIMESCALE_RETAIN_FOR=''%'' is not a PostgreSQL interval. Use a form like ''90 days'' or '
        '''5 years'', or ''never'' to keep telemetry indefinitely.', raw_retain;
    END;
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
  -- A hard delete with no undo: TimescaleDB drops whole chunks and nothing here copies them first.
  -- The interval is an operator decision; the default holds until someone sets it.
  PERFORM remove_retention_policy('public.telemetry', if_exists => TRUE);

  IF v_retain IS NOT NULL THEN
    IF v_compress IS NOT NULL AND v_retain < v_compress THEN
      -- Legal, and almost certainly a mistake: chunks would be dropped before they were ever
      -- compressed. A warning rather than an exception, because it is the operator's data and
      -- the configuration does exactly what it says.
      RAISE WARNING
        'retention (%) is shorter than compression (%), so no chunk will ever be compressed '
        'before it is dropped.', v_retain, v_compress;
    END IF;

    -- Cold archival and a drop policy are a data-loss combination: this policy deletes chunks on a
    -- timer and records nothing, and the timer wins the race for anything the archiver has not
    -- reached. A warning rather than a refusal, because refusing would trade a loud data-loss risk
    -- for a quiet disk-exhaustion one, and `archive.enabled` lives in the platform database, which
    -- this file cannot read.
    IF to_regclass('public.telemetry_archive_manifest') IS NOT NULL THEN
      DECLARE v_archived bigint;
      BEGIN
        SELECT count(*) INTO v_archived FROM public.telemetry_archive_manifest;
        IF v_archived > 0 THEN
          RAISE WARNING
            'cold archival is in use (% manifest row(s)) AND a retention policy of % is being '
            'added. This policy drops chunks on a timer with no export and no record, so it will '
            'delete whatever the archiver has not reached yet. Set TIMESCALE_RETAIN_FOR=never and '
            'let `python -m cold_archive --drop` remove chunks once their export is verified.',
            v_archived, v_retain;
        END IF;
      END;
    END IF;

    PERFORM add_retention_policy('public.telemetry', v_retain);
    RAISE NOTICE 'retention policy: chunks older than % are DROPPED', v_retain;
  ELSE
    RAISE NOTICE 'retention policy: DISABLED -- telemetry is kept indefinitely and will grow '
                 'without bound. This is a valid choice; it is not an unconfigured one.';
  END IF;

  -- The `assets` dimension table is deliberately NOT covered by any of the above. It is small,
  -- holds one row per device, and telemetry.asset_id references it -- dropping an asset row
  -- would orphan history that has not yet aged out.
END $$;
