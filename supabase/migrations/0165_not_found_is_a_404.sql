-- 0165: A function that finds nothing answers 404 through the API.
--
-- PostgREST answers the whole P0 class 500, no_data_found (P0002) included, so a mistyped id read
-- as a server fault. raise_not_found() raises PostgREST's custom error instead: the response keeps
-- the code P0002 and the message, with status 404. Any other caller (psql, a test) sees SQLSTATE
-- PGRST, with that JSON body as the message and {"status": 404} as the detail.

CREATE OR REPLACE FUNCTION public.raise_not_found(p_message text)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- PostgREST cannot parse a body whose message is null, and would answer 500.
  RAISE SQLSTATE 'PGRST'
    USING MESSAGE = json_build_object(
            'code', 'P0002', 'message', coalesce(p_message, 'not found'),
            'details', NULL, 'hint', NULL)::text,
          DETAIL = '{"status": 404}';
END
$$;

-- Called only by SECURITY DEFINER functions owned by postgres, so no API role may execute it and
-- PostgREST refuses a direct call.
ALTER FUNCTION public.raise_not_found(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.raise_not_found(text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.raise_not_found(text) IS
  'Raises "not found" so that PostgREST answers 404 with code P0002 and this message; a direct '
  'caller sees SQLSTATE PGRST with that JSON body as the message. Use it in place of '
  'RAISE ... USING ERRCODE = ''no_data_found'', which PostgREST answers 500.';

-- 0001's functions that said "not found" with no_data_found, redeclared unchanged but for those
-- raises, which now call raise_not_found() with the same message.

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
               grafana_url = v_cell_new.grafana_url,
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

CREATE OR REPLACE FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid DEFAULT NULL::uuid, p_merge_into_device_id uuid DEFAULT NULL::uuid, p_asset_name text DEFAULT NULL::text, p_cell_id uuid DEFAULT NULL::uuid, p_location_scope text DEFAULT NULL::text, p_set_cell boolean DEFAULT false, p_set_location_scope boolean DEFAULT false, p_area_id uuid DEFAULT NULL::uuid, p_set_area boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_quarantined public.devices%ROWTYPE;
  v_candidate   public.devices%ROWTYPE;
  v_result      public.devices%ROWTYPE;
  v_actor_role  text;
  v_cell        uuid := p_cell_id;
  v_area        uuid := p_area_id;
BEGIN
  -- Authorization is re-derived from the database rather than taken on trust. The edge function
  -- checks too; this is the check that still holds if the RPC is ever reached another way.
  SELECT r.name INTO v_actor_role
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_actor_id::text
   LIMIT 1;

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('Administrator', 'Shopfloor_Manager') THEN
    RAISE EXCEPTION 'actor % is not permitted to approve quarantined devices', p_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Attribute every trigger-written audit row in this transaction to the operator. SET LOCAL, so
  -- it is discarded at COMMIT and cannot bleed into the connection's next user.
  PERFORM set_config('aber.actor_id', p_actor_id::text, true);

  SELECT * INTO v_quarantined FROM public.devices WHERE id = p_device_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('quarantined device %s not found', p_device_id));
  END IF;

  -- ---------------------------------------------------------------------------------------
  -- Merge path: absorb a discovered duplicate into the row that was already provisioned.
  -- ---------------------------------------------------------------------------------------
  IF p_merge_into_device_id IS NOT NULL THEN
    IF p_merge_into_device_id = p_device_id THEN
      RAISE EXCEPTION 'cannot merge device % into itself', p_device_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Two named ids and a short transaction; the FOR UPDATE is what stops a concurrent approval
    -- racing this one into two live rows.
    SELECT * INTO v_candidate FROM public.devices WHERE id = p_merge_into_device_id FOR UPDATE;
    IF NOT FOUND THEN
      PERFORM public.raise_not_found(format('target device %s not found', p_merge_into_device_id));
    END IF;

    -- asset_config is keyed by sparkplug_id, not by row id, so the recorded birth parameters
    -- have to be re-keyed onto the surviving row.
    UPDATE public.asset_config
       SET asset_id = v_candidate.sparkplug_id
     WHERE asset_id = v_quarantined.sparkplug_id;

    -- reported_identity carries over deliberately: the physical device keeps publishing under
    -- the id it announced, and that is what ingestion has to keep resolving. Without it the
    -- merged device is re-quarantined on its very next birth. The candidate's deliberately
    -- provisioned fields (gateway_id, schema_id, connection_method) are left alone.
    UPDATE public.devices
       SET status            = v_quarantined.status,
           first_dbirth_at   = COALESCE(v_candidate.first_dbirth_at, v_quarantined.first_dbirth_at),
           reported_identity = v_quarantined.reported_identity,
           identity_source   = v_quarantined.identity_source,
           quarantine_reason = NULL,
           is_quarantined    = false
     WHERE id = v_candidate.id
    RETURNING * INTO v_result;

    DELETE FROM public.devices WHERE id = v_quarantined.id;

    RETURN jsonb_build_object(
      'merged', true,
      'device', to_jsonb(v_result),
      'discarded_device_id', v_quarantined.id
    );
  END IF;

  -- ---------------------------------------------------------------------------------------
  -- Straight approval.
  -- ---------------------------------------------------------------------------------------
  -- Mirrors the scope CHECKs: a site-wide asset names neither cell nor area, an area-wide one
  -- names its area and no cell, a cell-scoped one names no area. Cleared here rather than left
  -- to a constraint violation the caller cannot interpret.
  IF p_set_location_scope AND p_location_scope = 'site_wide' THEN
    v_cell := NULL;
    v_area := NULL;
  ELSIF p_set_location_scope AND p_location_scope = 'area_wide' THEN
    v_cell := NULL;
    IF v_area IS NULL THEN
      RAISE EXCEPTION 'an area_wide device must name its area'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_set_location_scope THEN
    v_area := NULL;
  END IF;

  UPDATE public.devices
     SET is_quarantined    = false,
         quarantine_reason = NULL,
         gateway_id        = p_gateway_id,
         -- LOCATION IS OMITTED WHEN NOT ANSWERED, NEVER DEFAULTED. devices.cell_id is
         -- NULL-means-inherit with no column default, so writing a value the operator did not
         -- choose would switch inheritance off permanently for every device approved this way.
         -- The p_set_* flags are what distinguish "not supplied" from "explicitly cleared" --
         -- a plain NULL argument cannot express the difference. A wide scope clears the cell
         -- whether or not one was supplied, since the CHECK would refuse the pair.
         cell_id           = CASE WHEN p_set_cell OR (p_set_location_scope AND p_location_scope <> 'cell')
                                  THEN v_cell ELSE cell_id END,
         area_id           = CASE WHEN p_set_area OR p_set_location_scope THEN v_area ELSE area_id END,
         location_scope    = CASE WHEN p_set_location_scope THEN p_location_scope ELSE location_scope END,
         name              = COALESCE(NULLIF(btrim(COALESCE(p_asset_name, '')), ''), name)
   WHERE id = p_device_id
  RETURNING * INTO v_result;

  RETURN jsonb_build_object('merged', false, 'device', to_jsonb(v_result));
END;
$$;

ALTER FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean, p_area_id uuid, p_set_area boolean) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.discard_schema_draft(p_schema_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_draft      public.schemas%ROWTYPE;
    v_detached   integer := 0;
    v_actor      uuid := auth.uid();
BEGIN
    -- THE SAME GATE `fork_schema()` AND `publish_schema_version()` CARRY SINCE 0087, and for the
    -- same reason: a SECURITY DEFINER function bypasses RLS entirely, so its own check is the only
    -- one there is. `schema:manage` rather than a role pair, so it cannot drift from the policy.
    IF NOT public.has_authority(ARRAY['schema:manage']) THEN
        RAISE EXCEPTION 'insufficient privileges to discard a schema draft'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_draft FROM public.schemas WHERE id = p_schema_id FOR UPDATE;
    IF NOT FOUND THEN
        PERFORM public.raise_not_found(format('schema %s not found', p_schema_id));
    END IF;

    -- THE WHOLE REASON THIS FUNCTION EXISTS. An active or archived schema is part of the record of
    -- what devices were judged against, and deleting one would detach every device bound to it
    -- through two different foreign keys, silently.
    IF v_draft.status <> 'draft' THEN
        RAISE EXCEPTION
            'schema "%" is %, not a draft; only a draft can be discarded',
            v_draft.schema_name, v_draft.status
            USING ERRCODE = 'check_violation';
    END IF;

    -- Counted BEFORE the delete, because the CASCADE and the SET NULL are what detach them and
    -- neither reports anything. A draft can be attached to a machine to try it out, through either
    -- arm, so this is a real number rather than always zero. A device on both arms counts once.
    SELECT count(*) INTO v_detached
      FROM (SELECT d.id FROM public.devices d WHERE d.schema_id = p_schema_id
            UNION
            SELECT ds.device_id FROM public.device_submodels ds WHERE ds.schema_id = p_schema_id) attached;

    -- Attributes the audit row this DELETE fires to the person who asked for it. SET LOCAL, so it
    -- is discarded at COMMIT and cannot bleed into the connection's next user.
    PERFORM set_config('aber.actor_id', v_actor::text, true);

    DELETE FROM public.schemas WHERE id = p_schema_id;

    RETURN jsonb_build_object(
        'discarded_schema_id',   p_schema_id,
        'discarded_schema_name', v_draft.schema_name,
        'version',               v_draft.version,
        'parent_schema_id',      v_draft.parent_schema_id,
        'devices_detached',      v_detached
    );
END;
$$;

ALTER FUNCTION public.discard_schema_draft(p_schema_id uuid) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.ensure_shadow_devices(p_capture_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_capture   public.captures;
    v_gateway   public.gateways;
    v_wire_id   text;
    v_origin    public.devices;
    v_shadow_id uuid;
    v_map       jsonb := '{}'::jsonb;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION
          'ensure_shadow_devices: creating playback lanes requires Administrator or '
          'Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_capture FROM public.captures WHERE id = p_capture_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ensure_shadow_devices: no capture %', p_capture_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- THE SINGLE SHADOW GATEWAY, found by its flag rather than by the pinned id above. An operator
    -- may legitimately want a second one -- two playbacks at once need two edge nodes, since
    -- playback_jobs allows only one RUNNING per target -- and looking it up by flag means that
    -- works without this function being edited. More than one is ambiguous and says so.
    SELECT * INTO v_gateway FROM public.gateways
     WHERE is_shadow AND NOT is_archived
     ORDER BY created_at
     LIMIT 1;
    IF NOT FOUND THEN
        PERFORM public.raise_not_found(
          'ensure_shadow_devices: this stack has no playback gateway. One is seeded by migration '
          '0060; if it was archived, restore it or mark another gateway is_shadow.');
    END IF;

    FOR v_wire_id IN
        SELECT jsonb_array_elements_text(coalesce(v_capture.manifest -> 'device_ids', '[]'::jsonb))
    LOOP
        SELECT * INTO v_origin FROM public.devices WHERE sparkplug_id = v_wire_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
              'ensure_shadow_devices: the capture records device %, which this stack does not '
              'know. A playback lane stands in for a real machine, and there is none here to '
              'stand in for.', v_wire_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        -- THE ORIGINAL MAY ITSELF BE A SHADOW if someone captured a playback. Refused: the lane
        -- already exists and is the one to replay onto, and a shadow of a shadow is a chain whose
        -- far end nobody can name.
        IF v_origin.shadow_of IS NOT NULL THEN
            RAISE EXCEPTION
              'ensure_shadow_devices: % is itself a playback lane. Replay onto it directly rather '
              'than shadowing it.', v_origin.name
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT id INTO v_shadow_id FROM public.devices
         WHERE gateway_id = v_gateway.id AND shadow_of = v_origin.id;

        IF NOT FOUND THEN
            INSERT INTO public.devices (
                name, gateway_id, shadow_of, status, schema_id, conformance_policy, description
            ) VALUES (
                left(v_origin.name, 96) || ' (replay)',
                v_gateway.id,
                v_origin.id,
                'OFFLINE',
                -- THE CONTRACT, COPIED. See this migration's header: without it a replay is either
                -- unjudged or wholly rejected, and both look like a broken capture.
                v_origin.schema_id,
                v_origin.conformance_policy,
                'Replays recordings of ' || v_origin.name || '. Not a machine: its readings are '
                'genuine but were observed elsewhere, at another time.'
            )
            RETURNING id INTO v_shadow_id;

            -- The many-to-many half of the same contract. `device_schemas` unions this with
            -- devices.schema_id, so copying only one of the two silently narrows what the shadow
            -- is judged against for every device provisioned with submodels.
            INSERT INTO public.device_submodels (device_id, schema_id, submodel_key)
            SELECT v_shadow_id, ds.schema_id, ds.submodel_key
              FROM public.device_submodels ds
             WHERE ds.device_id = v_origin.id;
        END IF;

        v_map := v_map || jsonb_build_object(
            v_wire_id,
            (SELECT sparkplug_id FROM public.devices WHERE id = v_shadow_id)
        );
    END LOOP;

    IF v_map = '{}'::jsonb THEN
        PERFORM public.raise_not_found(format(
          'ensure_shadow_devices: capture %s names no devices, so there is nothing to replay as. A '
          'gateway-scoped capture that recorded only node-level messages has no device data in it.',
          p_capture_id));
    END IF;

    RETURN v_map;
END;
$$;

ALTER FUNCTION public.ensure_shadow_devices(p_capture_id uuid) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.fork_schema(parent_schema_id uuid, change_description text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  -- Copied out of the parameters immediately: both are named after columns of `schemas`, and
  -- plpgsql would raise "column reference is ambiguous" on the first `WHERE id = parent_schema_id`.
  v_parent_id  UUID := parent_schema_id;
  v_change     TEXT := NULLIF(btrim(COALESCE(change_description, '')), '');
  parent       public.schemas%ROWTYPE;
  child        public.schemas%ROWTYPE;
  v_base       TEXT;
  v_next       INTEGER;
  v_name       TEXT;
  v_suffix     INTEGER := 1;
BEGIN
  -- Fail closed, before anything else observable happens. `has_authority` rather than a role name,
  -- so the gate is the permission 0069 withdrew.
  IF NOT public.has_authority(ARRAY['schema:manage']) THEN
    RAISE EXCEPTION 'insufficient privileges to version a schema'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_parent_id IS NULL THEN
    RAISE EXCEPTION 'parent_schema_id is required' USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- FOR UPDATE, not a bare SELECT: two operators forking the same schema at the same moment would
  -- otherwise both read version N and both insert N+1. The partial unique index catches the
  -- collision either way, but the lock turns a confusing constraint violation into a wait.
  SELECT * INTO parent FROM public.schemas WHERE id = v_parent_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('schema %s not found', v_parent_id));
  END IF;

  -- Only the head of a lineage may be forked. Forking an archived version would produce a second
  -- claimant to the same version number, and forking a draft would branch something that has never
  -- been in force -- edit the draft instead, which is what a draft is for.
  IF parent.status <> 'active' THEN
    RAISE EXCEPTION 'only an active schema can be versioned; "%" is %', parent.schema_name, parent.status
      USING ERRCODE = 'check_violation',
            HINT = 'Fork the active version of this lineage.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.schemas s
              WHERE s.parent_schema_id = v_parent_id AND s.status = 'draft') THEN
    RAISE EXCEPTION 'a draft version of "%" already exists; publish or delete it first', parent.schema_name
      USING ERRCODE = 'unique_violation';
  END IF;

  v_next := parent.version + 1;
  v_base := public.schema_version_base_name(parent.schema_name);
  v_name := v_base || '_v' || v_next;

  -- A discarded draft leaves its name behind, so the obvious one can already be taken. Suffixing
  -- beats failing: the operator asked for a version, not for a naming negotiation.
  WHILE EXISTS (SELECT 1 FROM public.schemas s WHERE s.schema_name = v_name) LOOP
    v_suffix := v_suffix + 1;
    v_name := v_base || '_v' || v_next || '_' || v_suffix;
  END LOOP;

  -- The metric links are the definition: a schema's membership of the catalog lives in
  -- `schema_definition.properties` / `.required`, which deviceTags.js and validate.py both read.
  INSERT INTO public.schemas (
    schema_name, description, schema_definition,
    semantic_id, semantic_id_type,
    version, parent_schema_id, status, change_description
  ) VALUES (
    v_name, parent.description, parent.schema_definition,
    parent.semantic_id, parent.semantic_id_type,
    v_next, parent.id, 'draft', v_change
  )
  RETURNING * INTO child;

  RETURN to_jsonb(child);
END;
$$;

ALTER FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.publish_schema_version(draft_schema_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_draft_id       UUID := draft_schema_id;
  draft            public.schemas%ROWTYPE;
  parent           public.schemas%ROWTYPE;
  published        public.schemas%ROWTYPE;
  v_submodels      INTEGER := 0;
  v_schema_ids     INTEGER := 0;
  v_merged         INTEGER := 0;
BEGIN
  -- NARROWED BY 0087. This admitted the pair while the RLS write policies it is the transactional
  -- form of admitted Administrator alone, and being SECURITY DEFINER it did not consult them --
  -- so it was the way around 0069 rather than an application of it.
  IF NOT public.has_authority(ARRAY['schema:manage']) THEN
    RAISE EXCEPTION 'insufficient privileges to publish a schema version'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_draft_id IS NULL THEN
    RAISE EXCEPTION 'draft_schema_id is required' USING ERRCODE = 'null_value_not_allowed';
  END IF;

  SELECT * INTO draft FROM public.schemas WHERE id = v_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('schema %s not found', v_draft_id));
  END IF;

  IF draft.status <> 'draft' THEN
    RAISE EXCEPTION 'schema "%" is %, not a draft', draft.schema_name, draft.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF draft.parent_schema_id IS NOT NULL THEN
    SELECT * INTO parent FROM public.schemas WHERE id = draft.parent_schema_id FOR UPDATE;

    -- Rebind before archiving, so no window exists in which a device points at an archived schema. A
    -- device already carrying both versions as submodels would collide on `uq_device_submodels` when
    -- repointed, so the redundant old-version rows are dropped first.
    DELETE FROM public.device_submodels old_link
     WHERE old_link.schema_id = parent.id
       AND EXISTS (
         SELECT 1 FROM public.device_submodels new_link
          WHERE new_link.device_id = old_link.device_id
            AND new_link.schema_id = draft.id
       );
    GET DIAGNOSTICS v_merged = ROW_COUNT;

    UPDATE public.device_submodels SET schema_id = draft.id WHERE schema_id = parent.id;
    GET DIAGNOSTICS v_submodels = ROW_COUNT;

    -- The dashboard's attachment moves too: `devices.schema_id` is the other arm of the
    -- `device_schemas` view. This UPDATE fires `log_audit_trail_event()`, so the rebinding lands in
    -- the audit trail per device.
    UPDATE public.devices SET schema_id = draft.id WHERE schema_id = parent.id;
    GET DIAGNOSTICS v_schema_ids = ROW_COUNT;

    IF parent.status = 'active' THEN
      UPDATE public.schemas SET status = 'archived' WHERE id = parent.id;
    END IF;
  END IF;

  UPDATE public.schemas SET status = 'active' WHERE id = draft.id RETURNING * INTO published;

  RETURN jsonb_build_object(
    'schema', to_jsonb(published),
    'archived_schema_id', parent.id,
    'archived_schema_name', parent.schema_name,
    'devices_rebound', v_submodels + v_schema_ids,
    'submodels_rebound', v_submodels,
    'schema_ids_rebound', v_schema_ids,
    'duplicate_submodels_removed', v_merged
  );
END;
$$;

ALTER FUNCTION public.publish_schema_version(draft_schema_id uuid) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.reject_proposal(p_proposal_id uuid, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_proposal public.change_proposals%ROWTYPE;
    v_actor    uuid := auth.uid();
BEGIN
    IF NOT (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
            OR public.has_authority(ARRAY['cell:manage', 'gateway:manage'])) THEN
        RAISE EXCEPTION 'not permitted to decide change proposals'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF COALESCE(TRIM(p_reason), '') = '' THEN
        -- A REASON IS THE WHOLE POINT OF A REJECTION. Without one the proposer learns only that
        -- somebody said no, which leaves them to propose the same thing again.
        RAISE EXCEPTION 'a rejection needs a reason' USING ERRCODE = 'invalid_parameter_value';
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

    PERFORM set_config('aber.proposal_transition', 'on', true);

    UPDATE public.change_proposals
       SET status = 'rejected', decided_by = v_actor, decided_at = now(),
           decision_reason = p_reason
     WHERE id = p_proposal_id;

    RETURN jsonb_build_object('id', p_proposal_id, 'status', 'rejected');
END;
$$;

ALTER FUNCTION public.reject_proposal(p_proposal_id uuid, p_reason text) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.relocate_devices(p_moves jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_move      jsonb;
  v_device_id uuid;
  v_scope     text;
  v_cell      uuid;
  v_raw_cell  text;
  v_area      uuid;
  v_raw_area  text;
  v_len       integer;
  v_applied   integer := 0;
  v_unchanged integer := 0;
  v_before    public.devices%ROWTYPE;
  v_after     public.devices%ROWTYPE;
  v_results   jsonb := '[]'::jsonb;
  v_changed   boolean;
BEGIN
  -- Fail closed, before anything observable happens. SECURITY DEFINER means RLS does not apply
  -- inside this function, so the allow-list `devices_update_privileged` uses is re-derived here.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to relocate devices'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_moves IS NULL OR jsonb_typeof(p_moves) <> 'array' THEN
    RAISE EXCEPTION 'p_moves must be a JSON array of moves, got %',
                    COALESCE(jsonb_typeof(p_moves), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_len := jsonb_array_length(p_moves);

  -- An empty batch is a caller bug: the page disables Apply at zero staged moves.
  IF v_len = 0 THEN
    RAISE EXCEPTION 'p_moves is empty; nothing to relocate'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Every row below takes a FOR UPDATE lock held until commit, so the batch is bounded.
  IF v_len > 200 THEN
    RAISE EXCEPTION 'a relocation batch is limited to 200 moves; got %', v_len
      USING ERRCODE = 'program_limit_exceeded',
            HINT = 'Apply the rearrangement in smaller batches.';
  END IF;

  -- One device may appear once: "last one wins" would silently discard an instruction.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_moves) m
     GROUP BY m ->> 'device_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'p_moves names the same device more than once; a batch must state one destination per device'
      USING ERRCODE = 'cardinality_violation';
  END IF;

  -- Ordered by device_id so two overlapping batches cannot deadlock on their row locks.
  FOR v_move IN
    SELECT m FROM jsonb_array_elements(p_moves) m ORDER BY m ->> 'device_id'
  LOOP
    IF jsonb_typeof(v_move) <> 'object' THEN
      RAISE EXCEPTION 'every element of p_moves must be an object, got %', jsonb_typeof(v_move)
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF (v_move ->> 'device_id') IS NULL THEN
      RAISE EXCEPTION 'every move must name a device_id' USING ERRCODE = 'null_value_not_allowed';
    END IF;

    BEGIN
      v_device_id := (v_move ->> 'device_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'device_id % is not a uuid', v_move ->> 'device_id'
        USING ERRCODE = 'invalid_parameter_value';
    END;

    -- Required, not defaulted to 'cell': a caller that forgot the key would silently clear a
    -- wide scope an operator asserted.
    v_scope := v_move ->> 'location_scope';
    IF v_scope IS NULL THEN
      RAISE EXCEPTION 'move for device % must state location_scope (cell, area_wide or site_wide)', v_device_id
        USING ERRCODE = 'null_value_not_allowed';
    END IF;
    IF v_scope NOT IN ('cell', 'area_wide', 'site_wide') THEN
      RAISE EXCEPTION 'location_scope % is not valid for device %; expected cell, area_wide or site_wide',
                      v_scope, v_device_id
        USING ERRCODE = 'check_violation';
    END IF;

    -- Empty string reads as absent, as emptyToNull() does in frontend/src/api.js.
    v_raw_cell := NULLIF(btrim(COALESCE(v_move ->> 'cell_id', '')), '');
    IF v_raw_cell IS NULL THEN
      v_cell := NULL;
    ELSE
      BEGIN
        v_cell := v_raw_cell::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'cell_id % is not a uuid', v_raw_cell
          USING ERRCODE = 'invalid_parameter_value';
      END;
    END IF;

    v_raw_area := NULLIF(btrim(COALESCE(v_move ->> 'area_id', '')), '');
    IF v_raw_area IS NULL THEN
      v_area := NULL;
    ELSE
      BEGIN
        v_area := v_raw_area::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'area_id % is not a uuid', v_raw_area
          USING ERRCODE = 'invalid_parameter_value';
      END;
    END IF;

    -- Mirrors the CHECKs and locationFieldsFrom() in frontend/src/api.js. Forced rather than
    -- rejected: "site-wide, in cell 3" is an incompletely cleared form, not a refusal case. The
    -- one thing that cannot be forced is an area-wide move with no area, which is refused.
    IF v_scope = 'site_wide' THEN
      v_cell := NULL;
      v_area := NULL;
    ELSIF v_scope = 'area_wide' THEN
      v_cell := NULL;
      IF v_area IS NULL THEN
        RAISE EXCEPTION 'an area_wide move for device % must name area_id', v_device_id
          USING ERRCODE = 'null_value_not_allowed';
      END IF;
    ELSE
      v_area := NULL;
    END IF;

    SELECT * INTO v_before FROM public.devices WHERE id = v_device_id FOR UPDATE;
    IF NOT FOUND THEN
      -- The whole batch fails: a half-applied rearrangement is what the batch exists to remove.
      PERFORM public.raise_not_found(
          format('device %s not found; no part of this batch was applied', v_device_id));
    END IF;

    IF v_cell IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cells c WHERE c.id = v_cell) THEN
      RAISE EXCEPTION 'cell % not found; no part of this batch was applied', v_cell
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_area IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.areas a WHERE a.id = v_area) THEN
      RAISE EXCEPTION 'area % not found; no part of this batch was applied', v_area
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- The gateway is left alone: a drop says where the machine is, not which connector reaches it.
    UPDATE public.devices
       SET cell_id        = v_cell,
           area_id        = v_area,
           location_scope = v_scope
     WHERE id = v_device_id
    RETURNING * INTO v_after;

    v_changed := v_before.cell_id IS DISTINCT FROM v_after.cell_id
              OR v_before.area_id IS DISTINCT FROM v_after.area_id
              OR v_before.location_scope IS DISTINCT FROM v_after.location_scope;

    -- A no-op move is counted but not called applied: the audit trigger writes no row for it.
    IF v_changed THEN
      v_applied := v_applied + 1;
    ELSE
      v_unchanged := v_unchanged + 1;
    END IF;

    v_results := v_results || jsonb_build_object(
      'device_id',      v_after.id,
      'cell_id',        v_after.cell_id,
      'area_id',        v_after.area_id,
      'location_scope', v_after.location_scope,
      'changed',        v_changed
    );
  END LOOP;

  RETURN jsonb_build_object(
    -- The transaction the UPDATEs ran in, which log_audit_trail_event() stamped on every row it
    -- wrote; NULL when nothing changed, since the trigger then wrote no row.
    'causation_id', CASE WHEN v_applied > 0 THEN txid_current() ELSE NULL END,
    'requested',    v_len,
    'applied',      v_applied,
    'unchanged',    v_unchanged,
    'devices',      v_results
  );
END;
$$;

ALTER FUNCTION public.relocate_devices(p_moves jsonb) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.withdraw_proposal(p_proposal_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_proposal public.change_proposals%ROWTYPE;
BEGIN
    SELECT * INTO v_proposal FROM public.change_proposals
     WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND THEN
        PERFORM public.raise_not_found(format('proposal %s not found', p_proposal_id));
    END IF;

    -- The proposer's own, and nobody else's. An approver who wants an open proposal gone rejects
    -- it with a reason -- withdrawal on somebody's behalf would erase the refusal.
    IF v_proposal.proposed_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'only the proposer may withdraw proposal %', p_proposal_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_proposal.status <> 'open' THEN
        RAISE EXCEPTION 'proposal % is already %', p_proposal_id, v_proposal.status
            USING ERRCODE = 'check_violation';
    END IF;

    PERFORM set_config('aber.proposal_transition', 'on', true);

    UPDATE public.change_proposals
       SET status = 'withdrawn', decided_by = auth.uid(), decided_at = now()
     WHERE id = p_proposal_id;

    RETURN jsonb_build_object('id', p_proposal_id, 'status', 'withdrawn');
END;
$$;

ALTER FUNCTION public.withdraw_proposal(p_proposal_id uuid) OWNER TO postgres;
