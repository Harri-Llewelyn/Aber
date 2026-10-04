-- Storage access control for the platform's buckets: the RLS policies on storage.objects and the
-- grants the roles need, applied on every boot by the storage-policies Job. Idempotent: each policy
-- is dropped before it is created. Runs after supabase-storage is healthy, because storage-api
-- creates storage.objects by its own migrations and the PG17 image ships the storage schema empty,
-- and before storage-init, which creates the buckets as service_role and needs the grants below.
-- Between the two, RLS is on with no policies: a brief loss of function, never of control. Depends
-- on public.has_role(). The reasoning per bucket is in ./README.md, "Storage buckets and why they
-- differ".
\set ON_ERROR_STOP on

-- Fail with the reason rather than a bare "relation does not exist": reaching this before
-- storage-api has migrated is an ordering fault in the service graph, not a wrong policy.
DO $$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION
      'storage.objects does not exist. It is created by storage-api''s own migrations when the '
      'supabase-storage service boots, so this script must run AFTER that service is healthy -- '
      'see the hook-weight on the Helm Job. The database '
      'image no longer ships a stub storage schema (it did up to supabase/postgres 15.x).';
  END IF;
END $$;

-- Restated rather than assumed: this file is the access control for the table and must not depend
-- on storage-api's migrations having done it.
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- asset-3d-models. Public reads (/object/public/...) are served by the bucket's public flag and
-- never consult a SELECT policy. SELECT governs listing, and storage-api's writes read the row
-- back, so it takes the same authority as writing: the geometry is public, the inventory of which
-- devices have a model is not.
DROP POLICY IF EXISTS "asset_3d_models_public_read" ON storage.objects;
DROP POLICY IF EXISTS "asset_3d_models_select_privileged" ON storage.objects;
CREATE POLICY "asset_3d_models_select_privileged" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'asset-3d-models'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
  );

DROP POLICY IF EXISTS "asset_3d_models_insert_privileged" ON storage.objects;
CREATE POLICY "asset_3d_models_insert_privileged" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'asset-3d-models'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
  );

DROP POLICY IF EXISTS "asset_3d_models_update_privileged" ON storage.objects;
CREATE POLICY "asset_3d_models_update_privileged" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'asset-3d-models'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
  )
  WITH CHECK (
    bucket_id = 'asset-3d-models'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
  );

DROP POLICY IF EXISTS "asset_3d_models_delete_privileged" ON storage.objects;
CREATE POLICY "asset_3d_models_delete_privileged" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'asset-3d-models'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
  );

-- On the PG17 image storage-api creates its tables with no grants to these roles, so each is
-- stated, and only what it needs. service_role bypasses RLS, so the grants are the only limit that
-- applies to it, which is why it is enumerated rather than given ALL.
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

GRANT SELECT                         ON storage.buckets TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.buckets TO service_role;

GRANT SELECT                         ON storage.objects TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO service_role;

-- Self-check, by name and not by count: a missing policy denies silently (the viewer shows nothing
-- and nobody reads a log), and a policy another version left behind is reported without failing
-- the boot.
DO $$
DECLARE
  expected CONSTANT text[] := ARRAY[
    'asset_3d_models_select_privileged', 'asset_3d_models_insert_privileged',
    'asset_3d_models_update_privileged', 'asset_3d_models_delete_privileged'];
  missing text[];
  extra   text[];
BEGIN
  SELECT array_agg(e) INTO missing FROM unnest(expected) e
   WHERE NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = e);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'asset-3d-models policies missing on storage.objects: %', missing;
  END IF;
  SELECT array_agg(policyname) INTO extra FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'asset\_3d\_models\_%' AND policyname <> ALL (expected);
  IF extra IS NOT NULL THEN
    RAISE WARNING 'asset-3d-models policies this file does not create: %. Drop them if nothing needs them.', extra;
  END IF;
  RAISE NOTICE 'storage policies reconciled (4 asset-3d-models policies on storage.objects).';
END $$;

-- broker-captures: private. Administrator and Shopfloor_Manager read, write, replace and delete;
-- Auditor reads; Operator nothing. Three ways in, two of them machines confined to one file each: a
-- person reading the whole bucket, the ingestion daemon on the object of the capture job it is
-- recording (SELECT included, because an upsert is checked against the SELECT policy), and the
-- playback worker on the capture of the job it is running. Every write is confined to <subject>/
-- naming a gateway or device that exists; SELECT is not, so a reader can find the capture of a
-- subject since deleted. storage.objects.name is qualified in every policy and must be:
-- public.gateways has a name column of its own, and an unqualified reference binds to it.
DROP POLICY IF EXISTS "broker_captures_read_privileged" ON storage.objects;
CREATE POLICY "broker_captures_read_privileged" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'broker-captures'
    AND (
      public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor'])
      OR (public.is_ingestion_caller()
          AND public.is_active_capture_object(storage.objects.name))
      OR (public.is_playback_caller()
          AND public.is_active_playback_capture(storage.objects.name))
    )
  );

