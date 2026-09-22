-- =============================================================================================
-- Statement statistics on the historian.
-- =============================================================================================
--
-- WHY THE HISTORIAN NEEDS THIS AND THE PLATFORM DATABASE DOES NOT. supabase/postgres preloads
-- `pg_stat_statements` already; the timescale image preloads `timescaledb` alone. So this is the
-- half that had no server-side view of how long a write actually took.
--
-- WHAT IT ANSWERS. `aber_ingestion_write_seconds` measures a telemetry write from the CLIENT and
-- was the instrument that retired horizontal ingestion scaling as an item. It cannot distinguish a
-- slow disk from lock contention from a saturated connection pool, and the single-writer ceiling
-- is argued on exactly that distinction. These are the server-side series that can.
--
-- THE LIBRARY IS LOADED BY THE STATEFULSET, NOT HERE. `shared_preload_libraries` is a postmaster
-- setting and only the server's own command line can set it: the chart appends
-- `pg_stat_statements` beside `timescaledb` under `databaseMetrics.statementStats`. This file
-- creates the SQL-level extension, which is the other half and is not implied by the first.
--
-- FAILS SOFT, DELIBERATELY. If the library is not loaded -- an operator running this file by hand
-- against a server started without it -- creating the extension succeeds and every read of the
-- view then raises. Rather than leave that to be discovered from a dashboard, this checks first
-- and says which half is missing.
--
-- Applied on every boot by the chart's maintenance hook Job, after extension.sql.
-- =============================================================================================

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_setting('shared_preload_libraries', true) IS NULL
     OR current_setting('shared_preload_libraries', true) NOT LIKE '%pg_stat_statements%' THEN
    RAISE NOTICE
      'statistics: pg_stat_statements is NOT in shared_preload_libraries, so the extension would '
      'install and every read of it would raise. Skipping. The library is added by the '
      'StatefulSet under databaseMetrics.statementStats, and that is a postmaster setting -- the '
      'pod has to restart for it to take effect.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN
    CREATE EXTENSION pg_stat_statements;
    RAISE NOTICE 'statistics: created pg_stat_statements';
  END IF;

  -- No GRANT here. The view is world-readable, and WHOSE statements a caller sees is decided by
  -- pg_monitor rather than by a table privilege: without it a role sees only its own. metrics_reader
  -- holds pg_monitor (roles.sql), which is what makes the exporter's view of this complete.
  RAISE NOTICE 'statistics: pg_stat_statements is loaded and installed; % statement(s) tracked.',
    (SELECT count(*) FROM public.pg_stat_statements);
END $$;
