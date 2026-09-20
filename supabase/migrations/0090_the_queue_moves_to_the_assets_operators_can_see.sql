-- =================================================================================================
-- 0090 :: THE QUEUE MOVES TO THE ASSETS AN OPERATOR CAN ACTUALLY SEE
-- =================================================================================================
--
-- 1. THE SCHEMA LANE IS WITHDRAWN. A draft is created by `fork_schema()`, which requires
--    `schema:manage`, so the only person who could create a draft was the only person who could
--    publish it, and an Operator proposing a publication was never proposing a change they had
--    authored. `proposable_columns('schemas')` returns the empty array (so the validator's
--    fail-closed branch refuses a new one and names the reason), `may_decide_proposal('schemas')`
--    returns false, and `approve_proposal()` loses its schemas branch. The CHECK constraint still
--    admits the string, because refusing it would refuse the rows already in the table. Anything
--    still open in that lane is withdrawn below with a reason. 0087 is not reverted.
--
-- 2. CELLS, GATEWAYS AND DOCUMENTS TAKE ITS PLACE. `cells` and `gateways` are patches of
--    allowlisted columns over an existing row, as `devices` is. `cell_links`, `gateway_links` and
--    `device_links` are a new shape: the patch is a row to create in `links`, so `display_name`
--    and `url` are required rather than optional. Three link lanes rather than one because
--    `entity_id`'s table is decided by `entity_type`, and the validator must know which table to
--    look the target up in.
--
--    Proposable: cells (name, grafana_url, icon; not the lifecycle columns), gateways (name,
--    description, cell_id, location_scope, access_url; not what the gateway IS or publishes
--    under, and not any observed health column), *_links (display_name, url, link_tag; adding
--    only, since `links.id` is not `entity_id`). The new lanes resolve authority
--    (`cell:manage` etc.), not role names, so a lane cannot drift from the policy on its table.
--
-- 3. A PROPOSAL THAT HAS ALREADY COME TRUE CANNOT BE APPROVED. The queue is a way to ask, not a
--    lock, so a Manager can make the change by hand while a proposal sits open. Approving it then
--    would record an act with no effect attributed to somebody who did not perform it, so
--    `approve_proposal()` refuses and the repair is to reject it with a reason. The test is
--    `to_jsonb(current_row) @> patch`: containment, so a type mismatch fails towards "approval
--    proceeds", never towards refusing a real change.
-- =================================================================================================

-- -------------------------------------------------------------------------------------------------
-- 1. Close what the withdrawn lane leaves open
-- -------------------------------------------------------------------------------------------------
-- Before the functions below stop admitting the lane, or these rows become undecidable. A no-op
-- after the first boot.
DO $$
DECLARE
    v_closed integer;
BEGIN
    -- The transition guard refuses a status change that does not come through the RPCs, which is
    -- what keeps a client from closing its own proposal. This is that guard's owner speaking.
    PERFORM set_config('acs_cymru.proposal_transition', 'on', true);

    UPDATE public.change_proposals
       SET status = 'withdrawn',
           decided_at = now(),
           decision_reason = 'The schema lane was withdrawn in 0090: a draft can only be created '
                             || 'by somebody who can already publish it, so a proposal here was '
                             || 'never a change the proposer could not make.'
     WHERE entity_type = 'schemas'
       AND status = 'open';

    GET DIAGNOSTICS v_closed = ROW_COUNT;
    IF v_closed > 0 THEN
        RAISE NOTICE '0090: withdrew % open schema proposal(s); the lane is closed.', v_closed;
    END IF;
END $$;

