-- =============================================================================================
-- Storage access control for the 3D model bucket.
--
-- Applied on EVERY boot by the `supabase-storage-policies` service (Compose) and the Job of the
-- same name (Helm). Idempotent: every policy is dropped before it is created, and the grants are
-- repeatable.
--
-- ORDERING: AFTER `supabase-storage` is healthy, and BEFORE `supabase-storage-init`.
--
-- The first half is obvious -- `storage.objects` does not exist until storage-api migrates it into
-- being. The second half is not, and getting it wrong fails in a way that reads as someone else's
-- bug: storage-init creates the bucket through the Storage REST API, and storage-api serves that
-- call by ASSUMING service_role. Without the grants below, that SELECT on `storage.buckets` is
-- refused, and storage-api reports it as `400 new row violates row-level security policy` with the
-- real cause -- a 42501 privilege error naming `service_role` -- buried inside a nested
-- `originalError`. It is not an RLS failure at all.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS IS NOT IN 0001_baseline_schema.sql ANY MORE.
--
-- It was, as section 6, and it worked for exactly as long as the database image happened to make
-- it work. `supabase/postgres:15.6.1.143` shipped a STUB `storage` schema -- buckets, objects and
-- migrations, with a reduced column set -- so `storage.objects` existed from first boot and a
-- migration could attach policies to it. `supabase/postgres:17.6.1.160` ships the `storage`
-- SCHEMA and nothing in it. The stub is gone.
--
-- That turns 0001 into a migration that aborts on `relation "storage.objects" does not exist`,
-- and the ordering makes it unfixable in place: `storage.objects` is created by storage-api's own
-- migrations when that service boots, and storage-api depends on db-init having COMPLETED. The
-- table therefore cannot exist while the migrations run, on any target, by construction.
--
-- So the policies move to where the table is real. This is the same reasoning that already put
-- the bucket ROW in scripts/storage-init.mjs rather than in a migration (see its header): the
-- parts of storage that a migration cannot own are the parts storage-api creates for itself.
--
-- ---------------------------------------------------------------------------------------------
-- THE WINDOW THIS OPENS, AND WHY IT FAILS CLOSED.
--
-- Between storage-api creating `storage.objects` and this script running, the table exists with
-- RLS enabled by storage-api's own migrations and NO policies of ours attached. A table with RLS
-- enabled and no matching policy DENIES -- so `anon` and `authenticated` can read nothing and
-- write nothing in that gap. `service_role` bypasses RLS and is unaffected, which is what lets
-- storage-init create the bucket during the same window.
--
-- The gap is therefore a brief loss of FUNCTION, never a loss of CONTROL. That direction is not
-- an accident and must be preserved: any future edit that enables RLS here rather than relying on
-- storage-api, or that grants before policies exist, inverts it.
--
-- ---------------------------------------------------------------------------------------------
-- THE POLICIES THEMSELVES are unchanged from 0001 section 6.
--
-- Public read, because an AAS `File` element's URL has to be dereferenceable by a viewer holding
-- no Factory+ session; a signed URL would expire and break every shell already handed out.
-- WRITES are gated on device-management authority, NOT merely on `authenticated`: an upload
-- changes what a shell publishes *and* puts bytes at a world-readable URL.
--
-- Depends on public.has_role(), created by 0001 section 4 -- which is why this runs after db-init
-- as well as after storage.
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
      'see the depends_on in docker-compose.yml and the hook-weight on the Helm Job. The database '
      'image no longer ships a stub storage schema (it did up to supabase/postgres 15.x).';
  END IF;
END $$;

-- Restated rather than assumed. storage-api enables RLS in its own migrations, but this file is
-- the access control for the table and must not depend on that remaining true.
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "asset_3d_models_public_read" ON storage.objects;
CREATE POLICY "asset_3d_models_public_read" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'asset-3d-models');

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

