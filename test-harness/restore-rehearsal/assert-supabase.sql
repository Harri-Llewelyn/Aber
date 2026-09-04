-- What a row count cannot catch, asserted after the restore.
--
-- THE POINT OF THIS FILE. A restore that "completes" is not the bar, and neither is one whose row
-- counts match. `pg_dump` carries data and DDL; what it carries LESS obviously is the machinery
-- that makes the data mean something -- triggers, RLS, grants, partition routing, and anything
-- encrypted with a key that lives outside the dump. Each of those can be absent while every count
-- agrees, and each is a security property rather than a convenience.
--
-- EVERY CHECK RAISES. This file is run with ON_ERROR_STOP=1, so the first failure stops the
-- rehearsal and names itself. A check that only printed would let a broken restore report success
-- in a log nobody reads to the end.

\set ON_ERROR_STOP on

DO $rehearsal$
DECLARE
  v_count   bigint;
  v_text    text;
  v_bool    boolean;
BEGIN
  -- 1. The seeded rows came back, and came back as themselves ----------------------------------
  SELECT count(*) INTO v_count FROM public.cells
   WHERE id = 'e1000000-0000-4000-8000-000000000001' AND name = 'Rehearsal Cell';
  IF v_count <> 1 THEN RAISE EXCEPTION 'the seeded cell did not survive the restore'; END IF;

  SELECT count(*) INTO v_count FROM public.gateways
   WHERE id = 'e2000000-0000-4000-8000-000000000001'
     AND cell_id = 'e1000000-0000-4000-8000-000000000001';
  IF v_count <> 1 THEN RAISE EXCEPTION 'the seeded gateway did not survive, or lost its cell'; END IF;

  SELECT count(*) INTO v_count FROM public.devices
   WHERE id = 'e3000000-0000-4000-8000-000000000001'
     AND gateway_id = 'e2000000-0000-4000-8000-000000000001';
  IF v_count <> 1 THEN RAISE EXCEPTION 'the seeded device did not survive, or lost its gateway'; END IF;

  -- 2. The audit trail of that seeding came back ------------------------------------------------
  --
  -- Written by log_digital_thread_event(), so this is evidence the trigger fired at seed time AND
  -- that its rows survived. The trigger itself is checked separately below.
  SELECT count(*) INTO v_count FROM public.digital_thread
   WHERE entity_id IN ('e1000000-0000-4000-8000-000000000001',
                       'e2000000-0000-4000-8000-000000000001',
                       'e3000000-0000-4000-8000-000000000001');
  IF v_count < 3 THEN
    RAISE EXCEPTION 'expected at least 3 audit rows for the seeded assets, found %', v_count;
  END IF;

  -- 3. digital_thread is still append-only ------------------------------------------------------
  --
  -- BOTH LAYERS, because they fail differently. The trigger is what refuses a role that HAS the
  -- privilege; the revoked grants are what stop the question being asked. A dump carries both, and
  -- a restore that dropped either leaves an audit table that looks completely normal.
  SELECT count(*) INTO v_count FROM pg_trigger
   WHERE tgrelid = 'public.digital_thread'::regclass
     AND tgname = 'trg_digital_thread_append_only' AND NOT tgisinternal;
  IF v_count <> 1 THEN RAISE EXCEPTION 'the digital_thread append-only trigger did not survive'; END IF;

  IF has_table_privilege('service_role', 'public.digital_thread', 'UPDATE')
     OR has_table_privilege('service_role', 'public.digital_thread', 'DELETE')
     OR has_table_privilege('service_role', 'public.digital_thread', 'TRUNCATE') THEN
    RAISE EXCEPTION 'service_role can write to digital_thread after the restore -- 0001''s REVOKE did not survive';
  END IF;

  SELECT relrowsecurity INTO v_bool FROM pg_class WHERE oid = 'public.digital_thread'::regclass;
  IF NOT v_bool THEN RAISE EXCEPTION 'row-level security is OFF on digital_thread after the restore'; END IF;

  SELECT count(*) INTO v_count FROM pg_policy WHERE polrelid = 'public.digital_thread'::regclass;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected 2 RLS policies on digital_thread, found % -- the audit lane split did not survive', v_count;
  END IF;

  -- 4. The partitioning survived, and is still routing (0079) -----------------------------------
  --
  -- A dump writes `COPY public.digital_thread` and the live constraints route each row on the way
  -- in. So a database that came back UNPARTITIONED holds every row and passes every count -- and
  -- has quietly lost the ability to retire a month at all. This is the check that separates them.
  IF NOT EXISTS (SELECT 1 FROM pg_partitioned_table
                  WHERE partrelid = 'public.digital_thread'::regclass) THEN
    RAISE EXCEPTION 'digital_thread came back UNPARTITIONED -- retention by DETACH is gone';
  END IF;

  SELECT count(*) INTO v_count FROM public.digital_thread_default;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'restored % row(s) into the DEFAULT partition -- the monthly partitions did not come back, so those rows will never be detached with their month', v_count;
  END IF;

  -- The partitions themselves must still be unreachable by an application role. A restore
  -- recreates them, and the image's default privileges apply to anything created afterwards.
  SELECT count(*) INTO v_count
    FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
   WHERE i.inhparent = 'public.digital_thread'::regclass
     AND (has_table_privilege('service_role', c.oid, 'TRUNCATE')
       OR has_table_privilege('authenticated', c.oid, 'SELECT'));
  IF v_count > 0 THEN
    RAISE EXCEPTION '% partition(s) came back reachable by an application role -- TRUNCATE raises no trigger, so a month of audit is erasable', v_count;
  END IF;

  -- 5. Vault decrypts, which is the pgsodium root key surviving ---------------------------------
  --
  -- THE DOCUMENTED LATE FIND. The key is not in the dump. Rows that are present and undecryptable
  -- read as a working Vault until something asks for a plaintext, and by then the backup that
  -- could have been re-taken is gone.
  SELECT decrypted_secret INTO v_text
    FROM vault.decrypted_secrets WHERE name = 'restore_rehearsal_canary';
  IF v_text IS DISTINCT FROM 'rehearsal-canary-plaintext' THEN
    RAISE EXCEPTION 'the Vault canary did not decrypt to its plaintext (got %) -- the pgsodium root key did not survive the restore', coalesce(quote_literal(v_text), 'NULL');
  END IF;

  -- 6. The 3D model bucket is still there, and still public-read --------------------------------
  --
  -- `public` is the column the AAS exporter's URLs depend on. A bucket restored as private returns
  -- 400 for every object while the row in `devices.model_3d_path` still looks perfectly correct.
  SELECT public INTO v_bool FROM storage.buckets WHERE id = 'asset-3d-models';
  IF v_bool IS NULL THEN RAISE EXCEPTION 'the asset-3d-models bucket did not survive the restore'; END IF;
  IF NOT v_bool THEN RAISE EXCEPTION 'the asset-3d-models bucket came back PRIVATE -- every model URL now 400s'; END IF;

  -- 7. The foreign server is registered ----------------------------------------------------------
  --
  -- restore-databases.sh checks this too. Repeated here because this file is also what an operator
  -- runs by hand after a real restore, where nothing else will have checked it.
  SELECT count(*) INTO v_count FROM pg_foreign_server WHERE srvname = 'timescaledb_server';
  IF v_count <> 1 THEN RAISE EXCEPTION 'the timescaledb_server foreign server did not survive'; END IF;

  -- 8. The roles the policies name still hold their grants ---------------------------------------
  --
  -- A restore that lost grants queries perfectly as postgres and fails for every actual caller,
  -- which is the shape of failure that reaches production rather than CI.
  IF NOT has_table_privilege('authenticated', 'public.digital_thread', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT on digital_thread -- the Digital Thread page would be empty, not broken';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.devices', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT on devices';
  END IF;

  RAISE NOTICE 'restore rehearsal: every Supabase assertion passed';
END $rehearsal$;
