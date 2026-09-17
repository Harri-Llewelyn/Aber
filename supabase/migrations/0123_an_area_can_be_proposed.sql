-- 0123: an area can be proposed.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- Areas gained a page, a plan and a place in the Unified Namespace in 0097, and never gained a
-- proposal lane. An Operator holds `proposal:create` and can ask for a change to a device, a
-- nameplate, a cell or a gateway -- and on the one rung between the site and its cells was shown a
-- greyed-out Edit Details reading "Requires Admin permissions", with nothing to do about it.
--
-- Reported by operators. This is the missing arm in six places, not a new mechanism: the queue, the
-- caps, the RLS, the expiry and the audit trail all already serve any lane the CHECK admits.
--
-- THREE COLUMNS, which is every column an area has that a person chooses. `id` and `created_at` are
-- the platform's. The table's own guards run on the approval's UPDATE, so a patch naming an icon
-- nobody drew, a name with a topic separator in it, or a name another area already holds aborts the
-- approval inside the approver's transaction rather than being stored.
--
-- THE DECIDE GATE RESOLVES A ROLE, NOT A PERMISSION, and that is deliberate -- see section 4.
--
-- Nothing here touches `audit_domain_for()`: 0097 put `areas` in the asset lane and 0120 left it
-- there. Nothing touches the `change_proposals` policies either, which name no lane at all.

SET search_path TO public;

-- -------------------------------------------------------------------------------------------------
-- 1. The lane is admitted
-- -------------------------------------------------------------------------------------------------
-- Guarded by the predicate rather than by a version check, so a replay updates nothing and a
-- database that has never had the constraint still gets it.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.change_proposals'::regclass
           AND conname  = 'change_proposals_entity_type_known'
           AND pg_get_constraintdef(oid) LIKE '%areas%'
    ) THEN
        ALTER TABLE public.change_proposals
            DROP CONSTRAINT IF EXISTS change_proposals_entity_type_known;

        ALTER TABLE public.change_proposals
            ADD CONSTRAINT change_proposals_entity_type_known
            CHECK (entity_type = ANY (ARRAY[
                'devices'::text, 'device_nameplate'::text,
                'areas'::text, 'cells'::text, 'gateways'::text,
                'schemas'::text
            ]));
    END IF;
END $$;

-- -------------------------------------------------------------------------------------------------
-- 2. What the lane admits
-- -------------------------------------------------------------------------------------------------
-- The 0108 body, plus the areas arm.
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

    -- Every column of an area a person chooses; the other two are the platform's. `name` reaches
    -- MQTT as the <area> segment of every uns/ topic beneath it, which is why the table carries
    -- `areas_name_topic_safe` and a UNIQUE -- both run on the approval's UPDATE. `icon` is one of
    -- the eight names `areas_icon_valid` admits.
    WHEN 'areas' THEN ARRAY['name', 'description', 'icon']

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

COMMENT ON FUNCTION public.proposable_columns(p_entity_type text) IS 'Which columns a change proposal may name, per entity type. An unknown or withdrawn entity type yields the empty array, so a lane nobody has written an allowlist for can propose nothing at all rather than everything. Withdrawn: schemas (0090) and the three link lanes (0108). Areas joined in 0123.';

