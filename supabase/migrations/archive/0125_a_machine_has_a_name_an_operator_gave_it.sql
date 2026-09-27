-- 0125: a machine principal has a name an operator gave it.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- `create_machine_principal()` (0080) makes an `auth.users` row holding only an id, which is what
-- keeps it unable to sign in, and records the permissions and a note in an append-only audit row.
-- Nothing it writes is a name. The Access Control page names the three identities a migration
-- pinned from a registry in frontend source and labels every other one "Undocumented principal",
-- which is the right word for a fixture a suite left behind and the wrong word for an identity an
-- Administrator created on purpose a minute ago.
--
-- The name lives in a table of its own, `machine_principals`, keyed to the `auth.users` row. Not
-- in `auth.users.raw_user_meta_data`: 0116 relies on that column being empty on every account this
-- stack creates, and GoTrue owns the column. Not in the audit row: that is append-only and records
-- what was asked for at the time, which is a different fact from what the identity is for now.
--
-- `create_machine_principal()` takes the name and purpose in the same transaction as the identity,
-- so a principal cannot exist without a name unless a migration pinned it. The two-argument form
-- is DROPPED rather than overloaded: PostgREST resolves an RPC by the names in the request body,
-- and an overload whose extra arguments all default makes every old-shape call ambiguous. The
-- signature change is recorded in check-docs-drift.mjs's INTENDED_REDECLARATIONS.
--
-- The allow-list of grantable permissions is unchanged and still lives in the function: the page
-- offers exactly that list, and check-docs-drift.mjs asserts the two agree.

SET search_path TO public;

-- -------------------------------------------------------------------------------------------------
-- 1. The table
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.machine_principals (
    principal_id uuid NOT NULL PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
    name         text NOT NULL,
    purpose      text,
    created_by   uuid REFERENCES auth.users (id) ON DELETE SET NULL,
    created_at   timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT machine_principals_name_bounded CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    CONSTRAINT machine_principals_purpose_bounded CHECK (purpose IS NULL OR length(purpose) <= 500)
);

-- One name per identity, ignoring case: two rows reading `Line 4 SCADA reader` and `line 4 scada
-- reader` would be the same identity to anyone reading the page.
CREATE UNIQUE INDEX IF NOT EXISTS machine_principals_name_key
    ON public.machine_principals (lower(btrim(name)));

COMMENT ON TABLE public.machine_principals IS
  'The name and purpose an Administrator gave a machine identity when creating it from the Access '
  'Control page. One row per runtime-created principal; the three identities a migration pinned '
  'have no row and are named by the dashboard''s own registry. Written only by '
  'create_machine_principal(), in the same transaction as the auth.users row it describes.';

COMMENT ON COLUMN public.machine_principals.name IS
  'What the page lists the identity as. Unique ignoring case and surrounding whitespace, 1 to 80 '
  'characters.';
COMMENT ON COLUMN public.machine_principals.purpose IS
  'Why the identity exists, in the Administrator''s words, up to 500 characters. Shown beside the '
  'name so an unfamiliar principal is safe to leave alone or safe to remove.';
COMMENT ON COLUMN public.machine_principals.created_by IS
  'The Administrator whose session created the identity. NULL once that account is deleted; the '
  'digital thread row keeps the attribution.';

ALTER TABLE public.machine_principals ENABLE ROW LEVEL SECURITY;

-- Administrator and Auditor, as list_user_accounts() (0116): a name here labels digital-thread
-- rows both roles may read, and holds nothing a token could be derived from. No write policy; the
-- function below is the only write path.
DROP POLICY IF EXISTS machine_principals_select_admin_or_auditor ON public.machine_principals;
CREATE POLICY machine_principals_select_admin_or_auditor ON public.machine_principals
    FOR SELECT TO authenticated
    USING (public.has_role(ARRAY['Administrator'::text, 'Auditor'::text]));

