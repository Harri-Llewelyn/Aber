-- =============================================================================================
-- Migration: 0153_an_approval_shares_a_causation_id_with_the_change_it_made.sql (applied as 0021 until the 1.0 squash)
-- A proposal's trail row carries the transaction that applied or expired it (#536)
-- =============================================================================================
--
-- approve_proposal() writes a PROPOSAL_APPLIED row, and the target's own audit trigger records
-- the UPDATE that approval made. The trigger stamps causation_id = txid_current(); the
-- PROPOSAL_APPLIED INSERT named no causation_id, and the column has no default, so the two rows
-- could not be grouped. expire_open_proposals() wrote PROPOSAL_EXPIRED the same way.
--
-- Both now stamp txid_current() themselves, the mechanism every other multi-row act in the chain
-- uses: an explicit value in the INSERT, the same one the trigger writes in that transaction. One
-- expiry run is one act, so the proposals a run closes share its causation_id.
--
-- validate_change_proposal()'s COMMENT still described a schema-lane "not a draft" check, which
-- archived migration 0090 withdrew with the lane; approve_proposal()'s still described the link
-- lanes archived migration 0108 withdrew. Both are restated.
--
-- The two functions are 0001's otherwise, recorded in check-docs-drift.mjs's
-- INTENDED_REDECLARATIONS, and fold into it at the next squash.
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. approve_proposal(): the PROPOSAL_APPLIED row carries the approval's transaction
-- ---------------------------------------------------------------------------------------------

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
        RAISE EXCEPTION 'proposal % not found', p_proposal_id USING ERRCODE = 'no_data_found';
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
            RAISE EXCEPTION 'device % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
        END IF;

        SELECT * INTO v_merged FROM jsonb_populate_record(v_device, v_proposal.patch);

        UPDATE public.devices
           SET name              = v_merged.name,
               description       = v_merged.description,
               asset_type        = v_merged.asset_type,
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
            RAISE EXCEPTION 'area % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
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
            RAISE EXCEPTION 'cell % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
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
            RAISE EXCEPTION 'gateway % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
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

COMMENT ON FUNCTION public.approve_proposal(p_proposal_id uuid) IS 'Approving IS applying: the lane''s own gate is re-checked server-side, the patch re-validated against proposable_columns(), and the change written in this transaction so every CHECK and foreign key on the target runs now -- an invalid change aborts the approval instead of becoming an audit record of something that did not happen. A proposal whose values are already in place is refused for the same reason. The PROPOSAL_APPLIED row names both parties and carries this transaction as its causation_id, as the target''s own audit row does, so the two group as one act.';

