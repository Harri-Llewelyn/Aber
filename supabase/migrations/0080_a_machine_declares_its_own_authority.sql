-- 0080: a machine principal declares its own authority, instead of borrowing a person's role.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT WAS WRONG
--
-- `MCP read-only client` (b0000000-...-0001), `Service_Ingestor` (...-0002) and `Service_Playback`
-- (...-0003) all hold `Operator` AND NOTHING ELSE. That was a good decision when it was made and it
-- is written down as one: 0034's header says Operator was chosen OVER `Auditor` precisely so a model
-- could not read the audit trail. The role was picked for the shape it had.
--
-- THE PROBLEM IS THAT THE SHAPE IS NOT THEIRS. `Operator` is a PERSON's role -- the read-only
-- shopfloor user -- and it is the role that changes whenever somebody asks for an operator to be
-- able to do one more thing. Every one of those requests silently re-grants three machine
-- identities.
--
-- This has already happened once. A request to let an `Operator` read the asset lane of
-- `digital_thread` was refused by 0034's own self-check:
--
--     0034 self-check: the MCP principal read 2 digital_thread row(s). Operator was chosen over
--     Auditor precisely so it could not.
--
-- The check did its job. Note what it cost: A CHANGE ABOUT PEOPLE WAS BLOCKED BY A PROPERTY OF A
-- MACHINE, and the only reason it was caught is that somebody had written that assertion down years'
-- worth of migrations earlier.
--
-- =================================================================================================
-- THE ESCALATION IS LATENT, NOT LIVE, AND THAT IS WHY THIS SHIPS BEFORE THE THING THAT NEEDS IT
--
-- `Operator` is named in exactly three places in 0001, and NONE OF THEM IS AN RLS POLICY: the
-- allow-list in `create_service_principal()`, and the default role a new signup receives. Every read
-- policy the three principals depend on is `FOR SELECT TO authenticated USING (true)`, which 0034
-- states in as many words. So the role grants them nothing today, and removing it takes nothing
-- away.
--
-- WHAT IT GRANTS IS THE NEXT POLICY THAT NAMES `Operator`. The approvals queue is that policy: an
-- INSERT policy admitting `Operator` so a shopfloor user may PROPOSE a change would admit all three
-- of these identities at the same moment, and the per-proposer cap would then hand each of them its
-- own allowance. This migration is a prerequisite for that work rather than a hardening of this
-- one, and it is cheapest to do now, while the role still grants nothing and the change is
-- therefore provably inert.
--
-- =================================================================================================
-- WHY A SECOND MECHANISM RATHER THAN A PREDICATE IN THE POLICY
--
-- `AND NOT is_machine_principal(auth.uid())` on each new policy is the natural repair and it is
-- refused here for a reason that outlives the one originally recorded. The original reason has in
-- fact EXPIRED and is corrected here so nobody goes looking for it: 0034's self-check ran before
-- 0048 re-granted EXECUTE on the predicate, so the rule failed as `permission denied for function
-- is_machine_principal` forty migrations away. Both files are folded into 0001 now, which grants
-- that function to `authenticated` itself, and the archive directory is not copied into the image
-- (`COPY migrations/*.sql` does not recurse), so the ordering that made it fail no longer exists.
--
-- IT IS STILL THE WRONG FIX. A predicate patches the policy that remembers to carry it. The three
-- principals would still hold a person's role, the next author would still have to know to exclude
-- them, and the failure of forgetting is silent and in the permissive direction. `0048` also
-- forbids the other spelling in as many words: "a second definition of 'is this a service account'
-- would be worse than none."
--
-- =================================================================================================
-- WHAT REPLACES IT
--
-- `principal_permissions(principal_id, permission_id)` -- the join `role_permissions` already models
-- for people, scoped to one identity instead of to a role. `has_authority()` resolves a PERSON
-- through `user_roles` -> `role_permissions` and a MACHINE through its own grants, and answers about
-- PERMISSIONS rather than role names, because a permission is what a machine can be said to need.
--
-- `has_role()` IS NOT TOUCHED. Fifty-eight policy sites call it, it is what people resolve through,
-- and every one of those sites names `Administrator` or `Shopfloor_Manager` -- which no machine
-- principal has ever satisfied. Widening this file to that surface would be a rewrite of the access
-- control system in a migration whose subject is three accounts.
--
-- A MACHINE MAY NOT HOLD A ROLE AT ALL, and that is enforced rather than assumed. Allowing both is
-- how the ambiguity comes back: an identity resolving through grants AND through a role is one
-- somebody has to check twice. The trigger in section 3 is the enforcement, and it is what makes the
-- sentence above a property of the database rather than a note in a header.
--
-- A PERMISSION NOBODY GRANTED FAILS CLOSED, on 0070's argument: the safe failure is a machine that
-- cannot read something, not one that can.
--
-- =================================================================================================
-- WHY 0002 CHANGES IN THE SAME BREATH
--
-- 0002 seeds the three `user_roles` rows and runs BEFORE this file on every boot. A DELETE here
-- against an INSERT there is a fight this file would win once per boot and lose in the logs forever,
-- and the guard trigger would turn it into an ABORT: 0002 would try to give a machine a role, the
-- trigger would refuse it, and ON_ERROR_STOP would take the stack down at file two.
--
-- So 0002 stops assigning the role -- the `auth.users` rows stay exactly where they are, because the
-- identities are not what is wrong -- and the DELETE below exists for databases that already have
-- the rows. On a fresh install it removes nothing, which is the house rule for a replayed migration.
--
-- =================================================================================================
-- THE TWO RPCs ARE RENAMED RATHER THAN REDECLARED
--
-- `create_service_principal()` returns `TABLE(principal_id uuid, roles text[])` and
-- `list_service_principals()` returns `roles text[]` as its second column. Both become permissions
-- here, and a changed return type CANNOT be shipped under the same name: 0001 re-declares its own
-- version first on every boot with CREATE OR REPLACE, which cannot change a return type, so the
-- chain would abort at file one AFTER 0001 has dropped the FDW server with CASCADE. That failure is
-- invisible until the SECOND boot. scripts/check-docs-drift.mjs asserts against it and states the
-- remedy: give the new shape its own function name, as 0078 does.


