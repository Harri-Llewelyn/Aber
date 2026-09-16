-- 0108: a link is attached, never proposed.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- 0090 opened three proposal lanes -- `cell_links`, `gateway_links`, `device_links` -- so that an
-- Operator could ask for a document to be attached to an asset. The UI for asking was never built.
-- EntityLinksModal writes straight to `links` through `link:manage`, which is how every link that
-- exists got there; `submitLinkProposal()` in frontend/src/utils/proposeFromForm.js was exported
-- and unit-tested, and called by nothing.
--
-- So the lanes were reachable only by hand-crafting a POST. This withdraws them the way 0090
-- withdrew `schemas`: the allowlist goes empty, the decision gate answers false, and the CHECK
-- constraint stops admitting the strings.
--
-- WHAT IS NOT WITHDRAWN
--
--   `link:manage` stays. It gates the direct edit, which was always the only route that worked,
--   and the links RLS policies resolve it. Only its use as a proposal gate goes -- including in
--   the outer gate of approve_proposal() and reject_proposal(), where holding it alone now admits
--   nobody to any remaining lane, so keeping it there would only change an error message.
--
--   audit_domain_for() KEEPS its three link strings. A deployment where a link proposal was once
--   approved holds `digital_thread` rows carrying those entity_types, and dropping the arms would
--   reclassify that history from the asset domain into the fail-closed security one -- silently
--   narrowing who may read records that are already written.
--
-- WHAT HAPPENS TO THE ROWS
--
-- Every `*_links` row in `change_proposals` is DELETED, open or decided. Nothing references them:
-- `change_proposals` has no foreign key pointing at it, in either direction. A row in
-- `digital_thread` recording a PROPOSAL_APPLIED for one of these lanes survives the delete and
-- keeps naming a `proposal_id` that is now absent -- the thread is the audit record and is not
-- rewritten here.
--
-- `proposable_link_tags()` is dropped with the lanes: validate_change_proposal() was its only
-- caller. The tag vocabulary itself is unaffected -- it lives in EntityLinksModal, and
-- `links.link_tag` never carried a CHECK.
-- =================================================================================================

-- -------------------------------------------------------------------------------------------------
-- 1. The rows
-- -------------------------------------------------------------------------------------------------
-- Before the constraint narrows, or the narrowing would be refused by the rows it is about.
DO $$
DECLARE
    v_deleted integer;
BEGIN
    DELETE FROM public.change_proposals
     WHERE entity_type IN ('cell_links', 'gateway_links', 'device_links');
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    IF v_deleted > 0 THEN
        RAISE NOTICE '0108: deleted % link proposal(s); the lane they were filed in no longer exists.',
            v_deleted;
    END IF;
END $$;

-- -------------------------------------------------------------------------------------------------
-- 2. What the table admits
-- -------------------------------------------------------------------------------------------------
-- The 0090 list less the three link strings. Guarded the way 0088 and 0090 guard theirs: rebuilt
-- only when it is not already this shape, so a replay is a no-op rather than a table rewrite.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.change_proposals'::regclass
           AND conname  = 'change_proposals_entity_type_known'
           AND pg_get_constraintdef(oid) LIKE '%cell_links%'
    ) THEN
        ALTER TABLE public.change_proposals
            DROP CONSTRAINT IF EXISTS change_proposals_entity_type_known;

        ALTER TABLE public.change_proposals
            ADD CONSTRAINT change_proposals_entity_type_known
            CHECK (entity_type = ANY (ARRAY[
                'devices'::text, 'device_nameplate'::text,
                'cells'::text, 'gateways'::text,
                'schemas'::text
            ]));
    END IF;
END $$;

