-- The historian side of the restore, where the interesting failures are not about rows.
--
-- WHY THIS IS NOT JUST A COUNT. TimescaleDB keeps its own catalogue in `_timescaledb_catalog`, and
-- a restore can bring back every telemetry row while losing the things that make the table a
-- hypertable: the chunks, the continuous aggregates, and the background jobs that refresh and
-- retire them. `restore-databases.sh` wraps the restore in timescaledb_pre_restore()/post_restore()
-- precisely because getting that wrong leaves the rollups present in the catalogue and not
-- refreshing -- a state in which nothing looks broken until a dashboard is silently a flat line and
-- the disk quietly stops being pruned.

\set ON_ERROR_STOP on

DO $rehearsal$
DECLARE
  v_count bigint;
  v_val   double precision;
BEGIN
  -- 1. The seeded telemetry came back --------------------------------------------------------
  SELECT count(*) INTO v_count FROM public.telemetry
   WHERE asset_id = 'REHEARSAL/Rehearsal_Device' AND metric_name = 'Rehearsal_Temperature';
  IF v_count <> 30 THEN
    RAISE EXCEPTION 'expected 30 seeded telemetry rows, found %', v_count;
  END IF;

  -- Values, not only rows. A restore that truncated a column type would keep the count.
  SELECT max(val_double) INTO v_val FROM public.telemetry
   WHERE asset_id = 'REHEARSAL/Rehearsal_Device';
  IF v_val IS DISTINCT FROM 49.0 THEN
    RAISE EXCEPTION 'the seeded telemetry came back with the wrong values (max=%), expected 49.0', v_val;
  END IF;

  SELECT count(*) INTO v_count FROM public.assets WHERE asset_id = 'REHEARSAL/Rehearsal_Device';
  IF v_count <> 1 THEN RAISE EXCEPTION 'the seeded asset row did not survive'; END IF;

  -- 2. telemetry is still a HYPERTABLE, not just a table -------------------------------------
  --
  -- The failure this catches is a restore that replayed the CREATE TABLE and the data and skipped
  -- create_hypertable(). Every row is present, every query works, and the table has no chunks, no
  -- compression and no retention -- so it grows forever and nothing says so.
  SELECT count(*) INTO v_count FROM timescaledb_information.hypertables
   WHERE hypertable_schema = 'public' AND hypertable_name = 'telemetry';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'public.telemetry is not a hypertable after the restore -- it has no chunks, no compression and no retention';
  END IF;

  SELECT count(*) INTO v_count FROM timescaledb_information.chunks
   WHERE hypertable_schema = 'public' AND hypertable_name = 'telemetry';
  IF v_count < 1 THEN RAISE EXCEPTION 'the telemetry hypertable came back with no chunks'; END IF;

  -- 3. All three continuous aggregates exist --------------------------------------------------
  SELECT count(*) INTO v_count FROM timescaledb_information.continuous_aggregates
   WHERE view_name IN ('telemetry_1m', 'telemetry_5m', 'telemetry_1h');
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'expected 3 continuous aggregates (1m/5m/1h), found %', v_count;
  END IF;

  -- 4. AND ONE OF THEM RETURNS DATA -----------------------------------------------------------
  --
  -- THE CHECK THAT SEPARATES "restored" FROM "working". A continuous aggregate can come back as a
  -- catalogue entry over an empty materialisation hypertable: it exists, it is listed, it queries
  -- successfully, and it answers nothing. That is indistinguishable from a healthy rollup on a
  -- quiet plant, which is why the rehearsal seeds backdated rows and refreshes them first -- so
  -- "empty" here can only mean the materialised data did not survive.
  SELECT count(*) INTO v_count FROM public.telemetry_1m
   WHERE asset_id = 'REHEARSAL/Rehearsal_Device';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'telemetry_1m exists but returns no rows for the seeded asset -- the materialised aggregate did not survive the restore';
  END IF;

  -- 5. The background jobs are registered and armed --------------------------------------------
  --
  -- post_restore() re-registers these. If it did not run -- or the restore failed before it -- the
  -- database comes up with its workers stopped: no retention, no compression, no refresh. Nothing
  -- about the running stack looks wrong until the disk fills, which is the slowest possible way to
  -- find out.
  SELECT count(*) INTO v_count FROM timescaledb_information.jobs
   WHERE proc_name = 'policy_refresh_continuous_aggregate';
  IF v_count < 3 THEN
    RAISE EXCEPTION 'expected a refresh policy for each of the 3 rollups, found % -- the aggregates will never update again', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM timescaledb_information.jobs
   WHERE proc_name = 'policy_retention';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'no retention policy survived the restore -- the historian will grow without bound';
  END IF;

  -- Scheduled, not merely present. A job row with scheduled = false is a policy that exists and
  -- never runs, which reads as configured in every view an operator would check.
  SELECT count(*) INTO v_count FROM timescaledb_information.jobs
   WHERE proc_name IN ('policy_retention', 'policy_refresh_continuous_aggregate')
     AND NOT scheduled;
  IF v_count > 0 THEN
    RAISE EXCEPTION '% policy job(s) came back UNSCHEDULED -- present in every catalogue view and never running', v_count;
  END IF;

  RAISE NOTICE 'restore rehearsal: every historian assertion passed';
END $rehearsal$;