-- -------------------------------------------------------------------------------------------------
-- 1. The grant table
-- -------------------------------------------------------------------------------------------------
-- Deliberately the same two-column shape as `role_permissions`. A machine's authority should be
-- readable by the same query the human side uses, with one join swapped.
CREATE TABLE IF NOT EXISTS public.principal_permissions (
    principal_id  uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    permission_id uuid NOT NULL REFERENCES public.permissions (id) ON DELETE RESTRICT,
    granted_at    timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (principal_id, permission_id)
);

COMMENT ON TABLE public.principal_permissions IS
  'Permissions granted to ONE machine identity, resolved by has_authority(). The machine-side twin '
  'of role_permissions: a principal holds grants of its own instead of borrowing a person''s role, '
  'so widening Operator no longer widens the ingestion daemon. A machine principal may hold no role '
  'at all -- refuse_role_for_machine_principal() enforces that on user_roles.';

COMMENT ON COLUMN public.principal_permissions.granted_at IS
  'When the grant was made. role_permissions carries no equivalent because its rows are seeded by '
  'migration and never by a person; these are minted at runtime by create_machine_principal().';

ALTER TABLE public.principal_permissions ENABLE ROW LEVEL SECURITY;

-- READ ONLY, AND NO WRITE POLICY -- exactly the shape user_roles and role_permissions have. Nothing
-- authenticated may write this table through PostgREST; the SECURITY DEFINER RPC below is the only
-- write path, which is what keeps "who granted a machine what" an Administrator act.
--
-- A principal may read its OWN grants, mirroring user_roles_select_own_or_privileged. It is the
-- answer to "what am I allowed to do", which a caller can already discover by trying.
DROP POLICY IF EXISTS principal_permissions_select_own_or_admin ON public.principal_permissions;
CREATE POLICY principal_permissions_select_own_or_admin ON public.principal_permissions
    FOR SELECT TO authenticated
    USING ((principal_id = auth.uid()) OR public.has_role(ARRAY['Administrator'::text]));

