-- Known telemetry for the backup/restore rehearsal, on the historian side.
--
-- SPREAD ACROSS AN HOUR AND NOT ALL AT ONE INSTANT, because the rollups are what this exists to
-- exercise. `telemetry_1m` buckets by minute, so sixty rows one second apart produce one bucket and
-- prove nothing about the aggregate coming back; these land in distinct minutes so the continuous
-- aggregate has something to have aggregated.
--
-- BACKDATED, for the same reason. A continuous aggregate does not materialise the most recent
-- window until its refresh policy runs, and the rehearsal cannot wait for one. Rows an hour old are
-- inside the materialised range, so `refresh_continuous_aggregate` below fills the buckets
-- immediately and the post-restore assertion has real data to find.
--
-- IDEMPOTENT: the primary key is (time, asset_id, metric_name) and every timestamp is derived from
-- a fixed anchor, so re-seeding overwrites rather than duplicating.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.assets (asset_id, asset_name)
VALUES ('REHEARSAL/Rehearsal_Device', 'Rehearsal Device')
ON CONFLICT (asset_id) DO UPDATE SET asset_name = EXCLUDED.asset_name;

-- Thirty samples, one per minute, ending an hour ago.
INSERT INTO public.telemetry (time, asset_id, metric_name, val_double)
SELECT date_trunc('hour', now()) - interval '1 hour' + (g || ' minutes')::interval,
       'REHEARSAL/Rehearsal_Device',
       'Rehearsal_Temperature',
       20.0 + g
  FROM generate_series(0, 29) AS g
ON CONFLICT (time, asset_id, metric_name) DO UPDATE SET val_double = EXCLUDED.val_double;

COMMIT;

-- OUTSIDE THE TRANSACTION, AND IT HAS TO BE. refresh_continuous_aggregate() cannot run inside one:
-- it commits per bucket range, and calling it in a transaction block fails with
-- "refresh_continuous_aggregate cannot run inside a transaction block".
CALL refresh_continuous_aggregate('telemetry_1m',
       date_trunc('hour', now()) - interval '2 hours', now());

SELECT 'seeded ' || count(*) || ' telemetry row(s) and refreshed telemetry_1m' AS seed_timescale
  FROM public.telemetry WHERE asset_id = 'REHEARSAL/Rehearsal_Device';