-- -------------------------------------------------------------------------------------------------
-- 2. The lanes the queue admits
-- -------------------------------------------------------------------------------------------------
-- 'schemas' is still listed: the constraint applies to rows already in the table. Guarded on the
-- lane this migration exists to admit, not on the definition: a migration may widen a domain on
-- replay freely and may narrow one only until something later widens it again, so whoever adds
-- the next lane must copy this shape. The second half is the recovery case: `ALTER TABLE`
-- autocommits per statement, and a failed boot can leave the table with no constraint at all.
-- See docs/incidents.md -> "A replayed narrowing is a retraction".
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.change_proposals'::regclass
           AND conname  = 'change_proposals_entity_type_known'
           AND pg_get_constraintdef(oid) LIKE '%''cells''%'
    ) AND NOT EXISTS (
        SELECT 1
          FROM public.change_proposals
         WHERE entity_type <> ALL (ARRAY[
             'devices'::text, 'device_nameplate'::text,
             'cells'::text, 'gateways'::text,
             'cell_links'::text, 'gateway_links'::text, 'device_links'::text,
             'schemas'::text
         ])
    ) THEN
        ALTER TABLE public.change_proposals
            DROP CONSTRAINT IF EXISTS change_proposals_entity_type_known;

        ALTER TABLE public.change_proposals
            ADD CONSTRAINT change_proposals_entity_type_known
            CHECK (entity_type = ANY (ARRAY[
                'devices'::text, 'device_nameplate'::text,
                'cells'::text, 'gateways'::text,
                'cell_links'::text, 'gateway_links'::text, 'device_links'::text,
                'schemas'::text
            ]));
    END IF;
END $$;

-- -------------------------------------------------------------------------------------------------
-- 3. What each lane admits
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.proposable_columns(p_entity_type text) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE p_entity_type
    WHEN 'devices' THEN ARRAY[
      'name', 'description', 'asset_type', 'connection_method',
      'cell_id', 'location_scope', 'model_3d_path'
    ]
    WHEN 'device_nameplate' THEN ARRAY[
      'manufacturer_name', 'manufacturer_product_designation', 'manufacturer_product_type',
      'serial_number', 'year_of_construction', 'date_of_manufacture', 'hardware_version',
      'firmware_version', 'software_version', 'country_of_origin', 'uri_of_the_product'
    ]

    -- `grafana_url` is a dashboard address and `icon` is one of eight names the CHECK on the table
    -- admits -- an icon nobody drew aborts the approval rather than being stored.
    WHEN 'cells' THEN ARRAY['name', 'grafana_url', 'icon']

    -- `cell_id` and `location_scope` together decide where a gateway sits, and the table's own
    -- CHECKs decide whether the pair is sayable. Both are proposable so a relocation can be asked
    -- for as ONE proposal; splitting them would let an approval land halfway between two valid
    -- states and be refused for a combination nobody proposed.
    WHEN 'gateways' THEN ARRAY['name', 'description', 'cell_id', 'location_scope', 'access_url']

    -- THE COLUMNS OF A ROW TO CREATE, not of one to change. `display_name` and `url` are also
    -- REQUIRED, which this function cannot express -- validate_change_proposal() carries that half.
    WHEN 'cell_links'    THEN ARRAY['display_name', 'url', 'link_tag']
    WHEN 'gateway_links' THEN ARRAY['display_name', 'url', 'link_tag']
    WHEN 'device_links'  THEN ARRAY['display_name', 'url', 'link_tag']

    -- 'schemas' IS ABSENT ON PURPOSE and is not an oversight: the empty array is how this function
    -- closes a lane. validate_change_proposal() reads it first and refuses with "nothing is
    -- proposable on schemas", which is the true sentence.
    ELSE ARRAY[]::text[]
  END
$$;

COMMENT ON FUNCTION public.proposable_columns(p_entity_type text) IS 'Which columns a change proposal may name, per entity type. An unknown or withdrawn entity type yields the empty array, so a lane nobody has written an allowlist for can propose nothing at all rather than everything. For the three *_links lanes this is the shape of a row to CREATE, and validate_change_proposal() additionally requires display_name and url.';

-- -------------------------------------------------------------------------------------------------
-- 4. The tags a proposed document may carry
-- -------------------------------------------------------------------------------------------------
-- Mirrored by `TAG_LABELS` in frontend/src/components/modals/EntityLinksModal.jsx and compared by
-- scripts/check-mirror-drift.mjs. `links.link_tag` itself still carries no CHECK; this refuses to
-- create new junk through the queue only.
CREATE OR REPLACE FUNCTION public.proposable_link_tags() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT ARRAY[
    'image', 'health_and_safety', 'procurement', 'schematic',
    'asset_register', 'file_repository', 'other'
  ]
$$;

