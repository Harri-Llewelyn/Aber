-- 0198: A cell is archived only when nothing is in it.
--
-- Archiving a cell checked nothing, and its devices stayed in it: `device_locations` never reads
-- `cells.is_archived`, so the UNS kept publishing them under the archived cell's name, i3X moved
-- them up to the area, and the Site Map showed them nowhere. Three refusals, for every role:
--
--   * a cell is not archived while any device resolves to it (`device_locations.effective_cell_id`,
--     any lifecycle) or any gateway is filed in it (archived ones included);
--   * no device or gateway is filed in an archived cell, by INSERT or UPDATE;
--   * no device is assigned to an archived gateway.
--
-- Each acts only on its own write, and a write that leaves the column as it was passes. So no row
-- is changed here, and a replay over any database cannot fail.
--
-- Reasoning: supabase/README.md, "A cell is archived only when nothing is in it (0198)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. A cell that holds anything is not archived
-- -------------------------------------------------------------------------------------------------
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
          HINT = 'Show Its Devices, in the cell''s panel on the Cells page, lists them on the Devices '
                 'page. An archived device or gateway is restored, moved and archived again. A '
                 'quarantined device is approved into another place, or rejected.';
END $$;

ALTER FUNCTION public.refuse_archiving_an_occupied_cell() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_archiving_an_occupied_cell() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.refuse_archiving_an_occupied_cell() IS 'Refuses archiving a cell while any device resolves to it (device_locations.effective_cell_id, whatever the device''s lifecycle) or any gateway is filed in it, archived gateways included. Acts on the transition only, so a restore, an edit of an archived cell and the purge pass. The error counts both and names the gateways (0198).';

SELECT public.replay_trigger('public.cells', 'trg_cells_archived_only_when_empty', $ddl$
CREATE TRIGGER trg_cells_archived_only_when_empty BEFORE UPDATE OF is_archived ON public.cells FOR EACH ROW EXECUTE FUNCTION public.refuse_archiving_an_occupied_cell();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 2. Nothing is filed in an archived cell
-- -------------------------------------------------------------------------------------------------
-- One function for `devices` and `gateways`, which both carry `cell_id` and `name`.
CREATE OR REPLACE FUNCTION public.refuse_filing_in_an_archived_cell() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_cell public.cells%ROWTYPE;
BEGIN
  -- NULL passes, so a deleted cell's ON DELETE SET NULL still un-files what was in it. A PATCH
  -- sends the whole row, so an unchanged cell_id passes too.
  IF NEW.cell_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.cell_id IS NOT DISTINCT FROM OLD.cell_id) THEN
    RETURN NEW;
  END IF;

  -- FOR SHARE waits out an archive of this cell in flight, so the two cannot both commit.
  SELECT * INTO v_cell FROM public.cells WHERE id = NEW.cell_id FOR SHARE;
  IF NOT FOUND OR NOT v_cell.is_archived THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% "%" cannot be put in cell "%", which is archived. Restore the cell first, or choose another.',
    CASE TG_TABLE_NAME WHEN 'devices' THEN 'device' ELSE 'gateway' END, NEW.name, v_cell.name
    USING ERRCODE = 'check_violation';
END $$;

ALTER FUNCTION public.refuse_filing_in_an_archived_cell() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_filing_in_an_archived_cell() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.refuse_filing_in_an_archived_cell() IS 'Refuses a device or gateway INSERTed or UPDATEd with a cell_id that names an archived cell, whoever writes it: a PATCH, relocate_devices(), approve_proposal() or approve_quarantined_device(). A write that leaves cell_id unchanged, or sets it NULL, passes (0198).';

SELECT public.replay_trigger('public.devices', 'trg_devices_not_filed_in_an_archived_cell', $ddl$
CREATE TRIGGER trg_devices_not_filed_in_an_archived_cell BEFORE INSERT OR UPDATE OF cell_id ON public.devices FOR EACH ROW EXECUTE FUNCTION public.refuse_filing_in_an_archived_cell();
$ddl$);

SELECT public.replay_trigger('public.gateways', 'trg_gateways_not_filed_in_an_archived_cell', $ddl$
CREATE TRIGGER trg_gateways_not_filed_in_an_archived_cell BEFORE INSERT OR UPDATE OF cell_id ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.refuse_filing_in_an_archived_cell();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 3. No device is assigned to an archived gateway
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refuse_assigning_to_an_archived_gateway() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_gateway public.gateways%ROWTYPE;
BEGIN
  -- An unchanged gateway_id passes, so archiving a gateway leaves its devices as they are.
  IF NEW.gateway_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.gateway_id IS NOT DISTINCT FROM OLD.gateway_id) THEN
    RETURN NEW;
  END IF;

  -- FOR SHARE waits out an archive of this gateway in flight, as above.
  SELECT * INTO v_gateway FROM public.gateways WHERE id = NEW.gateway_id FOR SHARE;
  IF NOT FOUND OR NOT v_gateway.is_archived THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'device "%" cannot be assigned to gateway "%", which is archived. Restore the gateway first, or choose another.',
    NEW.name, v_gateway.name
    USING ERRCODE = 'check_violation';
END $$;

ALTER FUNCTION public.refuse_assigning_to_an_archived_gateway() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_assigning_to_an_archived_gateway() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.refuse_assigning_to_an_archived_gateway() IS 'Refuses a device INSERTed or UPDATEd with a gateway_id that names an archived gateway, whoever writes it, approval from Quarantine included. A write that leaves gateway_id unchanged, or sets it NULL, passes. Ingestion registers a device first seen behind an archived edge node with no gateway (0198).';

SELECT public.replay_trigger('public.devices', 'trg_devices_not_assigned_to_an_archived_gateway', $ddl$
CREATE TRIGGER trg_devices_not_assigned_to_an_archived_gateway BEFORE INSERT OR UPDATE OF gateway_id ON public.devices FOR EACH ROW EXECUTE FUNCTION public.refuse_assigning_to_an_archived_gateway();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 4. Self-check: the triggers are in place, and no API role may call their functions.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_trigger text[];
  v_fn      text;
BEGIN
  FOREACH v_trigger SLICE 1 IN ARRAY ARRAY[
      ['public.cells',    'trg_cells_archived_only_when_empty'],
      ['public.devices',  'trg_devices_not_filed_in_an_archived_cell'],
      ['public.gateways', 'trg_gateways_not_filed_in_an_archived_cell'],
      ['public.devices',  'trg_devices_not_assigned_to_an_archived_gateway']] LOOP
    IF public.live_trigger_statement(v_trigger[1]::regclass, v_trigger[2]) IS NULL THEN
      RAISE EXCEPTION '0198: % has no %', v_trigger[1], v_trigger[2];
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY['public.refuse_archiving_an_occupied_cell()',
                              'public.refuse_filing_in_an_archived_cell()',
                              'public.refuse_assigning_to_an_archived_gateway()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0198: an API role may execute %', v_fn;
    END IF;
  END LOOP;
END
$check$;
