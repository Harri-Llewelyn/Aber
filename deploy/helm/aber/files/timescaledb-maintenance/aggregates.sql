-- =============================================================================================
-- Telemetry rollups and the latest-value view.
--
-- Applied on every boot by the chart's maintenance hook Job.
-- It takes three psql variables:
--
--     -v rollup_1m_retain='180 days' -v rollup_5m_retain='1 year' -v rollup_1h_retain='5 years'
--
-- `never` (also `off`, `none`, `disabled`) removes a policy without dropping the rollup. Not in
-- timescaledb/init/, for the reason retention.sql is not: initdb scripts never reach an existing
-- database.
--
-- `public.telemetry` in Supabase is a postgres_fdw projection, and the wrapper pushes WHERE down
-- but not LIMIT. The rollups serve trend queries (Grafana reads this database directly and never
-- crosses the FDW); `telemetry_latest` serves latest-value lookups. The CSV export reads raw by
-- default -- it is an export of observations -- but may be asked for a rollup instead, which is
-- the only way to export a period the raw retention window has already dropped (issue #160);
-- `telemetry_horizons` is how it knows which resolutions still cover a range.
-- =============================================================================================

\set ON_ERROR_STOP on

-- Same GUC indirection retention.sql uses: psql interpolates `:'var'` while lexing and does not
-- descend into dollar-quoted strings, so these cannot be read directly inside the DO block below.
SELECT set_config('acs_cymru.rollup_1m_retain', :'rollup_1m_retain', false);
SELECT set_config('acs_cymru.rollup_5m_retain', :'rollup_5m_retain', false);
SELECT set_config('acs_cymru.rollup_1h_retain', :'rollup_1h_retain', false);

-- ---------------------------------------------------------------------------------------------
-- 1. telemetry_latest -- one row per (asset, metric), evaluated remotely.
-- ---------------------------------------------------------------------------------------------
-- A view on this side is evaluated here, so Supabase receives one row per metric instead of a
-- day of rows to discard. `DISTINCT ON` is served by idx_telemetry_asset_metric_time, so the
-- fleet-wide case is bounded by series count rather than time window. A plain view, not a
-- continuous aggregate: "the newest row" is not an aggregate over a bucket.
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
-- SUM and COUNT are stored, not AVG: the 5m view is built from the 1m view, and avg(avg) is
-- wrong when buckets hold different numbers of samples; the presentation views compute
-- `sum_double / NULLIF(n_double, 0)`. MIN and MAX are kept because the excursion is the signal.
-- val_string and val_bool are carried as last(): they are state metrics the alert rules read.
-- Created WITH NO DATA so a boot does not backfill years synchronously; the refresh policy
-- backfills in bounded increments.
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

-- Real-time aggregation on, so a query sees the current bucket by unioning the materialised
-- part with the raw tail; without it a live dashboard trails by up to one schedule_interval.
ALTER MATERIALIZED VIEW telemetry_1m SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW telemetry_5m SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW telemetry_1h SET (timescaledb.materialized_only = false);

-- ---------------------------------------------------------------------------------------------
-- 2b. telemetry_horizons -- how far back each resolution actually reaches.
-- ---------------------------------------------------------------------------------------------
-- WHAT IS THERE, NOT WHAT THE POLICY PROMISES. retention.sql and the policies below say what will
-- eventually be dropped; they say nothing about a stack installed three weeks ago, which holds
-- three weeks of raw whatever `retain_after` is set to. A reader deciding "will this range come
-- back empty?" needs the first, and only the database can answer it.
--
-- AFTER THE ROLLUPS, WHICH IT READS. On a fresh historian they do not exist until section 2 has
-- run, and a view over a missing relation fails the whole maintenance Job (docs/incidents.md,
-- "The horizons view was created before the rollups it reads").
--
-- EVALUATED HERE, FOR THE REASON telemetry_latest IS. Four rows cross postgres_fdw instead of the
-- scan that answering this on the Supabase side would need -- and the wrapper pushes WHERE down
-- but not LIMIT, so `ORDER BY time LIMIT 1` over the projection is not an alternative.
--
-- Each min() is an index scan per chunk (MergeAppend over the per-chunk time indexes), not a
-- table scan, so the cost is the chunk count rather than the row count.
CREATE OR REPLACE VIEW telemetry_horizons AS
SELECT 'telemetry'::text    AS relation, (SELECT min(time)   FROM telemetry)    AS oldest
UNION ALL
SELECT 'telemetry_1m'::text AS relation, (SELECT min(bucket) FROM telemetry_1m) AS oldest
UNION ALL
SELECT 'telemetry_5m'::text AS relation, (SELECT min(bucket) FROM telemetry_5m) AS oldest
UNION ALL
SELECT 'telemetry_1h'::text AS relation, (SELECT min(bucket) FROM telemetry_1h) AS oldest;

COMMENT ON VIEW telemetry_horizons IS
  'Oldest timestamp held by each telemetry resolution -- the raw hypertable and the three rollups. '
  'A NULL oldest means the relation is empty, which is not the same as a resolution that does not '
  'exist. Evaluated on this server so four rows cross postgres_fdw rather than a scan.';

-- ---------------------------------------------------------------------------------------------
-- 3. Policies -- refresh and retention, reconciled on every boot.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  disabled CONSTANT text[] := ARRAY['never', 'off', 'disabled', 'none', 'false', '0'];

  -- The refresh window must exceed the late-data window: ingestion.py accepts telemetry up to
  -- TELEMETRY_MAX_AGE_SECONDS (24h) old, and a smaller start_offset would leave late arrivals in
  -- raw and in no rollup. Cheap despite the width: TimescaleDB refreshes only the buckets its
  -- invalidation log marks as changed.
  late_data CONSTANT interval := INTERVAL '25 hours';

  spec     record;
  raw_val  text;
  retain   interval;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('telemetry_1m', INTERVAL '1 minute',  INTERVAL '1 minute',  'acs_cymru.rollup_1m_retain'),
      ('telemetry_5m', INTERVAL '5 minutes', INTERVAL '5 minutes', 'acs_cymru.rollup_5m_retain'),
      -- The 1h view refreshes on a 5-minute schedule, NOT hourly. Its end_offset still holds back
      -- the incomplete bucket, so this costs little and means a dashboard on the hourly rollup is
      -- never an hour stale.
      ('telemetry_1h', INTERVAL '1 hour',    INTERVAL '5 minutes', 'acs_cymru.rollup_1h_retain')
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

  -- The rollups outlive the raw data: retention.sql drops raw chunks (90 days by default), and
  -- these keep shape, excursions and state transitions far longer at a fraction of the size.
  RAISE NOTICE 'telemetry rollups reconciled (1m -> 5m -> 1h, real-time aggregation on).';
END $$;

-- ---------------------------------------------------------------------------------------------
-- 4. telemetry_gapfill() -- carry the last observation forward across buckets nobody reported in.
-- ---------------------------------------------------------------------------------------------
-- Under report-by-exception a metric that has not changed publishes nothing, so the aggregates
-- above emit one bucket in sixty for a steady machine, and a gap means "unchanged", not
-- "unknown". LOCF cannot live in the continuous aggregate (TimescaleDB rejects gapfill inside a
-- continuous definition; filling is relative to a query window). Nor does this use
-- time_bucket_gapfill(): that expands groups a query already produced and cannot invent a series
-- that returned no rows, which is exactly the case of a silent RBE device. The grid is built
-- from the series list first and observations are joined onto it.
--
-- The LOCF is the standard gaps-and-islands form in plain SQL. Source resolution follows the
-- bucket: the widest rollup no coarser than the bucket asked for, and raw only below one minute.
-- Each series is seeded with one lookup strictly earlier than the window, so a long silence
-- still fills. `is_carried` distinguishes a carried value from an observed one, so an alert rule
-- can refuse to fire on a reading nobody took.
CREATE OR REPLACE FUNCTION telemetry_gapfill(
    from_ts      TIMESTAMPTZ,
    to_ts        TIMESTAMPTZ,
    bucket       INTERVAL,
    asset_ids    TEXT[] DEFAULT NULL,
    metric_names TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    bucket_ts   TIMESTAMPTZ,
    asset_id    TEXT,
    metric_name TEXT,
    val_double  DOUBLE PRECISION,
    val_string  TEXT,
    val_bool    BOOLEAN,
    is_carried  BOOLEAN
)
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  source  text;
  tcol    text;
  dcol    text;
  scol    text;
  bcol    text;
  secs    double precision;
  aligned timestamptz;
BEGIN
  secs := extract(epoch FROM bucket);

  IF to_ts <= from_ts THEN
    RAISE EXCEPTION 'telemetry_gapfill: to_ts (%) must be after from_ts (%)', to_ts, from_ts;
  END IF;
  IF secs IS NULL OR secs <= 0 THEN
    RAISE EXCEPTION 'telemetry_gapfill: bucket must be a positive interval, got %', bucket;
  END IF;

  IF    bucket >= INTERVAL '1 hour'    THEN source := 'telemetry_1h';
  ELSIF bucket >= INTERVAL '5 minutes' THEN source := 'telemetry_5m';
  ELSIF bucket >= INTERVAL '1 minute'  THEN source := 'telemetry_1m';
  ELSE                                      source := 'telemetry';
  END IF;

  IF source = 'telemetry' THEN
    tcol := 'time';   dcol := 'val_double';  scol := 'val_string';  bcol := 'val_bool';
  ELSE
    tcol := 'bucket'; dcol := 'last_double'; scol := 'last_string'; bcol := 'last_bool';
  END IF;

  -- Buckets are aligned to the epoch, the same grid time_bucket() uses, so a window that opens
  -- mid-bucket still lines up with the rollup it is reading from.
  aligned := to_timestamp(floor(extract(epoch FROM from_ts) / secs) * secs);

  RETURN QUERY EXECUTE format($q$
    WITH obs AS (
      SELECT to_timestamp(floor(extract(epoch FROM o.%1$I) / $6) * $6) AS b,
             o.asset_id    AS aid,
             o.metric_name AS mname,
             (array_agg(o.%2$I ORDER BY o.%1$I DESC) FILTER (WHERE o.%2$I IS NOT NULL))[1] AS d,
             (array_agg(o.%3$I ORDER BY o.%1$I DESC) FILTER (WHERE o.%3$I IS NOT NULL))[1] AS s,
             (array_agg(o.%4$I ORDER BY o.%1$I DESC) FILTER (WHERE o.%4$I IS NOT NULL))[1] AS bo
        FROM %5$I o
       WHERE o.%1$I >= $1 AND o.%1$I < $2
         AND ($3::text[] IS NULL OR o.asset_id    = ANY ($3::text[]))
         AND ($4::text[] IS NULL OR o.metric_name = ANY ($4::text[]))
       GROUP BY 1, 2, 3
    ),
    -- The series list. `telemetry_latest` contributes the ones SILENT throughout the window --
    -- the whole point of this function -- and `obs` contributes any whose raw history has since
    -- been aged out by the retention policy but which still have rollup buckets in range.
    series AS (
      SELECT l.asset_id AS aid, l.metric_name AS mname
        FROM telemetry_latest l
       WHERE ($3::text[] IS NULL OR l.asset_id    = ANY ($3::text[]))
         AND ($4::text[] IS NULL OR l.metric_name = ANY ($4::text[]))
       UNION
      SELECT obs.aid, obs.mname FROM obs
    ),
    grid AS (
      SELECT series.aid, series.mname, g.b
        FROM series
        CROSS JOIN generate_series($5, $2, $7::interval) AS g(b)
       WHERE g.b < $2
    ),
    seed AS (
      SELECT series.aid, series.mname,
             (SELECT t.val_double FROM telemetry t
               WHERE t.asset_id = series.aid AND t.metric_name = series.mname
                 AND t.time < $1 AND t.val_double IS NOT NULL
               ORDER BY t.time DESC LIMIT 1) AS d,
             (SELECT t.val_string FROM telemetry t
               WHERE t.asset_id = series.aid AND t.metric_name = series.mname
                 AND t.time < $1 AND t.val_string IS NOT NULL
               ORDER BY t.time DESC LIMIT 1) AS s,
             (SELECT t.val_bool FROM telemetry t
               WHERE t.asset_id = series.aid AND t.metric_name = series.mname
                 AND t.time < $1 AND t.val_bool IS NOT NULL
               ORDER BY t.time DESC LIMIT 1) AS bo
        FROM series
    ),
    joined AS (
      SELECT grid.b, grid.aid, grid.mname, obs.d, obs.s, obs.bo, (obs.b IS NULL) AS empty_bucket
        FROM grid
        LEFT JOIN obs ON obs.aid = grid.aid AND obs.mname = grid.mname AND obs.b = grid.b
    ),
    islands AS (
      SELECT j.*,
             count(j.d)  OVER w AS grp_d,
             count(j.s)  OVER w AS grp_s,
             count(j.bo) OVER w AS grp_bo
        FROM joined j
      WINDOW w AS (PARTITION BY j.aid, j.mname ORDER BY j.b ROWS UNBOUNDED PRECEDING)
    ),
    filled AS (
      SELECT i.b, i.aid, i.mname, i.empty_bucket,
             max(i.d)      OVER (PARTITION BY i.aid, i.mname, i.grp_d)  AS d,
             max(i.s)      OVER (PARTITION BY i.aid, i.mname, i.grp_s)  AS s,
             bool_or(i.bo) OVER (PARTITION BY i.aid, i.mname, i.grp_bo) AS bo
        FROM islands i
    )
    SELECT f.b, f.aid, f.mname,
           coalesce(f.d,  sd.d),
           coalesce(f.s,  sd.s),
           coalesce(f.bo, sd.bo),
           f.empty_bucket
      FROM filled f
      JOIN seed sd ON sd.aid = f.aid AND sd.mname = f.mname
     ORDER BY f.aid, f.mname, f.b
  $q$, tcol, dcol, scol, bcol, source)
  USING from_ts, to_ts, asset_ids, metric_names, aligned, secs, bucket;
END;
$fn$;

COMMENT ON FUNCTION telemetry_gapfill(TIMESTAMPTZ, TIMESTAMPTZ, INTERVAL, TEXT[], TEXT[]) IS
  'Bucketed telemetry with every bucket present, empty ones carrying the last observation forward '
  'and seeded from the newest sample before the window. is_carried marks a bucket nobody reported '
  'in. Resolution selects the widest rollup no coarser than the bucket. This is what a report-by-'
  'exception series must be read through: an unchanged metric publishes nothing, so a missing '
  'bucket means unchanged, not unknown.';
