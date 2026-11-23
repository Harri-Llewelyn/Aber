-- 0317: A device has no connection_method column.
--
-- 1.9.0 deprecated `devices.connection_method`: every device reaches Aber over Sparkplug B, so the
-- column said nothing, and the dashboard stopped sending it. This drops it.
--
--   * proposable_columns() no longer admits it on the device lane, so validate_change_proposal()
--     refuses a new proposal that names it.
--   * approve_proposal() no longer writes it. A proposal filed before the upgrade that names it is
--     refused when someone approves it, with HTTP 400 telling the approver to reject it and ask for a
--     new one. It is never applied with the key left out, and the boot never waits on it.
--   * Then the column goes, with its values. db-init's log says how many devices held one.
--
-- The released files still name the column, and are not edited. 0001 creates it, and adds it back on
-- every boot. 0001 and 0165 declare approve_proposal() with it, and 0001 and 0202 proposable_columns().
-- So every boot replays them with the column in place, then this file redeclares both functions and
-- drops the column again.
--
-- Reasoning: supabase/README.md, "A device has no connection_method column (0317)".
-- Idempotent.
--
-- Redefines public.proposable_columns: 0317 takes connection_method out of the device lane, as
--   devices no longer has the column; 0202's body otherwise, with 0176's search_path pin
-- Redefines public.approve_proposal: 0317 writes no connection_method, and refuses a key the lane no
--   longer admits with what the approver should do; 0165's body otherwise

-- -------------------------------------------------------------------------------------------------
-- 1. connection_method is not proposable
-- -------------------------------------------------------------------------------------------------
-- 0202's definition, without connection_method. The SET clause restates 0176's pin, which a CREATE
-- OR REPLACE would otherwise clear.
CREATE OR REPLACE FUNCTION public.proposable_columns(p_entity_type text) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE p_entity_type
    -- `area_id` joins `cell_id` and `location_scope`: the three together say where an asset sits,
    -- and the table's CHECKs decide whether the triple is sayable, so one proposal can relocate.
    WHEN 'devices' THEN ARRAY[
      'name', 'description', 'cell_id', 'area_id', 'location_scope', 'model_3d_path'
    ]
    WHEN 'device_nameplate' THEN ARRAY[
      'manufacturer_name', 'manufacturer_product_designation', 'manufacturer_product_type',
      'serial_number', 'year_of_construction', 'date_of_manufacture', 'hardware_version',
      'firmware_version', 'software_version', 'country_of_origin', 'uri_of_the_product'
    ]

    -- Every column of an area a person chooses; the other two are the platform's. `name` reaches
    -- MQTT as the <area> segment of every uns/ topic beneath it, which is why the table carries
    -- `areas_name_topic_safe` and a UNIQUE -- both run on the approval's UPDATE. `icon` is one of
    -- the eight names `areas_icon_valid` admits.
    WHEN 'areas' THEN ARRAY['name', 'description', 'icon']

    -- `icon` is one of eight names the CHECK on the table admits. `area_id` and the place are where
    -- the cell is; the cells trigger decides whether the three agree. A cell's dashboard is one of
    -- its links.
    WHEN 'cells' THEN ARRAY['name', 'icon', 'area_id', 'plan_x', 'plan_y', 'description']

    WHEN 'gateways' THEN ARRAY['name', 'description', 'cell_id', 'area_id', 'location_scope', 'access_url']

    -- 'schemas' is absent on purpose, and so are the three link lanes 0108 withdrew: the empty
    -- array is how this function closes a lane.
    ELSE ARRAY[]::text[]
  END
$$;