-- -------------------------------------------------------------------------------------------------
-- 3. What each lane admits
-- -------------------------------------------------------------------------------------------------
-- The 0098 body, less the three link arms.
CREATE OR REPLACE FUNCTION public.proposable_columns(p_entity_type text) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE p_entity_type
    -- `area_id` joins `cell_id` and `location_scope`: the three together say where an asset sits,
    -- and the table's CHECKs decide whether the triple is sayable, so one proposal can relocate.
    WHEN 'devices' THEN ARRAY[
      'name', 'description', 'asset_type', 'connection_method',
      'cell_id', 'area_id', 'location_scope', 'model_3d_path'
    ]
    WHEN 'device_nameplate' THEN ARRAY[
      'manufacturer_name', 'manufacturer_product_designation', 'manufacturer_product_type',
      'serial_number', 'year_of_construction', 'date_of_manufacture', 'hardware_version',
      'firmware_version', 'software_version', 'country_of_origin', 'uri_of_the_product'
    ]

    -- `grafana_url` is a dashboard address and `icon` is one of eight names the CHECK on the table
    -- admits. `area_id` and the place are where the cell is; the cells trigger decides whether the
    -- three agree.
    WHEN 'cells' THEN ARRAY['name', 'grafana_url', 'icon', 'area_id', 'plan_x', 'plan_y', 'description']

    WHEN 'gateways' THEN ARRAY['name', 'description', 'cell_id', 'area_id', 'location_scope', 'access_url']

    -- 'schemas' is absent on purpose, and so are the three link lanes 0108 withdrew: the empty
    -- array is how this function closes a lane.
    ELSE ARRAY[]::text[]
  END
$$;

COMMENT ON FUNCTION public.proposable_columns(p_entity_type text) IS 'Which columns a change proposal may name, per entity type. An unknown or withdrawn entity type yields the empty array, so a lane nobody has written an allowlist for can propose nothing at all rather than everything. Withdrawn: schemas (0090) and the three link lanes (0108).';

-- -------------------------------------------------------------------------------------------------
-- 4. Who may decide one
-- -------------------------------------------------------------------------------------------------
-- The 0090 body, less the three link arms.
CREATE OR REPLACE FUNCTION public.may_decide_proposal(p_entity_type text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE p_entity_type
    -- The two original lanes, unchanged. `device:manage` is held by exactly the two roles named
    -- here, so rewriting them as has_authority() would be a no-op with a migration's blast radius.
    WHEN 'devices'          THEN public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
    WHEN 'device_nameplate' THEN public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])

    -- 0090. THE PERMISSION THE TABLE'S OWN POLICY RESOLVES, so the lane closes when the grant is
    -- withdrawn rather than outliving it.
    WHEN 'cells'            THEN public.has_authority(ARRAY['cell:manage'])
    WHEN 'gateways'         THEN public.has_authority(ARRAY['gateway:manage'])

    -- 'schemas' FALLS THROUGH TO false, which is 0090 withdrawing the lane rather than an omission,
    -- and so do the three link lanes 0108 withdrew. Nothing can be filed in either (proposable_columns
    -- is empty) and nothing left in them can be decided.
    -- `link:manage` is NOT retired with them: it still gates the direct edit that was always the
    -- only way a link was actually attached.
    ELSE false
  END
$$;

COMMENT ON FUNCTION public.may_decide_proposal(p_entity_type text) IS 'Who may approve or reject a proposal in this lane. The two device lanes resolve a role pair; every lane added since resolves the PERMISSION its target table''s own policy resolves, so the lane closes when the grant is withdrawn rather than outliving it. An unknown or withdrawn lane -- schemas since 0090, the three link lanes since 0108 -- is decidable by nobody.';

