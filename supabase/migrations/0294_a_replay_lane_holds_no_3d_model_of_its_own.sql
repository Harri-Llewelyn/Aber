-- 0294: A replay lane holds no 3D model of its own.
--
-- The device drawer offered the 3D model upload on every device, a replay lane included. The file
-- went to asset-3d-models/<lane id>/<file> and the lane's model_3d_path named it. So the same model
-- was uploaded twice, once for the machine and once for its lane, and a lane could show a model its
-- machine lacked. A lane is a recording of a machine, not a second asset, so the model is the
-- machine's, and the lane shows it.
--
--   * A model a lane already holds moves, or is cleared. Where the machine has none, the machine's
--     model_3d_path takes the lane's path and the lane's is cleared. Where the machine has one, the
--     lane's is cleared. The object is NEVER copied, moved or deleted: devices_model_3d_path_shape
--     checks the shape of a path and not whose id it carries, and the bucket is public-read, so a
--     machine reads an object under its lane's id as it reads one under its own. A lane with a model
--     is found by shadow_of, so a lane whose machine is gone (shadow_of is NULL) is not a lane
--     here and keeps its path. Each row moved or cleared is named in a NOTICE. The UPDATEs write an
--     Audit Trail row each, attributed to the migration.
--   * devices_a_replay_lane_has_no_model keeps model_3d_path NULL where shadow_of is set. It is
--     added after the move, and validated.
--   * is_replay_lane_model_path() says whether an object's first folder is a lane's id. The
--     asset-3d-models INSERT and UPDATE policies (storage-policies.sql, applied after the
--     migrations) refuse such an object, so the Storage API cannot put a model under a lane either.
--     DELETE and SELECT are unchanged: a machine that took a lane's object removes it as it removes
--     its own.
--
-- Nothing a lane exports carries a model of its own after this: aas-export reads the lane's own
-- model_3d_path, which is NULL.
--
-- Reasoning: supabase/README.md, "A replay lane holds no 3D model of its own (0294)". Idempotent:
-- the move finds no lane with a model once the CHECK is in place, and the function and the CHECK
-- are stated again only where they differ.

