-- =============================================================================================
-- Migration: 0013_machine_identities_may_hold_write_permissions.sql
-- Machines propose, people decide: what a machine identity may hold (#526, #517)
-- =============================================================================================
--
-- create_machine_principal() refused every permission but three reads, saying a token signed for
-- a principal cannot be revoked. revoke_service_token() and revoke_service_principal() made that
-- false: auth_pre_request() refuses a withdrawn token or identity on every PostgREST request, and
-- every check a machine's grant opens is a database check reached through PostgREST.
--
-- The allow-list gains schema:manage, proposal:create and archive:manage. Every other permission
-- is refused with the reason that holds for it: device writes and quarantine decisions are made by
-- people; cell:manage and gateway:manage would only let a machine decide proposals, which is a
-- person's act; access control stays with people; no check a machine passes consults link:manage
-- or gitops:manage.
--
-- audit_trail:read opens the trail's asset lane to a machine: the policy named three roles, so
-- a machine granted the permission read no trail rows. The security lane stays Administrator and
-- Auditor. Nothing moves for a person: those three roles are the ones that hold the permission.
--
-- may_decide_proposal() is rewritten with the same five arms and comments that say what the cell
-- and gateway lanes check: the permission, where the tables' own policies name the role pair.
-- The two agree for a person and no machine can reach them. service_token_max_days()'s COMMENT
-- stops saying tokens cannot be revoked.
--
-- Both functions are 0001's otherwise, recorded in check-docs-drift.mjs's
-- INTENDED_REDECLARATIONS, and fold into it at the next squash.
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. create_machine_principal(): the allow-list, and a reason for each refusal
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text DEFAULT NULL::text) RETURNS TABLE(principal_id uuid, permissions text[])
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    -- Machines propose, people decide. An allow-list, so a permission added later is refused
    -- until somebody decides a machine may hold it. check-docs-drift.mjs asserts the Access
    -- Control page offers exactly this list (11e) and that each entry reaches a machine (11f).
    c_allowed CONSTANT text[] := ARRAY['telemetry:read', 'quarantine:view', 'audit_trail:read',
                                       'archive:manage', 'proposal:create', 'schema:manage'];
    v_id      uuid;
    v_name    text := btrim(p_name);
    v_purpose text := nullif(btrim(coalesce(p_purpose, '')), '');
    v_refused text;
    v_ids     uuid[];