GRANT SELECT ON TABLE public.principal_permissions TO authenticated;
GRANT ALL    ON TABLE public.principal_permissions TO service_role;


-- -------------------------------------------------------------------------------------------------
-- 2. has_authority(), which resolves a person and a machine differently on purpose
-- -------------------------------------------------------------------------------------------------
-- It answers about PERMISSIONS, not role names. `has_role()` stays what it is for people and is not
-- redefined here -- see the header.
--
-- SECURITY DEFINER because is_machine_principal() reads auth.users, and STABLE because both arms are
-- reads within one statement.
CREATE OR REPLACE FUNCTION public.has_authority(allowed_permissions text[]) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    -- ONE ARM OR THE OTHER, NEVER BOTH. A machine resolves through its own grants and a person
    -- through their roles; the trigger on user_roles is what guarantees an identity cannot be in
    -- both sets and make this a question of which arm ran first.
    --
    -- auth.uid() IS NULL -- an anonymous caller -- takes the person arm, matches nothing, and
    -- returns false. Fail-closed, on 0070's argument.
    SELECT CASE
        WHEN public.is_machine_principal(auth.uid()) THEN EXISTS (
            SELECT 1
              FROM public.principal_permissions pp
              JOIN public.permissions p ON p.id = pp.permission_id
             WHERE pp.principal_id = auth.uid()
               AND p.name = ANY (allowed_permissions)
        )
        ELSE EXISTS (
            SELECT 1
              FROM public.user_roles ur
              JOIN public.role_permissions rp ON rp.role_id = ur.role_id
              JOIN public.permissions p ON p.id = rp.permission_id
             WHERE ur.user_id = auth.uid()::text
               AND p.name = ANY (allowed_permissions)
        )
    END;
$$;

COMMENT ON FUNCTION public.has_authority(allowed_permissions text[]) IS
  'True when the caller holds any of these PERMISSIONS. A machine principal resolves through '
  'principal_permissions, a person through user_roles -> role_permissions, and nothing resolves '
  'through both. Use it where a policy would otherwise name a role that machine principals happen '
  'to share; has_role() remains the predicate for the 58 sites that name Administrator or '
  'Shopfloor_Manager, which no machine has ever satisfied.';

REVOKE ALL ON FUNCTION public.has_authority(allowed_permissions text[]) FROM PUBLIC;
GRANT ALL  ON FUNCTION public.has_authority(allowed_permissions text[]) TO authenticated;
GRANT ALL  ON FUNCTION public.has_authority(allowed_permissions text[]) TO service_role;


-- -------------------------------------------------------------------------------------------------
-- 3. The enforcement: a machine principal may not hold a role
-- -------------------------------------------------------------------------------------------------
-- Without this, the separation is a convention and the next `create_*_principal()` re-introduces the
-- problem in one INSERT. With it, an identity that cannot sign in resolves through grants or through
-- nothing.
CREATE OR REPLACE FUNCTION public.refuse_role_for_machine_principal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    -- `user_roles.user_id` is TEXT and carries no FK, so it is not guaranteed to be a uuid. A cast
    -- that raises here would refuse a row for the wrong reason and name the wrong problem, so the
    -- shape is checked before the predicate is asked.
    IF NEW.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND public.is_machine_principal(NEW.user_id::uuid) THEN
        RAISE EXCEPTION
            'user_roles: % is a machine principal and may not hold a role. Grant it permissions '
            'with create_machine_principal() or principal_permissions instead -- 0080 separated the '
            'two so that widening a person''s role stops widening the stack''s own processes.',
            NEW.user_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.refuse_role_for_machine_principal() IS
  'BEFORE INSERT/UPDATE guard on user_roles. Refuses a role assignment to an identity that cannot '
  'sign in, which is what makes "a machine resolves through its own grants" a property of the '
  'database rather than a convention every future author has to remember.';