-- 0001's ACL, restated; CREATE OR REPLACE keeps it either way.
REVOKE ALL ON FUNCTION public.approve_proposal(p_proposal_id uuid) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.approve_proposal(p_proposal_id uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. expire_open_proposals(): the PROPOSAL_EXPIRED rows carry the run's transaction
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.expire_open_proposals() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_days    numeric;
    v_expired integer := 0;
    v_row     record;
BEGIN
    SELECT (value #>> '{}')::numeric INTO v_days
      FROM public.system_settings
     WHERE key = 'proposals.open_expiry_days';

    -- Seven days, the seeded default. A deleted setting would make the interval NULL and stop
    -- expiry silently, which is what the setting's floor exists to prevent.
    v_days := COALESCE(v_days, 7);

    PERFORM set_config('aber.proposal_transition', 'on', true);

    FOR v_row IN
        UPDATE public.change_proposals
           SET status = 'expired', decided_at = now()
         WHERE status = 'open'
           AND proposed_at < now() - make_interval(secs => v_days::double precision * 86400.0)
        RETURNING id, entity_type, entity_id, proposed_by
    LOOP
        INSERT INTO public.audit_trail
            (entity_type, entity_id, action, new_data, changed_by, actor_source, causation_id,
             audit_domain)
        VALUES (
            'change_proposals',
            v_row.id,
            'PROPOSAL_EXPIRED',
            jsonb_build_object(
                'proposed_by', v_row.proposed_by,
                'target_type', v_row.entity_type,
                'target_id',   v_row.entity_id,
                'after_days',  v_days
            ),
            -- NULL: `changed_by` names which user, and no user did this.
            NULL,
            'service',
            -- One run is one act: every proposal it closes shares this transaction.
            txid_current(),
            public.audit_domain_for('change_proposals', 'PROPOSAL_EXPIRED')
        );
        v_expired := v_expired + 1;
    END LOOP;

    RETURN v_expired;
END;
$$;

ALTER FUNCTION public.expire_open_proposals() OWNER TO postgres;

COMMENT ON FUNCTION public.expire_open_proposals() IS 'Closes open proposals older than proposals.open_expiry_days, freeing the slots they hold under both caps. Records actor_source ''service'' with changed_by NULL: the timer has no session and is not a person, and an expiry is not a rejection. Every PROPOSAL_EXPIRED row one run writes carries that run''s transaction as its causation_id.';

-- 0001's ACL, restated: the timer's, not a person's.
REVOKE ALL ON FUNCTION public.expire_open_proposals() FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.expire_open_proposals() TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. validate_change_proposal(): the COMMENT says what the function checks
-- ---------------------------------------------------------------------------------------------

COMMENT ON FUNCTION public.validate_change_proposal() IS 'Refuses a proposal in a lane proposable_columns() has no allowlist for (the withdrawn schemas lane among them), a patch naming a key the lane does not admit, and a proposal aimed at a target that is absent or archived. Runs on INSERT and on any UPDATE that touches the patch, because editing an open proposal is a path INSERT-only validation would miss.';

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
    v_fn  regprocedure;
    v_def text;
BEGIN
    -- Each writer stamps its transaction on the row it writes.
    FOREACH v_fn IN ARRAY ARRAY['public.approve_proposal(uuid)'::regprocedure,
                                'public.expire_open_proposals()'::regprocedure] LOOP
        v_def := pg_get_functiondef(v_fn);
        IF v_def !~ 'actor_source,\s+causation_id' OR position('txid_current()' IN v_def) = 0 THEN
            RAISE EXCEPTION '0021 self-check: % does not stamp causation_id with txid_current().', v_fn;
        END IF;
    END LOOP;

    -- approve_proposal() is a copy with one change, and a lane lost in a copy is silent.
    v_def := pg_get_functiondef('public.approve_proposal(uuid)'::regprocedure);
    IF v_def !~ 'entity_type = ''devices''' OR v_def !~ 'entity_type = ''device_nameplate'''
       OR v_def !~ 'entity_type = ''areas''' OR v_def !~ 'entity_type = ''cells'''
       OR v_def !~ 'entity_type = ''gateways'''
       OR position('public.may_decide_proposal(v_proposal.entity_type)' IN v_def) = 0
       OR position('public.proposal_is_already_true(p_proposal_id)' IN v_def) = 0 THEN
        RAISE EXCEPTION '0021 self-check: approve_proposal() lost a lane, its lane gate or its already-true refusal.';
    END IF;

    -- The COMMENTs this file restated no longer describe withdrawn lanes.
    IF coalesce(obj_description('public.validate_change_proposal()'::regprocedure::oid, 'pg_proc'), '') = ''
       OR obj_description('public.validate_change_proposal()'::regprocedure::oid, 'pg_proc') ILIKE '%not a draft%' THEN
        RAISE EXCEPTION '0021 self-check: the COMMENT on validate_change_proposal() is missing or still describes the schema lane''s draft check.';
    END IF;
    IF coalesce(obj_description('public.approve_proposal(uuid)'::regprocedure::oid, 'pg_proc'), '') NOT LIKE '%causation_id%'
       OR obj_description('public.approve_proposal(uuid)'::regprocedure::oid, 'pg_proc') ILIKE '%_links lanes%' THEN
        RAISE EXCEPTION '0021 self-check: the COMMENT on approve_proposal() does not name its causation_id, or still describes the link lanes.';
    END IF;

    -- The ACLs this file restated.
    IF has_function_privilege('anon', 'public.approve_proposal(uuid)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.approve_proposal(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION '0021 self-check: approve_proposal() is executable by anon, or not by authenticated.';
    END IF;
    IF has_function_privilege('anon', 'public.expire_open_proposals()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.expire_open_proposals()', 'EXECUTE') THEN
        RAISE EXCEPTION '0021 self-check: expire_open_proposals() is executable by anon or authenticated.';
    END IF;
END
$check$;