COMMENT ON FUNCTION public.proposable_link_tags() IS 'The link_tag values a proposed document may carry. Mirrored by TAG_LABELS in frontend/src/components/modals/EntityLinksModal.jsx and compared by scripts/check-mirror-drift.mjs.';

REVOKE ALL ON FUNCTION public.proposable_link_tags() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.proposable_link_tags() TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 5. Who may decide each lane
-- -------------------------------------------------------------------------------------------------
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
    WHEN 'cell_links'       THEN public.has_authority(ARRAY['link:manage'])
    WHEN 'gateway_links'    THEN public.has_authority(ARRAY['link:manage'])
    WHEN 'device_links'     THEN public.has_authority(ARRAY['link:manage'])

    -- 'schemas' FALLS THROUGH TO false, which is 0090 withdrawing the lane rather than an omission.
    -- Nothing can be filed in it (proposable_columns is empty) and nothing left in it can be
    -- decided; the open rows were withdrawn at the top of this file.
    ELSE false
  END
$$;

COMMENT ON FUNCTION public.may_decide_proposal(p_entity_type text) IS 'Who may approve or reject a proposal in this lane. The two device lanes resolve a role pair; every lane added since resolves the PERMISSION its target table''s own policy resolves, so the lane closes when the grant is withdrawn rather than outliving it. An unknown or withdrawn lane -- schemas, since 0090 -- is decidable by nobody.';