-- -------------------------------------------------------------------------------------------------
-- 5. Whether a proposal has already come true
-- -------------------------------------------------------------------------------------------------
-- The 0090 body, less the link branch. Every remaining lane is an UPDATE over an existing row, so
-- containment is the whole test again.
CREATE OR REPLACE FUNCTION public.proposal_is_already_true(p_proposal_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_proposal public.change_proposals%ROWTYPE;
    v_current  jsonb;
BEGIN
    SELECT * INTO v_proposal FROM public.change_proposals WHERE id = p_proposal_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;


    SELECT CASE v_proposal.entity_type
        WHEN 'devices' THEN
            (SELECT to_jsonb(d) FROM public.devices d WHERE d.id = v_proposal.entity_id)
        WHEN 'device_nameplate' THEN
            (SELECT to_jsonb(n) FROM public.device_nameplate n
              WHERE n.device_id = v_proposal.entity_id)
        WHEN 'cells' THEN
            (SELECT to_jsonb(c) FROM public.cells c WHERE c.id = v_proposal.entity_id)
        WHEN 'gateways' THEN
            (SELECT to_jsonb(g) FROM public.gateways g WHERE g.id = v_proposal.entity_id)
        ELSE NULL
    END INTO v_current;

    -- NO ROW IS NOT A NO-OP. A device_nameplate that does not exist yet is the normal case for that
    -- lane -- the approval CREATES it -- so a missing row means the proposal has everything still
    -- to do.
    IF v_current IS NULL THEN
        RETURN false;
    END IF;

    -- CONTAINMENT, NOT EQUALITY: does the row already hold every value the patch proposes? Columns
    -- the patch says nothing about are ignored, which is what a patch means.
    RETURN v_current @> v_proposal.patch;
END;
$$;

-- -------------------------------------------------------------------------------------------------
-- 6. What a proposal has to look like before it is queued
-- -------------------------------------------------------------------------------------------------
-- The 0090 body, less the link arms of the target check and the whole required-fields block that
-- followed it. `v_tag` went with the block that was its only reader.
CREATE OR REPLACE FUNCTION public.validate_change_proposal() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_allowed text[] := public.proposable_columns(NEW.entity_type);
    v_key     text;
    v_exists  boolean;
BEGIN
    -- Fail closed, naming the real problem: the CHECK constraint admits the known lanes and this
    -- trigger runs before it. This is also how the schema lane's withdrawal is enforced: the string
    -- is admitted by the constraint and has no allowlist.
    IF array_length(v_allowed, 1) IS NULL THEN
        RAISE EXCEPTION
            'nothing is proposable on %; proposable_columns() has no allowlist for it',
            NEW.entity_type
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    FOREACH v_key IN ARRAY ARRAY(SELECT jsonb_object_keys(NEW.patch)) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            -- NAMED, not merely refused. The proposer chose this field in a form; "invalid patch"
            -- would send them to an administrator to find out which one.
            RAISE EXCEPTION
                'column % is not proposable on %; proposable columns are: %',
                v_key, NEW.entity_type, array_to_string(v_allowed, ', ')
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
    END LOOP;

    -- ---------------------------------------------------------------------------------------------
    -- The target has to exist, and no foreign key can say so: `entity_id` addresses a different
    -- table depending on `entity_type`. Archived is refused too.
    -- ---------------------------------------------------------------------------------------------
    v_exists := CASE
        WHEN NEW.entity_type IN ('devices', 'device_nameplate') THEN
            EXISTS (SELECT 1 FROM public.devices d
                     WHERE d.id = NEW.entity_id AND d.is_archived = false)
        WHEN NEW.entity_type = 'cells' THEN
            EXISTS (SELECT 1 FROM public.cells c
                     WHERE c.id = NEW.entity_id AND COALESCE(c.is_archived, false) = false)
        WHEN NEW.entity_type = 'gateways' THEN
            EXISTS (SELECT 1 FROM public.gateways g
                     WHERE g.id = NEW.entity_id AND COALESCE(g.is_archived, false) = false)
        ELSE false
    END;

    IF NOT v_exists THEN
        RAISE EXCEPTION 'no live target % to propose a % change against',
            NEW.entity_id, NEW.entity_type
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END;
$$;

-- -------------------------------------------------------------------------------------------------
-- 7. Approving is applying
-- -------------------------------------------------------------------------------------------------
-- The 0098 body, less the ELSIF that inserted a `links` row and the `link:manage` arm of the outer
-- gate. Every remaining branch updates a row that already exists.
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
    v_cell      public.cells%ROWTYPE;
    v_cell_new  public.cells%ROWTYPE;
    v_gateway   public.gateways%ROWTYPE;
    v_gw_new    public.gateways%ROWTYPE;
    v_actor     uuid := auth.uid();
    v_allowed   text[];
    v_key       text;
    v_thread    bigint;
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
    PERFORM set_config('acs_cymru.actor_id', v_actor::text, true);

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
               -- The proposer; see 0086.
               updated_by                       = v_proposal.proposed_by
         WHERE device_id = v_proposal.entity_id;

    ELSIF v_proposal.entity_type = 'cells' THEN
        SELECT * INTO v_cell FROM public.cells
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'cell % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
        END IF;

        SELECT * INTO v_cell_new FROM jsonb_populate_record(v_cell, v_proposal.patch);

        -- The table's CHECKs, the area foreign key and place_cell_in_its_area() run on this
        -- UPDATE, so a patch naming an icon nobody drew, a deleted area or a place too close to a
        -- neighbour aborts the approval rather than being stored.
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
    -- No `schemas` branch: 0090 withdrew the lane and may_decide_proposal() refuses it above. No
    -- link branch either: 0108 withdrew those three the same way, and a link has only ever been
    -- attached by the direct edit that `link:manage` gates.

    -- The row that names both parties; the target's own audit trigger records only the approver.
    INSERT INTO public.digital_thread
        (entity_type, entity_id, action, old_data, new_data, changed_by, actor_source, audit_domain)
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
        public.audit_domain_for(v_proposal.entity_type, 'PROPOSAL_APPLIED')
    )
    RETURNING id INTO v_thread;

    PERFORM set_config('acs_cymru.proposal_transition', 'on', true);

    UPDATE public.change_proposals
       SET status = 'applied', decided_by = v_actor, decided_at = now(),
           applied_thread_id = v_thread
     WHERE id = p_proposal_id;

    RETURN jsonb_build_object(
        'id', p_proposal_id, 'status', 'applied', 'thread_id', v_thread
    );