-- =============================================================================================
-- gateway-backups -- Node-RED flow backups from physical gateway appliances
-- =============================================================================================
--
-- PRIVATE, and there is no `getPublicUrl()` path for this bucket. Reads go through a signed URL
-- minted for a caller whose role has already been checked.
--
--   Administrator, Shopfloor_Manager   read, write, replace, delete
--   Auditor                            READ ONLY
--   Operator                           nothing
--
-- Why the split is asymmetric, and what a backup does and does not contain:
--   ./README.md -> "Storage buckets and why they differ"
--
-- ---------------------------------------------------------------------------------------------
-- THE PATH IS CONFINED BY THE DATABASE, NOT BY THE UPLOADER.
--
-- Every object must live under `<sparkplug_id>/`, and that first folder must name a gateway that
-- actually exists. `storage.foldername(name)` returns the path segments, so `[1]` is the leading
-- folder.
--
-- This is the same idea as mosquitto.acl's `pattern readwrite spBv1.0/+/+/%u/#` one layer up: the
-- client does not get to assert where its data belongs. A convention the frontend happens to follow
-- is not a control -- Storage's REST API is reachable with any authenticated session, so without
-- this a privileged user could scatter objects anywhere in the bucket, including paths that shadow
-- another gateway's backups.
--
-- SELECT IS *NOT* PATH-CONFINED, and that asymmetry is deliberate: a reader may list the bucket to
-- find backups, and requiring a valid gateway prefix on read would hide the backups of a gateway
-- that had since been deleted -- which is exactly when someone is looking for them.
--
-- ---------------------------------------------------------------------------------------------
-- `storage.objects.name` IS FULLY QUALIFIED INSIDE THE SUBQUERY, AND IT MUST BE.
--
-- `public.gateways` HAS ITS OWN COLUMN CALLED `name`. Postgres resolves an unqualified identifier
-- against the INNERMOST scope first, so the natural-looking
--
--     EXISTS (SELECT 1 FROM public.gateways g WHERE g.sparkplug_id = (storage.foldername(name))[1])
--
-- binds `name` to `gateways.name` -- the gateway's DISPLAY LABEL -- not to the object's path. It
-- parses, it runs, and it is false for every row, because `storage.foldername('Sim_Gateway_Cell1')`
-- is an empty array. The policy then denies every upload, including correct ones.
--
-- THAT IS THE BENIGN HALF OF THE FAILURE. The dangerous half is that the same expression would
-- start ACCEPTING rows if a gateway were ever named something path-shaped, and would then accept
-- them under ANY prefix -- so the confinement this policy exists to enforce would silently depend on
-- what somebody typed into a display field. Caught by test_path_is_confined_to_an_existing_gateway,
-- which is why that test asserts a valid path is accepted as well as that invalid ones are refused:
-- a check that only tested refusals passes perfectly against a policy that refuses everything.
-- =============================================================================================

DROP POLICY IF EXISTS "gateway_backups_read_privileged" ON storage.objects;
CREATE POLICY "gateway_backups_read_privileged" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'gateway-backups'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor'])
  );

DROP POLICY IF EXISTS "gateway_backups_insert_privileged" ON storage.objects;
CREATE POLICY "gateway_backups_insert_privileged" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'gateway-backups'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
    -- storage.objects.name, QUALIFIED: public.gateways has a `name` column of its own and would
    -- otherwise capture this reference. See the header block above.
    AND EXISTS (
      SELECT 1 FROM public.gateways g
       WHERE g.sparkplug_id = (storage.foldername(storage.objects.name))[1]
    )
  );

-- UPDATE covers `upsert: true`, which is how storage-js replaces an object that already exists.
-- Both halves are gated: USING decides which existing objects may be targeted, WITH CHECK decides
-- what the result may look like -- so an update cannot move an object out from under the prefix
-- rule that the insert enforced.
DROP POLICY IF EXISTS "gateway_backups_update_privileged" ON storage.objects;
CREATE POLICY "gateway_backups_update_privileged" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'gateway-backups'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
  )
  WITH CHECK (
    bucket_id = 'gateway-backups'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
    -- storage.objects.name, QUALIFIED: public.gateways has a `name` column of its own and would
    -- otherwise capture this reference. See the header block above.
    AND EXISTS (
      SELECT 1 FROM public.gateways g
       WHERE g.sparkplug_id = (storage.foldername(storage.objects.name))[1]
    )
  );

