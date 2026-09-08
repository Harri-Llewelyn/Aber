-- 0086: a change can be proposed by somebody who may not make it.
--
-- =================================================================================================
-- WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT
--
-- One queue for a change a person proposes but may not apply. An `Operator` proposes; an
-- `Administrator` or `Shopfloor_Manager` approves; THE APPROVAL IS THE WRITE.
--
-- `Operator` is role 3 and held two permissions before this file, neither of them a write. So this
-- is not the loosening of an existing grant -- it is the first write that role has ever been
-- given, and it is worth being exact about what it is a write TO: a queue, not an asset.
--
-- THE ASSET WRITE POLICIES DO NOT MOVE. `devices`, `cells`, `gateways` and `schemas` stay gated on
-- has_role(ARRAY['Administrator', 'Shopfloor_Manager']) exactly as they were before this file. What
-- is new is one table an Operator may INSERT into, and an apply path that runs as the approver. If
-- a later change ever adds a second write path to an asset table -- however convenient -- this item
-- has failed, and that is the review question to ask of it.
--
-- =================================================================================================
-- WHY APPROVING IS APPLYING
--
-- `approve_quarantined_device()` is the precedent and already has the three properties that matter:
-- it re-checks the actor's role SERVER-SIDE rather than trusting the caller, it applies in one
-- transaction, and it attributes the resulting `digital_thread` rows to the approver.
--
-- The consequence is the point. Because the approval IS the write, every CHECK, every foreign key
-- and every trigger on the target table runs at approval time, and an invalid change CANNOT BE
-- APPROVED -- it aborts the approval instead of being accepted and then failing somewhere else. A
-- queue that accepts a change it cannot apply produces an audit record of something that did not
-- happen, which is worse than no record at all.
--
-- Concretely: a patch setting `location_scope = 'site_wide'` while leaving `cell_id` populated
-- fails `devices_site_wide_has_no_cell` at approval and the approver is told so. Nothing in this
-- file re-implements that rule, and nothing should.
--
-- =================================================================================================
-- THE PATCH IS OPERATOR-CONTROLLED INPUT
--
-- It is validated on the way IN -- so a proposal naming a column nobody may propose never reaches
-- an approver looking approvable -- and again at apply, so an edit between the two cannot smuggle
-- one past. NO SQL IS EVER BUILT FROM THE PATCH'S KEYS: the patch is merged onto the current row
-- with `jsonb_populate_record` and then assigned column by column in SQL written out by hand. The
-- allowlist is `proposable_columns()`, which is the only place that answer exists.
--
-- The columns ingestion writes are absent from every allowlist, and that is the security half of
-- the design rather than a tidiness preference: `status`, `first_dbirth_at`, `reported_identity`,
-- `identity_source` and `is_quarantined` are what the platform OBSERVED, and a proposal able to
-- edit them would let an operator assert a device's identity by describing it.
--
-- =================================================================================================
-- TWO CAPS, DOING TWO DIFFERENT JOBS, BOTH IN THE DATABASE
--
--   1. A partial unique index on (entity_type, entity_id, proposed_by) WHERE status = 'open'.
--      One open proposal per asset per person, which forces three nameplate edits into one coherent
--      diff instead of three. SCOPED TO THE PROPOSER DELIBERATELY: a cap on the asset alone would
--      let one operator's forgotten proposal block everybody else from proposing against that
--      machine -- a denial of service by accident rather than by intent.
--
--   2. A ceiling on total open proposals per proposer, held in `system_settings`. This is the one
--      that actually bounds reviewer load, because the per-asset rule still permits one proposal
--      against each of five hundred devices. A setting rather than a constant, because the right
--      number differs per plant.
--
-- BOTH ARE ENFORCED HERE RATHER THAN IN A BUTTON, and 0069's header already made the argument: a
-- rule the frontend applies and the database does not is "a frontend flag and therefore never an
-- access control". The RLS policy below admits a direct PostgREST INSERT, so a cap living only in
-- an RPC would be a cap with a documented way around it.
--
-- =================================================================================================
-- WHAT THIS FILE DOES NOT TOUCH
--
-- `quarantine:approve` and `quarantine:reject`, which are not proposable and not delegable -- a
-- quarantine entry is a discovery the SYSTEM made, not a change a person authored, and approving
-- one mints identity and binds a device to a gateway. The schema lineage invariants, which
-- `publish_schema_version()` maintains and which a schema lane must go through rather than around.
-- And the write policies on every asset table, which are the same after this migration as before.
-- =================================================================================================