BEGIN
    -- ADMINISTRATOR ONLY. Creating an identity that can reach the stack is an access-control act,
    -- and `authz:manage` is granted to Administrator alone.
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'insufficient privileges to create a machine principal'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_name IS NULL OR length(v_name) = 0 THEN
        RAISE EXCEPTION
            'create_machine_principal: a name is required. An identity nobody can name on the '
            'Access Control page is one nobody can decide to keep or remove.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF length(v_name) > 80 THEN
        RAISE EXCEPTION 'create_machine_principal: p_name must be 80 characters or fewer'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_purpose IS NOT NULL AND length(v_purpose) > 500 THEN
        RAISE EXCEPTION 'create_machine_principal: p_purpose must be 500 characters or fewer'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Checked before the identity exists, so the refusal names the name and not a constraint.
    IF EXISTS (SELECT 1 FROM public.machine_principals mp WHERE lower(btrim(mp.name)) = lower(v_name)) THEN
        RAISE EXCEPTION
            'create_machine_principal: an identity named "%" already exists. Names are unique '
            'ignoring case, so the page never lists two rows a reader cannot tell apart.', v_name
            USING ERRCODE = 'unique_violation';
    END IF;

    IF p_permissions IS NULL OR cardinality(p_permissions) = 0 THEN
        RAISE EXCEPTION
            'create_machine_principal: at least one permission is required. A principal with no '
            'authority can still be named by a token, which makes it a credential that looks '
            'harmless and is not accounted for anywhere.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Each refused permission once, in the order asked, with the rule that refuses it.
    SELECT string_agg(format('%s (%s)', r.perm, CASE
               WHEN NOT EXISTS (SELECT 1 FROM public.permissions p WHERE p.name = r.perm)
                 THEN 'no such permission'
               WHEN r.perm = 'device:manage'
                 THEN 'device writes are made by people'
               WHEN r.perm IN ('quarantine:approve', 'quarantine:reject')
                 THEN 'quarantine decisions are made by people'
               WHEN r.perm IN ('cell:manage', 'gateway:manage')
                 THEN 'for a machine it would only decide change proposals, and deciding is a '
                      'person''s act: machines propose, people decide'
               WHEN r.perm = 'authz:manage'
                 THEN 'access control stays with people'
               WHEN r.perm IN ('link:manage', 'gitops:manage')
                 THEN 'no check a machine passes consults it, so the grant would do nothing'
               ELSE 'nobody has decided that a machine may hold it'
             END), '; ' ORDER BY r.first_at)
      INTO v_refused
      FROM (SELECT u.x AS perm, min(u.o) AS first_at
              FROM unnest(p_permissions) WITH ORDINALITY AS u(x, o)
             WHERE u.x <> ALL (c_allowed)
             GROUP BY u.x) AS r;

    IF v_refused IS NOT NULL THEN
        RAISE EXCEPTION
            'create_machine_principal: not grantable to a machine identity: %. Allowed: %.',
            v_refused, array_to_string(c_allowed, ', ')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- BY NAME, not by a hardcoded id.
    SELECT array_agg(p.id) INTO v_ids
      FROM public.permissions p
     WHERE p.name = ANY (p_permissions);

    IF v_ids IS NULL OR cardinality(v_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_permissions))) THEN
        RAISE EXCEPTION 'create_machine_principal: one of % does not exist in public.permissions',
            array_to_string(p_permissions, ', ')
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    v_id := gen_random_uuid();

    -- ONLY `id`. This is what makes the account unable to sign in, and it is a property of the
    -- INSERT rather than of anybody's intent -- which is also what makes is_machine_principal()
    -- true for it, and therefore what routes it through principal_permissions from here on.
    INSERT INTO auth.users (id) VALUES (v_id);

    -- BY CONSTRAINT NAME, not by column list: `principal_id` is also this function's first output
    -- column, and PL/pgSQL refuses the column list as ambiguous.
    INSERT INTO public.principal_permissions (principal_id, permission_id)
    SELECT v_id, unnest(v_ids)
    ON CONFLICT ON CONSTRAINT principal_permissions_pkey DO NOTHING;

    -- The name, in the same transaction: an identity and its name either both exist or neither
    -- does.
    INSERT INTO public.machine_principals (principal_id, name, purpose, created_by)
    VALUES (v_id, v_name, v_purpose, auth.uid());

    -- ATTRIBUTED TO A PERSON: this is called by an Administrator with a session, so `auth.uid()` is
    -- the attribution rather than a claim.
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'service_principals',
        v_id,
        'INSERT',
        NULL,
        jsonb_build_object(
            'name',        v_name,
            'purpose',     v_purpose,
            'permissions', to_jsonb(p_permissions),
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

ALTER FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text) OWNER TO postgres;

COMMENT ON FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text) IS 'Create a machine identity that cannot sign in, holding permissions of its own and a name the Access Control page lists it by. Administrator only. Machines propose, people decide: allows telemetry:read, quarantine:view, audit_trail:read, archive:manage, proposal:create and schema:manage, and refuses every other permission with its reason -- device writes, quarantine decisions, deciding proposals and access control are made by people, and no check a machine passes consults link:manage or gitops:manage. revoke_service_token() and revoke_service_principal() withdraw what it creates at PostgREST, where every check those grants open is reached. The name is unique ignoring case. One form only: an overload whose extra arguments default makes every RPC call ambiguous.';

-- 0001's ACL, restated; CREATE OR REPLACE keeps it either way.
REVOKE ALL ON FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. audit_trail:read opens the asset lane; the security lane is untouched
-- ---------------------------------------------------------------------------------------------
-- has_role() for a person, has_authority() for a machine, which holds permissions and never a
-- role. The roles the first arm names are the roles that hold the permission, so for a person
-- the second arm adds nobody.
DROP POLICY IF EXISTS audit_trail_select_asset ON public.audit_trail;
CREATE POLICY audit_trail_select_asset ON public.audit_trail FOR SELECT TO authenticated USING (((audit_domain = 'asset'::text) AND (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]) OR public.has_authority(ARRAY['audit_trail:read'::text]))));

