-- 0088: the approvals queue gains its second lane, and its second approval gate.
--
-- =================================================================================================
-- WHAT THIS ADDS
--
-- `0086` built the queue and the asset-details lane. This adds the schema-publication lane: an
-- `Operator` proposes that a draft schema be published, and an `Administrator` approves — at which
-- point the approval calls `publish_schema_version()`.
--
-- ONE INBOX, TWO APPROVAL GATES, and the asymmetry is the substance rather than a wrinkle. A
-- `Shopfloor_Manager` may approve a nameplate edit and may NOT approve a schema publication,
-- because `0069` withdrew `schema:manage` from that role and `0087` made the two schema RPCs
-- actually enforce it. So `may_decide_proposal()` exists: one function naming who decides each
-- lane, read by both `approve_proposal()` and `reject_proposal()`, and fail-closed for a lane
-- nobody has classified.
--
-- REJECTING IS GATED THE SAME WAY AS APPROVING, deliberately. Rejection looks like the lesser act,
-- but a Manager able to reject a schema publication could block an Administrator-only decision
-- indefinitely -- and the operator would read that refusal as the platform's answer. Whoever may
-- decide a lane decides it both ways.
--
-- =================================================================================================
-- THE LANE PROPOSES AN ACT, NOT A COLUMN EDIT, AND THAT IS WHY IT LOOKS DIFFERENT
--
-- The asset lanes carry a patch of columns because an asset detail IS a column. A publication is
-- not: `publish_schema_version()` activates the draft, archives its parent, atomically repoints
-- every `device_submodels` row and the legacy `devices.schema_id`, and drops the duplicate links
-- that would otherwise collide. That is fork, review and merge with the side effects included, in
-- one transaction.
--
-- A patch of `{"status": "active"}` would therefore be a LIE: it names a column write, and the
-- apply path would ignore it and do six other things. So the schema lane's patch is
-- `{"publish": true}` -- the act, named -- and `proposable_columns()` returns `publish` for it.
-- The function's contract is "the keys a patch may name", which is columns for the asset lanes and
-- the act for this one; a form building itself from that list gets the right answer either way.
--
-- The alternative was a second table for schema proposals. That would give the queue two shapes,
-- two caps, two retention answers and two pages, to model a difference that is one key in a JSONB
-- column.
--
-- =================================================================================================
-- THE AUDIT ROW LANDS IN THE SECURITY DOMAIN, AND IT SHOULD
--
-- `audit_domain_for('schemas')` is 'security', because `0070`'s rule is WHO MAY PERFORM the act and
-- publishing is Administrator-only. `0086` moved `device_nameplate` and `change_proposals` into the
-- asset lane; `schemas` deliberately does not follow them.
--
-- The consequence is real and is accepted: the `Operator` who proposed the publication cannot read
-- the `digital_thread` row recording that it was applied. What they can read is their own proposal
-- row, which carries `status = 'applied'`, `decided_by` and `applied_thread_id`. The queue is the
-- proposer's record; the thread is the platform's.
-- =================================================================================================


-- -------------------------------------------------------------------------------------------------
-- 1. The lane is admitted
-- -------------------------------------------------------------------------------------------------
-- DROP-then-ADD rather than a second constraint, so a replay lands on exactly one definition. A
-- bare ADD would fail on the second boot, which is the property `0001`'s header calls the thing the
-- whole schema model rests on.
--
-- AND THE DROP-then-ADD ALONE WAS NOT ENOUGH, WHICH IS WHAT THE GUARD BELOW IS FOR. It is
-- idempotent against its OWN replay and not against a LATER migration's. `0090` widens this same
-- constraint to eight lanes; every migration here is replayed on every boot, so on any database
-- that has reached `0090` and holds a `cells` proposal, this file's three-lane definition is
-- re-applied against a row `0090` legitimately admits and the whole boot stops here:
--
--     ERROR: check constraint "change_proposals_entity_type_known" of relation
--            "change_proposals" is violated by some row
--
-- THE RULE THIS RECORDS: an idempotent migration may WIDEN a domain freely, and may NARROW one
-- only until something later widens it again. A replayed narrowing is not a no-op, it is a
-- retraction -- and it fails against exactly the rows the later migration was written to allow.
-- The failure needs data to appear, so a fresh boot and `npm run test:db` both pass on it.
--
-- SO THE TEST IS THE LANE AND NOT THE DEFINITION, and it is in two halves because the fault has
-- two shapes. What this migration exists to do is admit `schemas`. It should do nothing when:
--
--   THE LANE IS ALREADY ADMITTED -- by something newer than this file, which is then the only
--   definition that should stand. Checking the lane rather than comparing definitions keeps this
--   right for the NEXT widening, which will not have been written when this is read.
--
--   THE TABLE HOLDS A ROW THIS FILE'S LANE SET DOES NOT NAME -- the recovery case, and it is not
--   hypothetical. `ALTER TABLE` autocommits per statement, so the boot that first hit this left
--   the DROP applied and the ADD rolled back: NO constraint on the table at all, and a `cells`
--   row still there. The first half alone then says "not admitted, install mine" and fails again
--   on exactly the row that broke it. A migration that cannot install its definition without
--   RETRACTING a row must leave the definition to whichever later migration admits that row --
--   here `0090`, three statements' worth of boot away, installing a strict superset of this.
--
-- Both halves are the same rule seen from two sides: never narrow.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.change_proposals'::regclass
           AND conname  = 'change_proposals_entity_type_known'
           AND pg_get_constraintdef(oid) LIKE '%''schemas''%'
    ) AND NOT EXISTS (
        SELECT 1
          FROM public.change_proposals
         WHERE entity_type <> ALL (ARRAY['devices'::text, 'device_nameplate'::text, 'schemas'::text])
    ) THEN
        ALTER TABLE public.change_proposals
            DROP CONSTRAINT IF EXISTS change_proposals_entity_type_known;

        ALTER TABLE public.change_proposals
            ADD CONSTRAINT change_proposals_entity_type_known
            CHECK (entity_type = ANY (ARRAY['devices'::text, 'device_nameplate'::text, 'schemas'::text]));
    END IF;
