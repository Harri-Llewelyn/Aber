-- =============================================================================================
-- Storage access control for the platform's buckets.
--
-- Applied on every boot by the chart's storage-policies Job. Idempotent: every policy is dropped before it is created, and the grants are
-- repeatable.
--
-- ORDERING: after `supabase-storage` is healthy (storage-api creates `storage.objects` by its
-- own migrations; the PG17 image ships the `storage` schema empty, which is why this is not in
-- 0001) and before `supabase-storage-init`, which creates the bucket through the Storage REST
-- API as service_role and needs the grants below, or fails with a misleading
-- `400 new row violates row-level security policy`.
--
-- Between storage-api creating the table and this running, RLS is enabled with no policies, so
-- `anon` and `authenticated` are denied and `service_role` (which bypasses RLS) is unaffected:
-- a brief loss of function, never of control. Do not enable RLS here or grant before the
-- policies exist.
--
-- The 3D-model bucket's objects are public (an AAS `File` URL must resolve with no session);
-- listing and writing are gated on device-management authority. Depends on public.has_role()
-- from 0001.
-- =============================================================================================

\set ON_ERROR_STOP on

-- Fail with the REASON rather than with a bare "relation does not exist". Reaching this script
-- before storage-api has migrated its schema is an ordering fault in the service graph, and that
-- is a different problem from a policy being wrong.
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

-- Restated rather than assumed. storage-api enables RLS in its own migrations, but this file is
-- the access control for the table and must not depend on that remaining true.
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Public reads (/object/public/...) are served by the bucket's `public` flag and never consult a
-- SELECT policy. SELECT governs listing, and storage-api cannot upload or remove without it (its
-- writes read the row back), so it takes the same authority as writing: the geometry is public,
-- the inventory of which devices have a model is not.
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

-- ---------------------------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------------------------
-- On the PG17 image the storage tables are created by storage-api with no grants to these roles,
-- so the privileges are stated, and only what each role needs. service_role gets the admin
-- surface because storage-api assumes it to serve the REST API; it bypasses RLS, so the grants
-- are the only limit that applies to it, which is why it is enumerated rather than given ALL.
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

GRANT SELECT                         ON storage.buckets TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.buckets TO service_role;

GRANT SELECT                         ON storage.objects TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO service_role;

-- Self-check. The failure this guards against is silent in the direction that matters least and
-- loudest in the direction that matters most: a MISSING policy denies, so the 3D model viewer
-- simply shows nothing and nobody reads a log. Assert the set is complete instead. By name, not by
-- count: a policy another chart version left behind is reported, and does not fail the boot.
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

-- =============================================================================================
-- broker-captures -- recorded Sparkplug traffic, for playback
-- =============================================================================================
--
-- Private; reads go through a signed URL minted for a caller whose role has been checked.
--
--   Administrator, Shopfloor_Manager   read, write, replace, delete
--   Auditor                            read only, re-asserted at the end
--   Operator                           nothing
--   the ingestion daemon               one object, for the duration of one job (below)
--
-- A capture records every edge node, device id, metric name and value that spoke in the window.
-- Captures are filed under the subject recorded; a capture filed under gateway A can name
-- gateway B, which the admitted roles can already enumerate through the directory.
--
-- The path is confined by the database: every object must live under `<subject prefix>/`
-- naming a gateway or device that exists (`storage.foldername(name)[1]` is the leading folder),
-- as mosquitto/README.md confines a client to its own edge node. SELECT is not path-confined,
-- so a reader can find the capture of a subject that has since been deleted.
--
-- `storage.objects.name` is fully qualified inside every policy, and must be: `public.gateways`
-- has its own `name`, and an unqualified reference binds to the gateway's display label, which
-- refuses every upload and would accept any prefix if a gateway were ever named something
-- path-shaped. See ./README.md -> "Storage buckets and why they differ".
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Two things the capture page needs that the asset bucket above does not.
--
-- 1. The prefix rule admits devices as well as gateways: `public.is_capture_subject_prefix()`,
--    shared with the gate that builds the path so the two cannot drift.
--
-- 2. The ingestion daemon may write, and only write, the object of the capture job it is
--    running: `is_ingestion_caller() AND is_active_capture_object(name)`. Recording is a
--    server-side act (a browser cannot open an MQTT subscription), and a SECURITY DEFINER
--    function cannot carry a 50 MiB body into a bucket; the row is written by storage-api under
--    the caller's JWT, so a policy arm is the only place this authority can live. UPDATE is
--    included because a re-record overwrites the one object per subject with `upsert: true`,
--    which destroys nothing until the replacement is written. SELECT is included because an
--    upsert is `INSERT ... ON CONFLICT DO UPDATE` and Postgres checks the SELECT policy for the
--    conflicting row (measured: the upsert was refused without it). No DELETE arm: removing a
--    capture is a human act.
-- ---------------------------------------------------------------------------------------------

-- Three ways in, two of them machines confined to one file each:
--   a person          Administrator, Shopfloor_Manager or Auditor, reading the whole bucket
--   the daemon        the object of the capture job it is recording
--   the worker        the object of the playback job it is running
-- The playback arm is a prerequisite: without it every playback fails at its first read with
-- 42501, visible only as a failed job.
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
      -- storage.objects.name, QUALIFIED: public.gateways has a `name` column of its own and would
      -- otherwise capture this reference. See the header block above.
      (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
       AND public.is_capture_subject_prefix((storage.foldername(storage.objects.name))[1]))
      OR (public.is_ingestion_caller()
          AND public.is_active_capture_object(storage.objects.name))
    )
  );

