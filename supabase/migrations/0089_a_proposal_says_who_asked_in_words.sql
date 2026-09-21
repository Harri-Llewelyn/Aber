-- 0089: a proposal names its author in something a person can read.
--
-- `change_proposals.proposed_by` is a uuid and stays the key (the policy, the cap and the audit
-- trail resolve through it), but an approver cannot resolve it into a person: `auth.users` is
-- not exposed to the browser. This adds `proposed_by_email`, read off the signed token's `email`
-- claim rather than typed into a form, since a self-declared name is not evidence.
--
-- Stamped by a trigger, not a DEFAULT: a DEFAULT applies only when the column is omitted, and
-- this table takes a direct PostgREST INSERT from any Operator. The trigger overwrites
-- unconditionally, as `system_settings_stamp()` does to `updated_by`.
--
-- Nothing authorises on it. An email that changes in GoTrue does not retro-fit onto proposals
-- already filed. NULL is a real state: a token with no email gets NULL, and the page falls back
-- to the uuid.

-- -------------------------------------------------------------------------------------------------
-- 1. The column
-- -------------------------------------------------------------------------------------------------
ALTER TABLE public.change_proposals
    ADD COLUMN IF NOT EXISTS proposed_by_email text;

COMMENT ON COLUMN public.change_proposals.proposed_by_email IS 'The proposer''s email, taken from the signed access token at INSERT and never from the request body. A readable label beside proposed_by, which stays the key everything resolves through. NULL when the token carried no email.';

-- -------------------------------------------------------------------------------------------------
-- 2. The stamp
-- -------------------------------------------------------------------------------------------------
-- Overwrites rather than fills in, so whatever the client sent is discarded.
CREATE OR REPLACE FUNCTION public.stamp_proposal_author() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    -- The primitive, not `auth.email()`: the base image the database suites run against ships a
    -- legacy definition reading the singular `request.jwt.claim.email` GUC and returns NULL for a
    -- modern session (the same trap test-harness/auth-bootstrap.sql records for `auth.uid()`).
    -- NULL under service_role and during a migration, which is correct.
    NEW.proposed_by_email := NULLIF(auth.jwt() ->> 'email', '');
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.stamp_proposal_author() IS 'Stamps change_proposals.proposed_by_email from the access token on INSERT, discarding anything the client supplied. A DEFAULT would only apply when the column was omitted, and this table takes a direct PostgREST INSERT from any Operator.';

REVOKE ALL ON FUNCTION public.stamp_proposal_author() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_change_proposals_author ON public.change_proposals;
CREATE TRIGGER trg_change_proposals_author
    BEFORE INSERT ON public.change_proposals
    FOR EACH ROW EXECUTE FUNCTION public.stamp_proposal_author();

-- -------------------------------------------------------------------------------------------------
-- 3. It is not editable afterwards either
-- -------------------------------------------------------------------------------------------------
-- The new column joins the list of columns a proposer may not move, or an UPDATE could rewrite
-- the author of a proposal an approver is already reading. Rebuilt whole because the check is
-- one expression.
CREATE OR REPLACE FUNCTION public.guard_change_proposal_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    IF COALESCE(current_setting('acs_cymru.proposal_transition', true), '') = 'on' THEN
        RETURN NEW;
    END IF;

    IF OLD.status <> 'open' THEN
        RAISE EXCEPTION 'proposal % is %, and a decided proposal is a record rather than a draft',
            OLD.id, OLD.status
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
       OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
       OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
       OR NEW.proposed_by_email IS DISTINCT FROM OLD.proposed_by_email
       OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
       OR NEW.applied_thread_id IS DISTINCT FROM OLD.applied_thread_id
    THEN
        RAISE EXCEPTION
            'only the patch and the rationale may be edited; approve_proposal(), reject_proposal() '
            'and withdraw_proposal() are how a proposal changes status'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_change_proposal_transition() IS 'Outside the transition functions, only patch and rationale may be edited and only while open. An RLS policy can say who may UPDATE a row; it cannot say which columns, and status is the column that must not move -- a proposer who could set ''applied'' would hold the asset write this design exists to withhold. The author stamp is equally immutable: rewriting it would re-attribute a proposal an approver is already reading.';

REVOKE ALL ON FUNCTION public.guard_change_proposal_transition() FROM PUBLIC;

-- -------------------------------------------------------------------------------------------------
-- 4. And the approval records it beside the uuid
-- -------------------------------------------------------------------------------------------------
-- The audit row gains the proposer's email for the same reason the column exists.
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
        -- The function, not a column write: it activates the draft, archives its parent and repoints
        -- every attached device in this transaction. It re-checks authority for itself (`schema:manage`
        -- since 0087), so it agrees with may_decide_proposal() rather than being a wider door beside it.
        PERFORM public.publish_schema_version(v_proposal.entity_id);
    END IF;

    -- The row that names both parties; the target's own audit trigger records only the approver.
    -- `proposed_by_email` rides along because this row is read by a person. For the schema lane it
    -- lands in the security domain, so the proposer reads their own proposal row instead.
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

COMMENT ON FUNCTION public.approve_proposal(uuid) IS 'Approving IS applying: the lane''s own gate is re-checked server-side, the patch re-validated against proposable_columns(), and the change written in this transaction so every CHECK and foreign key on the target runs now -- an invalid change aborts the approval instead of becoming an audit record of something that did not happen. The schema lane calls publish_schema_version() rather than writing a column.';

REVOKE ALL ON FUNCTION public.approve_proposal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_proposal(uuid) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 5. Self-check
-- -------------------------------------------------------------------------------------------------
-- READ-ONLY, and it writes nothing -- 0037 and 0038 are why that is stated.
DO $selfcheck$
DECLARE
    v_problems text[] := ARRAY[]::text[];
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_change_proposals_author' AND NOT tgisinternal
    ) THEN
        v_problems := v_problems || 'the author stamp trigger is missing'::text;
    END IF;

    -- THE PROPERTY THAT MAKES IT EVIDENCE RATHER THAN A FORM FIELD. A DEFAULT here instead of the
    -- trigger would leave a client's own value in place, and the column would quietly become
    -- self-declared -- which is the thing this migration exists not to build.
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'change_proposals'
           AND column_name = 'proposed_by_email' AND column_default IS NOT NULL
    ) THEN
        v_problems := v_problems ||
            'proposed_by_email carries a DEFAULT, which a client-supplied value would survive'::text;
    END IF;

    IF array_length(v_problems, 1) IS NOT NULL THEN
        RAISE EXCEPTION '0089 self-check failed: %', array_to_string(v_problems, '; ');
    END IF;
END $selfcheck$;