-- -------------------------------------------------------------------------------------------------
-- 3. Whether a proposal has already come true
-- -------------------------------------------------------------------------------------------------
-- The 0108 body, plus the areas arm. Every lane is an UPDATE over an existing row, so containment
-- is the whole test.
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
        WHEN 'areas' THEN
            (SELECT to_jsonb(a) FROM public.areas a WHERE a.id = v_proposal.entity_id)
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
-- 4. Who may decide one
-- -------------------------------------------------------------------------------------------------
-- The 0108 body, plus the areas arm.
CREATE OR REPLACE FUNCTION public.may_decide_proposal(p_entity_type text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE p_entity_type
    -- The two original lanes, unchanged. `device:manage` is held by exactly the two roles named
    -- here, so rewriting them as has_authority() would be a no-op with a migration's blast radius.
    WHEN 'devices'          THEN public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
    WHEN 'device_nameplate' THEN public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])

    -- 0123. A ROLE PAIR, NOT A PERMISSION, WHICH IS THE RULE AND NOT AN EXCEPTION TO IT. The rule
    -- every lane follows is: resolve whatever the target table's own policy resolves, so the lane
    -- closes when that closes. `areas_update_privileged` resolves this role pair -- there is no
    -- `area:manage` grant anywhere in the schema -- so mirroring it means has_role() here. A lane
    -- gated on a permission the table does not consult would be a second, disagreeing answer.
    WHEN 'areas'            THEN public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])

    -- 0090. THE PERMISSION THE TABLE'S OWN POLICY RESOLVES, so the lane closes when the grant is
    -- withdrawn rather than outliving it.
    WHEN 'cells'            THEN public.has_authority(ARRAY['cell:manage'])
    WHEN 'gateways'         THEN public.has_authority(ARRAY['gateway:manage'])

    -- 'schemas' FALLS THROUGH TO false, which is 0090 withdrawing the lane rather than an omission,
    -- and so do the three link lanes 0108 withdrew. Nothing can be filed in either (proposable_columns
    -- is empty) and nothing left in them can be decided.
    ELSE false
  END
$$;

COMMENT ON FUNCTION public.may_decide_proposal(p_entity_type text) IS 'Who may approve or reject a proposal in this lane. Each lane resolves whatever its target table''s own policy resolves, so the lane closes when that closes: the two device lanes and areas (0123) resolve a role pair, cells and gateways the permission their policy names. An unknown or withdrawn lane -- schemas since 0090, the three link lanes since 0108 -- is decidable by nobody.';

-- -------------------------------------------------------------------------------------------------
-- 5. What a proposal has to look like before it is queued
-- -------------------------------------------------------------------------------------------------
-- The 0108 body, plus the areas arm of the target check.
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
        -- NO ARCHIVED TEST, because an area cannot be archived: `areas` carries no `is_archived`
        -- column. An area is deleted outright and its cells become unfiled, so existing is the
        -- whole of what there is to check here.
        WHEN NEW.entity_type = 'areas' THEN
            EXISTS (SELECT 1 FROM public.areas a WHERE a.id = NEW.entity_id)
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
-- 6. Approving is applying
-- -------------------------------------------------------------------------------------------------
-- The 0108 body, plus the areas branch and its two locals. The outer gate is unchanged: it already
-- admits the role pair this lane resolves, so an area approver passes it on the has_role() half.
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

    ELSIF v_proposal.entity_type = 'areas' THEN
        SELECT * INTO v_area FROM public.areas
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'area % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
        END IF;

        SELECT * INTO v_area_new FROM jsonb_populate_record(v_area, v_proposal.patch);

        -- `areas_name_topic_safe`, `areas_name_key` and `areas_icon_valid` run on this UPDATE, so a
        -- patch naming an area another area is already called, a name carrying a topic separator,
        -- or an icon nobody drew aborts the approval rather than being stored. The refusal is the
        -- database's own sentence and the proposal stays open.
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
-- 7. Self-check
-- -------------------------------------------------------------------------------------------------
-- Properties, never totals: an absolute count passes on the boot that writes it and breaks on the
-- next migration that adds a lane, in a place `test:db` cannot see.
DO $$
DECLARE
    v_missing text[] := ARRAY[]::text[];
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.change_proposals'::regclass
           AND conname  = 'change_proposals_entity_type_known'
           AND pg_get_constraintdef(oid) LIKE '%areas%'
    ) THEN
        v_missing := v_missing || 'change_proposals_entity_type_known does not admit the areas lane';
    END IF;

    IF NOT ('name' = ANY (public.proposable_columns('areas'))) THEN
        v_missing := v_missing || 'proposable_columns(areas) does not admit name';
    END IF;

    -- The lane must not be able to name a column the platform owns. `id` and `created_at` are not a
    -- person's to propose, and this is the assertion that says so rather than the list's length.
    IF public.proposable_columns('areas') && ARRAY['id', 'created_at'] THEN
        v_missing := v_missing || 'proposable_columns(areas) admits a column the platform owns';
    END IF;

    IF array_length(v_missing, 1) IS NOT NULL THEN
        RAISE EXCEPTION '0123 self-check failed: %', array_to_string(v_missing, '; ');
    END IF;
END $$;
