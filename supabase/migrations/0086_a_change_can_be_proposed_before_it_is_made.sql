-- 0086: a change can be proposed by somebody who may not make it.
--
-- One queue for a change a person proposes but may not apply. An `Operator` proposes; an
-- `Administrator` or `Shopfloor_Manager` approves; the approval is the write. This is the first
-- write `Operator` has held, and it is a write to a queue, not an asset: the asset write policies
-- do not move. A second write path to an asset table would mean this design has failed.
--
-- APPROVING IS APPLYING, as `approve_quarantined_device()` does: the actor's role is re-checked
-- server-side, the patch is applied in one transaction, and the audit rows name the approver.
-- Every CHECK, foreign key and trigger on the target runs at approval time, so an invalid change
-- cannot be approved; nothing here re-implements those rules.
--
-- THE PATCH IS OPERATOR-CONTROLLED INPUT. It is validated on the way in and again at apply. No
-- SQL is ever built from its keys: the patch is merged with `jsonb_populate_record` and assigned
-- column by column in hand-written SQL. The allowlist is `proposable_columns()`. The columns
-- ingestion writes (`status`, `first_dbirth_at`, `reported_identity`, `identity_source`,
-- `is_quarantined`) are absent from every allowlist: they are what the platform observed.
--
-- TWO CAPS, BOTH IN THE DATABASE: a partial unique index on (entity_type, entity_id, proposed_by)
-- WHERE status = 'open' (scoped to the proposer, so one person's forgotten proposal cannot block
-- everybody else), and a per-proposer ceiling on open proposals held in `system_settings`. The RLS
-- policy admits a direct PostgREST INSERT, so a cap living only in an RPC would be bypassable.
--
-- Not touched: `quarantine:approve` and `quarantine:reject` (a quarantine entry is a discovery the
-- system made, and approving one mints identity), the schema lineage invariants, and the write
-- policies on every asset table.