DROP POLICY IF EXISTS "broker_captures_insert_privileged" ON storage.objects;
CREATE POLICY "broker_captures_insert_privileged" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'broker-captures'
    AND (
      (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
       AND public.is_capture_subject_prefix((storage.foldername(storage.objects.name))[1]))
      OR (public.is_ingestion_caller()
          AND public.is_active_capture_object(storage.objects.name))
    )
  );

-- UPDATE covers upsert: true, which is how a re-record replaces the one capture per subject. USING
-- decides which objects may be targeted, WITH CHECK what the result may look like.
DROP POLICY IF EXISTS "broker_captures_update_privileged" ON storage.objects;
CREATE POLICY "broker_captures_update_privileged" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'broker-captures'
    AND (
      public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
      OR (public.is_ingestion_caller()
          AND public.is_active_capture_object(storage.objects.name))
    )
  )
  WITH CHECK (
    bucket_id = 'broker-captures'
    AND (
      (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
       AND public.is_capture_subject_prefix((storage.foldername(storage.objects.name))[1]))
      OR (public.is_ingestion_caller()
          AND public.is_active_capture_object(storage.objects.name))
    )
  );

DROP POLICY IF EXISTS "broker_captures_delete_privileged" ON storage.objects;
CREATE POLICY "broker_captures_delete_privileged" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'broker-captures'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
  );

DO $$
DECLARE
  v_policies       integer;
  v_auditor_writes integer;
  v_daemon_reads   integer;
  v_daemon_writes  integer;
BEGIN
  -- Reconcile: four policies; Auditor never writes; the daemon in exactly SELECT, INSERT and UPDATE,
  -- each arm confined to the active job, and never DELETE; the worker in SELECT alone. Each exception
  -- says what a missing arm looks like from outside, which is a job that failed for no stated reason.
  SELECT count(*) INTO v_policies FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'broker_captures_%';
  IF v_policies <> 4 THEN
    RAISE EXCEPTION
      'broker-captures has % policy/policies, expected 4 (select, insert, update, delete). A '
      'missing one does not error -- storage.objects is RLS-enabled, so the operation simply '
      'stops working for everyone, which reads as a broken upload rather than a missing policy.',
      v_policies;
  END IF;

  SELECT count(*) INTO v_auditor_writes FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'broker_captures_%'
     AND cmd <> 'SELECT'
     AND (qual LIKE '%Auditor%' OR with_check LIKE '%Auditor%');
  IF v_auditor_writes <> 0 THEN
    RAISE EXCEPTION
      '% broker_captures_* write policy/policies name Auditor. Auditor is READ ONLY on this '
      'bucket -- write authority is Administrator and Shopfloor_Manager only.', v_auditor_writes;
  END IF;

  SELECT count(*) INTO v_daemon_writes FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'broker_captures_%'
     AND cmd IN ('SELECT', 'INSERT', 'UPDATE')
     AND (coalesce(qual, '') LIKE '%is_ingestion_caller%'
       OR coalesce(with_check, '') LIKE '%is_ingestion_caller%');
  IF v_daemon_writes <> 3 THEN
    RAISE EXCEPTION
      'broker-captures: the ingestion daemon appears in % of the 3 policies it needs (SELECT, '
      'INSERT, UPDATE). Recording is a server-side act performed by the daemon, which holds '
      'Operator and would otherwise have every upload refused with 42501 -- caught, logged, and '
      'seen only as a capture that never appears. See 0055.', v_daemon_writes;
  END IF;

  SELECT count(*) INTO v_daemon_reads FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'broker_captures_%'
     AND (coalesce(qual, '') LIKE '%is_ingestion_caller%'
       OR coalesce(with_check, '') LIKE '%is_ingestion_caller%')
     AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%is_active_capture_object%';
  IF v_daemon_reads <> 0 THEN
    RAISE EXCEPTION
      'broker-captures: % polic(ies) admit the ingestion daemon WITHOUT confining it to the object '
      'of the capture job it is running. is_ingestion_caller() alone is standing authority over '
      'every capture in the bucket; it must be paired with is_active_capture_object(name).',
      v_daemon_reads;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname LIKE 'broker_captures_%' AND cmd = 'DELETE'
       AND coalesce(qual, '') LIKE '%is_ingestion_caller%'
  ) THEN
    RAISE EXCEPTION
      'broker-captures: the DELETE policy admits the ingestion daemon. It has no reason to destroy '
      'a capture -- replacing one is an overwrite -- and every reason not to be able to.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname = 'broker_captures_read_privileged'
       AND coalesce(qual, '') LIKE '%is_playback_caller%'
       AND coalesce(qual, '') LIKE '%is_active_playback_capture%'
  ) THEN
    RAISE EXCEPTION
      'broker-captures: the SELECT policy does not admit the playback worker, confined to the '
      'capture of its running job. Service_Playback holds Operator, so every playback would fail '
      'at its first read with 42501 -- caught, logged, and seen only as a job that failed for no '
      'stated reason. See 0056.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname LIKE 'broker_captures_%' AND cmd <> 'SELECT'
       AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%is_playback_caller%'
  ) THEN
    RAISE EXCEPTION
      'broker-captures: a write policy admits the playback worker. It publishes captures and must '
      'not be able to alter or destroy them -- it holds broker publish rights, which is exactly '
      'the process that should not also be able to edit the evidence of what it published.';
  END IF;

  RAISE NOTICE
    'broker-captures policies reconciled (4 policies; Auditor read-only; the ingestion daemon '
    'confined to the object of its running job, and never deleting).';