-- -------------------------------------------------------------------------------------------------
-- 1. The permission, and the first write grant `Operator` has ever held
-- -------------------------------------------------------------------------------------------------
-- Mirrored by PERMISSION_UUIDS in frontend/src/constants.js and by DEFAULT_ROLE_PERMISSIONS_MAP in
-- frontend/src/hooks/usePermissions.js; scripts/check-mirror-drift.mjs replays this whole chain and
-- compares the two, so a grant added here and not there renders controls the database refuses.
--
-- GRANTED TO ALL THREE, not to Operator alone. A Shopfloor_Manager who can apply a change directly
-- can also propose one -- a manager drafting a change for a colleague to check is the same act --
-- and a permission that exists only for the role which cannot act reads as a demotion rather than
-- as a capability.
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
-- `audit_domain_for()` FAILS CLOSED: an entity_type nobody classified is 'security', readable by
-- Administrator and Auditor alone. That is the right default and the wrong answer for these two.
--
-- `device_nameplate` has never appeared in `digital_thread`, because no trigger writes it and the
-- apply path below is the first thing that does. It is operator-supplied identification about a
-- machine, a Shopfloor_Manager may edit it today, and filing it under 'security' would hide a
-- manager's own act from that manager.
--
-- `change_proposals` is the queue itself. Only the expiry timer writes an audit row against it --
-- every other transition is legible in the proposal row -- and an expiry a manager cannot see is an
-- expiry that gets reported as a disappearance.
CREATE OR REPLACE FUNCTION public.audit_domain_for(p_entity_type text, p_action text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    -- Identity and authority. Every act on these is Administrator-only to perform, so it is
    -- Administrator-and-Auditor to read.
    WHEN p_entity_type IN ('service_principals', 'user_roles', 'system_settings')
      THEN 'security'

    -- The asset trail: the shopfloor's own history, which is what a Shopfloor_Manager manages.
    -- CREDENTIAL_ISSUED lands here on `gateways` deliberately -- see 0001's header. A Manager may
    -- mint a virtual gateway's broker credential, so a Manager may read that one was minted.
    --
    -- `device_nameplate` and `change_proposals` joined in 0086: an assertion about an asset, and
    -- the queue of proposed assertions about assets.
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
-- IMMUTABLE and per entity type. Read by the validation trigger on the way in and by the apply path
-- on the way out, so the two cannot drift into disagreeing about what is proposable.
--
-- WHAT IS ABSENT FROM `devices`, AND WHY, because the omissions carry the argument:
--   status, first_dbirth_at, reported_identity, identity_source, is_quarantined
--                       -- written by ingestion from what the plant actually did. A proposal able
--                          to set them would let an operator assert an observation.
--   gateway_id          -- the DATA PATH. 0036 separated location from it precisely so a location
--                          change need not rewire a device's connection; this keeps them apart.
--   schema_id           -- schema binding belongs to `publish_schema_version()`, transactionally,
--                          and a patch repointing it would fork the lineage that function keeps.
--   is_archived, archived_at, auto_delete_at
--                       -- lifecycle, with a retention promise attached to a date the user picked.
--   conformance_policy  -- decides what ingestion ENFORCES. 0069 made that class of decision
--                          Administrator-only; it is not an asset detail.
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
-- `entity_type` holds the TABLE NAME rather than a singular noun, so it speaks the vocabulary
-- `digital_thread.entity_type` and `audit_domain_for()` already use.
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

-- BOUNDS SET BY UPDATE, NOT BY EXTRA ARGUMENTS -- 0032's reason, restated by 0002: adding
-- parameters to seed_setting() creates an OVERLOAD rather than replacing it, because CREATE OR
-- REPLACE matches on the argument list.
--
-- MIN 1 ON THE EXPIRY, AND THE FLOOR IS THE WHOLE POINT. Zero would auto-close every proposal at
-- the moment it was created -- a working configuration in which the feature silently does nothing,
-- every operator's proposal vanishes before an approver sees it, and nothing anywhere reports an
-- error. The ceiling is a typo guard in the same spirit as 0032's.
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
-- A CHECK constraint cannot do this: it would have to call proposable_columns() per key, and it
-- must also confirm the target exists. So it is a trigger, and it runs on INSERT and on every
-- UPDATE that touches the patch -- an operator editing an open proposal is exactly the path a
-- validation written for INSERT alone would miss.
CREATE OR REPLACE FUNCTION public.validate_change_proposal() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_allowed text[] := public.proposable_columns(NEW.entity_type);
    v_key     text;
BEGIN
    -- FAIL-CLOSED, AND IT NAMES THE REAL PROBLEM. The CHECK constraint admits two entity types and
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

    -- THE TARGET HAS TO EXIST, and there is no foreign key that can say so: `entity_id` addresses
    -- two different tables depending on `entity_type`. Both lanes are keyed by a device, which is
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

COMMENT ON FUNCTION public.validate_change_proposal() IS 'Refuses a patch naming a column proposable_columns() does not admit, or one aimed at a device that is absent or archived. Runs on INSERT and on any UPDATE that touches the patch, because editing an open proposal is a path INSERT-only validation would miss.';

DROP TRIGGER IF EXISTS trg_change_proposals_validate ON public.change_proposals;
CREATE TRIGGER trg_change_proposals_validate
    BEFORE INSERT OR UPDATE OF patch, entity_type, entity_id ON public.change_proposals
    FOR EACH ROW EXECUTE FUNCTION public.validate_change_proposal();


-- -------------------------------------------------------------------------------------------------
-- 7. Cap 2, which has to be a trigger
-- -------------------------------------------------------------------------------------------------
-- The per-asset cap is an index and needs nothing. This one counts rows, so it is a trigger -- and
-- it is a trigger rather than a line in an RPC because the INSERT policy below admits a direct
-- PostgREST write. A cap only an RPC enforced would be documented and bypassable in the same page.
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
-- The UPDATE policy lets a proposer edit their own open proposal, which the caps make necessary
-- rather than convenient: told "you already have an open proposal on this device", they have to be
-- able to open it and add to it. Otherwise the constraint reads as a wall and people route around
-- it by proposing against a neighbouring asset, or stop proposing.
--
-- But an UPDATE policy cannot say WHICH COLUMNS may move, and `status` is the one that must not:
-- a proposer who could set 'applied' would have granted themselves the asset write this entire
-- design exists to withhold.
--
-- SO THE TRANSITION FUNCTIONS DECLARE THEMSELVES with a session flag, exactly as the approval path
-- declares its actor with `acs_cymru.actor_id`. SET LOCAL, so it is discarded at COMMIT and cannot
-- bleed into the connection's next statement.
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

-- WRITE. `has_authority` rather than a role name, on 0080's argument: the three machine principals
-- held `Operator` and nothing else until that migration, and a policy naming the role would have
-- admitted them along with the shopfloor -- each with its own allowance under the per-person cap.
-- They now resolve through `principal_permissions` and hold no `proposal:create`.
--
-- `proposed_by = auth.uid()` is what stops a proposal being filed in somebody else's name, which
-- would otherwise be a way to consume another person's allowance.
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
-- The whole design in one function. It re-checks the role, re-validates the patch, applies it in
-- this transaction so every constraint on the target runs, and writes the audit row naming BOTH
-- parties.
--
-- NO DYNAMIC SQL. `jsonb_populate_record` merges the patch onto the current row and the UPDATE
-- assigns the allowlisted columns by name, written out. The patch's keys never become identifiers.
--
-- WHO `updated_by` NAMES on the nameplate is the one attribution question this raises, and the
-- column's own comment settles it: a nameplate is an assertion ABOUT an asset, so who made it is
-- part of the record -- that is the PROPOSER. The approver is who authorised it, which is what the
-- digital_thread row says. Both are in the record; neither column has to hold both.
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
-- An open proposal nobody acts on holds a slot under both caps indefinitely, so it closes on a
-- timer. `decided_by` stays NULL: naming an approver for a decision nobody made would put a false
-- attribution in the one record this feature exists to produce.
--
-- IT DECLARES `service`. `digital_thread.actor_source` admits user | ingestion | migration |
-- service, and only the last three can be DECLARED -- 'user' is derived from auth.uid() rather than
-- claimed. A timer has no session and is not a person, so 'service' is what it is: a machine acting
-- on its own schedule, which is what that value already means for the other scheduled jobs. §8's
-- reconciling sidecar asks the identical question and should give the identical answer rather than
-- minting a second kind for the same shape of actor.
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
-- Every other durable store in this repository has a retention answer and 0079 has just finished
-- giving one to the largest. A queue of closed proposals with operator-authored free text attached
-- would be the next store to arrive without one.
--
-- WHAT THE APPROVAL CHANGED IS NOT PRUNED HERE. That is in `digital_thread` under its own policy;
-- this removes only the queue entry, so shortening it destroys no record of what happened.
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

-- EVERY function this file creates, and the REVOKE comes FIRST on all of them.
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC, and `anon` is a member of PUBLIC -- so
-- `GRANT EXECUTE ... TO authenticated` alone narrows NOTHING, it restates a permission everybody
-- already had. 0001's sweep catches the leak on the SECOND boot and `CREATE OR REPLACE` then
-- preserves the healed ACL, which is what makes this invisible on any stack that has been
-- restarted once and present on exactly one kind of installation: a new one. 0076 shipped this
-- fault and it reached CI; test_anon_privilege_baseline.py is the suite that now refuses it, and
-- it refused this file's first draft.
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
-- `ensure_cron_job` unschedules before scheduling, which is what makes this survive the every-boot
-- replay -- `cron.schedule` appends rather than replaces, and 0032 records finding that the hard
-- way.
--
-- 03:45, after `prune_platform_alerts` (03:15) and `purge_expired_archives` (03:30) rather than
-- beside them. Both jobs are small, and the ordering is only so that a morning reading of the cron
-- history has one thing happening at a time.
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
-- READ-ONLY, and it writes nothing. 0037 and 0038 are why that is stated: their self-checks
-- appended nine audit rows per boot to a table that is append-only to every application role, and
-- by the time it was found `migration` was the largest actor_source in `digital_thread`.
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
