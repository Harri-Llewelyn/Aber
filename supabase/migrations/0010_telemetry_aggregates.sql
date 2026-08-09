-- =============================================================================================
-- 0010 — Expose the telemetry rollups and the latest-value view through PostgREST.
--
-- The objects themselves live in the standalone TimescaleDB and are created by
-- `timescaledb/aggregates.sql`, reconciled there on every boot. This migration only MAPS them:
-- foreign tables in `timescale`, presentation views in `public`.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS EXISTS. `public.telemetry` is a postgres_fdw projection, and the wrapper pushes WHERE
-- down but NOT LIMIT. Two different problems live under that one sentence and they need different
-- answers:
--
--   * TREND queries over a long window genuinely need less data -> the rollups.
--   * LATEST-VALUE lookups need one row per series, not a window at all -> telemetry_latest.
--
-- The second was the expensive one in practice. The device drawer fetched TWENTY-FOUR HOURS of
-- rows for one device to keep the newest of each metric, and a rollup does not help with that:
-- averaging a day of buckets is still shipping a day of buckets. `telemetry_latest` is a view on
-- the REMOTE side, so `DISTINCT ON` runs there against
-- idx_telemetry_asset_metric_time and only the answer crosses the wrapper. Verified on a live
-- database: the plan is `Custom Scan (SkipScan)` over that index, so the cost is bounded by SERIES
-- COUNT and does not grow as history does.
--
-- ORDERING. `0001` recreates the FDW server on every boot with `DROP SERVER ... CASCADE`, which
-- takes every foreign table in `timescale` with it -- including these. That is why this file
-- recreates rather than assumes, and why it must sort after 0001. The remote objects must also
-- exist BEFORE this runs, so the maintenance Job/service is ordered ahead of db-init on both
-- targets; the self-check at the end is what would catch that ordering being broken.
--
-- RAW STAYS RAW FOR THE EXPORT. `public.telemetry` is unchanged and the CSV export still reads it.
-- An export is a record of observations, and handing an operator bucket averages under a column
-- header that says "value" would be inventing readings no instrument produced.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. Foreign tables.
--
-- Column types must match what the remote actually returns or the failure is a runtime error in
-- the dashboard, not here: count() is BIGINT, the sums and extrema are DOUBLE PRECISION.
-- ---------------------------------------------------------------------------------------------
DROP FOREIGN TABLE IF EXISTS timescale.telemetry_latest CASCADE;
CREATE FOREIGN TABLE timescale.telemetry_latest (
    "time"      TIMESTAMPTZ      NOT NULL,
    asset_id    TEXT             NOT NULL,
    metric_name TEXT             NOT NULL,
    val_double  DOUBLE PRECISION,
    val_string  TEXT,
    val_bool    BOOLEAN
)
SERVER timescaledb_server
OPTIONS (schema_name 'public', table_name 'telemetry_latest');

DROP FOREIGN TABLE IF EXISTS timescale.telemetry_1m CASCADE;
CREATE FOREIGN TABLE timescale.telemetry_1m (
    bucket      TIMESTAMPTZ      NOT NULL,
    asset_id    TEXT             NOT NULL,
    metric_name TEXT             NOT NULL,
    sum_double  DOUBLE PRECISION,
    n_double    BIGINT,
    min_double  DOUBLE PRECISION,
    max_double  DOUBLE PRECISION,
    last_double DOUBLE PRECISION,
    last_string TEXT,
    last_bool   BOOLEAN,
    n_rows      BIGINT
)
SERVER timescaledb_server
OPTIONS (schema_name 'public', table_name 'telemetry_1m');

DROP FOREIGN TABLE IF EXISTS timescale.telemetry_5m CASCADE;
CREATE FOREIGN TABLE timescale.telemetry_5m (
    bucket      TIMESTAMPTZ      NOT NULL,
    asset_id    TEXT             NOT NULL,
    metric_name TEXT             NOT NULL,
    sum_double  DOUBLE PRECISION,
    n_double    BIGINT,
    min_double  DOUBLE PRECISION,
    max_double  DOUBLE PRECISION,
    last_double DOUBLE PRECISION,
    last_string TEXT,
    last_bool   BOOLEAN,
    n_rows      BIGINT
)
SERVER timescaledb_server
OPTIONS (schema_name 'public', table_name 'telemetry_5m');

DROP FOREIGN TABLE IF EXISTS timescale.telemetry_1h CASCADE;
CREATE FOREIGN TABLE timescale.telemetry_1h (
    bucket      TIMESTAMPTZ      NOT NULL,
    asset_id    TEXT             NOT NULL,
    metric_name TEXT             NOT NULL,
    sum_double  DOUBLE PRECISION,
    n_double    BIGINT,
    min_double  DOUBLE PRECISION,
    max_double  DOUBLE PRECISION,
    last_double DOUBLE PRECISION,
    last_string TEXT,
    last_bool   BOOLEAN,
    n_rows      BIGINT
)
SERVER timescaledb_server
OPTIONS (schema_name 'public', table_name 'telemetry_1h');

