-- Historian counts that must be identical either side of a backup and restore.
--
-- Same contract as snapshot-supabase.sql: `key=value` lines for `psql -tA`, diffed by the
-- rehearsal rather than judged against a threshold.
--
-- CHUNKS ARE COUNTED, and that is not a formality. A restore can bring back every telemetry row
-- into a table that is no longer a hypertable, in which case the row count matches and the chunk
-- count drops to zero -- so this line is the one that moves when the shape is lost rather than the
-- data. assert-timescale.sql then says what it means.

SELECT 'assets='     || count(*) FROM public.assets;
SELECT 'telemetry='  || count(*) FROM public.telemetry;
SELECT 'chunks='     || count(*) FROM timescaledb_information.chunks
 WHERE hypertable_schema = 'public' AND hypertable_name = 'telemetry';
SELECT 'continuous_aggregates=' || count(*) FROM timescaledb_information.continuous_aggregates;
SELECT 'telemetry_1m=' || count(*) FROM public.telemetry_1m;
SELECT 'jobs_retention=' || count(*) FROM timescaledb_information.jobs
 WHERE proc_name = 'policy_retention';
SELECT 'jobs_refresh='   || count(*) FROM timescaledb_information.jobs
 WHERE proc_name = 'policy_refresh_continuous_aggregate';
