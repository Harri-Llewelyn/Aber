-- pg_stat_statements on the historian, applied after extension.sql when databaseMetrics.statementStats
-- is on. The StatefulSet preloads the library; this creates the SQL-level extension, which the first
-- does not imply. Fails soft when the library is absent, saying which half is missing, because the
-- extension would install and every read of the view would then raise. Reasoning: timescaledb/README.md.
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

  -- No GRANT: the view is world-readable, and whose statements a caller sees is decided by
  -- pg_monitor (roles.sql), not by a table privilege.
  RAISE NOTICE 'statistics: pg_stat_statements is loaded and installed; % statement(s) tracked.',
    (SELECT count(*) FROM public.pg_stat_statements);
END $$;
