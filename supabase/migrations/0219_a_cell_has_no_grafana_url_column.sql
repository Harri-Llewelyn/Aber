-- 0219: A cell has no grafana_url column.
--
-- 1.7.0 deprecated `cells.grafana_url`: 0202 moved each cell's web address into its Attached Links,
-- as a link named Dashboard, and cleared the column. This drops the column, as 0175 dropped
-- devices.schema_id. All of it is guarded by the column's existence, so only the first boot after
-- the upgrade does anything; a fresh install and every later boot take no lock on cells.
--
--   * An http:// or https:// address an API client wrote since 0202 moves first, with 0202's
--     statement: a Dashboard link unless the cell already links to it, and the value cleared.
--   * Any other value 0202 kept is named in a NOTICE with its cell, then cleared by an UPDATE, so
--     that cell's audit row (actor_source 'migration') keeps it. A blank one just goes.
--   * Then the column is dropped.
--
-- approve_proposal() is declared here without the column, as 0001 and 0165 now declare it. 0001 no
-- longer creates the column, and 0202 moves only while it exists, so no replay brings it back.
--
-- Reasoning: supabase/README.md, "A cell has no grafana_url column (0219)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. What the column still holds moves or is recorded, then the column goes
-- -------------------------------------------------------------------------------------------------
-- One statement, so one transaction: if a step fails, the column and every value stay as they were.
DO $$
DECLARE
  v_linked  integer;
  v_cleared integer;
  v_kept    integer := 0;
  v_cell    record;
BEGIN
  -- PL/pgSQL plans each statement when it first runs it, so the ones below never meet the missing
  -- column.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.cells'::regclass
                    AND attname = 'grafana_url' AND NOT attisdropped) THEN
    RETURN;
  END IF;

  -- 0202's statement, so a web address written since then reaches Attached Links.
  WITH moving AS (
    SELECT c.id, btrim(c.grafana_url) AS url
      FROM public.cells c
     WHERE btrim(c.grafana_url) ~ '^https?://'
       FOR UPDATE
  ), linked AS (
    INSERT INTO public.links (entity_type, entity_id, display_name, url, link_tag)
    SELECT 'cell', m.id::text, 'Dashboard', m.url, 'other'
      FROM moving m
     WHERE NOT EXISTS (SELECT 1 FROM public.links l
                        WHERE l.entity_type = 'cell'
                          AND l.entity_id = m.id::text
                          AND btrim(l.url) = m.url)
    RETURNING 1
  ), cleared AS (
    UPDATE public.cells c
       SET grafana_url = NULL
      FROM moving m
     WHERE c.id = m.id
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM linked), (SELECT count(*) FROM cleared)
    INTO v_linked, v_cleared;

  IF v_cleared > 0 THEN
    RAISE NOTICE '0219: % cell dashboard address(es) moved to Attached Links, as links named Dashboard: % linked now, % linked already.',
      v_cleared, v_linked, v_cleared - v_linked;
  END IF;

  -- What 0202 kept. The UPDATE writes the cell's audit row, whose old_data holds the whole value;
  -- the NOTICE quotes its first 200 characters.
  FOR v_cell IN
    SELECT c.id, c.name, c.grafana_url
      FROM public.cells c
     WHERE btrim(c.grafana_url) <> ''
     ORDER BY c.name, c.id
       FOR UPDATE
  LOOP
    RAISE NOTICE '0219: cell "%" (%) held grafana_url %, which is not a web address. It goes with the column, and the cell''s Audit Trail keeps it.',
      v_cell.name, v_cell.id, quote_literal(left(v_cell.grafana_url, 200));
    UPDATE public.cells SET grafana_url = NULL WHERE id = v_cell.id;
    v_kept := v_kept + 1;
  END LOOP;

  ALTER TABLE public.cells DROP COLUMN grafana_url;

  RAISE NOTICE '0219: cells.grafana_url dropped; % value(s) that were not web addresses are named above and kept in the Audit Trail.',
    v_kept;
END
$$;

-- -------------------------------------------------------------------------------------------------
-- 2. approve_proposal() sets no grafana_url
-- -------------------------------------------------------------------------------------------------
-- 0165's definition, which 0001 and 0165 now share: the cells branch sets every proposable column
-- and nothing else.
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
    -- it, and the allowlist may have narrowed.
    v_allowed := public.proposable_columns(v_proposal.entity_type);
    FOREACH v_key IN ARRAY ARRAY(SELECT jsonb_object_keys(v_proposal.patch)) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            RAISE EXCEPTION 'proposal % names % , which is not proposable on %',
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
               connection_method = v_merged.connection_method,
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

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.cells'::regclass
                AND attname = 'grafana_url' AND NOT attisdropped) THEN
    RAISE EXCEPTION '0219: cells.grafana_url is still there';
  END IF;
  IF 'grafana_url' = ANY (public.proposable_columns('cells')) THEN
    RAISE EXCEPTION '0219: proposable_columns(''cells'') admits grafana_url, which cells no longer has';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.approve_proposal(uuid)'::regprocedure
                    AND prosecdef
                    AND 'search_path=public' = ANY (proconfig)
                    AND prosrc !~ '\mgrafana_url\M') THEN
    RAISE EXCEPTION '0219: approve_proposal() names grafana_url, or is not SECURITY DEFINER with its search_path pinned';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