-- REVOKED FROM PUBLIC AND GRANTED TO NOBODY. A trigger body is invoked by the executor and needs no
-- EXECUTE grant on anyone's behalf, but PostgreSQL grants EXECUTE on every NEW function to PUBLIC --
-- and `anon` is a member of PUBLIC. 0001's section 6 sweep would catch it, except that the sweep
-- runs in 0001, BEFORE this file creates the function, so the leak exists on a FIRST boot and heals
-- on the second. test_anon_privilege_baseline.py exists for precisely that fault.
REVOKE ALL ON FUNCTION public.refuse_role_for_machine_principal() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_user_roles_refuse_machine_principal ON public.user_roles;
CREATE TRIGGER trg_user_roles_refuse_machine_principal
    BEFORE INSERT OR UPDATE ON public.user_roles
    FOR EACH ROW EXECUTE FUNCTION public.refuse_role_for_machine_principal();


-- -------------------------------------------------------------------------------------------------
-- 4. The three principals declare what they actually need
-- -------------------------------------------------------------------------------------------------
-- `Operator` holds TWO permissions -- `telemetry:read` and `quarantine:view` -- so that is what the
-- three have been holding. Each keeps `telemetry:read`, which is the one that describes what it
-- does, and loses `quarantine:view`:
--
--   MCP read-only client  the Access Control page already states the specification -- "Read-only
--                         across the asset inventory and live telemetry. Cannot read the audit
--                         trail." There is no MCP surface for the quarantine queue and i3x/README.md
--                         records the decision that there will not be one.
--   Service_Ingestor      quarantines devices through log_device_quarantine()/the ingest_* gates,
--                         which are SECURITY DEFINER and check is_ingestion_caller(). It has never
--                         needed to SELECT the queue to write to it.
--   Service_Playback      publishes as a gateway through the playback_* gates, and touches
--                         onboarding not at all.
--
-- The grants are additive and keyed on the permission NAME rather than its uuid, following 0034's
-- rule for roles: a migration that hardcodes an id asserts a fact about a sequence.
DO $$
DECLARE
    c_principals CONSTANT uuid[] := ARRAY[
        'b0000000-0000-4000-8000-000000000001'::uuid,  -- MCP read-only client (0034)
        'b0000000-0000-4000-8000-000000000002'::uuid,  -- Service_Ingestor     (0046)
        'b0000000-0000-4000-8000-000000000003'::uuid   -- Service_Playback     (0056)
    ];
    v_permission uuid;
    v_principal  uuid;
BEGIN
    SELECT id INTO v_permission FROM public.permissions WHERE name = 'telemetry:read';
    IF v_permission IS NULL THEN
        RAISE EXCEPTION '0080: the telemetry:read permission is missing; 0002 did not run cleanly.';
    END IF;

    FOREACH v_principal IN ARRAY c_principals LOOP
        -- ONLY IF THE IDENTITY EXISTS. 0002 seeds all three, but a database that has had one
        -- removed by hand should not be given it back by a file whose subject is authority.
        IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_principal) THEN
            INSERT INTO public.principal_permissions (principal_id, permission_id)
            VALUES (v_principal, v_permission)
            ON CONFLICT (principal_id, permission_id) DO NOTHING;
        END IF;
    END LOOP;
END $$;


