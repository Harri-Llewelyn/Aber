-- =============================================================================================
-- Migration: 0138_raw_telemetry_has_a_stated_window.sql (applied as 0005 until the 1.0 squash)
-- The Cold Storage page reads how long raw telemetry is kept (#401)
-- =============================================================================================
--
-- The window lives on the historian, in `telemetry_raw_window` (timescaledb/retention.sql), beside
-- whether the cold archiver last reported archiving on. This maps it over the FDW and gives the
-- page one function to read it through.
--
-- 0001 drops the FDW server with CASCADE on every boot, so the foreign table is recreated here
-- each time; check-schema-surface.mjs selects it.
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

CREATE FOREIGN TABLE IF NOT EXISTS timescale.telemetry_raw_window (
    raw_window          interval,
    archive_armed       boolean,
    archive_reported_at timestamp with time zone
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'telemetry_raw_window'
);

ALTER FOREIGN TABLE timescale.telemetry_raw_window OWNER TO postgres;
REVOKE ALL ON TABLE timescale.telemetry_raw_window FROM PUBLIC, anon, authenticated;

-- ONE ROW OR NONE. No row means "not known" (the historian is unreachable, or has not run
-- retention.sql yet), which the page must not render as a window. The same roles as
-- cold_archive_backlog().
CREATE OR REPLACE FUNCTION public.raw_telemetry_window()
RETURNS TABLE(raw_window_seconds numeric, archive_armed boolean, archive_reported_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor']) THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT EXTRACT(EPOCH FROM w.raw_window)::numeric, w.archive_armed, w.archive_reported_at
      FROM timescale.telemetry_raw_window w;
EXCEPTION
    -- postgres_fdw raises on CONNECT, so an unreachable historian arrives here.
    WHEN OTHERS THEN
        RETURN;
END;
$$;

ALTER FUNCTION public.raw_telemetry_window() OWNER TO postgres;

COMMENT ON FUNCTION public.raw_telemetry_window() IS
  'How long raw telemetry is kept (NULL seconds = indefinitely) and whether the cold archiver last '
  'reported archiving on. No row when the historian cannot be read.';

-- Revoked from anon BY NAME. The image's default privileges hand anon EXECUTE on every new
-- function; 0001's revoke_anon_function_privileges() sweep would withdraw it, but re-running that
-- sweep here also takes auth_pre_request() from anon, which 0001 re-grants only after its own
-- sweep, and every anonymous request then fails (PostgREST's probe with it).
REVOKE ALL ON FUNCTION public.raw_telemetry_window() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raw_telemetry_window() TO authenticated;
GRANT EXECUTE ON FUNCTION public.raw_telemetry_window() TO service_role;
