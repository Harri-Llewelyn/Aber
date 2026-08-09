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


-- ---------------------------------------------------------------------------------------------
-- 4. telemetry_gapfill() -- carry the last observation forward across buckets nobody reported in.
-- ---------------------------------------------------------------------------------------------
-- WHY A ROLLUP ALONE IS THE WRONG SHAPE FOR REPORT-BY-EXCEPTION DATA. The aggregates above emit a
-- row only for a bucket that CONTAINED a sample. Correct as an aggregate, wrong as a signal: under
-- RBE a metric that has not changed publishes nothing, so a machine running steadily at 42 degC
-- for an hour produces one bucket in sixty. Charted directly the other fifty-nine read as NULL --
-- and a gap in a temperature trace does not mean "unknown", it means "unchanged", which is very
-- nearly the opposite. Grafana draws a broken line through it and a `no data` alert rule reads it
-- as the machine having stopped.
--
-- LOCF CANNOT LIVE IN THE CONTINUOUS AGGREGATE ITSELF. TimescaleDB rejects time_bucket_gapfill()
-- inside a `WITH (timescaledb.continuous)` definition, and rightly: gapfill is defined relative to
-- a query window, and a materialised view has no window to be relative to. Filling belongs at READ
-- time. That is why the absence of locf() in section 2 is not the defect it looks like.
--
-- AND WHY THIS DOES NOT USE time_bucket_gapfill() EITHER, which is the part that is easy to get
-- wrong. That function expands the groups a query already produced; it cannot invent a series that
-- returned NO ROWS AT ALL. A device silent for the whole window has no rows in the window, so it
-- yields no group, so there is nothing to expand and the result comes back EMPTY -- precisely the
-- case gap-filling exists for, and precisely the case a silent RBE device is in. Measured on this
-- database before this function existed: a 3-minute window opening 25 minutes after a device's
-- last change returned zero rows. The grid below is built from the SERIES LIST FIRST and
-- observations are joined onto it, so a series that reported nothing still gets one row per
-- bucket carrying its last known value.
--
-- The LOCF itself is the standard gaps-and-islands form: a running count of non-null values labels
-- each island, and the one real value in an island is broadcast across it. Deliberately plain SQL
-- rather than locf() -- it costs nothing here and keeps the function readable by anyone who does
-- not know the TimescaleDB toolkit.
--
-- SOURCE RESOLUTION FOLLOWS THE BUCKET: the widest rollup no coarser than the bucket asked for,
-- and raw only below one minute. Asking for hourly buckets must not scan raw rows.
--
-- THE SEED IS WHAT MAKES A LONG SILENCE WORK. Under RBE the last change is usually BEFORE the
-- window opens, so without a prior value the leading buckets would still be NULL. Each series gets
-- one `ORDER BY time DESC LIMIT 1` lookup strictly earlier than the window, served directly by
-- idx_telemetry_asset_metric_time, and that value fills everything up to the first real sample.
--
-- `is_carried` DISTINGUISHES A CARRIED VALUE FROM AN OBSERVED ONE, so a caller can render the two
-- differently and an alert rule can refuse to fire on a reading nobody actually took. Filling a
-- gap silently would be its own kind of lie.
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