END;
$$;

-- -------------------------------------------------------------------------------------------------
-- 8. Rejecting one
-- -------------------------------------------------------------------------------------------------
-- Only the outer gate changes, for the same reason it changed in approve_proposal().
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

    PERFORM set_config('acs_cymru.proposal_transition', 'on', true);

    UPDATE public.change_proposals
       SET status = 'rejected', decided_by = v_actor, decided_at = now(),
           decision_reason = p_reason
     WHERE id = p_proposal_id;

    RETURN jsonb_build_object('id', p_proposal_id, 'status', 'rejected');
END;
$$;

-- -------------------------------------------------------------------------------------------------
-- 9. The tag list the link lanes validated against
-- -------------------------------------------------------------------------------------------------
-- validate_change_proposal() was its only caller, and section 6 no longer calls it. The vocabulary
-- itself is unaffected: it lives in EntityLinksModal, and `links.link_tag` carries no CHECK.
DROP FUNCTION IF EXISTS public.proposable_link_tags();

-- -------------------------------------------------------------------------------------------------
-- 10. Self-check
-- -------------------------------------------------------------------------------------------------
-- RELATIVE, NEVER A TOTAL: this asserts the three lanes are shut, not how many lanes exist. An
-- absolute count is the assertion 0069 made and 0086 broke on its second boot.
DO $$
DECLARE
    v_lane    text;
    v_missing text[] := ARRAY[]::text[];
    v_rows    integer;
BEGIN
    FOREACH v_lane IN ARRAY ARRAY['cell_links', 'gateway_links', 'device_links'] LOOP
        IF array_length(public.proposable_columns(v_lane), 1) IS NOT NULL THEN
            v_missing := v_missing || format('proposable_columns(%s) still has an allowlist', v_lane);
        END IF;

        IF public.may_decide_proposal(v_lane) THEN
            v_missing := v_missing || format('may_decide_proposal(%s) still answers true', v_lane);
        END IF;

        -- The audit domain KEEPS these three; see the header. Asserted so that a later tidy-up
        -- removing them has to argue with this line first.
        IF public.audit_domain_for(v_lane, 'PROPOSAL_APPLIED') <> 'asset' THEN
            v_missing := v_missing || format(
                'audit_domain_for(%s) is no longer asset; digital_thread history for that lane just '
                'became security-domain', v_lane);
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.change_proposals'::regclass
           AND conname  = 'change_proposals_entity_type_known'
           AND pg_get_constraintdef(oid) LIKE '%_links%'
    ) THEN
        v_missing := v_missing || 'change_proposals_entity_type_known still admits a link lane';
    END IF;

    SELECT count(*) INTO v_rows
      FROM public.change_proposals
     WHERE entity_type IN ('cell_links', 'gateway_links', 'device_links');
    IF v_rows > 0 THEN
        v_missing := v_missing || format('% link proposal row(s) survived the delete', v_rows);
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'proposable_link_tags'
    ) THEN
        v_missing := v_missing || 'proposable_link_tags() still exists';
    END IF;

    -- The permission is NOT retired with the lanes: it still gates the direct edit.
    IF NOT EXISTS (SELECT 1 FROM public.permissions WHERE name = 'link:manage') THEN
        v_missing := v_missing || 'link:manage is gone; EntityLinksModal resolves it to allow an edit';
    END IF;

    IF array_length(v_missing, 1) IS NOT NULL THEN
        RAISE EXCEPTION '0108 self-check failed: %', array_to_string(v_missing, '; ');
    END IF;

    RAISE NOTICE '0108 self-check passed: the three link lanes are shut, their rows are gone, '
                 'link:manage still gates the direct edit, and the audit domain still reads asset.';
END $$;
