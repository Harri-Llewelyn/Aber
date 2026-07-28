-- Migration: 20260101000010_telemetry_foreign_table.sql
-- Description: Expose the standalone TimescaleDB `telemetry` hypertable to PostgREST
--              through a postgres_fdw foreign table, so the dashboard can read real
--              telemetry instead of client-side placeholder rows.
--
-- Why a foreign table: TimescaleDB is a separate container on its own port and is not
-- reachable from the browser -- only Kong (Auth / PostgREST / Edge Functions) is. The
-- FDW keeps TimescaleDB authoritative for time-series storage while giving the SPA a
-- normal PostgREST collection to query (`/rest/v1/telemetry`).
--
-- Credentials: supabase-db-init passes the TimescaleDB connection settings through
-- `psql -v`. The defaults below match docker-compose.yml, so this file is still
-- runnable standalone.

\if :{?ts_host}
\else
\set ts_host 'timescaledb'
\endif
\if :{?ts_port}
\else
\set ts_port '5432'
\endif
\if :{?ts_dbname}
\else
\set ts_dbname 'postgres'
\endif
\if :{?ts_user}
\else
\set ts_user 'postgres'
\endif
\if :{?ts_password}
\else
\set ts_password 'postgres'
\endif

CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- Foreign objects live in their own schema, kept out of PGRST_DB_SCHEMAS so the raw
-- foreign table is never routable; only the public view below is exposed.
CREATE SCHEMA IF NOT EXISTS timescale;

-- Recreated on every run so connection settings and column definitions stay in sync
-- with docker-compose.yml and timescaledb/init/001_schema.sql.
DROP SERVER IF EXISTS timescaledb_server CASCADE;

CREATE SERVER timescaledb_server
  FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host :'ts_host', port :'ts_port', dbname :'ts_dbname');

-- Only the table owner ever connects through the FDW; PostgREST's `authenticated`
-- role reaches the data through the view, which runs with the owner's rights.
CREATE USER MAPPING FOR postgres
  SERVER timescaledb_server
  OPTIONS (user :'ts_user', password :'ts_password');

CREATE FOREIGN TABLE timescale.telemetry (
    "time"      TIMESTAMPTZ      NOT NULL,
    asset_id    TEXT             NOT NULL,
    metric_name TEXT             NOT NULL,
    val_double  DOUBLE PRECISION,
    val_string  TEXT,
    val_bool    BOOLEAN
)
SERVER timescaledb_server
OPTIONS (schema_name 'public', table_name 'telemetry');

-- Read-only projection for PostgREST. `telemetry.asset_id` holds the Sparkplug B
-- device name (see ingestion.py), which is what the UI filters on.
CREATE OR REPLACE VIEW public.telemetry AS
SELECT "time", asset_id, metric_name, val_double, val_string, val_bool
FROM timescale.telemetry;

ALTER VIEW public.telemetry OWNER TO postgres;

-- Views do not carry RLS; access is granted at the role level instead. SELECT is
-- granted to `authenticated` only -- `anon` gets nothing, matching the fail-closed
-- posture of the RLS policies on the metadata tables.
REVOKE ALL ON public.telemetry FROM PUBLIC, anon;
GRANT SELECT ON public.telemetry TO authenticated, service_role;

COMMENT ON VIEW public.telemetry IS
  'Read-only PostgREST projection of the standalone TimescaleDB telemetry hypertable, '
  'reached over postgres_fdw. Filter with asset_id / metric_name / time and always pass '
  'a limit -- postgres_fdw pushes WHERE clauses to the remote but not LIMIT, so an '
  'unbounded query materialises the whole matching range locally.';

NOTIFY pgrst, 'reload schema';
