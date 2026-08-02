-- Migration: 20260101000035_asset_3d_models.sql
-- Description: Attach a 3D visual model to a device, stored in Supabase Storage and exported as an
-- AAS `File` element in a VisualRepresentation submodel.
--
-- WHAT IS STORED HERE IS A PATH, NOT A URL, and that is the whole design decision.
--
-- `model_3d_path` holds the object's key within the bucket -- `<device_uuid>/<filename>` -- never
-- `http://localhost:54321/storage/v1/object/public/...`. A stored URL bakes in the origin of the
-- stack that happened to perform the upload, so the row would be wrong the moment the deployment
-- moved behind a real hostname, and every consumer would be serving dead links with no way to tell
-- which part was stale. The public URL is composed at read time from a configurable base, exactly
-- as `AAS_BASE_IRI` and `AAS_HISTORIAN_ENDPOINT` already are for the shell's other outbound
-- references. Same reasoning, same place it is applied: the exporter.
--
-- THE BUCKET ITSELF IS NOT CREATED HERE. `storage.buckets` belongs to storage-api, which migrates
-- that schema when it boots -- and supabase-db-init replays these migrations well before that
-- happens. On a fresh stack the schema is still the supabase/postgres stub, which has no `public`
-- column at all, so a bucket created from here could not be marked public and would come up
-- private on first boot. `scripts/storage-init.mjs` creates it through the Storage REST API once
-- storage-api is healthy. The POLICIES below are a different matter and do belong in a migration:
-- they are on `storage.objects`, which exists from the stub onward, and they are the access
-- control -- keeping them beside the rest of the RLS is what makes them reviewable.

ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS model_3d_path TEXT;

COMMENT ON COLUMN public.devices.model_3d_path IS
  'Object key of this device''s 3D model within the asset-3d-models bucket (<device_uuid>/<filename>). Never a URL -- the public URL is composed at export time from a configurable base.';

-- Constrains the shape as well as the extension.
--
-- The extension list is the real control on what can be referenced. The bucket''s allowed_mime_types
-- cannot be, because browsers report .obj and .stl inconsistently -- often as application/octet-stream
-- or as nothing at all, since the OS has no mapping for them -- so the bucket has to accept
-- octet-stream and the extension is what remains to discriminate on. It is also what the exporter
-- derives the AAS `contentType` from, so an unrecognised extension here would become an unresolvable
-- media type in a published shell.
--
-- The leading segment is required to be a UUID because the storage policies below authorise writes
-- by that segment. A path that did not start with the device id could be written into another
-- device''s prefix.
ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_model_3d_path_shape;
ALTER TABLE public.devices ADD CONSTRAINT devices_model_3d_path_shape
  CHECK (
    model_3d_path IS NULL
    OR model_3d_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+\.(gltf|glb|obj|stl)$'
  );

-- ---------------------------------------------------------------------------------------------
-- Storage policies for the asset-3d-models bucket
-- ---------------------------------------------------------------------------------------------
--
-- READ IS PUBLIC, and that is a deliberate disclosure rather than an oversight. An AAS `File`
-- element carries a URL that an arbitrary AAS viewer -- not necessarily one holding a Factory+
-- session -- has to be able to dereference, which is the entire reason the shell is exportable. A
-- signed URL would expire and turn every exported shell into a time bomb. What follows from that:
-- a 3D model in this bucket is world-readable to anyone who learns its path, so it must carry no
-- more sensitive information than the geometry of the machine. Nothing else is public; the bucket
-- is scoped to this one purpose precisely so the blast radius is a fixed, reviewable set.
--
-- WRITES ARE NOT MERELY "authenticated". Uploading a model is a device configuration change: it
-- alters what an exported shell publishes about the asset, and it publishes bytes at a public URL.
-- Both are exactly the authority `device:manage` grants, which is held by Administrator and
-- Shopfloor_Manager. Letting any authenticated session write would let a read-only Operator or
-- Auditor -- roles that cannot rename a device -- put arbitrary content at a public URL under that
-- device''s prefix. Fail-closed, same posture as every other write policy in this schema.

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

-- UPDATE covers the `upsert: true` replace path -- storage-api updates the object row rather than
-- inserting a second one when a model is replaced under the same key.
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

-- storage-api evaluates these policies while impersonating the caller's role, so `authenticated`
-- needs to reach both the table and the helper. has_role() is SECURITY DEFINER, so this grants the
-- ability to ask the question, not to read user_roles.
GRANT USAGE ON SCHEMA storage TO anon, authenticated;
GRANT SELECT ON storage.objects TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
GRANT SELECT ON storage.buckets TO anon, authenticated;

-- The CHECK is the contract the exporter relies on: it derives the AAS contentType from the
-- extension, so a path it cannot classify would become an unresolvable media type in a published
-- shell. Assert it rejects rather than trusting the regex was written correctly -- the same
-- self-verifying discipline as migration 0029's mutability probe and 0033's schema assertion.
DO $$
DECLARE
    probe_id UUID := '00000000-0000-4000-8000-0000000035aa';
    rejected BOOLEAN := FALSE;
BEGIN
    DELETE FROM public.devices WHERE id = probe_id;
    INSERT INTO public.devices (id, name, status)
    VALUES (probe_id, 'migration-0035-probe', 'OFFLINE');

    BEGIN
        UPDATE public.devices SET model_3d_path = 'not-a-uuid/model.exe' WHERE id = probe_id;
    EXCEPTION WHEN check_violation THEN
        rejected := TRUE;
    END;

    IF NOT rejected THEN
        DELETE FROM public.devices WHERE id = probe_id;
        RAISE EXCEPTION 'devices_model_3d_path_shape accepted an invalid path; the exporter cannot derive a contentType from it';
    END IF;

    -- And that a well-formed one is accepted, so the constraint is not merely rejecting everything.
    UPDATE public.devices
       SET model_3d_path = probe_id || '/probe.glb'
     WHERE id = probe_id;

    DELETE FROM public.devices WHERE id = probe_id;
    -- log_digital_thread_event() fired for the probe. Remove its audit rows too: the table is
    -- append-only and a migration that replays on every boot would otherwise grow it forever.
    DELETE FROM public.digital_thread WHERE entity_id = probe_id;
END $$;
