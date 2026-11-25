-- 0329: A 3D model no device names is swept from storage.
--
-- A device's 3D model is an object in the asset-3d-models bucket, named by devices.model_3d_path. The
-- dashboard deletes the file a Replace or a Remove leaves, and swallows a failed delete. Until 1.10.0 a
-- Replace with a file of another name deleted nothing. A device rejected from Quarantine, or deleted
-- without being archived first, left its file too. The bucket is public, so each stayed open to anyone
-- with its link, and no page listed it.
--
--   * is_unclaimed_device_model_object() answers whether anything names an object: a device, the
--     tombstone of a retired one (retired_entities), or an open change proposal.
--   * ingest_unclaimed_device_model_objects() lists the unclaimed objects untouched for a given age, for
--     the ingestion principal alone. The device-model sweep, an hourly CronJob that runs as that
--     principal (ingestion/device_model_sweep.py), deletes the ones a day old through the Storage API.
--     Its first run clears what was left before this file.
--   * The asset-3d-models SELECT and DELETE policies (storage-policies.sql, applied after the
--     migrations) admit the ingestion principal to an unclaimed object only.
--
-- The dashboard uploads a model before it writes model_3d_path, so a young object may be an upload in
-- flight; the age is what spares it.
--
-- Reasoning: supabase/README.md, "A 3D model no device names is swept from storage (0329)". Idempotent:
-- it declares two functions and changes no row.

-- -------------------------------------------------------------------------------------------------
-- 1. Whether anything names an object
-- -------------------------------------------------------------------------------------------------
-- Two of the bucket's policies call this as the caller, so authenticated executes it. SECURITY DEFINER,
-- because a tombstone and a proposal are hidden from most callers, and an answer that left them out
-- would be yes. Any device counts, archived, quarantined or a replay lane, and whichever folder the
-- object is in: a machine may name a file stored under its lane's id (0294).
CREATE OR REPLACE FUNCTION public.is_unclaimed_device_model_object(p_name text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    -- No device at all is a database being restored, not a site that names nothing.
    IF NOT EXISTS (SELECT 1 FROM public.devices) THEN
        RETURN false;
    END IF;

    RETURN NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.model_3d_path = p_name)
       -- The last record of a deleted device names its model, and so may a bundle exported from it.
       AND NOT EXISTS (SELECT 1 FROM public.retired_entities r
                        WHERE r.entity_type = 'devices' AND r.old_data ->> 'model_3d_path' = p_name)
       -- model_3d_path is a proposable column, and approving writes what the proposal named.
       AND NOT EXISTS (SELECT 1 FROM public.change_proposals p
                        WHERE p.entity_type = 'devices' AND p.status = 'open'
                          AND p.patch ->> 'model_3d_path' = p_name);
END;
$$;

ALTER FUNCTION public.is_unclaimed_device_model_object(p_name text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_unclaimed_device_model_object(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.is_unclaimed_device_model_object(text) TO authenticated;

COMMENT ON FUNCTION public.is_unclaimed_device_model_object(p_name text) IS
  'True when no device''s model_3d_path names this asset-3d-models object, archived devices and replay '
  'lanes included, nor the tombstone of a retired device, nor an open change proposal. False while there '
  'is no device at all. The bucket''s SELECT and DELETE policies admit the ingestion principal to such an '
  'object alone, so the model a device shows cannot be swept (0329).';

-- -------------------------------------------------------------------------------------------------
-- 2. The objects the sweep may delete
-- -------------------------------------------------------------------------------------------------
-- storage.objects is storage-api's, created by its own migrations, so it is reached by name at run
-- time. At most 500 a call; the sweep asks again after a full answer.
CREATE OR REPLACE FUNCTION public.ingest_unclaimed_device_model_objects(p_min_age_seconds integer DEFAULT 86400) RETURNS text[]
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_names text[];
BEGIN
    PERFORM public.require_ingestion_caller('ingest_unclaimed_device_model_objects');

    IF to_regclass('storage.objects') IS NULL THEN
        RETURN '{}'::text[];
    END IF;
    EXECUTE 'SELECT coalesce(array_agg(n.name ORDER BY n.name), ''{}''::text[]) FROM ('
            '  SELECT o.name FROM storage.objects o'
            '   WHERE o.bucket_id = ''asset-3d-models'''
            '     AND coalesce(o.updated_at, o.created_at) <= now() - make_interval(secs => greatest($1, 0))'
            '     AND public.is_unclaimed_device_model_object(o.name)'
            '   ORDER BY o.name LIMIT 500) n'
       INTO v_names USING p_min_age_seconds;
    RETURN v_names;
END;
$$;

ALTER FUNCTION public.ingest_unclaimed_device_model_objects(p_min_age_seconds integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ingest_unclaimed_device_model_objects(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ingest_unclaimed_device_model_objects(integer) TO authenticated;

COMMENT ON FUNCTION public.ingest_unclaimed_device_model_objects(p_min_age_seconds integer) IS
  'Up to 500 asset-3d-models objects nothing names (is_unclaimed_device_model_object), untouched for at '
  'least p_min_age_seconds. The device-model sweep CronJob deletes them through the Storage API every '
  'hour, asking for a day, which spares a model uploaded and not yet recorded on its device: a file a '
  'Replace left before 1.10.0, one whose delete failed, the model of a device deleted without a '
  'tombstone, and anything else in the bucket. Ingestion principal only (0329).';

-- -------------------------------------------------------------------------------------------------
-- Self-check: this file's own declarations
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn  text;
  v_src text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
      'public.is_unclaimed_device_model_object(text)',
      'public.ingest_unclaimed_device_model_objects(integer)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0329: anon may execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0329: authenticated may not execute %, which the device-model sweep or the '
        'asset-3d-models policies call', v_fn;
    END IF;
  END LOOP;

  -- The policies' answer does not depend on what the caller may read of a tombstone or a proposal.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
              WHERE p.oid = 'public.is_unclaimed_device_model_object(text)'::regprocedure
                AND (l.lanname <> 'plpgsql' OR NOT p.prosecdef)) THEN
    RAISE EXCEPTION '0329: is_unclaimed_device_model_object() is not a SECURITY DEFINER plpgsql function';
  END IF;

  v_src := (SELECT prosrc FROM pg_proc WHERE oid = 'public.is_unclaimed_device_model_object(text)'::regprocedure);
  FOREACH v_fn IN ARRAY ARRAY['public.devices d', 'public.retired_entities r', 'public.change_proposals p'] LOOP
    IF position(v_fn IN v_src) = 0 THEN
      RAISE EXCEPTION '0329: is_unclaimed_device_model_object() does not read %, so a model it names would be swept', v_fn;
    END IF;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