-- -------------------------------------------------------------------------------------------------
-- 1. Whether an object is under a replay lane's id
-- -------------------------------------------------------------------------------------------------
-- The asset-3d-models INSERT and UPDATE policies call this as the caller, so authenticated executes
-- it. The folder is read as a uuid only when it is shaped like one, so a name such as
-- '__probe__/x.bin' or 'x.bin' is not a lane's. SECURITY DEFINER keeps the answer true whatever a
-- policy on devices later hides from the caller.
CREATE OR REPLACE FUNCTION public.is_replay_lane_model_path(p_name text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    IF p_name IS NULL
       OR p_name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' THEN
        RETURN false;
    END IF;
    RETURN EXISTS (SELECT 1 FROM public.devices d
                    WHERE d.shadow_of IS NOT NULL
                      AND d.id = split_part(p_name, '/', 1)::uuid);
END;
$$;

ALTER FUNCTION public.is_replay_lane_model_path(p_name text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_replay_lane_model_path(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.is_replay_lane_model_path(text) TO authenticated;

COMMENT ON FUNCTION public.is_replay_lane_model_path(p_name text) IS
  'True when the first folder of an asset-3d-models object name is the id of a replay lane (a '
  'device with shadow_of set). The bucket''s INSERT and UPDATE policies refuse such an object, so a '
  'model is stored under a machine and never under its lane (0294).';

-- -------------------------------------------------------------------------------------------------
-- 2. The models lanes already hold: moved to the machine, or cleared
-- -------------------------------------------------------------------------------------------------
-- In the order the lanes were made, so a machine with two lanes that both hold a model takes the
-- older one's and the later one's is cleared. The machine is read again for each lane, because an
-- earlier lane may have just given it one. A machine that is itself a lane takes nothing (no lane
-- stands in for a lane, so none should exist), and the lane's model is cleared.
DO $move$
DECLARE
  v_lane record;
  v_machine record;
  v_why text;
  v_moved integer := 0;
  v_cleared integer := 0;
BEGIN
  FOR v_lane IN
    SELECT l.id, l.name, l.shadow_of, l.model_3d_path
      FROM public.devices l
     WHERE l.shadow_of IS NOT NULL
       AND l.model_3d_path IS NOT NULL
     ORDER BY l.created_at, l.id
       FOR UPDATE OF l
  LOOP
    SELECT m.id, m.name, m.shadow_of, m.model_3d_path INTO v_machine
      FROM public.devices m
     WHERE m.id = v_lane.shadow_of
       FOR UPDATE OF m;

    IF FOUND AND v_machine.shadow_of IS NULL AND v_machine.model_3d_path IS NULL THEN
      UPDATE public.devices SET model_3d_path = v_lane.model_3d_path WHERE id = v_machine.id;
      UPDATE public.devices SET model_3d_path = NULL WHERE id = v_lane.id;
      v_moved := v_moved + 1;
      RAISE NOTICE '0294: replay lane % (%) held the 3D model %; its machine % (%) had none, so the machine now holds it. The file stays where it is.',
        v_lane.name, v_lane.id, v_lane.model_3d_path, v_machine.name, v_machine.id;
    ELSE
      v_why := CASE WHEN NOT FOUND THEN 'its machine is gone'
                    WHEN v_machine.shadow_of IS NOT NULL THEN format('%s (%s) is itself a lane', v_machine.name, v_machine.id)
                    ELSE format('its machine %s (%s) already has the model %s', v_machine.name, v_machine.id, v_machine.model_3d_path) END;
      UPDATE public.devices SET model_3d_path = NULL WHERE id = v_lane.id;
      v_cleared := v_cleared + 1;
      RAISE NOTICE '0294: replay lane % (%) held the 3D model %; the lane no longer holds it, because %. The file stays in the bucket.',
        v_lane.name, v_lane.id, v_lane.model_3d_path, v_why;
    END IF;
  END LOOP;

  IF v_moved + v_cleared > 0 THEN
    RAISE NOTICE '0294: % lane model(s) moved to their machines, % cleared', v_moved, v_cleared;
  END IF;
END
$move$;

-- -------------------------------------------------------------------------------------------------
-- 3. The CHECK
-- -------------------------------------------------------------------------------------------------
-- Added after the move, so it finds no row to refuse, and validated in its own statement. It is
-- declared as 0001 declares a constraint: compared by live_constraint_definition() and added only
-- where it is missing or reads otherwise, so a replay scans nothing and keeps the oid.
DO $c$
DECLARE
  v_want CONSTANT text := 'CHECK (((shadow_of IS NULL) OR (model_3d_path IS NULL)))';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_a_replay_lane_has_no_model'
                AND conrelid = 'public.devices'::regclass
                AND replace(public.live_constraint_definition(conrelid, conname), ' NOT VALID', '') <> v_want) THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_a_replay_lane_has_no_model;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_a_replay_lane_has_no_model'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE public.devices
        ADD CONSTRAINT devices_a_replay_lane_has_no_model
        CHECK (((shadow_of IS NULL) OR (model_3d_path IS NULL))) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_a_replay_lane_has_no_model'
                AND conrelid = 'public.devices'::regclass
                AND NOT convalidated) THEN
    ALTER TABLE public.devices VALIDATE CONSTRAINT devices_a_replay_lane_has_no_model;
  END IF;
END
$c$;

COMMENT ON CONSTRAINT devices_a_replay_lane_has_no_model ON public.devices IS
  'A replay lane (shadow_of set) holds no 3D model: its machine''s is shown in its place. The '
  'object key of a model that was a lane''s is the machine''s now (0294).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_want CONSTANT text := 'CHECK (((shadow_of IS NULL) OR (model_3d_path IS NULL)))';
BEGIN
  IF public.live_constraint_definition('public.devices'::regclass, 'devices_a_replay_lane_has_no_model')
       IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION '0294: devices_a_replay_lane_has_no_model is missing or reads %, not %',
      coalesce(public.live_constraint_definition('public.devices'::regclass, 'devices_a_replay_lane_has_no_model'),
               'nothing'), v_want;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.devices'::regclass
                AND conname = 'devices_a_replay_lane_has_no_model' AND NOT convalidated) THEN
    RAISE EXCEPTION '0294: devices_a_replay_lane_has_no_model is NOT VALID, so a lane may still hold a model';
  END IF;
  IF EXISTS (SELECT 1 FROM public.devices WHERE shadow_of IS NOT NULL AND model_3d_path IS NOT NULL) THEN
    RAISE EXCEPTION '0294: a replay lane still holds a 3D model';
  END IF;

  IF has_function_privilege('anon', 'public.is_replay_lane_model_path(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0294: anon may execute is_replay_lane_model_path()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.is_replay_lane_model_path(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0294: authenticated may not execute is_replay_lane_model_path(), which the asset-3d-models INSERT and UPDATE policies call';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                  WHERE p.oid = 'public.is_replay_lane_model_path(text)'::regprocedure
                    AND l.lanname = 'plpgsql' AND p.prosecdef) THEN
    RAISE EXCEPTION '0294: is_replay_lane_model_path() is not a SECURITY DEFINER plpgsql function';
  END IF;
  -- A name that is no lane's, whatever it holds, is answered false and never raises.
  IF public.is_replay_lane_model_path(NULL) OR public.is_replay_lane_model_path('')
     OR public.is_replay_lane_model_path('__probe__/x.bin') OR public.is_replay_lane_model_path('x.bin')
     OR public.is_replay_lane_model_path('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz/x.glb') THEN
    RAISE EXCEPTION '0294: is_replay_lane_model_path() answers true for a name that is no lane''s';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