GRANT SELECT ON TABLE public.machine_principals TO authenticated;
GRANT ALL    ON TABLE public.machine_principals TO service_role;

-- -------------------------------------------------------------------------------------------------
-- 2. create_machine_principal() takes a name
-- -------------------------------------------------------------------------------------------------
-- 0080 recreates the two-argument form on every boot, so this DROP runs once per boot.
DROP FUNCTION IF EXISTS public.create_machine_principal(text[], text);

CREATE OR REPLACE FUNCTION public.create_machine_principal(
    p_name        text,
    p_permissions text[],
    p_purpose     text DEFAULT NULL::text
)
    -- The 0080 return shape, unchanged: the caller supplied the name and does not need it back,
    -- and a changed return type cannot ship under a function name an earlier file replays.
    RETURNS TABLE(principal_id uuid, permissions text[])
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    -- Read-only permissions only, as an allow-list so a permission added later is refused until
    -- somebody decides otherwise: a machine identity holding a write permission becomes an
    -- unrevocable write credential the moment a token is signed for it. check-docs-drift.mjs
    -- asserts the Access Control page offers exactly this list.
    c_allowed CONSTANT text[] := ARRAY['telemetry:read', 'quarantine:view', 'digital_thread:read'];
    v_id      uuid;
    v_name    text := btrim(p_name);
    v_purpose text := nullif(btrim(coalesce(p_purpose, '')), '');
    v_bad     text[];
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
    -- column, and PL/pgSQL refuses the column list as ambiguous. 0080 spelled it the other way and
    -- nothing found out, because no page called the function until this file.
    INSERT INTO public.principal_permissions (principal_id, permission_id)
    SELECT v_id, unnest(v_ids)
    ON CONFLICT ON CONSTRAINT principal_permissions_pkey DO NOTHING;

    -- The name, in the same transaction: an identity and its name either both exist or neither
    -- does.
    INSERT INTO public.machine_principals (principal_id, name, purpose, created_by)
    VALUES (v_id, v_name, v_purpose, auth.uid());

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

COMMENT ON FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text) IS
  'Create a machine identity that cannot sign in, holding its own read-only permissions and a name '
  'the Access Control page lists it by. Administrator only. Refuses anything but telemetry:read, '
  'quarantine:view and digital_thread:read: once a token is signed for a principal it cannot be '
  'revoked. The name is unique ignoring case. Replaces the two-argument form of 0080, dropped '
  'because an overload whose extra arguments default makes every RPC call ambiguous.';

REVOKE ALL ON FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text) FROM PUBLIC;
GRANT ALL  ON FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text) TO authenticated;
GRANT ALL  ON FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text) TO service_role;

-- -------------------------------------------------------------------------------------------------
-- 3. Self-check
-- -------------------------------------------------------------------------------------------------
DO $$
DECLARE
    v_old integer;
    v_new integer;
BEGIN
    -- (a) Exactly one declaration, the three-argument one. Two would make the RPC ambiguous.
    SELECT count(*) INTO v_old
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'create_machine_principal'
       AND pg_get_function_identity_arguments(p.oid) = 'p_permissions text[], p_note text';
    SELECT count(*) INTO v_new
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'create_machine_principal';

    IF v_old <> 0 OR v_new <> 1 THEN
        RAISE EXCEPTION
            '0125 self-check: create_machine_principal has % declaration(s), % of them the 0080 '
            'form. A second declaration makes every RPC call ambiguous at PostgREST.', v_new, v_old;
    END IF;

    -- (b) The table refuses a nameless row on its own, not only through the function.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.machine_principals'::regclass
           AND conname = 'machine_principals_name_bounded'
    ) THEN
        RAISE EXCEPTION '0125 self-check: machine_principals_name_bounded is missing.';
    END IF;

    RAISE NOTICE
        '0125 self-check passed: create_machine_principal takes a name, and machine_principals '
        'refuses an empty one.';
END $$;
