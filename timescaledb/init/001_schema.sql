-- TimescaleDB Schema Initialization Script
-- Auto-provisioned on container startup via /docker-entrypoint-initdb.d

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Assets table
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