END $$;

-- telemetry-archive, RETIRED: cold telemetry goes to a configured S3 endpoint, somewhere a site
-- loss does not reach. Dropped explicitly, because a policy this file no longer mentions survives
-- every boot on a database that has it. The bucket itself is deleted by nobody: an Administrator
-- empties it once satisfied its objects are at the remote endpoint (cold_archive audit).
DROP POLICY IF EXISTS "telemetry_archive_read_privileged" ON storage.objects;
DROP POLICY IF EXISTS "telemetry_archive_insert_daemon" ON storage.objects;
DROP POLICY IF EXISTS "telemetry_archive_update_daemon" ON storage.objects;
DROP POLICY IF EXISTS "telemetry_archive_delete_admin" ON storage.objects;

DO $$
DECLARE
  v_left int;
BEGIN
  SELECT count(*) INTO v_left
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'telemetry_archive_%';

  IF v_left > 0 THEN
    RAISE EXCEPTION
      'telemetry-archive: % policy/policies survived the four DROPs above. A policy named '
      'telemetry_archive_* that this file does not name is one nothing maintains.', v_left;
  END IF;

  RAISE NOTICE
    'telemetry-archive policies retired (0 policies; cold telemetry goes to the configured S3 '
    'endpoint, ingestion/cold_archive.py).';
END $$;

-- asset-exports: written by the aas-export function as service_role, so no browser role writes,
-- and that is the point: an object here is evidence of an export a row records. Read is the
-- Archives set; DELETE is Administrator alone, since the row's tombstone points at the object.
DROP POLICY IF EXISTS "asset_exports_read_privileged" ON storage.objects;
CREATE POLICY "asset_exports_read_privileged" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'asset-exports'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor'])
  );

DROP POLICY IF EXISTS "asset_exports_delete_admin" ON storage.objects;
CREATE POLICY "asset_exports_delete_admin" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'asset-exports'
    AND public.has_role(ARRAY['Administrator'])
  );

DO $$
DECLARE
  v_count int;
  v_writes int;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'asset_exports_%';

  IF v_count <> 2 THEN
    RAISE EXCEPTION
      'asset-exports has % policy/policies, expected 2 (select, delete). A policy added here '
      'without being added to this file is one nothing maintains.', v_count;
  END IF;

  SELECT count(*) INTO v_writes
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'asset_exports_%' AND cmd IN ('INSERT', 'UPDATE');

  IF v_writes > 0 THEN
    RAISE EXCEPTION
      'asset-exports: a write policy admits a browser role. Bundles are written by the aas-export '
      'function alone; a hand-uploaded file would be catalogued as an export nobody took.';
  END IF;

  RAISE NOTICE
    'asset-exports policies reconciled (2 policies; the function writes as service_role, no '
    'browser role writes, Administrator alone may delete).';
END $$;

-- area-plans: private, read by every signed-in role (the Site Map is the Operator's page); writes
-- are the roles that manage areas, confined to <area_id>/ naming an area that exists.
DROP POLICY IF EXISTS "area_plans_read_authenticated" ON storage.objects;
CREATE POLICY "area_plans_read_authenticated" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'area-plans');

DROP POLICY IF EXISTS "area_plans_insert_privileged" ON storage.objects;
CREATE POLICY "area_plans_insert_privileged" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'area-plans'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
    AND public.is_area_plan_path(storage.objects.name)
  );

DROP POLICY IF EXISTS "area_plans_update_privileged" ON storage.objects;
CREATE POLICY "area_plans_update_privileged" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'area-plans'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
  )
  WITH CHECK (
    bucket_id = 'area-plans'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
    AND public.is_area_plan_path(storage.objects.name)
  );

DROP POLICY IF EXISTS "area_plans_delete_privileged" ON storage.objects;
CREATE POLICY "area_plans_delete_privileged" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'area-plans'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
  );

DO $$
DECLARE
  v_policies integer;
  v_unconfined integer;
BEGIN
  SELECT count(*) INTO v_policies FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'area_plans_%';
  IF v_policies <> 4 THEN
    RAISE EXCEPTION 'area-plans has % policy/policies, expected 4 (select, insert, update, delete).', v_policies;
  END IF;

  SELECT count(*) INTO v_unconfined FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'area_plans_%'
     AND cmd IN ('INSERT', 'UPDATE')
     AND coalesce(with_check, '') NOT LIKE '%is_area_plan_path%';
  IF v_unconfined <> 0 THEN
    RAISE EXCEPTION 'area-plans: % write policy/policies do not confine the path to an existing area.', v_unconfined;
  END IF;

  RAISE NOTICE 'area-plans policies reconciled (4 policies; writes confined to <area_id>/).';
END $$;