-- UPDATE covers `upsert: true`, which is how a re-record replaces the one capture stored for a
-- subject. Both halves are gated: USING decides which objects may be targeted, WITH CHECK what
-- the result may look like.
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

-- ---------------------------------------------------------------------------------------------
-- Reconcile: broker-captures
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_policies       integer;
  v_auditor_writes integer;
  v_daemon_reads   integer;
  v_daemon_writes  integer;
BEGIN
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

  -- The daemon reaches three of the four policies, each confined to one file. SELECT belongs in
  -- this count because replacing a capture is an upsert, which Postgres evaluates against the
  -- SELECT policy as well.
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

  -- Every one of those arms must be scoped to the active job: a bare `is_ingestion_caller()` would
  -- be standing authority over every capture in the bucket, held by the process most exposed to
  -- the plant network.
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

  -- AND IT NEVER DELETES. Removing a capture is a human act with a confirmation in front of it;
  -- recording never requires destroying an earlier recording, because the overwrite replaces it.
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

  -- ---------------------------------------------------------------------------------------------
  -- The playback worker reads, and does nothing else. Missing, every playback fails at its first
  -- read; present on any policy but SELECT, a process holding broker publish rights could also
  -- overwrite the recordings it replays.
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

-- ---------------------------------------------------------------------------------------------
-- telemetry-archive -- RETIRED
-- ---------------------------------------------------------------------------------------------
-- Cold telemetry is written to a configured S3 endpoint and no longer to a bucket in this
-- cluster: the destination has to be somewhere a site loss does not reach, and an object here was
-- on the same node as the database whose rows it had replaced.
--
-- DROPPED EXPLICITLY, because deleting the block above would not. This file drops each policy it
-- is about to create, so a policy it no longer mentions is one nothing touches -- it survives
-- every boot on a database that already has it, guarding a bucket nothing writes to.
--
-- THE BUCKET ITSELF IS NOT DELETED HERE, and nothing else deletes it either. It is left with
-- whatever it holds, for an Administrator to empty and remove from Studio once satisfied the
-- objects in it are also at the remote endpoint. `cold_archive audit` answers that question for
-- the manifest's rows; objects no manifest row references are reported by the same command.
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

-- =============================================================================================
-- asset-exports -- AAS export bundles, one .aasx per export
-- =============================================================================================
-- Written by the `aas-export` function as service_role, which bypasses RLS, so there is NO write
-- policy here for any browser role and that is the point: an object in this bucket is evidence of
-- an export that a row in `asset_exports` records, and a hand-uploaded file would be a bundle with
-- no provenance sitting beside ones that have it.
--
-- READ is the same privileged set the Archives tab admits, and the download goes through a signed
-- URL minted for a caller whose role has been checked (frontend/src/api.js). DELETE is
-- Administrator alone: the row's tombstone points at the object, so removing one is a decision
-- about the record, not about disk.
--
-- These bundles lived under `assets/` in `telemetry-archive` until cold telemetry moved to a
-- remote endpoint. See scripts/storage-init.mjs for why they did not follow it there.
-- =============================================================================================

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

-- ---------------------------------------------------------------------------------------------
-- Reconcile: asset-exports
-- ---------------------------------------------------------------------------------------------
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

-- =============================================================================================
-- floor-plans -- the SVG drawings the Site Map renders, one per area
-- =============================================================================================
-- Private, read by every signed-in role: the Site Map is the page an Operator lives on, and a
-- plan with no reader draws nothing. Writes are Administrator and Shopfloor_Manager, the roles
-- that manage areas, and every object must live under `<area_id>/` naming an area that exists,
-- so a plan cannot be filed against an area somebody made up.
-- =============================================================================================

DROP POLICY IF EXISTS "floor_plans_read_authenticated" ON storage.objects;
CREATE POLICY "floor_plans_read_authenticated" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'floor-plans');

DROP POLICY IF EXISTS "floor_plans_insert_privileged" ON storage.objects;
CREATE POLICY "floor_plans_insert_privileged" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'floor-plans'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
    AND public.is_floor_plan_path(storage.objects.name)
  );

DROP POLICY IF EXISTS "floor_plans_update_privileged" ON storage.objects;
CREATE POLICY "floor_plans_update_privileged" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'floor-plans'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
  )
  WITH CHECK (
    bucket_id = 'floor-plans'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
    AND public.is_floor_plan_path(storage.objects.name)
  );

DROP POLICY IF EXISTS "floor_plans_delete_privileged" ON storage.objects;
CREATE POLICY "floor_plans_delete_privileged" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'floor-plans'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
  );

-- ---------------------------------------------------------------------------------------------
-- Reconcile: floor-plans
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_policies integer;
  v_unconfined integer;
BEGIN
  SELECT count(*) INTO v_policies FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'floor_plans_%';
  IF v_policies <> 4 THEN
    RAISE EXCEPTION 'floor-plans has % policy/policies, expected 4 (select, insert, update, delete).', v_policies;
  END IF;

  -- Every write is confined to a real area's prefix.
  SELECT count(*) INTO v_unconfined FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'floor_plans_%'
     AND cmd IN ('INSERT', 'UPDATE')
     AND coalesce(with_check, '') NOT LIKE '%is_floor_plan_path%';
  IF v_unconfined <> 0 THEN
    RAISE EXCEPTION 'floor-plans: % write policy/policies do not confine the path to an existing area.', v_unconfined;
  END IF;

  RAISE NOTICE 'floor-plans policies reconciled (4 policies; writes confined to <area_id>/).';
END $$;
