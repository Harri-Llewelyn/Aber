-- 0199: A plan no area names is swept from storage, and an area is archived only when no asset is
-- Area-Wide in it.
--
-- An area's plan is an object in the area-plans bucket, named by areas.plan_path. The nightly purge
-- deletes an expired area in SQL, and SQL cannot remove a stored file, so the plan stayed in the
-- bucket for ever, readable by every signed-in role. The dashboard's own removals (Permanent Delete,
-- Replace plan, Remove plan) delete the row first and swallow a failed object delete, so each could
-- strand one too.
--
--   * is_unclaimed_area_plan_object() answers whether no area names an object.
--   * ingest_unclaimed_area_plan_objects() lists the unclaimed objects untouched for a given age, for
--     the ingestion principal alone. The area-plan sweep, an hourly CronJob that runs as that
--     principal (ingestion/area_plan_sweep.py), deletes them through the Storage API. Its first run
--     clears what was stranded before this file.
--   * The area-plans DELETE policy (storage-policies.sql, applied after the migrations) admits the
--     ingestion principal to an unclaimed object only.
--
-- The dashboard uploads a plan before it writes plan_path, so an object younger than the sweep's
-- hour may be an upload in flight; the age is what spares it.
--
-- The purge also skipped an expired area an Area-Wide device or gateway named, for good and without
-- a word, since areas.area_id has no ON DELETE action and one refused DELETE would abort the whole
-- job. So an area is now archived only when nothing is Area-Wide in it, archived assets included,
-- and nothing is made Area-Wide in an archived area. The purge's skip stays as a guard no row
-- reaches. Cells filed in the area do not block: archiving an area keeps its cells filed in it.
--
-- Reasoning: supabase/README.md, "A plan no area names is swept from storage (0199)". Idempotent:
-- the triggers act on their own write alone and no row is changed here, so a replay cannot fail.