-- ---------------------------------------------------------------------------------------------
-- 3. may_decide_proposal(): the same arms, and comments that say what they check
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.may_decide_proposal(p_entity_type text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE p_entity_type
    -- The role pair the devices, device_nameplate and areas write policies name.
    WHEN 'devices'          THEN public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
    WHEN 'device_nameplate' THEN public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
    WHEN 'areas'            THEN public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])

    -- THE PERMISSION, where the cells and gateways write policies name the role pair. For a
    -- person the two agree: the pair are the only roles holding cell:manage and gateway:manage.
    -- No machine reaches these arms, because create_machine_principal() refuses both grants:
    -- machines propose, people decide. check-docs-drift.mjs (11f) holds all three facts.
    WHEN 'cells'            THEN public.has_authority(ARRAY['cell:manage'])
    WHEN 'gateways'         THEN public.has_authority(ARRAY['gateway:manage'])

    -- Withdrawn lanes decide nothing: schemas, and the three link lanes. proposable_columns() is
    -- empty for each, so nothing new can be filed in them either.
    ELSE false
  END
$$;

ALTER FUNCTION public.may_decide_proposal(p_entity_type text) OWNER TO postgres;

COMMENT ON FUNCTION public.may_decide_proposal(p_entity_type text) IS 'Who may approve or reject a proposal in this lane. The device lanes and areas resolve the role pair (Administrator, Shopfloor_Manager) their tables'' write policies name. Cells and gateways resolve cell:manage and gateway:manage, where their tables'' policies name the same pair: the two agree for a person, because the pair are the only roles holding those grants, and no machine can hold either, because create_machine_principal() refuses them. An unknown or withdrawn lane -- schemas, and the three link lanes -- is decidable by nobody.';