-- -------------------------------------------------------------------------------------------------
-- 6. The audit domain of the new lanes
-- -------------------------------------------------------------------------------------------------
-- The three link lanes are new strings and would otherwise fall through to the fail-closed
-- security domain, where a Shopfloor_Manager could not read the record of a document they
-- approved.
CREATE OR REPLACE FUNCTION public.audit_domain_for(p_entity_type text, p_action text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    -- Identity and authority. Every act on these is Administrator-only to perform, so it is
    -- Administrator-and-Auditor to read.
    WHEN p_entity_type IN ('service_principals', 'user_roles', 'system_settings')
      THEN 'security'

    -- The asset trail: the shopfloor's own history. CREDENTIAL_ISSUED lands here on `gateways`
    -- deliberately: a Manager may mint a host-run gateway's broker credential. `device_nameplate` and
    -- `change_proposals` joined in 0086; the three *_links lanes in 0090.
    WHEN p_entity_type IN ('cells', 'devices', 'gateways', 'links',
                           'device_nameplate', 'change_proposals',
                           'cell_links', 'gateway_links', 'device_links')
      THEN 'asset'

    -- FAIL-CLOSED. A new entity_type nobody classified is restricted rather than exposed. The
    -- cost is a lane a Manager cannot see and will report; the alternative is a privileged act
    -- they can, and will not.
    ELSE 'security'
  END
$$;

-- -------------------------------------------------------------------------------------------------
-- 7. Has this proposal already come true?
-- -------------------------------------------------------------------------------------------------
-- Read by approve_proposal(), and exposed to the browser so the queue can warn before the click.
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

    -- A LINK PROPOSAL IS A CREATE, so "already true" is not containment -- there is no row to
    -- contain it. It is: does this asset already carry a document at that address? The URL is the
    -- identity of a link; two rows pointing at the same PDF under different display names are the
    -- duplicate this is asked to catch.
    IF v_proposal.entity_type IN ('cell_links', 'gateway_links', 'device_links') THEN
        RETURN EXISTS (
            SELECT 1 FROM public.links l
             WHERE l.entity_id = v_proposal.entity_id::text
               AND l.url = v_proposal.patch ->> 'url'
        );
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

COMMENT ON FUNCTION public.proposal_is_already_true(uuid) IS 'Whether every value this proposal asks for is already in place -- because somebody made the change by hand while it sat in the queue. approve_proposal() refuses such a proposal rather than writing an audit row for a change that did not happen; the queue reads it to warn an approver first.';

REVOKE ALL ON FUNCTION public.proposal_is_already_true(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.proposal_is_already_true(uuid) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 8. What a proposal has to look like before it is queued
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_change_proposal() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_allowed text[] := public.proposable_columns(NEW.entity_type);
    v_key     text;
    v_tag     text;
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
        WHEN NEW.entity_type IN ('devices', 'device_nameplate', 'device_links') THEN
            EXISTS (SELECT 1 FROM public.devices d
                     WHERE d.id = NEW.entity_id AND d.is_archived = false)
        WHEN NEW.entity_type IN ('cells', 'cell_links') THEN
            EXISTS (SELECT 1 FROM public.cells c
                     WHERE c.id = NEW.entity_id AND COALESCE(c.is_archived, false) = false)
        WHEN NEW.entity_type IN ('gateways', 'gateway_links') THEN
            EXISTS (SELECT 1 FROM public.gateways g
                     WHERE g.id = NEW.entity_id AND COALESCE(g.is_archived, false) = false)
        ELSE false
    END;

    IF NOT v_exists THEN
        RAISE EXCEPTION 'no live target % to propose a % change against',
            NEW.entity_id, NEW.entity_type
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- ---------------------------------------------------------------------------------------------
    -- The link lanes are a create, so their required fields are required: a new `links` row has
    -- no "as it was" to fall back on, and a hole is caught now rather than by a NOT NULL at
    -- approval.
    -- ---------------------------------------------------------------------------------------------
    IF NEW.entity_type IN ('cell_links', 'gateway_links', 'device_links') THEN
        IF COALESCE(NULLIF(TRIM(NEW.patch ->> 'display_name'), ''), '') = '' THEN
            RAISE EXCEPTION 'a proposed document needs a display_name'
                USING ERRCODE = 'invalid_parameter_value';
        END IF;

        IF COALESCE(NULLIF(TRIM(NEW.patch ->> 'url'), ''), '') = '' THEN
            RAISE EXCEPTION 'a proposed document needs a url'
                USING ERRCODE = 'invalid_parameter_value';
        END IF;

        -- ABSOLUTE, WITH ITS SCHEME. A relative path resolves against whatever page happens to
        -- render it -- this app's own origin -- so "documents/rams.pdf" would become a link into
        -- the platform that goes nowhere, and it would do so silently.
        IF NEW.patch ->> 'url' !~ '^[a-zA-Z][a-zA-Z0-9+.\-]*://' THEN
            RAISE EXCEPTION
                'a proposed document url must be absolute, including its scheme (https://…); got %',
                NEW.patch ->> 'url'
                USING ERRCODE = 'invalid_parameter_value';
        END IF;

        v_tag := NEW.patch ->> 'link_tag';
        IF v_tag IS NOT NULL AND NOT (v_tag = ANY (public.proposable_link_tags())) THEN
            RAISE EXCEPTION 'link_tag % is not one of: %',
                v_tag, array_to_string(public.proposable_link_tags(), ', ')
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- -------------------------------------------------------------------------------------------------
-- 9. Approving is applying
-- -------------------------------------------------------------------------------------------------
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
    v_link_kind text;
    v_actor     uuid := auth.uid();
    v_allowed   text[];
    v_key       text;
    v_thread    bigint;
BEGIN
    -- The outer gate is deliberately the UNION of everybody who may decide anything, because the
    -- lane's own gate below is the one that decides. Narrowing it would refuse a lane before
    -- may_decide_proposal() got to answer for it.
    IF NOT (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
            OR public.has_authority(ARRAY['cell:manage', 'gateway:manage', 'link:manage'])) THEN
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

    -- RE-VALIDATED, not trusted. The insert trigger checked this patch, and the patch may have
    -- been edited since; the allowlist may also have narrowed between the two moments -- which is
    -- exactly what happened to the schema lane in this migration.
    v_allowed := public.proposable_columns(v_proposal.entity_type);
    FOREACH v_key IN ARRAY ARRAY(SELECT jsonb_object_keys(v_proposal.patch)) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            RAISE EXCEPTION 'proposal % names % , which is not proposable on %',
                p_proposal_id, v_key, v_proposal.entity_type
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
    END LOOP;

    -- ALREADY TRUE IS NOT APPROVABLE. See the header: approving here would write a PROPOSAL_APPLIED
    -- row naming this approver and this patch for a change that happened earlier, by hand, by
    -- somebody else. The repair is to reject it with that as the reason, which records what
    -- actually happened.
    IF public.proposal_is_already_true(p_proposal_id) THEN
        RAISE EXCEPTION
            'this change is already in place -- somebody made it while the proposal was open; reject it with that as the reason rather than recording an approval that changes nothing'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Attribute every trigger-written audit row in this transaction to the APPROVER. SET LOCAL, so
    -- it is discarded at COMMIT and cannot bleed into the connection's next user.
    PERFORM set_config('acs_cymru.actor_id', v_actor::text, true);

    IF v_proposal.entity_type = 'devices' THEN
        SELECT * INTO v_device FROM public.devices
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'device % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
        END IF;

        SELECT * INTO v_merged FROM jsonb_populate_record(v_device, v_proposal.patch);

        -- Column by column, allowlist only. A column absent from the patch keeps the value the
        -- merge carried over from the current row, which is what makes this a patch rather than
        -- a row snapshot that reverts whatever moved underneath it.
        UPDATE public.devices
           SET name              = v_merged.name,
               description       = v_merged.description,
               asset_type        = v_merged.asset_type,
               connection_method = v_merged.connection_method,
               cell_id           = v_merged.cell_id,
               location_scope    = v_merged.location_scope,
               model_3d_path     = v_merged.model_3d_path
         WHERE id = v_device.id;

    ELSIF v_proposal.entity_type = 'device_nameplate' THEN
        -- A device with no nameplate row yet is the normal case, not an error: the row is created
        -- by whoever first asserts something about the asset, and here that is the proposer.
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
               -- THE PROPOSER, and see 0086 for why.
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

        -- `cells_icon_valid` runs on this UPDATE, so a patch naming an icon nobody drew aborts the
        -- approval rather than being stored. That is the whole point of applying at approval time.
        UPDATE public.cells
           SET name        = v_cell_new.name,
               grafana_url = v_cell_new.grafana_url,
               icon        = v_cell_new.icon
         WHERE id = v_cell.id;

    ELSIF v_proposal.entity_type = 'gateways' THEN
        SELECT * INTO v_gateway FROM public.gateways
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'gateway % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
        END IF;

        SELECT * INTO v_gw_new FROM jsonb_populate_record(v_gateway, v_proposal.patch);

        -- Four CHECK constraints guard this statement (site_wide_has_no_cell, synthetic_has_no_cell,
        -- simulated_is_host, location_scope_valid). A relocation that breaks one fails here, inside the
        -- approver's transaction, and the proposal stays open with the database's own sentence.
        UPDATE public.gateways
           SET name           = v_gw_new.name,
               description    = v_gw_new.description,
               cell_id        = v_gw_new.cell_id,
               location_scope = v_gw_new.location_scope,
               access_url     = v_gw_new.access_url
         WHERE id = v_gateway.id;

    ELSIF v_proposal.entity_type IN ('cell_links', 'gateway_links', 'device_links') THEN
        -- AN INSERT, NOT AN UPDATE -- the one lane shape that creates a row. `links.entity_type`
        -- is the SINGULAR noun the rest of the app writes ('cell', 'gateway', 'device') and
        -- `links.entity_id` is text, so both are derived rather than copied across.
        v_link_kind := CASE v_proposal.entity_type
            WHEN 'cell_links'    THEN 'cell'
            WHEN 'gateway_links' THEN 'gateway'
            WHEN 'device_links'  THEN 'device'
        END;

        INSERT INTO public.links (entity_type, entity_id, display_name, url, link_tag)
        VALUES (
            v_link_kind,
            v_proposal.entity_id::text,
            v_proposal.patch ->> 'display_name',
            v_proposal.patch ->> 'url',
            -- The table's own default is 'other'; COALESCE says so here rather than relying on a
            -- default that a NULL in the patch would defeat.
            COALESCE(NULLIF(v_proposal.patch ->> 'link_tag', ''), 'other')
        );

    END IF;
    -- NO `schemas` BRANCH. 0090 withdrew the lane; may_decide_proposal() refuses it above, so this
    -- point is unreachable for one -- and an ELSE that silently did nothing would let a lane added
    -- to the CHECK and forgotten here record an approval that changed nothing.

    -- The row that names both parties; the target's own audit trigger records only the approver.
    -- `proposed_by_email` rides along because this row is read by a person.
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

COMMENT ON FUNCTION public.approve_proposal(uuid) IS 'Approving IS applying: the lane''s own gate is re-checked server-side, the patch re-validated against proposable_columns(), and the change written in this transaction so every CHECK and foreign key on the target runs now -- an invalid change aborts the approval instead of becoming an audit record of something that did not happen. A proposal whose values are already in place is refused for the same reason. The three *_links lanes INSERT a row rather than updating one.';

REVOKE ALL ON FUNCTION public.approve_proposal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_proposal(uuid) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 10. Rejecting, which has to admit the same lanes as approving
-- -------------------------------------------------------------------------------------------------
-- A Manager who may decide a cell proposal must be able to say no to one. This is also the
-- repair for an overtaken proposal: "already done by hand" is a rejection reason.
CREATE OR REPLACE FUNCTION public.reject_proposal(p_proposal_id uuid, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_proposal public.change_proposals%ROWTYPE;
    v_actor    uuid := auth.uid();
BEGIN
    IF NOT (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
            OR public.has_authority(ARRAY['cell:manage', 'gateway:manage', 'link:manage'])) THEN
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

REVOKE ALL ON FUNCTION public.reject_proposal(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_proposal(uuid, text) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 11. Self-check
-- -------------------------------------------------------------------------------------------------
-- Replays on every boot, so a later migration that widens the CHECK and forgets one of the three
-- functions a lane needs fails the boot.
DO $$
DECLARE
    v_lane    text;
    v_missing text[] := ARRAY[]::text[];
BEGIN
    FOREACH v_lane IN ARRAY ARRAY['devices', 'device_nameplate', 'cells', 'gateways',
                                  'cell_links', 'gateway_links', 'device_links'] LOOP
        -- EVERY LIVE LANE NEEDS ALL THREE ANSWERS. An allowlist, so something is proposable; an
        -- asset audit domain, so the Manager who approved it can read the record; and a decider.
        IF array_length(public.proposable_columns(v_lane), 1) IS NULL THEN
            v_missing := v_missing || (v_lane || ': no proposable_columns() entry');
        END IF;

        IF public.audit_domain_for(v_lane, 'PROPOSAL_APPLIED') <> 'asset' THEN
            v_missing := v_missing || (v_lane || ': audit_domain_for() does not say asset');
        END IF;
    END LOOP;

    -- THE WITHDRAWN LANE, ASSERTED AS WITHDRAWN. A later migration that restores an allowlist for
    -- `schemas` without restoring the rest of the lane would reopen filing and leave the rows
    -- undecidable, which is the worst of the three states.
    IF array_length(public.proposable_columns('schemas'), 1) IS NOT NULL THEN
        v_missing := v_missing || 'schemas: the lane is withdrawn but proposable_columns() answers for it';
    END IF;
    IF public.may_decide_proposal('schemas') THEN
        v_missing := v_missing || 'schemas: the lane is withdrawn but may_decide_proposal() admits it';
    END IF;
    IF EXISTS (SELECT 1 FROM public.change_proposals
                WHERE entity_type = 'schemas' AND status = 'open') THEN
        v_missing := v_missing || 'schemas: an open proposal survives in a lane nobody can decide';
    END IF;

    -- The table must end the boot with a validated constraint on it: both blocks above guard on the
    -- lane and correctly do nothing when it is already admitted, so the chain could otherwise pass
    -- while installing no definition at all. Read from the catalogue, and no count of lanes is
    -- asserted, because a later widening is the expected case.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.change_proposals'::regclass
           AND conname  = 'change_proposals_entity_type_known'
           AND convalidated
    ) THEN
        v_missing := v_missing || 'the entity_type CHECK is missing or was left NOT VALID';
    END IF;

    -- The link lanes' tag list must be non-empty, or every proposed document naming a tag is
    -- refused and the form's dropdown is a list of values nothing accepts.
    IF array_length(public.proposable_link_tags(), 1) IS NULL THEN
        v_missing := v_missing || 'proposable_link_tags() is empty';
    END IF;

    IF array_length(v_missing, 1) IS NOT NULL THEN
        RAISE EXCEPTION '0090 self-check failed: %', array_to_string(v_missing, '; ');
    END IF;

    RAISE NOTICE '0090: seven live lanes, each with an allowlist, an asset audit domain and a decider; schemas withdrawn.';
END $$;
