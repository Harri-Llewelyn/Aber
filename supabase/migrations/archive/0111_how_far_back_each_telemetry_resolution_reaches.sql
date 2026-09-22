-- 0111: how far back each telemetry resolution actually reaches, so an export over an old range
-- can be told which resolution still covers it.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- Exporting telemetry for a range older than the raw retention window returned nothing and reported
-- "No telemetry in that range for the selected metrics." That sentence describes a device that
-- published nothing. What actually happened is that the raw chunks were dropped by the retention
-- policy -- and the data the reader wants still exists, in a rollup, under a query the client can
-- already make: `telemetry_1h` is kept five years against the raw hypertable's ninety days, and
-- `queryTelemetry` has always accepted `resolution` (issue #160).
--
-- To offer that, the dialog has to know how far back each resolution reaches. The retention
-- SETTINGS cannot answer it: they say what will eventually be dropped, not what is held. A stack
-- installed three weeks ago has three weeks of raw whatever `retain_after` says, and a stack whose
-- policy was widened last week does not retroactively have the chunks it already deleted. Only the
-- database knows, so this asks the database.
--
-- WHY IT IS A VIEW ON THE OTHER SIDE. `public.telemetry` and the rollups are postgres_fdw
-- projections, and the wrapper pushes WHERE down but NOT LIMIT -- which is why the export pages in
-- bounded batches in the first place. So `ORDER BY time LIMIT 1` over the projection would stream
-- the relation across the link to discard all but one row. `timescale.telemetry_horizons` is a view
-- evaluated on the TimescaleDB server (timescaledb/aggregates.sql), where each min() is a
-- MergeAppend over the per-chunk time indexes; four rows cross the FDW. This is the same move
-- `telemetry_latest` makes, for the same reason.
--
-- READ-ONLY AND UNFILTERED BY ASSET. Retention is a property of the chunk, not of the device, so
-- the horizon is the same for every asset and there is nothing to filter by. It carries no metric
-- values and no device identity -- four relation names and four timestamps -- which is why
-- `authenticated` may read it without a per-row policy.
-- =================================================================================================

-- The foreign table follows timescaledb/aggregates.sql. `oldest` is nullable on purpose: NULL means
-- the relation holds no rows at all, which a reader must not confuse with "this resolution does not
-- reach that far" -- an empty stack covers nothing at any resolution, and saying so is the honest
-- answer rather than offering a switch that would also return nothing.
CREATE FOREIGN TABLE IF NOT EXISTS timescale.telemetry_horizons (
    relation text NOT NULL,
    oldest timestamp with time zone
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'telemetry_horizons'
);

-- security_invoker, as every other projection of this server is: the caller's grants decide, not
-- the view owner's.
CREATE OR REPLACE VIEW public.telemetry_horizons WITH (security_invoker='true') AS
 SELECT relation,
    oldest
   FROM timescale.telemetry_horizons t;

COMMENT ON VIEW public.telemetry_horizons IS
    'Oldest timestamp held by each telemetry resolution: `telemetry` (raw) and the `telemetry_1m`, `telemetry_5m` and `telemetry_1h` rollups. Four rows, evaluated on the TimescaleDB side. What is HELD, not what the retention policy promises -- a young stack holds less than its policy allows, and a widened policy does not restore dropped chunks. A null `oldest` means that relation is empty. Read by the telemetry export dialog to say which resolutions still cover a chosen range.';

GRANT SELECT ON TABLE timescale.telemetry_horizons TO authenticated;
GRANT SELECT ON TABLE timescale.telemetry_horizons TO service_role;

GRANT ALL ON TABLE public.telemetry_horizons TO service_role;
GRANT SELECT ON TABLE public.telemetry_horizons TO authenticated;

NOTIFY pgrst, 'reload schema';