REVOKE ALL ON FUNCTION public.proposable_columns(p_entity_type text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.proposable_columns(p_entity_type text) TO authenticated, service_role;

COMMENT ON FUNCTION public.proposable_columns(p_entity_type text) IS
  'Which columns a change proposal may name, per entity type. An unknown or withdrawn entity type '
  'yields the empty array, so a lane nobody has written an allowlist for can propose nothing at all '
  'rather than everything. Withdrawn: schemas (0090) and the three link lanes (0108). Areas joined in '
  '0123. A cell''s dashboard address left in 0202, when it moved to Attached Links, and a '
  'device''s connection method in 0317, when the column was dropped.';

-- -------------------------------------------------------------------------------------------------
-- 2. Approving writes no connection_method
-- -------------------------------------------------------------------------------------------------
-- 0165's body, without the column in the devices branch. The allowlist check names what to do with
-- a key the lane no longer admits, such as connection_method in a proposal filed before 1.10.0.
CREATE OR REPLACE FUNCTION public.approve_proposal(p_proposal_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_proposal  public.change_proposals%ROWTYPE;
    v_device    public.devices%ROWTYPE;
    v_merged    public.devices%ROWTYPE;
    v_plate     public.device_nameplate%ROWTYPE;
    v_plate_new public.device_nameplate%ROWTYPE;
    v_area      public.areas%ROWTYPE;
    v_area_new  public.areas%ROWTYPE;
    v_cell      public.cells%ROWTYPE;
    v_cell_new  public.cells%ROWTYPE;
    v_gateway   public.gateways%ROWTYPE;
    v_gw_new    public.gateways%ROWTYPE;
    v_actor     uuid := auth.uid();
    v_allowed   text[];
    v_key       text;
    v_trail    bigint;
BEGIN
    -- The outer gate is the union of everybody who may decide anything; the lane's own gate below
    -- is the one that decides.
    IF NOT (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
            OR public.has_authority(ARRAY['cell:manage', 'gateway:manage'])) THEN
        RAISE EXCEPTION 'not permitted to decide change proposals'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.require_mfa();

    SELECT * INTO v_proposal FROM public.change_proposals
     WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND THEN
        PERFORM public.raise_not_found(format('proposal %s not found', p_proposal_id));
    END IF;

    IF NOT public.may_decide_proposal(v_proposal.entity_type) THEN
        RAISE EXCEPTION 'not permitted to decide proposals on %', v_proposal.entity_type
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_proposal.status <> 'open' THEN
        RAISE EXCEPTION 'proposal % is already %', p_proposal_id, v_proposal.status
            USING ERRCODE = 'check_violation';
    END IF;

    -- Re-validated, not trusted: the patch may have been edited since the insert trigger checked
    -- it, and the allowlist may have narrowed. A key it no longer admits is refused with what to
    -- do, and never dropped: the proposer asked for the whole patch.
    v_allowed := public.proposable_columns(v_proposal.entity_type);
    FOREACH v_key IN ARRAY ARRAY(SELECT jsonb_object_keys(v_proposal.patch)) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            RAISE EXCEPTION 'proposal % names % , which is not proposable on %; reject it, and ask for a new proposal without it',
                p_proposal_id, v_key, v_proposal.entity_type
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
    END LOOP;

    -- Already true is not approvable: the repair is a rejection naming what happened.
    IF public.proposal_is_already_true(p_proposal_id) THEN
        RAISE EXCEPTION
            'this change is already in place -- somebody made it while the proposal was open; reject it with that as the reason rather than recording an approval that changes nothing'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Attribute every trigger-written audit row in this transaction to the approver. SET LOCAL,
    -- so it is discarded at COMMIT.
    PERFORM set_config('aber.actor_id', v_actor::text, true);

    IF v_proposal.entity_type = 'devices' THEN
        SELECT * INTO v_device FROM public.devices
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            PERFORM public.raise_not_found(
                format('device %s no longer exists', v_proposal.entity_id));
        END IF;

        SELECT * INTO v_merged FROM jsonb_populate_record(v_device, v_proposal.patch);

        UPDATE public.devices
           SET name              = v_merged.name,
               description       = v_merged.description,
               cell_id           = v_merged.cell_id,
               area_id           = v_merged.area_id,
               location_scope    = v_merged.location_scope,
               model_3d_path     = v_merged.model_3d_path
         WHERE id = v_device.id;

    ELSIF v_proposal.entity_type = 'device_nameplate' THEN
        -- A device with no nameplate row yet is the normal case: the row is created by whoever
        -- first asserts something about the asset.
        INSERT INTO public.device_nameplate (device_id) VALUES (v_proposal.entity_id)
        ON CONFLICT (device_id) DO NOTHING;

        SELECT * INTO v_plate FROM public.device_nameplate
         WHERE device_id = v_proposal.entity_id FOR UPDATE;

        SELECT * INTO v_plate_new FROM jsonb_populate_record(v_plate, v_proposal.patch);

        UPDATE public.device_nameplate
           SET manufacturer_name                = v_plate_new.manufacturer_name,
               manufacturer_product_designation = v_plate_new.manufacturer_product_designation,
               manufacturer_product_type        = v_plate_new.manufacturer_product_type,
               serial_number                    = v_plate_new.serial_number,
               year_of_construction             = v_plate_new.year_of_construction,
               date_of_manufacture              = v_plate_new.date_of_manufacture,
               hardware_version                 = v_plate_new.hardware_version,
               firmware_version                 = v_plate_new.firmware_version,
               software_version                 = v_plate_new.software_version,
               country_of_origin                = v_plate_new.country_of_origin,
               uri_of_the_product               = v_plate_new.uri_of_the_product,
               updated_at                       = now(),
               -- The proposer: a nameplate is an assertion about the asset, and who made it is
               -- part of the record.
               updated_by                       = v_proposal.proposed_by
         WHERE device_id = v_proposal.entity_id;

    ELSIF v_proposal.entity_type = 'areas' THEN
        SELECT * INTO v_area FROM public.areas
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            PERFORM public.raise_not_found(
                format('area %s no longer exists', v_proposal.entity_id));
        END IF;

        SELECT * INTO v_area_new FROM jsonb_populate_record(v_area, v_proposal.patch);

        -- `areas_name_topic_safe`, `areas_name_key` and `areas_icon_valid` run on this UPDATE, so a
        -- taken name, a topic separator or an unknown icon aborts the approval with the database's
        -- own sentence and the proposal stays open.
        UPDATE public.areas
           SET name        = v_area_new.name,
               description = v_area_new.description,
               icon        = v_area_new.icon
         WHERE id = v_area.id;

    ELSIF v_proposal.entity_type = 'cells' THEN
        SELECT * INTO v_cell FROM public.cells
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            PERFORM public.raise_not_found(
                format('cell %s no longer exists', v_proposal.entity_id));
        END IF;

        SELECT * INTO v_cell_new FROM jsonb_populate_record(v_cell, v_proposal.patch);

        -- The table's CHECKs, the area foreign key and place_cell_in_its_area() run on this
        -- UPDATE, so an unknown icon, a deleted area or a place too close to a neighbour aborts
        -- the approval rather than being stored.
        UPDATE public.cells
           SET name        = v_cell_new.name,
               icon        = v_cell_new.icon,
               area_id     = v_cell_new.area_id,
               plan_x      = v_cell_new.plan_x,
               plan_y      = v_cell_new.plan_y,
               description = v_cell_new.description
         WHERE id = v_cell.id;

    ELSIF v_proposal.entity_type = 'gateways' THEN
        SELECT * INTO v_gateway FROM public.gateways
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            PERFORM public.raise_not_found(
                format('gateway %s no longer exists', v_proposal.entity_id));
        END IF;

        SELECT * INTO v_gw_new FROM jsonb_populate_record(v_gateway, v_proposal.patch);

        -- The location CHECKs guard this statement; a relocation that breaks one fails here, inside
        -- the approver's transaction, and the proposal stays open with the database's own sentence.
        UPDATE public.gateways
           SET name           = v_gw_new.name,
               description    = v_gw_new.description,
               cell_id        = v_gw_new.cell_id,
               area_id        = v_gw_new.area_id,
               location_scope = v_gw_new.location_scope,
               access_url     = v_gw_new.access_url
         WHERE id = v_gateway.id;

    END IF;
    -- No `schemas` or link branch: those lanes are withdrawn and may_decide_proposal() refuses
    -- them above.

    -- The row that names both parties; the target's own audit trigger records only the approver.
    -- causation_id is this transaction, which the trigger also stamped on the target's row, so
    -- the two group as one act.
    INSERT INTO public.audit_trail
        (entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
         causation_id, audit_domain)
    VALUES (
        v_proposal.entity_type,
        v_proposal.entity_id,
        'PROPOSAL_APPLIED',
        NULL,
        jsonb_build_object(
            'proposal_id',       v_proposal.id,
            'proposed_by',       v_proposal.proposed_by,
            'proposed_by_email', v_proposal.proposed_by_email,
            'approved_by',       v_actor,
            'patch',             v_proposal.patch,
            'rationale',         v_proposal.rationale
        ),
        v_actor,
        'user',
        txid_current(),
        public.audit_domain_for(v_proposal.entity_type, 'PROPOSAL_APPLIED')
    )
    RETURNING id INTO v_trail;

    PERFORM set_config('aber.proposal_transition', 'on', true);

    UPDATE public.change_proposals
       SET status = 'applied', decided_by = v_actor, decided_at = now(),
           applied_trail_id = v_trail
     WHERE id = p_proposal_id;

    RETURN jsonb_build_object(
        'id', p_proposal_id, 'status', 'applied', 'trail_id', v_trail
    );
END;
$$;

ALTER FUNCTION public.approve_proposal(p_proposal_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.approve_proposal(p_proposal_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_proposal(p_proposal_id uuid) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 3. The column goes
-- -------------------------------------------------------------------------------------------------
-- Guarded by the column's existence, so the file also replays on its own. On a boot the column is
-- always there: 0001 has just added it back, empty, so only an upgrade's first boot drops values.
-- No view, index, constraint or trigger names it, so nothing has to be rebuilt.
DO $$
DECLARE
  v_held integer;
BEGIN
  -- PL/pgSQL plans each statement when it first runs it, so the count never meets a missing column.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.devices'::regclass
                    AND attname = 'connection_method' AND NOT attisdropped) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_held FROM public.devices WHERE btrim(connection_method) <> '';

  ALTER TABLE public.devices DROP COLUMN connection_method;

  IF v_held > 0 THEN
    RAISE NOTICE '0317: devices.connection_method dropped, with the value % device(s) held. Nothing in Aber read it.',
      v_held;
  END IF;
END
$$;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.devices'::regclass
                AND attname = 'connection_method' AND NOT attisdropped) THEN
    RAISE EXCEPTION '0317: devices.connection_method is still there';
  END IF;
  IF 'connection_method' = ANY (public.proposable_columns('devices')) THEN
    RAISE EXCEPTION '0317: proposable_columns(''devices'') admits connection_method, which devices no longer has';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.proposable_columns(text)'::regprocedure
                    AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0317: proposable_columns() lost its search_path pin';
  END IF;
  -- One that set the column would fail every device approval.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.approve_proposal(uuid)'::regprocedure
                    AND prosecdef
                    AND 'search_path=public' = ANY (proconfig)
                    AND prosrc !~ '\mconnection_method\M'
                    AND position('PERFORM public.require_mfa();' IN prosrc) > 0
                    AND position('public.proposable_columns(v_proposal.entity_type)' IN prosrc) > 0) THEN
    RAISE EXCEPTION '0317: approve_proposal() names connection_method, no longer re-checks the patch or asks for a second factor, or is not SECURITY DEFINER with its search_path pinned';
  END IF;
  IF has_function_privilege('anon', 'public.approve_proposal(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.proposable_columns(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0317: anon may execute approve_proposal() or proposable_columns()';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