DROP POLICY IF EXISTS "gateway_backups_delete_privileged" ON storage.objects;
CREATE POLICY "gateway_backups_delete_privileged" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'gateway-backups'
    AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
  );


-- ---------------------------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------------------------
-- THESE ARE NEW WORK, not a copy of 0001's, and the reason is worth recording. Up to
-- supabase/postgres:15.6.1.143 the stub schema arrived with ALL privileges already granted on all
-- three storage tables to anon, authenticated, service_role, postgres and supabase_storage_admin
-- alike -- so `anon` held DELETE on storage.buckets at the grant layer, with RLS as the only thing
-- standing in front of it. 0001 then added its own narrower grants on top, which read as the
-- access control but were in practice redundant: nothing had been revoked.
--
-- On 17.6.1.160 the tables are created by storage-api and carry NO grants to these roles at all,
-- so the privileges have to be stated. Stating them means stating only what each role needs, and
-- the result is tighter than the stack ever had on PG15. That is a deliberate narrowing; if
-- something in storage-api turns out to need more, add it here explicitly rather than reaching for
-- the old blanket grant.
--
-- service_role gets the admin surface because it IS the admin path: storage-api assumes this role
-- to serve the Storage REST API, which is how the bucket itself is created (scripts/
-- storage-init.mjs). It bypasses RLS, so the policies above do not constrain it -- the grants are
-- the only limit that applies, which is exactly why it is enumerated rather than given ALL.
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

GRANT SELECT                         ON storage.buckets TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.buckets TO service_role;

GRANT SELECT                         ON storage.objects TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO service_role;

-- Self-check. The failure this guards against is silent in the direction that matters least and
-- loudest in the direction that matters most: a MISSING policy denies, so the 3D model viewer
-- simply shows nothing and nobody reads a log. Assert the set is complete instead.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'asset_3d_models_%';
  IF n <> 4 THEN
    RAISE EXCEPTION 'expected 4 asset_3d_models_* policies on storage.objects, found %', n;
  END IF;
  RAISE NOTICE 'storage policies reconciled (4 policies on storage.objects).';
END $$;

-- A SECOND BLOCK RATHER THAN A WIDER COUNT IN THE FIRST. The assertion above is scoped by prefix
-- and should stay that way: one count of "8 policies" would be satisfied by five of one bucket's
-- and three of the other's, which is precisely the state it exists to rule out.
DO $$
DECLARE
  n int;
  v_auditor_writes int;
BEGIN
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'gateway_backups_%';
  IF n <> 4 THEN
    RAISE EXCEPTION 'expected 4 gateway_backups_* policies on storage.objects, found %', n;
  END IF;

  -- THE ASYMMETRY IS THE POLICY, so it is asserted rather than left to a reading of the SQL above.
  -- Auditor holds SELECT and must hold nothing else; the failure of getting this wrong is silent
  -- and permanent -- an auditor able to overwrite a backup is an auditor able to edit the record
  -- they exist to examine, and nothing would ever error.
  SELECT count(*) INTO v_auditor_writes FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'gateway_backups_%'
     AND cmd <> 'SELECT'
     AND (qual LIKE '%Auditor%' OR with_check LIKE '%Auditor%');
  IF v_auditor_writes <> 0 THEN
    RAISE EXCEPTION
      '% gateway_backups_* write policy/policies name Auditor. Auditor is READ ONLY on this '
      'bucket -- write authority is Administrator and Shopfloor_Manager only.', v_auditor_writes;
  END IF;

  RAISE NOTICE 'gateway-backups policies reconciled (4 policies; Auditor read-only).';
END $$;

