-- Migration: 20260101000022_realtime_schema_bootstrap.sql
-- Description: Create the `_realtime` schema the supabase/realtime container stores its
--              own Ecto state in (tenants, extensions, schema_migrations).
--
-- Why this is a migration and not container configuration:
--   The realtime service boots with DB_AFTER_CONNECT_QUERY = 'SET search_path TO _realtime'
--   and immediately runs its Ecto migrations. If the schema does not exist, search_path
--   resolves to nothing and the very first DDL fails with
--       (Postgrex.Error) ERROR 3F000 (invalid_schema_name)
--       no schema has been selected to create in
--   which crash-loops the container. Realtime creates its *tables* but not the schema
--   that holds them, so something has to exist first.
--
--   The official self-hosted Supabase stack ships this as a `realtime.sql` bootstrap file
--   baked into the database image. This stack applies migrations from ./supabase/migrations
--   instead (supabase-db-init), so it belongs here -- otherwise a fresh `docker compose
--   up -d` on a clean volume would come up with a permanently restarting realtime service.
--
-- Note the leading underscore: `_realtime` (the service's private state) is a different
-- schema from `realtime` (the API surface, already present in the supabase/postgres image).

CREATE SCHEMA IF NOT EXISTS _realtime;

-- The container connects as supabase_admin, which is superuser+replication in this
-- image and can therefore create its Ecto tables inside a postgres-owned schema.
--
-- Ownership is deliberately NOT reassigned. supabase-db-init runs every migration with
-- ON_ERROR_STOP=1 as `postgres`, and `postgres` is not a member of `supabase_admin`, so
-- ALTER SCHEMA ... OWNER TO supabase_admin aborts with "must be member of role" and takes
-- the whole database init down with it. The GRANT below is sufficient and does not
-- require role membership.
GRANT ALL ON SCHEMA _realtime TO supabase_admin;

-- Deliberately NOT granted to anon/authenticated, and deliberately not added to
-- PGRST_DB_SCHEMAS: this is the service's private state (including tenant rows that
-- carry the encrypted JWT secret), never a PostgREST-routable API surface.
REVOKE ALL ON SCHEMA _realtime FROM PUBLIC;
