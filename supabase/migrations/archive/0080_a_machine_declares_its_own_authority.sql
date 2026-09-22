-- 0080: a machine principal declares its own authority, instead of borrowing a person's role.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- The MCP reader, `Service_Ingestor` and `Service_Playback` held `Operator`, a person's role that
-- changes whenever somebody asks for an operator to be able to do one more thing; every such
-- change silently re-granted three machine identities. The role grants them nothing today
-- (every read policy they depend on is `FOR SELECT TO authenticated USING (true)`), so the
-- change is inert now and a prerequisite for the first policy that names `Operator`: the
-- approvals queue's INSERT policy.
--
-- WHAT REPLACES IT. `principal_permissions(principal_id, permission_id)`, the join
-- `role_permissions` models for people, scoped to one identity. `has_authority()` resolves a
-- person through `user_roles` -> `role_permissions` and a machine through its own grants, and
-- answers about permissions rather than role names. `has_role()` is not touched: fifty-eight
-- policy sites call it and every one names Administrator or Shopfloor_Manager. A machine may not
-- hold a role at all, enforced by the trigger in section 3. A permission nobody granted fails
-- closed. Not a predicate in each policy: that patches only the policy that remembers to carry
-- it.
--
-- 0002 stops assigning the role in the same change (a DELETE here against an INSERT there would
-- fight every boot, and the trigger would abort the chain at file two); the DELETE below is for
-- databases that already have the rows.
--
-- The two RPCs are renamed rather than redeclared because their return types move, and a changed
-- return type cannot ship under the same name on a chain 0001 replays first (check-docs-drift.mjs
-- asserts this).

-- -------------------------------------------------------------------------------------------------
-- 1. The grant table
-- -------------------------------------------------------------------------------------------------
-- The same two-column shape as `role_permissions`, so a machine's authority is readable by the
-- same query with one join swapped.
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

-- Read only, and no write policy, as user_roles and role_permissions: the SECURITY DEFINER RPC
-- below is the only write path. A principal may read its own grants.
DROP POLICY IF EXISTS principal_permissions_select_own_or_admin ON public.principal_permissions;
CREATE POLICY principal_permissions_select_own_or_admin ON public.principal_permissions
    FOR SELECT TO authenticated
    USING ((principal_id = auth.uid()) OR public.has_role(ARRAY['Administrator'::text]));

GRANT SELECT ON TABLE public.principal_permissions TO authenticated;
GRANT ALL    ON TABLE public.principal_permissions TO service_role;

-- -------------------------------------------------------------------------------------------------
-- 2. has_authority(), which resolves a person and a machine differently on purpose
-- -------------------------------------------------------------------------------------------------
-- Answers about permissions, not role names. SECURITY DEFINER because is_machine_principal()
-- reads auth.users; STABLE because both arms are reads.
CREATE OR REPLACE FUNCTION public.has_authority(allowed_permissions text[]) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    -- One arm or the other, never both: the trigger on user_roles guarantees an identity cannot be
    -- in both sets. An anonymous caller takes the person arm, matches nothing, and returns false.
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
-- Without this the separation is a convention the next `create_*_principal()` can undo in one
-- INSERT.
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

-- Revoked from PUBLIC and granted to nobody: a trigger body needs no EXECUTE grant, and
-- PostgreSQL grants EXECUTE to PUBLIC (which includes `anon`) on every new function. 0001's
-- sweep runs before this file creates the function, so the leak would exist on a first boot.
REVOKE ALL ON FUNCTION public.refuse_role_for_machine_principal() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_user_roles_refuse_machine_principal ON public.user_roles;
CREATE TRIGGER trg_user_roles_refuse_machine_principal
    BEFORE INSERT OR UPDATE ON public.user_roles
    FOR EACH ROW EXECUTE FUNCTION public.refuse_role_for_machine_principal();

-- -------------------------------------------------------------------------------------------------
-- 4. The three principals declare what they actually need
-- -------------------------------------------------------------------------------------------------
-- Each keeps `telemetry:read` and loses `quarantine:view`: the MCP client has no surface for the
-- quarantine queue, Service_Ingestor quarantines devices through SECURITY DEFINER gates and never
-- needed to SELECT the queue, and Service_Playback touches onboarding not at all. Keyed on the
-- permission name rather than its uuid.
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
-- For databases seeded before 0002 stopped assigning it. Matched on the predicate, not on the
-- three ids: `create_service_principal()` has minted principals this file has never heard of,
-- each given `Operator` or `Auditor`. Their permissions come across, so a minted principal keeps
-- the authority it was created with.
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
-- 0001 re-creates the old pair on every boot, so these DROPs run once per boot.
DROP FUNCTION IF EXISTS public.create_service_principal(text, text);
DROP FUNCTION IF EXISTS public.list_service_principals();

CREATE OR REPLACE FUNCTION public.create_machine_principal(p_permissions text[], p_note text DEFAULT NULL::text)
    RETURNS TABLE(principal_id uuid, permissions text[])
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    -- Read-only permissions only, as an allow-list so a permission added later is refused until
    -- somebody decides otherwise: a machine identity holding a write permission becomes an
    -- unrevocable write credential the moment a token is signed for it.
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
-- Re-asserts, against the new mechanism, the property the MCP principal's original self-check
-- guarded: it cannot read the audit trail.
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
