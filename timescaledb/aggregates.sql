-- =============================================================================================
-- Telemetry rollups and the latest-value view.
--
-- Applied on EVERY boot by the `timescaledb-maintenance` service (Compose) and hook Job (Helm),
-- alongside retention.sql. It takes three psql variables:
--
--     -v rollup_1m_retain='180 days' -v rollup_5m_retain='1 year' -v rollup_1h_retain='5 years'
--
-- `never` (also `off`, `none`, `disabled`) removes a policy without dropping the rollup.
--
-- NOT IN timescaledb/init/, FOR THE SAME REASON retention.sql IS NOT. The postgres entrypoint runs
-- initdb scripts ONLY on an empty data directory, so anything defined there never reaches a
-- database that already exists -- and on Kubernetes "recreate the volume" means deleting the PVC.
-- Rollups added to init/ would exist on fresh installs and silently not exist anywhere else.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS SOLVES, AND WHAT IT DELIBERATELY DOES NOT
--
-- `public.telemetry` in Supabase is a postgres_fdw projection of this hypertable, and the wrapper
-- pushes WHERE down but NOT LIMIT. Two different problems hide under that one sentence:
--
--   1. TREND QUERIES over a long window. Genuinely need less data, which is what the rollups
--      below are for. Grafana reads this database DIRECTLY by SQL and never crosses the FDW, so
--      it benefits from them without any Supabase involvement at all.
--
--   2. LATEST-VALUE lookups. The dashboard's two `/latest` routes fetch a window and discard
--      almost all of it -- the device drawer pulls TWENTY-FOUR HOURS for one device to keep the
--      newest row per metric. A rollup does not help here: averaging 24h of buckets is still
--      shipping 24h of buckets. `telemetry_latest` below is what fixes it, and it works *because*
--      of the wrapper's limitation rather than around it -- see its own comment.
--
-- The CSV export is deliberately left reading RAW. It is an export of observations, and a
-- rollup would hand the operator numbers no instrument ever produced.
-- =============================================================================================

\set ON_ERROR_STOP on

-- Same GUC indirection retention.sql uses: psql interpolates `:'var'` while lexing and does not
-- descend into dollar-quoted strings, so these cannot be read directly inside the DO block below.
SELECT set_config('factoryplus.rollup_1m_retain', :'rollup_1m_retain', false);
SELECT set_config('factoryplus.rollup_5m_retain', :'rollup_5m_retain', false);
SELECT set_config('factoryplus.rollup_1h_retain', :'rollup_1h_retain', false);


-- ---------------------------------------------------------------------------------------------
-- 1. telemetry_latest -- one row per (asset, metric), evaluated REMOTELY.
-- ---------------------------------------------------------------------------------------------
-- THE POINT IS WHERE THIS RUNS. postgres_fdw does not push LIMIT, but it does push WHERE, and a
-- view on this side is evaluated HERE -- so Supabase issues
--
--     SELECT ... FROM public.telemetry_latest WHERE asset_id = 'dev...'
--
-- and receives one row per metric instead of a day of rows to throw away. `DISTINCT ON` is served
-- directly by idx_telemetry_asset_metric_time (asset_id, metric_name, time DESC), so the fleet-wide
-- case is bounded by SERIES COUNT rather than by time window -- it does not grow as history does.
--
-- A plain view, not a continuous aggregate: "the newest row" is not an aggregate over a bucket,
-- and materialising it would mean a writer that has to be kept in step with every insert. This
-- stays derived, which is the same choice public.gateway_status makes in Supabase.
CREATE OR REPLACE VIEW telemetry_latest AS
SELECT DISTINCT ON (asset_id, metric_name)
       time,
       asset_id,
       metric_name,
       val_double,
       val_string,
       val_bool
  FROM telemetry
 ORDER BY asset_id, metric_name, time DESC;

COMMENT ON VIEW telemetry_latest IS
  'Newest sample per (asset_id, metric_name). Evaluated on this server so postgres_fdw ships one '
  'row per series instead of a whole time window. Backed by idx_telemetry_asset_metric_time.';


-- ---------------------------------------------------------------------------------------------
-- 2. The rollups: 1 minute -> 5 minutes -> 1 hour.
-- ---------------------------------------------------------------------------------------------
-- SUM AND COUNT ARE STORED, NOT AVG, and that is what makes the hierarchy exact. The 5m view is
-- built FROM the 1m view rather than from raw, so refresh cost stays proportional -- but
-- avg(avg) is WRONG whenever the buckets being combined hold different numbers of samples. A
-- machine that reported twice in one minute and two hundred times in the next would have both
-- minutes weighted equally. Storing the components and dividing at read time cannot get this
-- wrong; the presentation views in Supabase compute `sum_double / NULLIF(n_double, 0)`.
--
-- MIN AND MAX ARE KEPT because in manufacturing the excursion IS the signal. A temperature spike
-- averaged into a minute is a spike nobody can see afterwards, and a rollup that loses it is not
-- safe to chart in place of raw -- which is the whole purpose of building one.
--
-- val_string AND val_bool ARE CARRIED AS last(), NOT DROPPED. They are state metrics --
-- Controller/EXECUTION is 'ACTIVE', EMERGENCY_STOP is 'ARMED' -- and they are precisely what the
-- Grafana alert rules read. A rollup that covered only val_double would force every state panel
-- and every alert to stay on raw, which is most of the query volume this exists to reduce.
-- `last(value, time)` is the correct summariser for a state: it is what the metric read at the
-- end of the bucket.
--
-- CREATED `WITH NO DATA`, deliberately and not merely because TimescaleDB requires it: filling
-- years of history synchronously during a boot would hold the stack down for as long as it took.
-- The refresh policy backfills in bounded increments instead.
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 minute', time) AS bucket,
       asset_id,
       metric_name,
       sum(val_double)        AS sum_double,
       count(val_double)      AS n_double,
       min(val_double)        AS min_double,
       max(val_double)        AS max_double,
       last(val_double, time) AS last_double,
       last(val_string, time) AS last_string,
       last(val_bool, time)   AS last_bool,
       count(*)               AS n_rows
  FROM telemetry
 GROUP BY bucket, asset_id, metric_name
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_5m
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '5 minutes', bucket) AS bucket,
       asset_id,
       metric_name,
       sum(sum_double)          AS sum_double,
       sum(n_double)            AS n_double,
       min(min_double)          AS min_double,
       max(max_double)          AS max_double,
       last(last_double, bucket) AS last_double,
       last(last_string, bucket) AS last_string,
       last(last_bool, bucket)   AS last_bool,
       sum(n_rows)              AS n_rows
  FROM telemetry_1m
 GROUP BY 1, 2, 3
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1h
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 hour', bucket) AS bucket,
       asset_id,
       metric_name,
       sum(sum_double)          AS sum_double,
       sum(n_double)            AS n_double,
       min(min_double)          AS min_double,
       max(max_double)          AS max_double,
       last(last_double, bucket) AS last_double,
       last(last_string, bucket) AS last_string,
       last(last_bool, bucket)   AS last_bool,
       sum(n_rows)              AS n_rows
  FROM telemetry_5m
 GROUP BY 1, 2, 3