END $$;


-- -------------------------------------------------------------------------------------------------
-- 2. What may be proposed on it
-- -------------------------------------------------------------------------------------------------
-- `publish` is an ACT rather than a column, and this function's contract is "the keys a patch may
-- name" -- see the header. Nothing else on `schemas` is proposable: a schema's definition is edited
-- through the draft it lives on, which is what `fork_schema()` produces, and its `status` is
-- `publish_schema_version()`'s to move.
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
    -- 0088. The act, not a column: a publication is six writes across three tables, and a patch
    -- naming `status` would describe one of them and mislead about the rest.
    WHEN 'schemas' THEN ARRAY['publish']
    ELSE ARRAY[]::text[]
  END
$$;

COMMENT ON FUNCTION public.proposable_columns(p_entity_type text) IS 'The keys a change proposal may name, per entity type: columns for the asset lanes, and the ACT for the schema lane, whose publication is a function call rather than a column write. An unknown entity type yields the empty array, so a lane nobody has written an allowlist for can propose nothing at all rather than everything.';


-- -------------------------------------------------------------------------------------------------
-- 3. Who decides each lane
-- -------------------------------------------------------------------------------------------------
-- ONE FUNCTION, read by approve and by reject, so the two cannot come to disagree about a lane --
-- which is the failure `0087` had just finished repairing between an RPC and the policies it was
-- written to match.
--
-- FAIL-CLOSED on an unknown lane, on `audit_domain_for()`'s argument: the cost of the safe answer is
-- a proposal nobody can decide, which somebody will report; the cost of the unsafe one is a
-- privileged act nobody notices.
CREATE OR REPLACE FUNCTION public.may_decide_proposal(p_entity_type text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT CASE p_entity_type
    -- The shopfloor's own records. Unchanged from 0086.
    WHEN 'devices'          THEN public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
    WHEN 'device_nameplate' THEN public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])

    -- The platform's. `schema:manage` is Administrator's alone since 0069, and since 0087 the RPC
    -- this lane calls enforces that for itself -- so this gate and that one cannot drift apart
    -- into a queue that approves what the function then refuses.
    WHEN 'schemas'          THEN public.has_authority(ARRAY['schema:manage'])

    ELSE false
  END
$$;

COMMENT ON FUNCTION public.may_decide_proposal(p_entity_type text) IS 'Who may approve or reject a proposal in this lane. One inbox, two gates: a Shopfloor_Manager decides the asset lanes and an Administrator alone decides a schema publication, because 0069 withdrew schema:manage from that role. Rejection is gated identically to approval -- a role able to refuse an act it cannot authorise could block it indefinitely.';

