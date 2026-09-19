-- 0126: a machine principal can be described again.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- 0125 gave a principal created from the Access Control page a name and a purpose, and gave the
-- table no write policy: the function that creates the identity is the only path that writes it.
-- What that left out is the ordinary case of a purpose that was right when it was typed and is
-- not now -- the report was renamed, the client moved lines. One RPC adds that path and keeps the
-- table closed: Administrator only, machine principals only, rows that exist only (the three
-- identities a migration pinned are named by the dashboard's registry and have no row to edit),
-- and every change is an audit row carrying what it was and what it became.
--
-- Permissions are not editable here, deliberately. Widening what a principal holds is a change of
-- authority that a token already signed would carry at once; that is a new principal, not an edit.

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.describe_machine_principal(
    p_principal_id uuid,
    p_name         text,
    p_purpose      text DEFAULT NULL::text
)
    RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_actor   uuid;
    v_name    text := btrim(p_name);
    v_purpose text := nullif(btrim(coalesce(p_purpose, '')), '');
    v_old     public.machine_principals%ROWTYPE;
    v_id      bigint;
BEGIN
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'insufficient privileges to describe a machine principal'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    v_actor := auth.uid();
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'describe_machine_principal: no session, so this could not be attributed'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_principal_id IS NULL THEN
        RAISE EXCEPTION 'describe_machine_principal: p_principal_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF v_name IS NULL OR length(v_name) = 0 THEN
        RAISE EXCEPTION 'describe_machine_principal: a name is required'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF length(v_name) > 80 THEN
        RAISE EXCEPTION 'describe_machine_principal: p_name must be 80 characters or fewer'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_purpose IS NOT NULL AND length(v_purpose) > 500 THEN
        RAISE EXCEPTION 'describe_machine_principal: p_purpose must be 500 characters or fewer'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- A ROW THAT EXISTS. A pinned identity has none, and the message says where its name lives
    -- rather than "not found", which would send a reader looking for a row that was never meant
    -- to be there. FOR UPDATE, so two edits of one row serialise.
    SELECT * INTO v_old
      FROM public.machine_principals mp
     WHERE mp.principal_id = p_principal_id
       FOR UPDATE;

    IF NOT FOUND THEN
        IF public.is_machine_principal(p_principal_id) THEN
            RAISE EXCEPTION
                'describe_machine_principal: % has no name row. It was pinned by a migration or '
                'seeded by a suite, and the dashboard names it from its own registry '
                '(frontend/src/utils/serviceIdentities.js).', p_principal_id
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
        RAISE EXCEPTION
            'describe_machine_principal: % is not a machine principal. It either does not exist or '
            'it can sign in.', p_principal_id
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Unique ignoring case, excluding the row being renamed: keeping one's own name is not a
    -- collision.
    IF EXISTS (
        SELECT 1 FROM public.machine_principals mp
         WHERE lower(btrim(mp.name)) = lower(v_name)
           AND mp.principal_id <> p_principal_id
    ) THEN
        RAISE EXCEPTION
            'describe_machine_principal: an identity named "%" already exists. Names are unique '
            'ignoring case, so the page never lists two rows a reader cannot tell apart.', v_name
            USING ERRCODE = 'unique_violation';
    END IF;

    -- NOTHING TO SAY IS NOT AN EVENT. An unchanged save writes no row and returns NULL, so the
    -- thread records decisions rather than clicks.
    IF v_old.name = v_name AND v_old.purpose IS NOT DISTINCT FROM v_purpose THEN
        RETURN NULL;
    END IF;

    UPDATE public.machine_principals
       SET name = v_name, purpose = v_purpose
     WHERE principal_id = p_principal_id;

    INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'service_principals',
        p_principal_id,
        'PRINCIPAL_DESCRIBED',
        jsonb_build_object('name', v_old.name, 'purpose', v_old.purpose),
        jsonb_build_object('name', v_name,     'purpose', v_purpose),
        v_actor,
        'user',
        txid_current(),
        now()
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.describe_machine_principal(p_principal_id uuid, p_name text, p_purpose text) IS
  'Rename a machine principal created from the Access Control page, or change its purpose. '
  'Administrator only; the only write path to machine_principals after creation. Refuses an '
  'identity with no name row (the pinned ones, named by the dashboard''s registry) and a name '
  'another row holds. Records PRINCIPAL_DESCRIBED with the old and new values, and returns that '
  'row''s id, or NULL when nothing changed. Permissions are not editable: a wider grant is a new '
  'principal.';

REVOKE ALL ON FUNCTION public.describe_machine_principal(p_principal_id uuid, p_name text, p_purpose text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.describe_machine_principal(p_principal_id uuid, p_name text, p_purpose text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.describe_machine_principal(p_principal_id uuid, p_name text, p_purpose text) TO service_role;

-- Self-check: the function is reachable by authenticated and not by anon, which is the property
-- the sweep in 0001 would otherwise leave open on a first boot.
DO $$
BEGIN
    IF has_function_privilege('anon', 'public.describe_machine_principal(uuid, text, text)', 'EXECUTE') THEN
        RAISE EXCEPTION '0126 self-check: anon may execute describe_machine_principal().';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.describe_machine_principal(uuid, text, text)', 'EXECUTE') THEN
        RAISE EXCEPTION '0126 self-check: authenticated may not execute describe_machine_principal().';
    END IF;
    RAISE NOTICE '0126 self-check passed: describe_machine_principal() is granted to authenticated and refused to anon.';
END $$;