-- -------------------------------------------------------------------------------------------------
-- 1. The permission, and the first write grant `Operator` has ever held
-- -------------------------------------------------------------------------------------------------
-- Mirrored by PERMISSION_UUIDS in frontend/src/constants.js and DEFAULT_ROLE_PERMISSIONS_MAP in
-- frontend/src/hooks/usePermissions.js; scripts/check-mirror-drift.mjs compares them. Granted to
-- all three roles: a manager drafting a change for a colleague to check is the same act.
INSERT INTO public.permissions VALUES
    ('b678f901-2345-4c1d-8706-933e08544e43', 'proposal:create',
     'Propose a change to an asset for an approver to apply')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.role_permissions VALUES (1, 'b678f901-2345-4c1d-8706-933e08544e43')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'b678f901-2345-4c1d-8706-933e08544e43')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (3, 'b678f901-2345-4c1d-8706-933e08544e43')
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------------------------------------------
-- 2. Two entity types join the asset lane
-- -------------------------------------------------------------------------------------------------
-- `audit_domain_for()` fails closed to 'security' (Administrator and Auditor only), which is the
-- wrong answer for these two: `device_nameplate` is operator-supplied identification a
-- Shopfloor_Manager may edit, and `change_proposals` is the queue itself, whose expiry a manager
-- must be able to see.
CREATE OR REPLACE FUNCTION public.audit_domain_for(p_entity_type text, p_action text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    -- Identity and authority. Every act on these is Administrator-only to perform, so it is
    -- Administrator-and-Auditor to read.
    WHEN p_entity_type IN ('service_principals', 'user_roles', 'system_settings')
      THEN 'security'

    -- The asset trail: the shopfloor's own history. CREDENTIAL_ISSUED lands here on `gateways`
    -- deliberately: a Manager may mint a virtual gateway's broker credential, so may read that one
    -- was minted. `device_nameplate` and `change_proposals` joined in 0086.
    WHEN p_entity_type IN ('cells', 'devices', 'gateways', 'links',
                           'device_nameplate', 'change_proposals')
      THEN 'asset'

    -- FAIL-CLOSED. A new entity_type nobody classified is restricted rather than exposed. The
    -- cost is a lane a Manager cannot see and will report; the alternative is a privileged act
    -- they can, and will not.
    ELSE 'security'
  END
$$;

COMMENT ON FUNCTION public.audit_domain_for(p_entity_type text, p_action text) IS 'Which lane a digital_thread row belongs in. The rule is WHO MAY PERFORM the act, not what the act is about -- see 0070. Unrecognised input is ''security'': the safe failure is a row a Shopfloor_Manager cannot see, not a privileged act they can.';

-- -------------------------------------------------------------------------------------------------
-- 3. The allowlist, which is the only place the answer exists
-- -------------------------------------------------------------------------------------------------
-- IMMUTABLE and per entity type; read by the validation trigger and by the apply path. Absent
-- from `devices`, and why:
--   status, first_dbirth_at, reported_identity, identity_source, is_quarantined
--                       -- written by ingestion from what the plant actually did.
--   gateway_id          -- the data path; location was separated from it on purpose.
--   schema_id           -- schema binding belongs to `publish_schema_version()`.
--   is_archived, archived_at, auto_delete_at
--                       -- lifecycle, with a retention promise attached to a date the user picked.
--   conformance_policy  -- decides what ingestion enforces; Administrator-only since 0069.
--   sparkplug_id        -- generated, and the identity on the wire.
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
    ELSE ARRAY[]::text[]
  END
$$;

COMMENT ON FUNCTION public.proposable_columns(p_entity_type text) IS 'Which columns a change proposal may name, per entity type. An unknown entity type yields the empty array, so a lane nobody has written an allowlist for can propose nothing at all rather than everything.';

-- -------------------------------------------------------------------------------------------------
-- 4. The queue
-- -------------------------------------------------------------------------------------------------
-- `entity_type` holds the table name, the vocabulary `digital_thread.entity_type` and
-- `audit_domain_for()` use.
CREATE TABLE IF NOT EXISTS public.change_proposals (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type       text NOT NULL,
    entity_id         uuid NOT NULL,
    patch             jsonb NOT NULL,
    rationale         text,
    status            text NOT NULL DEFAULT 'open',
    proposed_by       uuid NOT NULL DEFAULT auth.uid(),
    proposed_at       timestamp with time zone NOT NULL DEFAULT now(),
    decided_by        uuid,
    decided_at        timestamp with time zone,
    decision_reason   text,
    applied_thread_id bigint,

    CONSTRAINT change_proposals_entity_type_known
        CHECK (entity_type = ANY (ARRAY['devices'::text, 'device_nameplate'::text])),

    CONSTRAINT change_proposals_status_known
        CHECK (status = ANY (ARRAY['open'::text, 'applied'::text, 'rejected'::text,
                                   'withdrawn'::text, 'expired'::text])),

    -- A patch has to be a non-empty object. An empty one is a proposal to change nothing, which
    -- would hold a slot under both caps and give an approver nothing to decide.
    CONSTRAINT change_proposals_patch_is_an_object
        CHECK (jsonb_typeof(patch) = 'object' AND patch <> '{}'::jsonb),

    -- REJECTION CARRIES A REASON, and this is where that is true rather than in a form. A rejected
    -- proposal frees its slot at once and the same change may be proposed again immediately -- no
    -- cooldown -- so the reason is the only thing that stops the second attempt being identical.
    CONSTRAINT change_proposals_rejection_carries_a_reason
        CHECK (status <> 'rejected'
               OR (decision_reason IS NOT NULL AND btrim(decision_reason) <> '')),

    -- Closed means decided. `decided_by` is deliberately NOT required -- see the note on
    -- expire_open_proposals(): the timer has no session and is not a person.
    CONSTRAINT change_proposals_closed_rows_are_decided
        CHECK (status = 'open' OR decided_at IS NOT NULL),

    CONSTRAINT change_proposals_open_rows_are_undecided
        CHECK (status <> 'open' OR (decided_by IS NULL AND decided_at IS NULL
                                    AND decision_reason IS NULL AND applied_thread_id IS NULL))
);

COMMENT ON TABLE public.change_proposals IS 'A change somebody proposed but may not apply. An Operator inserts; an Administrator or Shopfloor_Manager approves, and the approval is the write. The asset write policies are unchanged by this table existing.';
COMMENT ON COLUMN public.change_proposals.entity_type IS 'The TARGET TABLE, so this speaks the same vocabulary as digital_thread.entity_type and audit_domain_for().';
COMMENT ON COLUMN public.change_proposals.patch IS 'Column -> new value, for the columns proposable_columns() admits. A PATCH rather than a whole row: two proposals touching different fields of one asset both apply, where a row snapshot would silently revert whatever changed underneath it between proposal and approval.';
COMMENT ON COLUMN public.change_proposals.rationale IS 'Why the proposer is asking. Operator-authored free text, pruned with the row under proposals.retention_days.';
COMMENT ON COLUMN public.change_proposals.decided_by IS 'Who approved or rejected. NULL on an expired row: the timer is not a person, and naming one would be a false attribution.';
COMMENT ON COLUMN public.change_proposals.decision_reason IS 'Required to reject. The only thing an operator receives other than a refusal, and what stops the next attempt being identical.';
COMMENT ON COLUMN public.change_proposals.applied_thread_id IS 'The digital_thread row the approval wrote, so the queue entry and the audit trail can be read from either end.';

-- CAP 1. Partial, so only OPEN proposals collide -- a rejected proposal must not block the
-- corrected one that follows it.
CREATE UNIQUE INDEX IF NOT EXISTS change_proposals_one_open_per_asset_per_person
    ON public.change_proposals (entity_type, entity_id, proposed_by)
 WHERE status = 'open';

-- The approver's queue: every open proposal, oldest first, is the whole read that page makes.
CREATE INDEX IF NOT EXISTS change_proposals_open_by_age
    ON public.change_proposals (proposed_at)
 WHERE status = 'open';

CREATE INDEX IF NOT EXISTS change_proposals_by_entity
    ON public.change_proposals (entity_type, entity_id);

-- -------------------------------------------------------------------------------------------------
-- 5. The settings, and the floor the queue cannot work without
-- -------------------------------------------------------------------------------------------------
SELECT public.seed_setting(
    'proposals.max_open_per_person',
    to_jsonb(10),
    'number',
    'Approvals',
    'Open proposals allowed per person',
    'How many proposals one person may have awaiting a decision at once. This is the cap that '
    'bounds reviewer load: the per-asset rule already forces one proposal per machine per person, '
    'but that still permits one against every device on the floor. Raising it does not change who '
    'may approve, only how much can be queued for them.',
    NULL
);

SELECT public.seed_setting(
    'proposals.open_expiry_days',
    to_jsonb(7),
    'number',
    'Approvals',
    'Open proposal expires after (days)',
    'An open proposal nobody acts on closes on this timer, freeing the slot it holds under both '
    'caps. Expiry is not rejection: it records that nobody decided, carries no reason and names '
    'no approver, and the same change may be proposed again immediately.',
    'the seven-day fallback in expire_open_proposals()'
);

SELECT public.seed_setting(
    'proposals.retention_days',
    to_jsonb(90),
    'number',
    'Approvals',
    'Closed proposals kept for (days)',
    'How long an applied, rejected, withdrawn or expired proposal is kept before the nightly '
    'prune removes it. What an approval CHANGED lives in digital_thread under its own retention; '
    'this governs only the queue entry and the rationale attached to it.',
    'the ninety-day fallback in prune_closed_proposals()'
);

-- Bounds set by UPDATE, not by extra arguments: adding parameters to seed_setting() creates an
-- overload. MIN 1 on the expiry: zero would auto-close every proposal at creation, silently. The
-- ceiling is a typo guard.
UPDATE public.system_settings
   SET min_value = 1, max_value = 90
 WHERE key = 'proposals.open_expiry_days'
   AND (min_value IS DISTINCT FROM 1 OR max_value IS DISTINCT FROM 90);

-- MIN 1 for the same reason pointing the other way: a ceiling of zero would refuse every proposal,
-- which reads to an operator as a broken button rather than as a policy somebody chose.
UPDATE public.system_settings
   SET min_value = 1, max_value = 200
 WHERE key = 'proposals.max_open_per_person'
   AND (min_value IS DISTINCT FROM 1 OR max_value IS DISTINCT FROM 200);

UPDATE public.system_settings
   SET min_value = 7, max_value = 3650
 WHERE key = 'proposals.retention_days'
   AND (min_value IS DISTINCT FROM 7 OR max_value IS DISTINCT FROM 3650);

-- -------------------------------------------------------------------------------------------------
-- 6. What a proposal must look like, checked on the way in
-- -------------------------------------------------------------------------------------------------
-- A trigger, not a CHECK: it calls proposable_columns() per key and confirms the target exists.
-- Runs on INSERT and on every UPDATE that touches the patch.
CREATE OR REPLACE FUNCTION public.validate_change_proposal() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_allowed text[] := public.proposable_columns(NEW.entity_type);
    v_key     text;
BEGIN
    -- Fail closed, naming the real problem: the CHECK constraint admits the entity types and this
    -- trigger runs before it, so a lane with no allowlist reaches here first.
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

    -- The target has to exist, and no foreign key can say so: `entity_id` addresses a table that
    -- varies with `entity_type`. Archived is refused too: a proposal against a row on its way out
    -- would be applied to something nobody expects to change again, or expire unread.
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

COMMENT ON FUNCTION public.validate_change_proposal() IS 'Refuses a patch naming a column proposable_columns() does not admit, or one aimed at a device that is absent or archived. Runs on INSERT and on any UPDATE that touches the patch, because editing an open proposal is a path INSERT-only validation would miss.';

DROP TRIGGER IF EXISTS trg_change_proposals_validate ON public.change_proposals;
CREATE TRIGGER trg_change_proposals_validate
    BEFORE INSERT OR UPDATE OF patch, entity_type, entity_id ON public.change_proposals
    FOR EACH ROW EXECUTE FUNCTION public.validate_change_proposal();

-- -------------------------------------------------------------------------------------------------
-- 7. Cap 2, which has to be a trigger
-- -------------------------------------------------------------------------------------------------
-- The per-asset cap is an index. This one counts rows, and it is a trigger rather than a line in
-- an RPC because the INSERT policy admits a direct PostgREST write.
CREATE OR REPLACE FUNCTION public.enforce_open_proposal_cap() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_cap  integer;
    v_open integer;
BEGIN
    SELECT (value #>> '{}')::integer INTO v_cap
      FROM public.system_settings
     WHERE key = 'proposals.max_open_per_person';

    -- The setting is seeded by this migration and bounded at 1, so a NULL here means somebody
    -- deleted the row. Ten is the seeded default and the honest fallback: refusing every proposal
    -- because a setting is missing would take the feature away without saying so.
    v_cap := COALESCE(v_cap, 10);

    SELECT count(*) INTO v_open
      FROM public.change_proposals
     WHERE proposed_by = NEW.proposed_by
       AND status = 'open';

    IF v_open >= v_cap THEN
        RAISE EXCEPTION
            'you already have % open proposal(s), which is the limit; decide or withdraw one first',
            v_open
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_open_proposal_cap() IS 'The per-person ceiling on OPEN proposals, read from system_settings. A trigger rather than a line in an RPC because the INSERT policy admits a direct PostgREST write, and a cap with a documented way around it is not a cap.';

DROP TRIGGER IF EXISTS trg_change_proposals_cap ON public.change_proposals;
CREATE TRIGGER trg_change_proposals_cap
    BEFORE INSERT ON public.change_proposals
    FOR EACH ROW WHEN (NEW.status = 'open')
    EXECUTE FUNCTION public.enforce_open_proposal_cap();

-- -------------------------------------------------------------------------------------------------
-- 8. What may move after the row exists
-- -------------------------------------------------------------------------------------------------
-- The UPDATE policy lets a proposer edit their own open proposal, which the caps make necessary.
-- An UPDATE policy cannot say which columns may move, and `status` must not: a proposer who could
-- set 'applied' would have the asset write. So the transition functions declare themselves with a
-- session flag (SET LOCAL, discarded at COMMIT), as the approval path declares its actor.
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

COMMENT ON FUNCTION public.guard_change_proposal_transition() IS 'Outside the transition functions, only patch and rationale may be edited and only while open. An RLS policy can say who may UPDATE a row; it cannot say which columns, and status is the column that must not move -- a proposer who could set ''applied'' would hold the asset write this design exists to withhold.';

DROP TRIGGER IF EXISTS trg_change_proposals_transition ON public.change_proposals;
CREATE TRIGGER trg_change_proposals_transition
    BEFORE UPDATE ON public.change_proposals
    FOR EACH ROW EXECUTE FUNCTION public.guard_change_proposal_transition();

-- -------------------------------------------------------------------------------------------------
-- 9. Who may see and file one
-- -------------------------------------------------------------------------------------------------
ALTER TABLE public.change_proposals ENABLE ROW LEVEL SECURITY;

-- READ. Approvers see the whole queue because that is the job; everybody else sees their own,
-- which is what makes the refusal message ("you already have an open proposal") actionable.
-- An Auditor reads what happened through `digital_thread`, which is the immutable record.
DROP POLICY IF EXISTS change_proposals_select_own_or_approver ON public.change_proposals;
CREATE POLICY change_proposals_select_own_or_approver ON public.change_proposals
    FOR SELECT TO authenticated
    USING (proposed_by = auth.uid()
           OR public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- WRITE. `has_authority` rather than a role name: a policy naming `Operator` would have admitted
-- the three machine principals before 0080. `proposed_by = auth.uid()` stops a proposal being
-- filed in somebody else's name to consume their allowance.
DROP POLICY IF EXISTS change_proposals_insert_proposer ON public.change_proposals;
CREATE POLICY change_proposals_insert_proposer ON public.change_proposals
    FOR INSERT TO authenticated
    WITH CHECK (public.has_authority(ARRAY['proposal:create'::text])
                AND proposed_by = auth.uid()
                AND status = 'open');

DROP POLICY IF EXISTS change_proposals_update_own_open ON public.change_proposals;
CREATE POLICY change_proposals_update_own_open ON public.change_proposals
    FOR UPDATE TO authenticated
    USING (proposed_by = auth.uid() AND status = 'open')
    WITH CHECK (proposed_by = auth.uid());

-- NO DELETE POLICY, DELIBERATELY. Withdrawing closes the row; it does not remove it. What survives
-- and for how long is `proposals.retention_days`, in one place, rather than a decision each
-- proposer makes for themselves at the moment they lose interest.

GRANT SELECT, INSERT, UPDATE ON public.change_proposals TO authenticated;
GRANT ALL ON public.change_proposals TO service_role;

-- -------------------------------------------------------------------------------------------------
-- 10. Withdrawing, which is the proposer's own act
-- -------------------------------------------------------------------------------------------------
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
        RAISE EXCEPTION 'proposal % not found', p_proposal_id USING ERRCODE = 'no_data_found';
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

    PERFORM set_config('acs_cymru.proposal_transition', 'on', true);

    UPDATE public.change_proposals
       SET status = 'withdrawn', decided_by = auth.uid(), decided_at = now()
     WHERE id = p_proposal_id;

    RETURN jsonb_build_object('id', p_proposal_id, 'status', 'withdrawn');
END;
$$;

COMMENT ON FUNCTION public.withdraw_proposal(uuid) IS 'The proposer closes their own open proposal, freeing the slot it holds under both caps. Not available to an approver: making somebody else''s proposal disappear without a reason is what rejection exists to prevent.';

-- -------------------------------------------------------------------------------------------------
-- 11. Rejecting, which carries a reason
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_proposal(p_proposal_id uuid, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_proposal public.change_proposals%ROWTYPE;
BEGIN
    -- Re-derived here rather than taken on trust, exactly as approve_quarantined_device() does.
    -- This is the check that still holds if the RPC is ever reached another way.
    IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
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

COMMENT ON FUNCTION public.reject_proposal(uuid, text) IS 'An approver refuses a proposal, with a reason the constraint also requires. The slot is freed immediately and the same change may be proposed again at once -- the reason, not a cooldown, is what makes the second attempt different from the first.';

-- -------------------------------------------------------------------------------------------------
-- 12. Approving, which is applying
-- -------------------------------------------------------------------------------------------------
-- Re-checks the role, re-validates the patch, applies it in this transaction so every constraint
-- on the target runs, and writes the audit row naming both parties. No dynamic SQL. On the
-- nameplate, `updated_by` names the proposer (who made the assertion); the digital_thread row
-- names the approver.
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
    IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
        RAISE EXCEPTION 'not permitted to decide change proposals'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_proposal FROM public.change_proposals
     WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'proposal % not found', p_proposal_id USING ERRCODE = 'no_data_found';
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
               -- THE PROPOSER, and see this function's header for why.
               updated_by                       = v_proposal.proposed_by
         WHERE device_id = v_proposal.entity_id;
    END IF;

    -- THE ROW THAT NAMES BOTH PARTIES. `devices` has its own audit trigger and it fires above,
    -- attributed to the approver; nothing there records who ASKED. This row does, and it is the
    -- only place the pair appears together.
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

COMMENT ON FUNCTION public.approve_proposal(uuid) IS 'Approving IS applying: the role is re-checked server-side, the patch re-validated against proposable_columns(), and the change written in this transaction so every CHECK and foreign key on the target runs now -- an invalid change aborts the approval instead of becoming an audit record of something that did not happen.';

-- -------------------------------------------------------------------------------------------------
-- 13. The timer, which is not a person
-- -------------------------------------------------------------------------------------------------
-- An open proposal nobody acts on holds a slot under both caps, so it closes on a timer.
-- `decided_by` stays NULL. It declares `service`: a machine acting on its own schedule, which is
-- what that value means for the other scheduled jobs.
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

    -- Seven days, matching the seeded default. The setting is bounded at 1 so it cannot be zero,
    -- but a deleted row would otherwise make this interval NULL and the comparison never true --
    -- expiry would stop silently, which is the failure mode the floor exists to prevent.
    v_days := COALESCE(v_days, 7);

    PERFORM set_config('acs_cymru.proposal_transition', 'on', true);

    FOR v_row IN
        UPDATE public.change_proposals
           SET status = 'expired', decided_at = now()
         WHERE status = 'open'
           AND proposed_at < now() - make_interval(secs => v_days::double precision * 86400.0)
        RETURNING id, entity_type, entity_id, proposed_by
    LOOP
        INSERT INTO public.digital_thread
            (entity_type, entity_id, action, new_data, changed_by, actor_source, audit_domain)
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
            -- NULL, and deliberately. `changed_by` names WHICH user, and no user did this.
            NULL,
            'service',
            public.audit_domain_for('change_proposals', 'PROPOSAL_EXPIRED')
        );
        v_expired := v_expired + 1;
    END LOOP;

    RETURN v_expired;
END;
$$;

COMMENT ON FUNCTION public.expire_open_proposals() IS 'Closes open proposals older than proposals.open_expiry_days, freeing the slots they hold under both caps. Records actor_source ''service'' with changed_by NULL: the timer has no session and is not a person, and an expiry is not a rejection.';

-- -------------------------------------------------------------------------------------------------
-- 14. And the queue itself stops growing without end
-- -------------------------------------------------------------------------------------------------
-- What the approval changed is in `digital_thread` under its own policy; this removes only the
-- queue entry.
CREATE OR REPLACE FUNCTION public.prune_closed_proposals() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_days    numeric;
    v_deleted integer;
BEGIN
    SELECT (value #>> '{}')::numeric INTO v_days
      FROM public.system_settings
     WHERE key = 'proposals.retention_days';
    v_days := COALESCE(v_days, 90);

    DELETE FROM public.change_proposals
     WHERE status <> 'open'
       AND decided_at < now() - make_interval(secs => v_days::double precision * 86400.0);

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.prune_closed_proposals() IS 'Removes decided proposals older than proposals.retention_days. Only the queue entry: what an approval changed is in digital_thread under its own retention.';

-- Every function this file creates, REVOKE first: PostgreSQL grants EXECUTE on a new function to
-- PUBLIC, and `anon` is a member of PUBLIC, so a GRANT alone narrows nothing. 0001's sweep heals
-- it on the second boot, which is what makes the leak invisible on any restarted stack;
-- test_anon_privilege_baseline.py refuses it.
REVOKE ALL ON FUNCTION public.proposable_columns(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_change_proposal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_open_proposal_cap() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_change_proposal_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.withdraw_proposal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_proposal(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_proposal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_open_proposals() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_closed_proposals() FROM PUBLIC;

-- The three a person calls, plus the allowlist a form reads to know which fields to offer.
-- `authenticated` may execute them; each re-checks authority itself, which is what makes the grant
-- safe rather than the grant being the check.
GRANT EXECUTE ON FUNCTION public.approve_proposal(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_proposal(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.withdraw_proposal(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.proposable_columns(text) TO authenticated, service_role;

-- NOT `authenticated`. These two are the schedule's, and a user able to call the pruner could
-- shorten retention for everybody by calling it after changing a setting they may also change.
GRANT EXECUTE ON FUNCTION public.expire_open_proposals() TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_closed_proposals() TO service_role;

-- -------------------------------------------------------------------------------------------------
-- 15. The schedule
-- -------------------------------------------------------------------------------------------------
-- `ensure_cron_job` unschedules before scheduling (`cron.schedule` appends). 03:45, after the
-- other nightly jobs, so a morning reading of the cron history has one thing at a time.
SELECT public.ensure_cron_job(
  'expire_open_proposals',
  '45 3 * * *',
  $job$SELECT public.expire_open_proposals()$job$
);

SELECT public.ensure_cron_job(
  'prune_closed_proposals',
  '50 3 * * *',
  $job$SELECT public.prune_closed_proposals()$job$
);

-- -------------------------------------------------------------------------------------------------
-- 16. Self-check
-- -------------------------------------------------------------------------------------------------
-- Read-only: a self-check that writes to an append-only audit table appends on every boot.
DO $$
DECLARE
    v_problems text[] := ARRAY[]::text[];
BEGIN
    -- The grant this migration exists to make, and the two roles that already had everything.
    IF NOT EXISTS (
        SELECT 1 FROM public.role_permissions rp
          JOIN public.permissions p ON p.id = rp.permission_id
         WHERE p.name = 'proposal:create' AND rp.role_id = 3
    ) THEN
        v_problems := v_problems || 'Operator does not hold proposal:create';
    END IF;

    -- THE PROPERTY THE WHOLE ITEM RESTS ON. If a proposable column ever names something ingestion
    -- writes, an operator can assert an observation -- so it is asserted here rather than reviewed.
    IF public.proposable_columns('devices') && ARRAY[
        'status', 'first_dbirth_at', 'reported_identity', 'identity_source', 'is_quarantined',
        'gateway_id', 'schema_id', 'sparkplug_id', 'is_archived', 'conformance_policy'
    ] THEN
        v_problems := v_problems ||
            'proposable_columns(devices) admits a column ingestion or the platform owns';
    END IF;

    -- The floor. A zero here is a working configuration in which the feature silently does nothing.
    IF NOT EXISTS (
        SELECT 1 FROM public.system_settings
         WHERE key = 'proposals.open_expiry_days' AND min_value >= 1
    ) THEN
        v_problems := v_problems || 'proposals.open_expiry_days has no floor of at least 1';
    END IF;

    -- Both caps present: one index, one trigger. Either alone is a cap with a way around it.
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'change_proposals_one_open_per_asset_per_person'
    ) THEN
        v_problems := v_problems || 'the per-asset cap index is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_change_proposals_cap' AND NOT tgisinternal
    ) THEN
        v_problems := v_problems || 'the per-person cap trigger is missing';
    END IF;

    IF array_length(v_problems, 1) IS NOT NULL THEN
        RAISE EXCEPTION '0086 self-check failed: %', array_to_string(v_problems, '; ');
    END IF;
END $$;