REVOKE ALL ON FUNCTION public.may_decide_proposal(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.may_decide_proposal(text) TO authenticated, service_role;


-- -------------------------------------------------------------------------------------------------
-- 4. What a proposal must look like, now that a lane is not keyed by a device
-- -------------------------------------------------------------------------------------------------
-- `0086`'s trigger resolved every `entity_id` through `public.devices`, because both of its lanes
-- were keyed by one. The schema lane is not, so the existence check branches -- and it must, or a
-- perfectly good schema proposal is refused with "no live device to propose a change against".
CREATE OR REPLACE FUNCTION public.validate_change_proposal() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_allowed text[] := public.proposable_columns(NEW.entity_type);
    v_key     text;
    v_status  text;
BEGIN
    -- FAIL-CLOSED, AND IT NAMES THE REAL PROBLEM. The CHECK constraint admits the known lanes and
    -- this trigger runs BEFORE it, so an entity type with no allowlist reaches here first. Without
    -- this branch the loop below reports "proposable columns are: " with nothing after the colon,
    -- which reads as a broken message rather than as a lane nobody has written an allowlist for --
    -- the state a widened CHECK and a forgotten proposable_columns() entry would produce.
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

    IF NEW.entity_type = 'schemas' THEN
        -- The act carries no arguments, so there is exactly one well-formed patch. Anything else --
        -- `{"publish": false}` above all -- is a proposal whose approval would do the opposite of
        -- what the row appears to say, and there is no such act to perform.
        IF NEW.patch <> '{"publish": true}'::jsonb THEN
            RAISE EXCEPTION
                'a schema proposal''s patch is exactly {"publish": true}; publication takes no other argument'
                USING ERRCODE = 'invalid_parameter_value';
        END IF;

        SELECT status INTO v_status FROM public.schemas WHERE id = NEW.entity_id;
        IF v_status IS NULL THEN
            RAISE EXCEPTION 'no schema % to propose a publication of', NEW.entity_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        -- CHECKED HERE AND AGAIN AT APPLY, by publish_schema_version() itself. Here so an operator
        -- learns immediately rather than after a week in a queue; there because the draft can be
        -- published by somebody else in between, and the approval is what has to be right.
        IF v_status <> 'draft' THEN
            RAISE EXCEPTION 'schema % is %, not a draft', NEW.entity_id, v_status
                USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
    END IF;

    -- THE TARGET HAS TO EXIST, and there is no foreign key that can say so: `entity_id` addresses
    -- different tables depending on `entity_type`. Both asset lanes are keyed by a device, which is
    -- why one lookup answers for both.
    --
    -- ARCHIVED IS REFUSED TOO. An archived device is on its way out under a retention promise, and
    -- a proposal against one would either be applied to a row nobody expects to change again or
    -- expire unread.
    IF NOT EXISTS (
        SELECT 1 FROM public.devices d
         WHERE d.id = NEW.entity_id AND d.is_archived = false
    ) THEN
        RAISE EXCEPTION 'no live device % to propose a change against', NEW.entity_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.validate_change_proposal() IS 'Refuses a patch naming a key proposable_columns() does not admit, and a proposal aimed at a target that is absent, archived or -- for the schema lane -- not a draft. Runs on INSERT and on any UPDATE that touches the patch, because editing an open proposal is a path INSERT-only validation would miss.';

REVOKE ALL ON FUNCTION public.validate_change_proposal() FROM PUBLIC;


-- -------------------------------------------------------------------------------------------------
-- 5. Deciding, with the gate the lane names
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_proposal(p_proposal_id uuid, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_proposal public.change_proposals%ROWTYPE;
BEGIN
    -- BEFORE ANYTHING OBSERVABLE, and it has to be a question that can be asked without knowing the
    -- lane: a caller who may decide NO lane learns nothing at all, not even whether the id exists.
    -- Today this reduces to the role check 0086 made, because Administrator holds schema:manage.
    IF NOT (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
            OR public.has_authority(ARRAY['schema:manage'])) THEN
        RAISE EXCEPTION 'not permitted to decide change proposals'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'a rejection needs a reason'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT * INTO v_proposal FROM public.change_proposals
     WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'proposal % not found', p_proposal_id USING ERRCODE = 'no_data_found';
    END IF;

    -- AND NOW THE LANE'S OWN GATE. Rejecting is gated identically to approving: a Manager able to
    -- refuse a schema publication could block an Administrator-only decision indefinitely, and the
    -- operator would read that refusal as the platform's answer.
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
       SET status = 'rejected', decided_by = auth.uid(), decided_at = now(),
           decision_reason = btrim(p_reason)
     WHERE id = p_proposal_id;

    RETURN jsonb_build_object('id', p_proposal_id, 'status', 'rejected');
END;
$$;

COMMENT ON FUNCTION public.reject_proposal(uuid, text) IS 'An approver refuses a proposal in a lane may_decide_proposal() admits them to, with a reason the constraint also requires. The slot is freed immediately and the same change may be proposed again at once -- the reason, not a cooldown, is what makes the second attempt different from the first.';


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
    v_actor     uuid := auth.uid();
    v_allowed   text[];
    v_key       text;
    v_thread    bigint;
BEGIN
    IF NOT (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
            OR public.has_authority(ARRAY['schema:manage'])) THEN
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
    -- been edited since; the allowlist may also have narrowed between the two moments.
    v_allowed := public.proposable_columns(v_proposal.entity_type);
    FOREACH v_key IN ARRAY ARRAY(SELECT jsonb_object_keys(v_proposal.patch)) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            RAISE EXCEPTION 'proposal % names % , which is not proposable on %',
                p_proposal_id, v_key, v_proposal.entity_type
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
    END LOOP;

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

    ELSIF v_proposal.entity_type = 'schemas' THEN
        -- THE FUNCTION, NOT A COLUMN WRITE. It activates the draft, archives its parent, repoints
        -- every device_submodels row and the legacy devices.schema_id, and drops the duplicate
        -- links that would otherwise collide -- all in this transaction, which is what makes the
        -- approval and the rebinding impossible to separate.
        --
        -- IT RE-CHECKS AUTHORITY FOR ITSELF, and since 0087 that check is `schema:manage` rather
        -- than the pair -- so it agrees with may_decide_proposal() above rather than being a
        -- second, wider door standing beside it. Left in place deliberately: this path is not the
        -- only caller, and a gate that only works because its caller checked first is not a gate.
        PERFORM public.publish_schema_version(v_proposal.entity_id);
    END IF;

    -- THE ROW THAT NAMES BOTH PARTIES. The target's own audit trigger fires above, attributed to
    -- the approver; nothing there records who ASKED. This row does, and it is the only place the
    -- pair appears together.
    --
    -- For the schema lane this lands in the SECURITY domain, because audit_domain_for('schemas')
    -- says so and 0070's rule is who may perform the act. The proposer therefore cannot read it.
    -- What they can read is their own proposal row, which carries the status, the approver and the
    -- id of this row: the queue is the proposer's record, the thread is the platform's.
    INSERT INTO public.digital_thread
        (entity_type, entity_id, action, old_data, new_data, changed_by, actor_source, audit_domain)
    VALUES (
        v_proposal.entity_type,
        v_proposal.entity_id,
        'PROPOSAL_APPLIED',
        NULL,
        jsonb_build_object(
            'proposal_id', v_proposal.id,
            'proposed_by', v_proposal.proposed_by,
            'approved_by', v_actor,
            'patch',       v_proposal.patch,
            'rationale',   v_proposal.rationale
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

COMMENT ON FUNCTION public.approve_proposal(uuid) IS 'Approving IS applying: the lane''s own gate is re-checked server-side, the patch re-validated against proposable_columns(), and the change written in this transaction so every CHECK and foreign key on the target runs now -- an invalid change aborts the approval instead of becoming an audit record of something that did not happen. The schema lane calls publish_schema_version() rather than writing a column.';

REVOKE ALL ON FUNCTION public.approve_proposal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_proposal(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_proposal(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_proposal(uuid, text) TO authenticated, service_role;


-- -------------------------------------------------------------------------------------------------
-- 6. Self-check
-- -------------------------------------------------------------------------------------------------
-- READ-ONLY, and it writes nothing -- 0037 and 0038 are why that is stated.
DO $selfcheck$
DECLARE
    v_problems text[] := ARRAY[]::text[];
BEGIN
    IF NOT ('publish' = ANY (public.proposable_columns('schemas'))) THEN
        v_problems := v_problems || 'the schema lane cannot propose a publication';
    END IF;

    -- THE ASYMMETRY THIS MIGRATION EXISTS FOR. If the two gates ever collapse into one, a
    -- Shopfloor_Manager approves schema publications again and nothing else here would say so.
    IF pg_get_functiondef('public.may_decide_proposal(text)'::regprocedure) NOT LIKE '%schema:manage%' THEN
        v_problems := v_problems || 'the schema lane does not gate on schema:manage';
    END IF;

    -- The gate this lane's apply path depends on. 0087 narrowed it; if something widens it again,
    -- the queue would be the only thing standing in front of a publication.
    IF pg_get_functiondef('public.publish_schema_version(uuid)'::regprocedure) LIKE '%Shopfloor_Manager%' THEN
        v_problems := v_problems || 'publish_schema_version() admits Shopfloor_Manager again';
    END IF;

    IF array_length(v_problems, 1) IS NOT NULL THEN
        RAISE EXCEPTION '0088 self-check failed: %', array_to_string(v_problems, '; ');
    END IF;
END $selfcheck$;