-- -------------------------------------------------------------------------------------------------
-- 5. And stop holding the role
-- -------------------------------------------------------------------------------------------------
-- For databases seeded before 0002 stopped assigning it. On a fresh install this removes nothing.
--
-- MATCHED ON THE PREDICATE, NOT ON THE THREE IDS. `create_service_principal()` has been mintable
-- since 0044, so a deployment may hold machine identities this file has never heard of -- and every
-- one of them was given `Operator` or `Auditor` by that function. Leaving those behind would fix the
-- three that are documented and none of the ones that are not.
--
-- Their permissions come across rather than being dropped, so a minted principal keeps the authority
-- it was created with. The role it held is the thing being taken away, not what the role granted.
INSERT INTO public.principal_permissions (principal_id, permission_id)
SELECT ur.user_id::uuid, rp.permission_id
  FROM public.user_roles ur
  JOIN public.role_permissions rp ON rp.role_id = ur.role_id
 WHERE ur.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND public.is_machine_principal(ur.user_id::uuid)
   -- The three seeded principals are handled by section 4 and deliberately narrow on the way
   -- across: carrying their grants wholesale here would hand back the `quarantine:view` that
   -- section is removing.
   AND ur.user_id::uuid <> ALL (ARRAY[
       'b0000000-0000-4000-8000-000000000001'::uuid,
       'b0000000-0000-4000-8000-000000000002'::uuid,
       'b0000000-0000-4000-8000-000000000003'::uuid
   ])
ON CONFLICT (principal_id, permission_id) DO NOTHING;

DELETE FROM public.user_roles ur
 WHERE ur.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND public.is_machine_principal(ur.user_id::uuid);


-- -------------------------------------------------------------------------------------------------
-- 6. The RPCs, renamed because their return types move
-- -------------------------------------------------------------------------------------------------
-- 0001 re-creates the old pair on every boot, so these DROPs run once per boot against a function
-- that has just been declared. That is the same shape 0069 uses when it DELETEs grants 0002 has just
-- inserted, and it is the price of a folded baseline that cannot be edited backwards.
DROP FUNCTION IF EXISTS public.create_service_principal(text, text);
DROP FUNCTION IF EXISTS public.list_service_principals();

CREATE OR REPLACE FUNCTION public.create_machine_principal(p_permissions text[], p_note text DEFAULT NULL::text)
    RETURNS TABLE(principal_id uuid, permissions text[])
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    -- READ-ONLY PERMISSIONS ONLY, and an allow-list rather than a deny-list so that a permission
    -- added later is refused until somebody decides otherwise. This is the same refusal
    -- `create_service_principal()` made with ARRAY['Operator', 'Auditor'], restated one level down:
    -- a machine identity holding a write permission becomes an unrevocable write credential the
    -- moment a token is signed for it.
    c_allowed CONSTANT text[] := ARRAY['telemetry:read', 'quarantine:view', 'digital_thread:read'];
    v_id        uuid;
    v_bad       text[];
    v_ids       uuid[];
BEGIN
    -- ADMINISTRATOR ONLY, matching the function it replaces. Creating an identity that can reach
    -- the stack is an access-control act, and `authz:manage` is granted to Administrator alone.
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'insufficient privileges to create a machine principal'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_permissions IS NULL OR cardinality(p_permissions) = 0 THEN
        RAISE EXCEPTION
            'create_machine_principal: at least one permission is required. A principal with no '
            'authority can still be named by a token, which makes it a credential that looks '
            'harmless and is not accounted for anywhere.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT array_agg(x) INTO v_bad
      FROM unnest(p_permissions) AS x
     WHERE x <> ALL (c_allowed);

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
            'create_machine_principal: % is not grantable to a machine identity. Allowed: %. Once a '
            'token is signed for a principal it cannot be revoked, so a write permission here would '
            'be an unrevocable write credential.',
            array_to_string(v_bad, ', '), array_to_string(c_allowed, ', ')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- BY NAME, not by a hardcoded id -- 0034's reasoning, applied to permissions.
    SELECT array_agg(p.id) INTO v_ids
      FROM public.permissions p
     WHERE p.name = ANY (p_permissions);

    IF v_ids IS NULL OR cardinality(v_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_permissions))) THEN
        RAISE EXCEPTION 'create_machine_principal: one of % does not exist in public.permissions',
            array_to_string(p_permissions, ', ')
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- A NOTE IS BOUNDED. It reaches the audit row below, which is append-only.
    IF p_note IS NOT NULL AND length(p_note) > 200 THEN
        RAISE EXCEPTION 'create_machine_principal: p_note must be 200 characters or fewer'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_id := gen_random_uuid();

    -- ONLY `id`. This is what makes the account unable to sign in, and it is a property of the
    -- INSERT rather than of anybody's intent -- which is also what makes is_machine_principal()
    -- true for it, and therefore what routes it through principal_permissions from here on.
    INSERT INTO auth.users (id) VALUES (v_id);

    INSERT INTO public.principal_permissions (principal_id, permission_id)
    SELECT v_id, unnest(v_ids)
    ON CONFLICT (principal_id, permission_id) DO NOTHING;

    -- ATTRIBUTED TO A PERSON: this is called by an Administrator with a session, so `auth.uid()` is
    -- the attribution rather than a claim.
    INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'service_principals',
        v_id,
        'INSERT',
        NULL,
        jsonb_build_object(
            'permissions', to_jsonb(p_permissions),
            'note',        p_note,
            'can_sign_in', false
        ),
        auth.uid(),
        'user',
        txid_current(),
        now()
    );

    RETURN QUERY SELECT v_id, p_permissions;
