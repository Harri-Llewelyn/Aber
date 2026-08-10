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
