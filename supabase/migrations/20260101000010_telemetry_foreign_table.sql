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

-- `postgres` keeps its own mapping for admin/superuser access. A second mapping
-- FOR PUBLIC covers every other local role (authenticated, service_role) with the
-- same TimescaleDB credentials, since the view below runs as security_invoker and
-- each querying role needs its own path through the FDW. `anon` still can't reach
-- any of this -- it has no SELECT on the view or the foreign table.
CREATE USER MAPPING FOR postgres
  SERVER timescaledb_server
  OPTIONS (user :'ts_user', password :'ts_password');

CREATE USER MAPPING FOR PUBLIC
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

GRANT USAGE ON SCHEMA timescale TO authenticated, service_role;
GRANT SELECT ON timescale.telemetry TO authenticated, service_role;

-- Read-only projection for PostgREST. `telemetry.asset_id` holds the device's immutable
-- Sparkplug B identifier -- `devices.sparkplug_id` (see migration 0014 and ingestion.py).
-- The UI derives that value from the device UUID it already holds rather than looking the
-- device up, since sparkplug_id is a pure function of the primary key.
--
-- security_invoker = true so the view runs with the querying role's own privileges
-- (per the GRANTs above) rather than the view owner's -- avoids the Supabase
-- "Security Definer View" advisor finding while keeping the same effective access
-- every authenticated user already had (all authenticated users see all telemetry).
CREATE OR REPLACE VIEW public.telemetry
WITH (security_invoker = true) AS
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