END;
$$;

COMMENT ON FUNCTION public.create_machine_principal(p_permissions text[], p_note text) IS
  'Create a machine identity that cannot sign in, holding its own read-only permissions. '
  'Administrator only. Replaces create_service_principal(), which handed it a person''s role -- the '
  'name changed because the return type did, and CREATE OR REPLACE cannot change a return type on '
  'a chain that replays. Refuses anything but telemetry:read, quarantine:view and '
  'digital_thread:read: once a token is signed for a principal it cannot be revoked.';

REVOKE ALL ON FUNCTION public.create_machine_principal(p_permissions text[], p_note text) FROM PUBLIC;
GRANT ALL  ON FUNCTION public.create_machine_principal(p_permissions text[], p_note text) TO authenticated;
GRANT ALL  ON FUNCTION public.create_machine_principal(p_permissions text[], p_note text) TO service_role;


CREATE OR REPLACE FUNCTION public.list_machine_principals()
    RETURNS TABLE(principal_id uuid, permissions text[], created_at timestamp with time zone, can_sign_in boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    -- ADMINISTRATOR ONLY, and narrower than the page's other reads on purpose. A gateway's
    -- credential state is operational -- a Shopfloor_Manager acts on it. The list of machine
    -- identities that can reach the stack is an access-control question.
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'insufficient privileges to list machine principals'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN QUERY
    SELECT u.id,
           coalesce(array_agg(p.name ORDER BY p.name) FILTER (WHERE p.name IS NOT NULL), '{}'::text[]),
           u.created_at,
           -- RETURNED RATHER THAN ASSUMED, even though the WHERE clause makes it false for every
           -- row. It is the property that makes listing these safe, and a page that states it is a
           -- page whose claim can be checked.
           false
      FROM auth.users u
      LEFT JOIN public.principal_permissions pp ON pp.principal_id = u.id
      LEFT JOIN public.permissions p ON p.id = pp.permission_id
     WHERE u.email IS NULL
       AND (u.encrypted_password IS NULL OR u.encrypted_password = '')
     GROUP BY u.id, u.created_at
     ORDER BY u.created_at;
END;
$$;

COMMENT ON FUNCTION public.list_machine_principals() IS
  'Machine identities that can reach this stack, with the permissions each holds in its own right. '
  'Administrator only. Replaces list_service_principals(), whose second column was the role a '
  'machine borrowed; the name changed because the return type did. Returns no email, no token and '
  'nothing derived from one.';

REVOKE ALL ON FUNCTION public.list_machine_principals() FROM PUBLIC;
GRANT ALL  ON FUNCTION public.list_machine_principals() TO authenticated;
GRANT ALL  ON FUNCTION public.list_machine_principals() TO service_role;


-- -------------------------------------------------------------------------------------------------
-- 7. Self-check
-- -------------------------------------------------------------------------------------------------
-- 0034's self-check asserted that the MCP principal could not read the audit trail, and it is the
-- best test in this area. It is not deleted with the mechanism it guarded: the property it asserted
-- is re-asserted below against the new one, which is the whole point of moving rather than removing
-- it.
DO $$
DECLARE
    c_mcp      CONSTANT uuid := 'b0000000-0000-4000-8000-000000000001';
    v_roles    integer;
    v_grants   integer;
    v_audit    integer;
    v_refused  boolean := false;
BEGIN
    -- (a) No machine principal holds a role any more.
    SELECT count(*) INTO v_roles
      FROM public.user_roles ur
     WHERE ur.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND public.is_machine_principal(ur.user_id::uuid);

    IF v_roles <> 0 THEN
        RAISE EXCEPTION
            '0080 self-check: % machine principal role assignment(s) survived. The DELETE matches on '
            'is_machine_principal(), so a survivor means the predicate no longer recognises an '
            'identity it used to -- check whether something gave one of them an email.', v_roles;
    END IF;

    -- (b) The three seeded principals hold telemetry:read and nothing else.
    SELECT count(*) INTO v_grants
      FROM public.principal_permissions pp
      JOIN public.permissions p ON p.id = pp.permission_id
     WHERE pp.principal_id IN (
             'b0000000-0000-4000-8000-000000000001',
             'b0000000-0000-4000-8000-000000000002',
             'b0000000-0000-4000-8000-000000000003')
       AND p.name <> 'telemetry:read';

    IF v_grants <> 0 THEN
        RAISE EXCEPTION
            '0080 self-check: the seeded principals hold % permission(s) beyond telemetry:read. '
            'Section 4 narrows them deliberately and section 5 excludes them from the carry-across; '
            'a surplus means one of those two stopped agreeing with the other.', v_grants;
    END IF;

    -- (c) THE PROPERTY 0034 ASSERTED, restated against principal_permissions. Operator was chosen
    -- over Auditor so the MCP principal could not read the audit trail; a grant of
    -- `digital_thread:read` to it would be that decision being reversed by accident.
    SELECT count(*) INTO v_audit
      FROM public.principal_permissions pp
      JOIN public.permissions p ON p.id = pp.permission_id
     WHERE pp.principal_id = c_mcp
       AND p.name = 'digital_thread:read';

    IF v_audit <> 0 THEN
        RAISE EXCEPTION
            '0080 self-check: the MCP principal holds digital_thread:read. 0034 chose Operator over '
            'Auditor precisely so it could not read the audit trail, and that decision is not this '
            'file''s to reverse.';
    END IF;

    -- (d) The guard actually refuses. Asserted by trying it rather than by trusting that CREATE
    -- TRIGGER ran, and rolled back either way -- a self-check that leaves a row behind is a seed.
    BEGIN
        INSERT INTO public.user_roles (user_id, role_id)
        SELECT c_mcp::text, id FROM public.roles WHERE name = 'Operator';
        RAISE EXCEPTION 'sentinel: the guard did not fire';
    EXCEPTION
        WHEN insufficient_privilege THEN
            v_refused := true;
        WHEN OTHERS THEN
            v_refused := false;
    END;

    IF NOT v_refused THEN
        RAISE EXCEPTION
            '0080 self-check: user_roles accepted a role for a machine principal. The trigger is '
            'what makes "a machine resolves through its own grants" enforced rather than assumed, '
            'and without it the next create_*_principal() re-introduces 0080''s whole subject.';
    END IF;

    RAISE NOTICE
        '0080 self-check passed: no machine principal holds a role, the three seeded principals hold '
        'telemetry:read alone, the MCP principal cannot read the audit trail, and user_roles refuses '
        'a machine identity.';
END $$;
