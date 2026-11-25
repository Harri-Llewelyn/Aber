-- 0326: A refused cell archive names the drawer action as the Cells page does.
--
-- refuse_archiving_an_occupied_cell() (0198) told its caller to use Show Its Devices in the cell's panel.
-- An action that opens a page is named View in <page>, so that one is View in Devices. The HINT
-- says so. The body is otherwise 0198's, and so are its owner, its grants, its comment and its trigger.
--
-- Reasoning: supabase/README.md, "A refused cell archive names the drawer action (0326)". Idempotent.
--
-- Redefines public.refuse_archiving_an_occupied_cell: 0326 says View in Devices in the HINT; 0198 said
--   Show Its Devices, which the action is no longer named

-- SECURITY DEFINER so the counts see every row, whoever archives.
CREATE OR REPLACE FUNCTION public.refuse_archiving_an_occupied_cell() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_devices  integer;
  v_gateways integer;
  v_names    text;
  v_holds    text;
BEGIN
  -- On the transition only: restoring a cell, and editing or purging an archived one, pass.
  IF NOT coalesce(NEW.is_archived, false) OR coalesce(OLD.is_archived, false) THEN
    RETURN NEW;
  END IF;

  -- In it means what device_locations resolves: own cell, else the gateway's. A device behind a
  -- simulated gateway or the Playback gateway resolves to no cell, so it does not count.
  SELECT count(*) INTO v_devices
    FROM public.device_locations dl
   WHERE dl.effective_cell_id = NEW.id;

  -- Named, because the Gateways page has no cell filter to find them by.
  SELECT count(*), string_agg(g.name, ', ' ORDER BY g.name)
    INTO v_gateways, v_names
    FROM public.gateways g
   WHERE g.cell_id = NEW.id;

  IF v_devices = 0 AND v_gateways = 0 THEN
    RETURN NEW;
  END IF;

  v_holds := concat_ws(' and ',
    CASE WHEN v_devices > 0 THEN v_devices || CASE WHEN v_devices = 1 THEN ' device' ELSE ' devices' END END,
    CASE WHEN v_gateways > 0
         THEN v_gateways || CASE WHEN v_gateways = 1 THEN ' gateway' ELSE ' gateways' END || ' (' || v_names || ')'
    END);

  RAISE EXCEPTION 'cell "%" still holds %. Move %, or delete %, then archive the cell.',
    NEW.name, v_holds,
    CASE WHEN v_devices + v_gateways = 1 THEN 'it to another cell' ELSE 'them to another cell' END,
    CASE WHEN v_devices + v_gateways = 1 THEN 'it' ELSE 'them' END
    USING ERRCODE = 'restrict_violation',
          HINT = 'View in Devices, in the cell''s panel on the Cells page, lists them on the Devices '
                 'page. An archived device or gateway is restored, moved and archived again. A '
                 'quarantined device is approved into another place, or rejected.';
END $$;

ALTER FUNCTION public.refuse_archiving_an_occupied_cell() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_archiving_an_occupied_cell() FROM PUBLIC, anon, authenticated;

-- Self-check: the HINT names the action, and no API role may call the function.
DO $check$
BEGIN
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.refuse_archiving_an_occupied_cell()'::regprocedure)
     NOT LIKE '%HINT = ''View in Devices, in the cell''''s panel on the Cells page,%' THEN
    RAISE EXCEPTION '0326: the refusal to archive an occupied cell does not name View in Devices';
  END IF;
  IF has_function_privilege('anon', 'public.refuse_archiving_an_occupied_cell()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.refuse_archiving_an_occupied_cell()', 'EXECUTE') THEN
    RAISE EXCEPTION '0326: an API role may execute refuse_archiving_an_occupied_cell()';
  END IF;
END
$check$;