-- =============================================================================================
-- broker-captures -- recorded Sparkplug traffic, for playback
-- =============================================================================================
--
-- Modelled on gateway-backups above, with the same four policies, the same role split and the same
-- prefix rule -- and the differences are worth naming rather than left to be inferred.
--
-- WHAT IS IN ONE OF THESE FILES. A capture is a recording of what the plant actually said: every
-- edge node and device id that spoke during the window, every metric name, and the values. A
-- flows.json describes what the edge is CONFIGURED to do; a capture shows what it DID. So the
-- privacy argument for the bucket above applies here at least as strongly.
--
-- THE PREFIX IS THE GATEWAY IT PLAYS BACK AS, NOT THE ONE IT WAS RECORDED FROM, and those are
-- different by construction. `capture.py play` cannot publish under a recorded identity --
-- mosquitto.acl pins the topic's edge-node segment to the connecting username -- so a capture is
-- always rewritten onto one gateway's own assets. Filing it under that gateway is the only prefix
-- that is a fact about the file rather than a guess.
--
-- A CONSEQUENCE THAT IS NOT A LEAK: a capture filed under gateway A can name gateway B, because it
-- records whatever was on the wire. The roles admitted here -- Administrator, Shopfloor_Manager,
-- Auditor -- can already enumerate the whole fleet through the directory, so this reveals nothing
-- the reader could not already look up. It IS the reason nobody below them can read the bucket.
--
-- AUDITOR IS READ ONLY, re-asserted by the reconcile block at the end of this file for the same
-- reason it is asserted for the bucket above: an auditor who can overwrite a capture can edit the
-- evidence they exist to examine, and nothing would ever error.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- TWO CHANGES FROM THE BUCKET ABOVE, BOTH REQUIRED BY THE CAPTURE PAGE (0055, roadmap item 17).
--
-- 1. THE PREFIX RULE ADMITS DEVICES AS WELL AS GATEWAYS. Captures are filed by the SUBJECT
--    RECORDED, and the page records from a gateway OR from a single device. The rule is
--    `public.is_capture_subject_prefix()` rather than an inlined EXISTS so that the two policies
--    below and the gate that builds the path cannot drift apart -- see its comment in 0055.
--
-- 2. THE INGESTION DAEMON MAY WRITE, AND ONLY WRITE. Recording is a server-side act: a browser
--    cannot open an MQTT subscription, mosquitto has no WebSocket listener, and the recording
--    credential is a server-side secret. The daemon is the host, and it authenticates as
--    `Service_Ingestor`, which holds `Operator` -- so without an arm here every capture it records
--    would be uploaded, refused with 42501, caught, logged, and lost. That is 0051's defect
--    exactly: the symptom is a capture that never appears rather than an error anybody sees.
--
--    THE ROADMAP ENTRY CALLED THIS "a SECURITY DEFINER function in 0047's shape", AND IT CANNOT BE.
--    A capture's bytes go through the Storage REST API, not through Postgres; no SQL function can
--    carry a 50 MiB body into a bucket. The row in `storage.objects` is written by storage-api
--    under the caller's own JWT, so the only place this authority can live is a policy arm. The
--    gates in 0055 remain what that paragraph is right about -- they are how `capture_jobs` and
--    `captures` are written -- but the bucket needs this.
--
--    UPDATE IS INCLUDED AND INSERT ALONE IS NOT ENOUGH, which is a deliberate widening beyond what
--    item 17 §1 proposed. Each subject has exactly ONE capture object, at a path derived from its
--    sparkplug id, so a re-record overwrites that key -- and storage-js spells overwrite as
--    `upsert: true`, which needs both. The alternative §1 preferred, deleting browser-side before
--    the job starts, keeps the daemon at INSERT and costs more than it saves: it destroys the old
--    capture before the new one exists, so a recording that then fails leaves nothing, and it needs
--    a browser present at exactly the right moment or the bucket accumulates orphans no policy
--    reaches. Overwriting in place makes an orphan impossible and destroys nothing until the
--    replacement is written.
--
--    THE DAEMON'S ARM IS SCOPED TO THE OBJECT OF THE JOB IT IS RUNNING, not to the bucket. It is
--    `is_ingestion_caller() AND is_active_capture_object(name)`, so with no capture in flight the
--    daemon can reach nothing here at all, and while one is it can reach exactly one path -- the
--    one `start_capture_job()` derived from the subject. See that function's comment in 0055.
--
--    IT READS AS WELL AS WRITES, WHICH THE FIRST VERSION OF THIS REFUSED TO ALLOW AND WAS WRONG
--    ABOUT. Write-only is the obvious posture and it is not achievable: an overwrite is
--    `INSERT ... ON CONFLICT DO UPDATE`, and Postgres checks the SELECT policy for the row being
--    conflicted with, so a principal that cannot read an object cannot replace it. Measured
--    against the running stack, not inferred -- INSERT of a new object returned 200 and the upsert
--    that followed returned `new row violates row-level security policy`. Confined to the active
--    job the read gives up almost nothing: the daemon may read back the file it is at that moment
--    writing, and holds its contents in memory regardless.
--
--    THERE IS STILL NO DELETE ARM. Removing a capture is a human act with a confirmation in front
--    of it, and nothing about recording requires destroying an earlier recording -- the overwrite
--    is what replaces it.
-- ---------------------------------------------------------------------------------------------