GRANT SELECT ON timescale.telemetry_latest, timescale.telemetry_1m,
                timescale.telemetry_5m,     timescale.telemetry_1h
  TO authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- 2. Presentation views.
--
-- `security_invoker` for the same reason public.telemetry uses it: each querying role goes through
-- the FDW as itself, and `anon` reaches none of this -- it holds SELECT on neither the views nor
-- the foreign tables.
--
-- THE AVERAGE IS COMPUTED HERE, NOT STORED. The rollups keep `sum` and `count` because the 5m and
-- 1h views are built FROM the 1m view, and avg(avg) is wrong whenever the buckets being combined
-- hold different numbers of samples -- a minute with two readings would weigh as heavily as a
-- minute with two hundred. Dividing at read time cannot get that wrong. `NULLIF` keeps a bucket
-- that contained only string or boolean metrics as NULL rather than a division error.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.telemetry_latest WITH (security_invoker='true') AS
 SELECT t."time", t.asset_id, t.metric_name, t.val_double, t.val_string, t.val_bool
   FROM timescale.telemetry_latest t;

COMMENT ON VIEW public.telemetry_latest IS
  'Newest sample per (asset_id, metric_name), evaluated on the TimescaleDB side so postgres_fdw '
  'ships one row per series instead of a time window. Filter with asset_id. This is what the '
  'dashboard''s latest-value routes read; public.telemetry remains the raw record for exports.';

CREATE OR REPLACE VIEW public.telemetry_1m WITH (security_invoker='true') AS
 SELECT t.bucket, t.asset_id, t.metric_name,
        t.sum_double / NULLIF(t.n_double, 0) AS avg_double,
        t.min_double, t.max_double, t.last_double, t.last_string, t.last_bool,
        t.n_double, t.n_rows
   FROM timescale.telemetry_1m t;

CREATE OR REPLACE VIEW public.telemetry_5m WITH (security_invoker='true') AS
 SELECT t.bucket, t.asset_id, t.metric_name,
        t.sum_double / NULLIF(t.n_double, 0) AS avg_double,
        t.min_double, t.max_double, t.last_double, t.last_string, t.last_bool,
        t.n_double, t.n_rows
   FROM timescale.telemetry_5m t;

CREATE OR REPLACE VIEW public.telemetry_1h WITH (security_invoker='true') AS
 SELECT t.bucket, t.asset_id, t.metric_name,
        t.sum_double / NULLIF(t.n_double, 0) AS avg_double,
        t.min_double, t.max_double, t.last_double, t.last_string, t.last_bool,
        t.n_double, t.n_rows
   FROM timescale.telemetry_1h t;

COMMENT ON VIEW public.telemetry_1m IS
  'One-minute rollup of the telemetry hypertable. avg_double is derived from the stored sum and '
  'count; min/max are preserved because an average hides the excursion. last_string/last_bool '
  'carry state metrics, which cannot be averaged. Filter with bucket / asset_id / metric_name.';
COMMENT ON VIEW public.telemetry_5m IS 'Five-minute rollup, aggregated from telemetry_1m. See telemetry_1m.';
COMMENT ON VIEW public.telemetry_1h IS
  'Hourly rollup, aggregated from telemetry_5m. Retained far longer than the raw hypertable, so '
  'it answers questions about periods the raw retention window has already dropped.';

GRANT SELECT ON public.telemetry_latest, public.telemetry_1m,
                public.telemetry_5m,     public.telemetry_1h
  TO authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- 3. Self-check: the mapping RESOLVES, not merely that the statements ran.
--
-- Creating a foreign table validates nothing -- postgres_fdw is lazy, so a mapping onto an object
-- that does not exist on the remote, or one whose column types disagree, is created perfectly and
-- fails at the first SELECT. Which would be in the dashboard, as an opaque PostgREST error.
--
-- `LIMIT 1` keeps this to one round trip per relation on a database of any size. It fires when
-- aggregates.sql has not run against this TimescaleDB -- most likely because the maintenance
-- Job/service was reordered after db-init -- and says so.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  rel text;
BEGIN
  FOREACH rel IN ARRAY ARRAY['telemetry_latest', 'telemetry_1m', 'telemetry_5m', 'telemetry_1h'] LOOP
    BEGIN
      EXECUTE format('SELECT 1 FROM public.%I LIMIT 1', rel);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION
        '0010 self-check FAILED: public.% is mapped but not readable (%). The remote objects are '
        'created by timescaledb/aggregates.sql, which the timescaledb-maintenance service (Compose) '
        'or hook Job (Helm) applies BEFORE db-init. Check that it ran and succeeded.',
        rel, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE '0010 self-check passed: the rollup and latest-value mappings resolve over the FDW.';
END $$;
