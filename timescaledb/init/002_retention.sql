-- TimescaleDB Retention & Compression Policies
-- Auto-provisioned on container startup via /docker-entrypoint-initdb.d (after 001_schema.sql)
--
-- WHY THIS IS NOT pg_cron
--
-- Telemetry lives in this standalone TimescaleDB container, not in Supabase. pg_cron runs
-- inside the Supabase database and reaches this one only through the postgres_fdw link
-- (Supabase migration 0010), which exists to serve read queries to PostgREST -- driving
-- destructive maintenance across it would be both slower and far easier to get wrong.
-- TimescaleDB has its own background job scheduler for exactly this, so the policies belong
-- here, next to the hypertable they act on.

-- Compression -------------------------------------------------------------------------------
-- Chunks must be told how to compress before a policy can be attached.
--   segmentby: rows for one asset/metric series compress together and stay individually
--              retrievable, which matches how the dashboard queries (asset_id + metric_name,
--              see queryTelemetry in frontend/src/api.js).
--   orderby:   time DESC matches both the query order and the supporting index.
ALTER TABLE telemetry SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'asset_id, metric_name',
    timescaledb.compress_orderby   = 'time DESC'
);

-- Compress chunks older than 7 days. Recent data -- everything the dashboard's time-window
-- filters and Grafana's live panels actually read -- stays uncompressed and fast.
--
-- NOTE: compressed chunks are effectively read-only. Late-arriving telemetry older than 7
-- days will be rejected rather than inserted. Sparkplug B timestamps come from the edge, so
-- a badly clock-skewed device is the realistic way to hit this; ingestion logs the write
-- failure rather than losing it silently.
SELECT add_compression_policy('telemetry', INTERVAL '7 days', if_not_exists => TRUE);

-- Retention ---------------------------------------------------------------------------------
-- Drop chunks older than 90 days. This is a hard delete of raw telemetry and there is no
-- undo: TimescaleDB drops whole chunks rather than deleting rows.
--
-- 90 days is a starting point, not a considered compliance decision. If telemetry here is
-- ever subject to a retention requirement, this interval is the single place to change it --
-- and it should be reviewed before this stack carries production data.
SELECT add_retention_policy('telemetry', INTERVAL '90 days', if_not_exists => TRUE);

-- The `assets` dimension table is deliberately NOT covered. It is small, holds one row per
-- device, and telemetry.asset_id references it -- dropping an asset row would orphan history
-- that has not yet aged out.