WITH NO DATA;

-- REAL-TIME AGGREGATION ON, so a query sees the CURRENT bucket -- the one the refresh policy has
-- not folded in yet -- by unioning the materialised part with the raw tail. Without this a live
-- dashboard trails the world by up to one schedule_interval and appears to have stopped updating,
-- which is the single most confusing way for a rollup to be wrong.
ALTER MATERIALIZED VIEW telemetry_1m SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW telemetry_5m SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW telemetry_1h SET (timescaledb.materialized_only = false);


-- ---------------------------------------------------------------------------------------------
-- 3. Policies -- refresh and retention, reconciled on every boot.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  disabled CONSTANT text[] := ARRAY['never', 'off', 'disabled', 'none', 'false', '0'];

  -- THE REFRESH WINDOW MUST EXCEED THE LATE-DATA WINDOW. ingestion.py accepts telemetry up to
  -- TELEMETRY_MAX_AGE_SECONDS (24h) old, because a gateway that buffers through an outage and
  -- flushes on reconnect is normal. A start_offset under that would fold late arrivals into
  -- nothing -- they would land in raw and never appear in any rollup, so the two would disagree
  -- and only the rollup would be consulted. 25 hours covers it with an hour to spare.
  --
  -- Cheap despite the width: TimescaleDB refreshes only the buckets its invalidation log marks
  -- as changed, not the whole span, so this is a bound on what MAY be rewritten rather than a
  -- description of what is.
  late_data CONSTANT interval := INTERVAL '25 hours';

  spec     record;
  raw_val  text;
  retain   interval;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('telemetry_1m', INTERVAL '1 minute',  INTERVAL '1 minute',  'factoryplus.rollup_1m_retain'),
      ('telemetry_5m', INTERVAL '5 minutes', INTERVAL '5 minutes', 'factoryplus.rollup_5m_retain'),
      -- The 1h view refreshes on a 5-minute schedule, NOT hourly. Its end_offset still holds back
      -- the incomplete bucket, so this costs little and means a dashboard on the hourly rollup is
      -- never an hour stale.
      ('telemetry_1h', INTERVAL '1 hour',    INTERVAL '5 minutes', 'factoryplus.rollup_1h_retain')
    ) AS t(view_name, bucket_width, schedule, guc)
  LOOP
    raw_val := btrim(coalesce(current_setting(spec.guc, true), ''));
    retain  := NULL;

    IF raw_val <> '' AND NOT (lower(raw_val) = ANY (disabled)) THEN
      BEGIN
        retain := raw_val::interval;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION
          '% is ''%'', which is not a PostgreSQL interval. Use a form like ''180 days'' or '
          '''5 years'', or ''never'' to keep this rollup indefinitely.', spec.guc, raw_val;
      END;
    END IF;

    -- Removed and re-added rather than if_not_exists: with a policy already present at different
    -- arguments, add_* emits a notice and does nothing, so a changed setting would appear to
    -- apply and would not. Same reasoning as retention.sql.
    PERFORM remove_continuous_aggregate_policy(spec.view_name, if_exists => TRUE);
    PERFORM add_continuous_aggregate_policy(
      spec.view_name,
      -- end_offset is ONE FULL BUCKET, so the policy never materialises a bucket that is still
      -- being written to. Real-time aggregation is what serves that bucket to readers meanwhile.
      start_offset      => late_data,
      end_offset        => spec.bucket_width,
      schedule_interval => spec.schedule
    );

    PERFORM remove_retention_policy(spec.view_name, if_exists => TRUE);
    IF retain IS NOT NULL THEN
      PERFORM add_retention_policy(spec.view_name, retain);
      RAISE NOTICE 'rollup %: buckets older than % are dropped', spec.view_name, retain;
    ELSE
      RAISE NOTICE 'rollup %: retained indefinitely', spec.view_name;
    END IF;
  END LOOP;

  -- THE ROLLUPS OUTLIVE THE RAW DATA, and that is the point of setting their retention separately.
  -- retention.sql drops raw chunks (90 days by default); these keep shape, excursions and state
  -- transitions for far longer at a fraction of the size. A question about last spring answered
  -- from telemetry_1h is a question that would otherwise have no answer at all.
  RAISE NOTICE 'telemetry rollups reconciled (1m -> 5m -> 1h, real-time aggregation on).';
END $$;