-- THREE WAYS IN, AND TWO OF THEM ARE MACHINES CONFINED TO ONE FILE EACH.
--
--   a person          Administrator, Shopfloor_Manager or Auditor, reading the whole bucket
--   the daemon        the object of the capture job it is RECORDING (0055)
--   the worker        the object of the playback job it is RUNNING (0056)
--
-- THE PLAYBACK ARM IS A PREREQUISITE, NOT A REFINEMENT. `Service_Playback` holds `Operator`, so
-- without it every playback fails at the first read with 42501 -- caught, logged, and visible only
-- as a job that failed for a reason nothing surfaces. That is 0051's defect for the third time,
-- which is why it is asserted below rather than trusted to this text.
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
      -- otherwise capture this reference. Same trap as the bucket above documents at length.
      (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
       AND public.is_capture_subject_prefix((storage.foldername(storage.objects.name))[1]))
      OR (public.is_ingestion_caller()
          AND public.is_active_capture_object(storage.objects.name))
    )
  );

-- UPDATE covers `upsert: true`, which is how a re-record replaces the one capture stored for a
-- subject. Both halves are gated: USING decides which existing objects may be targeted, WITH CHECK
-- what the result may look like -- so an update cannot move an object out from under the rule that
-- admitted the insert.
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

  -- THE DAEMON REACHES THREE OF THE FOUR POLICIES, AND EVERY ARM IT HAS IS CONFINED TO ONE FILE.
  --
  -- Too NARROW is silent in the way 0051 was: the daemon uploads, is refused with 42501, catches
  -- it, logs it, and the operator sees a capture that recorded successfully and then never
  -- appeared. SELECT belongs in this count for a reason that is not obvious and was MEASURED
  -- rather than reasoned: replacing a capture is an upsert, which storage-api serves as
  -- `INSERT ... ON CONFLICT DO UPDATE`, and Postgres evaluates that against the SELECT policy as
  -- well -- so omitting the read arm breaks re-recording, and only re-recording.
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
      'seen only as a capture that never appears. See 0055 and roadmap item 17.', v_daemon_writes;
  END IF;

  -- EVERY ONE OF THOSE ARMS MUST BE SCOPED TO THE ACTIVE JOB. A bare `is_ingestion_caller()` is
  -- the widening this design exists to avoid: standing authority over every capture in the bucket,
  -- held by the process most exposed to the plant network. Paired with is_active_capture_object(),
  -- the same principal reaches exactly one path while a capture runs and nothing at all when none
  -- does.
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
  -- THE PLAYBACK WORKER READS, AND DOES NOTHING ELSE.
  --
  -- Missing entirely, every playback fails at its first read with 42501 -- 0051's defect for the
  -- third time on this bucket. Present on any policy but SELECT, a process that already holds
  -- broker publish rights could also overwrite or destroy the recordings it is meant to replay,
  -- which is the one combination worth ruling out explicitly.
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

