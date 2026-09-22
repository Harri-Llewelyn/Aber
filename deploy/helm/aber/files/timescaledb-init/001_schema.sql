-- TimescaleDB Schema Initialization Script
-- Auto-provisioned on container startup via /docker-entrypoint-initdb.d

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Assets table
--
-- asset_id holds the device's immutable Sparkplug B identifier (devices.sparkplug_id in
-- Supabase -- 'dev' + 21 hex characters, derived from that row's UUID primary key). It used
-- to hold the device *name*, which made it impossible to rename a device without orphaning
-- its telemetry: asset_id is this table's primary key and part of the telemetry hypertable's
-- composite key, neither of which can be rewritten cheaply.
--
-- asset_name is a display-only cached copy of the Supabase label. It carries no identity and
-- is refreshed by the ingestion daemon on every birth, so a rename propagates here.
CREATE TABLE IF NOT EXISTS assets (
    asset_id TEXT PRIMARY KEY,
    asset_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Telemetry table
CREATE TABLE IF NOT EXISTS telemetry (
    time TIMESTAMPTZ NOT NULL,
    asset_id TEXT NOT NULL REFERENCES assets(asset_id),
    metric_name TEXT NOT NULL,
    val_double DOUBLE PRECISION,
    val_string TEXT,
    val_bool BOOLEAN,
    PRIMARY KEY (time, asset_id, metric_name)
);

-- Convert telemetry table into a TimescaleDB hypertable partitioned on 'time'
SELECT create_hypertable('telemetry', 'time', if_not_exists => TRUE);

-- Supporting index for querying metric time-series by asset and metric name
CREATE INDEX IF NOT EXISTS idx_telemetry_asset_metric_time ON telemetry (asset_id, metric_name, time DESC);