REVOKE ALL ON FUNCTION public.may_decide_proposal(p_entity_type text) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.may_decide_proposal(p_entity_type text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. service_token_max_days(): tokens are revocable, and the expiry still bounds every service
-- ---------------------------------------------------------------------------------------------

COMMENT ON FUNCTION public.service_token_max_days() IS 'The longest life a service-principal token may be recorded with (90 days). Mirrored by the --days ceiling in scripts/mint-mcp-token.mjs. revoke_service_token() and revoke_service_principal() withdraw a token at PostgREST; storage, realtime, the edge runtime and Studio verify the signature alone, so the expiry is the only bound that reaches every service.';

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
    v_def      text;
    v_allowed  text[];
    v_perm     text;
    v_arm      text[];
    v_qual     text;
    v_cmd      "char";
    v_roles    oid[];
    v_fn       regprocedure;
BEGIN
    -- The allow-list, read back from the function that runs.
    v_def := pg_get_functiondef('public.create_machine_principal(text, text[], text)'::regprocedure);
    SELECT array_agg(m[1] ORDER BY m[1]) INTO v_allowed
      FROM regexp_matches(
             substring(v_def FROM 'c_allowed CONSTANT text\[\] := ARRAY\[([^]]*)\]'),
             '''([^'']+)''', 'g') AS m;
    IF v_allowed IS DISTINCT FROM ARRAY['archive:manage', 'audit_trail:read', 'proposal:create',
                                        'quarantine:view', 'schema:manage', 'telemetry:read'] THEN
        RAISE EXCEPTION '0013 self-check: create_machine_principal() allows %, not the six this file decided.',
            coalesce(array_to_string(v_allowed, ', '), '(nothing it could read)');
    END IF;

    -- Every permission this file refuses by name has its reason in the body.
    FOREACH v_perm IN ARRAY ARRAY['device:manage', 'quarantine:approve', 'quarantine:reject',
                                  'cell:manage', 'gateway:manage', 'authz:manage',
                                  'link:manage', 'gitops:manage'] LOOP
        IF position(quote_literal(v_perm) IN v_def) = 0 THEN
            RAISE EXCEPTION '0013 self-check: create_machine_principal() gives no reason for refusing %.', v_perm;
        END IF;
    END LOOP;

    -- The premise that stopped being true is said nowhere this file restated.
    FOREACH v_fn IN ARRAY ARRAY['public.create_machine_principal(text, text[], text)'::regprocedure,
                                'public.service_token_max_days()'::regprocedure] LOOP
        IF coalesce(obj_description(v_fn::oid, 'pg_proc'), '') = ''
           OR obj_description(v_fn::oid, 'pg_proc') ILIKE '%cannot be revoked%' THEN
            RAISE EXCEPTION '0013 self-check: the COMMENT on % is missing or still says tokens cannot be revoked.', v_fn;
        END IF;
    END LOOP;
    IF v_def ILIKE '%cannot be revoked%' OR v_def ILIKE '%unrevocable%' THEN
        RAISE EXCEPTION '0013 self-check: create_machine_principal() still says a token cannot be revoked.';
    END IF;
    IF coalesce(obj_description('public.may_decide_proposal(text)'::regprocedure::oid, 'pg_proc'), '')
       NOT LIKE '%create_machine_principal() refuses%' THEN
        RAISE EXCEPTION '0013 self-check: the COMMENT on may_decide_proposal() does not say why no machine reaches the cell and gateway lanes.';
    END IF;

    -- The asset lane admits the permission as well as the three roles; the security lane does not.
    SELECT pg_get_expr(pol.polqual, pol.polrelid), pol.polcmd, pol.polroles
      INTO v_qual, v_cmd, v_roles
      FROM pg_policy pol
     WHERE pol.polrelid = 'public.audit_trail'::regclass
       AND pol.polname = 'audit_trail_select_asset'
       AND pol.polpermissive;
    IF v_qual IS NULL
       OR v_cmd <> 'r'
       OR v_roles IS DISTINCT FROM ARRAY['authenticated'::regrole::oid]
       OR v_qual NOT LIKE '%audit_domain = ''asset''::text%'
       OR v_qual NOT LIKE '%has_role(ARRAY[''Administrator''::text, ''Shopfloor_Manager''::text, ''Auditor''::text])%'
       OR v_qual NOT LIKE '%has_authority(ARRAY[''audit_trail:read''::text])%' THEN
        RAISE EXCEPTION '0013 self-check: audit_trail_select_asset is %, not the asset lane for the three roles or audit_trail:read.',
            coalesce(v_qual, '(missing)');
    END IF;

    SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO v_qual
      FROM pg_policy pol
     WHERE pol.polrelid = 'public.audit_trail'::regclass
       AND pol.polname = 'audit_trail_select_security';
    IF v_qual IS NULL OR v_qual LIKE '%has_authority%' THEN
        RAISE EXCEPTION '0013 self-check: audit_trail_select_security is %; the security lane is Administrator and Auditor only.',
            coalesce(v_qual, '(missing)');
    END IF;

    -- may_decide_proposal() is a copy with new comments, and an arm lost in a copy is silent.
    v_def := pg_get_functiondef('public.may_decide_proposal(text)'::regprocedure);
    FOREACH v_arm SLICE 1 IN ARRAY ARRAY[
        ARRAY['devices',          'has_role\(ARRAY\[''Administrator'', ''Shopfloor_Manager''\]\)'],
        ARRAY['device_nameplate', 'has_role\(ARRAY\[''Administrator'', ''Shopfloor_Manager''\]\)'],
        ARRAY['areas',            'has_role\(ARRAY\[''Administrator'', ''Shopfloor_Manager''\]\)'],
        ARRAY['cells',            'has_authority\(ARRAY\[''cell:manage''\]\)'],
        ARRAY['gateways',         'has_authority\(ARRAY\[''gateway:manage''\]\)']
    ] LOOP
        IF v_def !~ ('WHEN ''' || v_arm[1] || '''\s+THEN public\.' || v_arm[2]) THEN
            RAISE EXCEPTION '0013 self-check: may_decide_proposal() lost its % arm.', v_arm[1];
        END IF;
    END LOOP;
    IF v_def !~ 'ELSE false' THEN
        RAISE EXCEPTION '0013 self-check: may_decide_proposal() no longer refuses an unknown lane.';
    END IF;

    -- The ACL this file restated.
    FOREACH v_fn IN ARRAY ARRAY['public.create_machine_principal(text, text[], text)'::regprocedure,
                                'public.may_decide_proposal(text)'::regprocedure] LOOP
        IF has_function_privilege('anon', v_fn::oid, 'EXECUTE')
           OR NOT has_function_privilege('authenticated', v_fn::oid, 'EXECUTE') THEN
            RAISE EXCEPTION '0013 self-check: % is executable by anon, or not by authenticated.', v_fn;
        END IF;
    END LOOP;
END
$check$;
