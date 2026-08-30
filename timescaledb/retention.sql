-- =============================================================================================
-- TimescaleDB compression and retention policy RECONCILIATION
--
-- Applied on EVERY boot by the `timescaledb-retention` service (Compose) and by the
-- `timescaledb-retention` hook Job (Helm), against a database that already holds the
-- hypertable. It takes two psql variables:
--
--     -v compress_after='7 days'      -v retain_after='90 days'
--     -v compress_after='never'       -v retain_after='never'      (policy removed)
--
-- WHY THIS IS NOT IN /docker-entrypoint-initdb.d ANY MORE.
--
-- It was, as `timescaledb/init/002_retention.sql`, and that is precisely why the intervals were
-- unchangeable in practice. The postgres entrypoint runs initdb scripts ONLY on an empty data
-- directory, so an operator who edited the file saw no effect on their running stack and had no
-- way to reach one short of destroying the PVC and every telemetry row in it. A retention
-- interval that can only be chosen before the first boot is not a setting, it is a constant with
-- a misleading name.
--
-- Running on every boot instead means the value in `.env` (or in `values.yaml`) IS the policy: a
-- changed interval takes effect at the next restart, in both directions.
--
-- WHY NOT pg_cron. Telemetry lives in this standalone TimescaleDB container, not in Supabase.
-- pg_cron runs inside the Supabase database and reaches this one only through the postgres_fdw
-- link, which exists to serve read queries to PostgREST -- driving destructive maintenance across
-- it would be both slower and far easier to get wrong. TimescaleDB has its own background job
-- scheduler for exactly this, so the policies belong here, next to the hypertable they act on.
-- =============================================================================================

\set ON_ERROR_STOP on

-- Hand the psql variables to PL/pgSQL through GUCs. This indirection is required, not stylistic:
-- psql interpolates `:'var'` while lexing and does NOT descend into dollar-quoted strings, so a
-- `:'compress_after'` written inside the DO block below would reach the server as those literal
-- characters and fail as a syntax error.
SELECT set_config('acs_cymru.compress_after', :'compress_after', false);
SELECT set_config('acs_cymru.retain_after',   :'retain_after',   false);


DO $$
DECLARE
  -- `never`, `off`, `disabled`, `none` and the empty string all mean "no policy". Several
  -- spellings are accepted because this value is typed into a .env file by hand and a rejected
  -- one would take the boot down over a synonym.
  disabled  CONSTANT text[] := ARRAY['never', 'off', 'disabled', 'none', 'false', '0'];

  raw_compress text := btrim(coalesce(current_setting('acs_cymru.compress_after', true), ''));
  raw_retain   text := btrim(coalesce(current_setting('acs_cymru.retain_after',   true), ''));

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
  -- The table must be TOLD HOW to compress before a policy can be attached.
  --   segmentby: rows for one asset/metric series compress together and stay individually
  --              retrievable, which matches how the dashboard queries (asset_id + metric_name,
  --              see queryTelemetry in frontend/src/api.js).
  --   orderby:   time DESC matches both the query order and the supporting index.
  --
  -- THE COLUMNSTORE API, NOT THE LEGACY COMPRESSION ONE. `add_columnstore_policy()` superseded
  -- `add_compression_policy()` in TimescaleDB 2.18; the old spelling still works and is what this
  -- file used until 2026-08. Two differences matter more than the rename:
  --
  --   1. THE NEW ENTRY POINTS ARE PROCEDURES, NOT FUNCTIONS. `add_columnstore_policy` and
  --      `remove_columnstore_policy` must be reached with CALL; `PERFORM` fails with
  --      "... is a procedure / HINT: To call a procedure, use CALL." Verified against 2.29.1,
  --      including from inside this DO block and alongside an inner EXCEPTION handler.
  --   2. The option names lose their `compress_` prefix and gain an explicit enable flag:
  --      `timescaledb.compress` -> `timescaledb.enable_columnstore = true`,
  --      `compress_segmentby`   -> `segmentby`, `compress_orderby` -> `orderby`.
  --
  -- What did NOT change: the job still reports as `policy_compression` in
  -- timescaledb_information.jobs with `compress_after` in its config, and the hypertable's state
  -- is still `compression_enabled` in timescaledb_information.hypertables -- there is no
  -- columnstore-named equivalent of either. Both were checked rather than assumed, because a
  -- rename there would have silently broken the guard below and the CI assertions.
  --
  -- Applied only once. Re-issuing the SET with different segmentby columns raises once compressed
  -- chunks exist, so this is guarded on the current state rather than run unconditionally --
  -- otherwise the SECOND boot of a compressed database would fail.
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

  -- Removed and re-added rather than `if_not_exists => TRUE`. With the policy already present at
  -- a DIFFERENT interval, add_* does not update it -- it emits a notice and does nothing, so a
  -- changed setting would appear to apply and would not. Removing first is what makes the value
  -- in the environment authoritative.
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
  -- A HARD DELETE with no undo: TimescaleDB drops whole chunks rather than deleting rows, and
  -- nothing in this stack copies them anywhere first. The interval is deliberately an operator
  -- decision -- manufacturing traceability obligations vary from weeks to decades and this
  -- project cannot guess which applies -- so the default only holds until someone sets it.
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

    -- COLD ARCHIVAL AND A DROP POLICY ARE A DATA-LOSS COMBINATION (roadmap item 3).
    --
    -- This policy deletes chunks on a timer and records nothing. The archiver exports a chunk,
    -- verifies the object and only then drops it. Run both and the timer wins the race for
    -- anything the archiver has not reached yet: the rows are gone, no manifest row exists, and
    -- nothing anywhere says they were ever there.
    --
    -- Observed while building the archiver, which is why the wording is this specific: a 150-day
    -- test chunk was exported, and the next reconciliation of this file deleted it before the
    -- export could be verified.
    --
    -- A WARNING RATHER THAN A REFUSAL. Refusing to add the policy would leave chunks accumulating
    -- on a stack whose archiver is misconfigured -- trading a loud data-loss risk for a quiet
    -- disk-exhaustion one. And the manifest holding rows is EVIDENCE of archival, not proof it is
    -- switched on; `archive.enabled` lives in the platform database, which this file cannot read.
    -- So it reports the conflict and lets the operator settle it.
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
