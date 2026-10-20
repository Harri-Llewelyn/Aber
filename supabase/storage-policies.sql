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

-- broker-captures: private. Administrator, Shopfloor_Manager and Auditor read a stored capture's
-- file only for the minute after issue_capture_download() recorded the download for them. The two
-- writer roles also read an object nothing claims (no capture row, recording, open upload or
-- playback names it) and a path issued to them for upload, because storage-api reads a deleted or
-- written row back; they write only a path begin_capture_upload() issued them and still open, and
-- delete only an unclaimed object. Auditor never writes; Operator nothing. The ingestion daemon
-- reads, inserts and overwrites the object of the capture job it is recording (SELECT included,
-- because an upsert is checked against the SELECT policy), and reads and deletes an unclaimed
-- object, which is how a replaced capture's file and an orphan leave the bucket. The playback
-- worker reads the capture of the job it is running. A write is also confined to <subject>/ naming
-- a gateway or device that exists; SELECT is not, so a writer can delete an object whose subject is
-- gone. storage.objects.name is qualified in every policy and must be: public.gateways has a name
-- column of its own, and an unqualified reference binds to it.
DROP POLICY IF EXISTS "broker_captures_read_privileged" ON storage.objects;
CREATE POLICY "broker_captures_read_privileged" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'broker-captures'
    AND (
      (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor'])
       AND public.is_open_capture_download(storage.objects.name))
      OR (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
          AND (public.is_unclaimed_capture_object(storage.objects.name)
               OR public.is_open_capture_upload(storage.objects.name)))
      OR (public.is_ingestion_caller()
          AND (public.is_active_capture_object(storage.objects.name)
               OR public.is_unclaimed_capture_object(storage.objects.name)))
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
       AND public.is_capture_subject_prefix((storage.foldername(storage.objects.name))[1])
       AND public.is_open_capture_upload(storage.objects.name))
      OR (public.is_ingestion_caller()
          AND public.is_active_capture_object(storage.objects.name))
    )
  );

-- UPDATE covers upsert: true, which a retried upload of the same path uses. USING decides which
-- objects may be targeted, WITH CHECK what the result may look like.
DROP POLICY IF EXISTS "broker_captures_update_privileged" ON storage.objects;
CREATE POLICY "broker_captures_update_privileged" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'broker-captures'
    AND (
      (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
       AND public.is_open_capture_upload(storage.objects.name))
      OR (public.is_ingestion_caller()
          AND public.is_active_capture_object(storage.objects.name))
    )
  )
  WITH CHECK (
    bucket_id = 'broker-captures'
    AND (
      (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
       AND public.is_capture_subject_prefix((storage.foldername(storage.objects.name))[1])
       AND public.is_open_capture_upload(storage.objects.name))
      OR (public.is_ingestion_caller()
          AND public.is_active_capture_object(storage.objects.name))
    )
  );

DROP POLICY IF EXISTS "broker_captures_delete_privileged" ON storage.objects;
CREATE POLICY "broker_captures_delete_privileged" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'broker-captures'
    AND (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
         OR public.is_ingestion_caller())
    AND public.is_unclaimed_capture_object(storage.objects.name)
  );

DO $$
DECLARE
  v_policies       integer;
  v_auditor_writes integer;
  v_daemon_reads   integer;
  v_daemon_writes  integer;
  v_read           text;