-- -------------------------------------------------------------------------------------------------
-- 1. Whether an area names an object
-- -------------------------------------------------------------------------------------------------
-- The area-plans DELETE policy calls this as the caller, so authenticated executes it. Every
-- signed-in role reads areas, so the answer tells nobody more than they could read; SECURITY DEFINER
-- keeps it true whatever a policy on areas later hides from the caller.
CREATE OR REPLACE FUNCTION public.is_unclaimed_area_plan_object(p_name text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    RETURN NOT EXISTS (SELECT 1 FROM public.areas a WHERE a.plan_path = p_name);
END;
$$;

ALTER FUNCTION public.is_unclaimed_area_plan_object(p_name text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_unclaimed_area_plan_object(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.is_unclaimed_area_plan_object(text) TO authenticated;

COMMENT ON FUNCTION public.is_unclaimed_area_plan_object(p_name text) IS
  'True when no area''s plan_path names this area-plans object, archived areas included. The '
  'bucket''s DELETE policy admits the ingestion principal to such an object alone, so the plan an '
  'area shows cannot be swept while the area stands (0199).';

-- -------------------------------------------------------------------------------------------------
-- 2. The objects the sweep may delete
-- -------------------------------------------------------------------------------------------------
-- storage.objects is storage-api's, created by its own migrations, so it is reached by name at run
-- time. At most 500 a call; the sweep asks again after a full answer.
CREATE OR REPLACE FUNCTION public.ingest_unclaimed_area_plan_objects(p_min_age_seconds integer DEFAULT 3600) RETURNS text[]
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_names text[];
BEGIN
    PERFORM public.require_ingestion_caller('ingest_unclaimed_area_plan_objects');

    IF to_regclass('storage.objects') IS NULL THEN
        RETURN '{}'::text[];
    END IF;
    EXECUTE 'SELECT coalesce(array_agg(n.name ORDER BY n.name), ''{}''::text[]) FROM ('
            '  SELECT o.name FROM storage.objects o'
            '   WHERE o.bucket_id = ''area-plans'''
            '     AND coalesce(o.updated_at, o.created_at) <= now() - make_interval(secs => greatest($1, 0))'
            '     AND public.is_unclaimed_area_plan_object(o.name)'
            '   ORDER BY o.name LIMIT 500) n'
       INTO v_names USING p_min_age_seconds;
    RETURN v_names;
END;
$$;

ALTER FUNCTION public.ingest_unclaimed_area_plan_objects(p_min_age_seconds integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ingest_unclaimed_area_plan_objects(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ingest_unclaimed_area_plan_objects(integer) TO authenticated;

COMMENT ON FUNCTION public.ingest_unclaimed_area_plan_objects(p_min_age_seconds integer) IS
  'Up to 500 area-plans objects no area names (is_unclaimed_area_plan_object), untouched for at least '
  'p_min_age_seconds. The area-plan sweep CronJob deletes them through the Storage API every hour, '
  'asking for an hour, which spares a plan uploaded and not yet recorded on its area: the plan of an '
  'area the purge deleted, one replaced or removed whose delete failed, and anything else in the '
  'bucket. Ingestion principal only (0199).';

-- -------------------------------------------------------------------------------------------------
-- 3. An area is archived only when nothing is Area-Wide in it
-- -------------------------------------------------------------------------------------------------
-- On the transition only, as refuse_archiving_the_last_shadow_gateway() is: an edit to an archived
-- area and its restore pass. Every device and gateway counts, archived and quarantined included,
-- because each one's area_id would hold the purge off.
CREATE OR REPLACE FUNCTION public.refuse_archiving_an_area_with_area_wide_assets() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_devices  integer;
    v_gateways integer;
    v_names    text;
    v_held     text;
BEGIN
    IF NOT NEW.is_archived OR coalesce(OLD.is_archived, false) THEN
        RETURN NEW;
    END IF;

    SELECT count(*) INTO v_devices FROM public.devices d WHERE d.area_id = NEW.id;
    SELECT count(*), string_agg(g.name, ', ' ORDER BY g.name)
      INTO v_gateways, v_names
      FROM public.gateways g WHERE g.area_id = NEW.id;
    IF v_devices = 0 AND v_gateways = 0 THEN
        RETURN NEW;
    END IF;

    v_held := concat_ws(' and ',
        CASE WHEN v_devices > 0 THEN v_devices || ' Area-Wide device' || CASE WHEN v_devices = 1 THEN '' ELSE 's' END END,
        CASE WHEN v_gateways > 0 THEN v_gateways || ' Area-Wide gateway' || CASE WHEN v_gateways = 1 THEN '' ELSE 's' END END);
    RAISE EXCEPTION
      'area "%" still holds %. Make each one Site-Wide or put it in a cell, or delete it, then '
      'archive the area.%', NEW.name, v_held,
      CASE WHEN v_names IS NOT NULL THEN ' Gateways: ' || v_names || '.' ELSE '' END
        USING ERRCODE = 'restrict_violation';
END;
$$;

ALTER FUNCTION public.refuse_archiving_an_area_with_area_wide_assets() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_archiving_an_area_with_area_wide_assets() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.refuse_archiving_an_area_with_area_wide_assets() IS
  'BEFORE UPDATE OF is_archived on areas: refuses archiving an area while any device or gateway is '
  'Area-Wide in it (area_id), archived ones included, naming the counts, the gateways and the way '
  'out. The nightly purge cannot delete such an area, so its Auto-purge date would never be kept '
  '(0199).';

SELECT public.replay_trigger('public.areas', 'trg_areas_archived_only_when_nothing_is_area_wide', $ddl$
CREATE TRIGGER trg_areas_archived_only_when_nothing_is_area_wide BEFORE UPDATE OF is_archived ON public.areas FOR EACH ROW EXECUTE FUNCTION public.refuse_archiving_an_area_with_area_wide_assets();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 4. Nothing is made Area-Wide in an archived area
-- -------------------------------------------------------------------------------------------------
-- Whoever writes it: the device and gateway forms, approve_proposal(), a direct PATCH. A write that
-- leaves area_id as it was passes, so an edit to anything already there is not refused.
CREATE OR REPLACE FUNCTION public.refuse_area_wide_in_an_archived_area() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_area text;
BEGIN
    IF NEW.area_id IS NULL
       OR (TG_OP = 'UPDATE' AND NEW.area_id IS NOT DISTINCT FROM OLD.area_id) THEN
        RETURN NEW;
    END IF;

    SELECT a.name INTO v_area FROM public.areas a WHERE a.id = NEW.area_id AND a.is_archived;
    IF FOUND THEN
        RAISE EXCEPTION
          'area "%" is archived, so % "%" cannot be made Area-Wide in it. Restore the area first, or '
          'choose another.', v_area, CASE WHEN TG_TABLE_NAME = 'devices' THEN 'device' ELSE 'gateway' END,
          NEW.name
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.refuse_area_wide_in_an_archived_area() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_area_wide_in_an_archived_area() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.refuse_area_wide_in_an_archived_area() IS
  'BEFORE INSERT OR UPDATE OF area_id on devices and gateways: refuses making a device or gateway '
  'Area-Wide in an archived area, so an archived area stays one nothing names. A write that leaves '
  'area_id unchanged passes (0199).';

SELECT public.replay_trigger('public.devices', 'trg_devices_not_area_wide_in_an_archived_area', $ddl$
CREATE TRIGGER trg_devices_not_area_wide_in_an_archived_area BEFORE INSERT OR UPDATE OF area_id ON public.devices FOR EACH ROW EXECUTE FUNCTION public.refuse_area_wide_in_an_archived_area();
$ddl$);

SELECT public.replay_trigger('public.gateways', 'trg_gateways_not_area_wide_in_an_archived_area', $ddl$
CREATE TRIGGER trg_gateways_not_area_wide_in_an_archived_area BEFORE INSERT OR UPDATE OF area_id ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.refuse_area_wide_in_an_archived_area();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- Self-check: this file's own declarations
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
      'public.is_unclaimed_area_plan_object(text)',
      'public.ingest_unclaimed_area_plan_objects(integer)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0199: anon may execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0199: authenticated may not execute %, which the area-plan sweep or the '
        'area-plans DELETE policy calls', v_fn;
    END IF;
  END LOOP;

  -- The policy's answer does not depend on what the caller may read of areas.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
              WHERE p.oid = 'public.is_unclaimed_area_plan_object(text)'::regprocedure
                AND (l.lanname <> 'plpgsql' OR NOT p.prosecdef)) THEN
    RAISE EXCEPTION '0199: is_unclaimed_area_plan_object() is not a SECURITY DEFINER plpgsql function';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
      'public.areas trg_areas_archived_only_when_nothing_is_area_wide',
      'public.devices trg_devices_not_area_wide_in_an_archived_area',
      'public.gateways trg_gateways_not_area_wide_in_an_archived_area'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = split_part(v_fn, ' ', 1)::regclass
                      AND t.tgname = split_part(v_fn, ' ', 2)
                      AND t.tgenabled <> 'D') THEN
      RAISE EXCEPTION '0199: % is missing or disabled, so an archived area could be one an asset names', v_fn;
    END IF;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
