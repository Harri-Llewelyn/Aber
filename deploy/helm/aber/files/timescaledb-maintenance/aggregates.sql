-- The telemetry rollups (1m -> 5m -> 1h), telemetry_latest, telemetry_horizons and telemetry_gapfill(),
-- reconciled on every boot. Variables:
--     -v rollup_1m_retain='180 days' -v rollup_5m_retain='1 year' -v rollup_1h_retain='5 years'
-- 'never' (also off, none, disabled) removes a rollup's retention policy without dropping the rollup.
-- The rollups outlive the raw window; Grafana reads this database directly. Reasoning: timescaledb/README.md.
\set ON_ERROR_STOP on

-- The variables cross into PL/pgSQL as GUCs, as retention.sql does.
SELECT set_config('aber.rollup_1m_retain', :'rollup_1m_retain', false);
SELECT set_config('aber.rollup_5m_retain', :'rollup_5m_retain', false);
SELECT set_config('aber.rollup_1h_retain', :'rollup_1h_retain', false);

-- Newest row per (asset, metric), evaluated here so one row per series crosses postgres_fdw rather
-- than a time window. DISTINCT ON is served by idx_telemetry_asset_metric_time.
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

-- SUM and COUNT stored, not AVG: the 5m view is built from the 1m, and avg(avg) is wrong across
-- buckets of unequal size. val_string and val_bool as last(): state metrics the alert rules read.
-- WITH NO DATA so a boot does not backfill synchronously.
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

-- Real-time aggregation: the current bucket is served by unioning the raw tail.
ALTER MATERIALIZED VIEW telemetry_1m SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW telemetry_5m SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW telemetry_1h SET (timescaledb.materialized_only = false);

-- What is there, not what the policy promises. After the rollups it reads: a view over a missing
-- relation fails the Job. Evaluated here for the reason telemetry_latest is; each min() is an index
-- scan per chunk.
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

DO $$
DECLARE
  disabled CONSTANT text[] := ARRAY['never', 'off', 'disabled', 'none', 'false', '0'];

  -- Must exceed ingestion's 24h late-data window, or a late arrival lands in raw and in no rollup.
  -- Cheap: only buckets the invalidation log marks are refreshed.
  late_data CONSTANT interval := INTERVAL '25 hours';

  spec     record;
  raw_val  text;
  retain   interval;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('telemetry_1m', INTERVAL '1 minute',  INTERVAL '1 minute',  'aber.rollup_1m_retain'),
      ('telemetry_5m', INTERVAL '5 minutes', INTERVAL '5 minutes', 'aber.rollup_5m_retain'),
      -- The 1h view refreshes every five minutes, not hourly; end_offset still holds back the open bucket.
      ('telemetry_1h', INTERVAL '1 hour',    INTERVAL '5 minutes', 'aber.rollup_1h_retain')
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

    -- Removed and re-added: add_* with a policy present at different arguments emits a notice and does
    -- nothing.
    PERFORM remove_continuous_aggregate_policy(spec.view_name, if_exists => TRUE);
    PERFORM add_continuous_aggregate_policy(
      spec.view_name,
      start_offset      => late_data,
      -- One full bucket, so a bucket still being written is never materialised.
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

  RAISE NOTICE 'telemetry rollups reconciled (1m -> 5m -> 1h, real-time aggregation on).';
END $$;

-- Carries the last observation forward across buckets nobody reported in: under report-by-exception
-- a gap means unchanged, not unknown. Plain-SQL gaps-and-islands LOCF over a grid built from the
-- series list, because time_bucket_gapfill() cannot invent a series that returned no rows. Source is
-- the widest rollup no coarser than the bucket; each series is seeded from before the window;
-- is_carried marks a bucket nobody reported in.
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

  -- Aligned to the epoch grid time_bucket() uses, so a window opening mid-bucket lines up.
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
    -- telemetry_latest supplies the series silent all window; obs supplies those whose raw history has
    -- aged out but which still have buckets in range.
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