BEGIN
  -- Reconcile: four policies; Auditor never writes; a person's read confined to a recorded
  -- download, or for a writer to what they may delete or write; a person's write confined to an
  -- issued path; the daemon in all four, SELECT, INSERT and UPDATE confined to the active job's
  -- object and SELECT and DELETE to an unclaimed one; every DELETE confined to an unclaimed object;
  -- the worker in SELECT alone. Each exception says what a missing arm looks like from outside.
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

  -- Every role arm of the SELECT policy is ANDed with a predicate, and Auditor's is the grant.
  SELECT coalesce(qual, '') INTO v_read FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname = 'broker_captures_read_privileged';
  IF v_read NOT LIKE '%is_open_capture_download%'
     OR regexp_count(v_read, 'has_role\(') <> regexp_count(v_read, 'has_role\(ARRAY\[[^]]*\]\) AND ')
     OR regexp_count(v_read, 'Auditor') <> regexp_count(v_read, 'Auditor''::text\]\) AND (public\.)?is_open_capture_download\(')
  THEN
    RAISE EXCEPTION
      'broker-captures: the SELECT policy admits a person to a capture''s file without a download '
      'issue_capture_download() recorded. Any reader role could then sign a link or read the file '
      'through the Storage API, and the Audit Trail would hold nothing (0195).';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname LIKE 'broker_captures_%' AND cmd IN ('INSERT', 'UPDATE')
       AND coalesce(with_check, '') NOT LIKE '%is_open_capture_upload%'
  ) THEN
    RAISE EXCEPTION
      'broker-captures: a write policy admits a person to a path begin_capture_upload() did not '
      'issue them. Any path under a subject would then be writable, including the file a stored '
      'capture names, and a refused upload would leave the row describing the new bytes (0190).';
  END IF;

  SELECT count(*) INTO v_daemon_writes FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'broker_captures_%'
     AND cmd IN ('SELECT', 'INSERT', 'UPDATE')
     AND (coalesce(qual, '') LIKE '%is_ingestion_caller%'
       OR coalesce(with_check, '') LIKE '%is_ingestion_caller%');
  IF v_daemon_writes <> 3 THEN
    RAISE EXCEPTION
      'broker-captures: the ingestion daemon appears in % of the 3 policies it records through '
      '(SELECT, INSERT, UPDATE). Recording is a server-side act performed by the daemon, which '
      'holds no role and would otherwise have every upload refused with 42501 -- caught, logged, '
      'and seen only as a capture that never appears. See 0055.', v_daemon_writes;
  END IF;

  SELECT count(*) INTO v_daemon_reads FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'broker_captures_%'
     AND (coalesce(qual, '') LIKE '%is_ingestion_caller%'
       OR coalesce(with_check, '') LIKE '%is_ingestion_caller%')
     AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%is_active_capture_object%'
     AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%is_unclaimed_capture_object%';
  IF v_daemon_reads <> 0 THEN
    RAISE EXCEPTION
      'broker-captures: % polic(ies) admit the ingestion daemon WITHOUT confining it to the object '
      'of the capture job it is running or to an object nothing claims. is_ingestion_caller() '
      'alone is standing authority over every capture in the bucket.', v_daemon_reads;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname = 'broker_captures_delete_privileged'
       AND coalesce(qual, '') LIKE '%is_ingestion_caller%'
       AND coalesce(qual, '') LIKE '%is_unclaimed_capture_object%'
  ) THEN
    RAISE EXCEPTION
      'broker-captures: the DELETE policy does not admit the ingestion daemon to an unclaimed '
      'object. The file a finalise replaced, and the capture of a deleted subject, then stay in '
      'the bucket for ever, readable and in every backup (0190).';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname LIKE 'broker_captures_%' AND cmd = 'DELETE'
       AND coalesce(qual, '') NOT LIKE '%is_unclaimed_capture_object%'
  ) THEN
    RAISE EXCEPTION
      'broker-captures: a DELETE policy reaches an object a capture row, a recording, an open '
      'upload or a playback still names. Deleting it would leave a stored capture with no file '
      '(0190).';
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
      'capture of its running job. Service_Playback holds no role, so every playback would fail '
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
    'broker-captures policies reconciled (4 policies; Auditor read-only; a person reads a stored '
    'capture only through a recorded download and writes only an issued upload path; the ingestion '
    'daemon confined to the object of its running job, and deleting, like a person, only an object '
    'nothing claims).';
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
