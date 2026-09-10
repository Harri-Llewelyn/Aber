-- =================================================================================================
-- 0091 :: A DRAFT CAN BE DISCARDED
-- =================================================================================================
--
-- One draft may exist per lineage, and the only exit from a draft nobody wanted was to publish
-- it, which archives the parent and repoints every attached device.
--
-- An RPC and not the DELETE policy that already exists: `devices.schema_id` is ON DELETE SET
-- NULL and `device_submodels.schema_id` is ON DELETE CASCADE, so deleting an active schema
-- silently detaches every device bound to it. This function refuses anything whose status is
-- not `draft` and reports how many device attachments the discard removed (a draft may
-- legitimately have devices attached for trial). The parent is untouched, and the DELETE writes
-- its own `digital_thread` row through the audit trigger.
-- =================================================================================================

CREATE OR REPLACE FUNCTION public.discard_schema_draft(p_schema_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_draft      public.schemas%ROWTYPE;
    v_detached   integer := 0;
    v_actor      uuid := auth.uid();
BEGIN
    -- THE SAME GATE `fork_schema()` AND `publish_schema_version()` CARRY SINCE 0087, and for the
    -- same reason: a SECURITY DEFINER function bypasses RLS entirely, so its own check is the only
    -- one there is. `schema:manage` rather than a role pair, so it cannot drift from the policy.
    IF NOT public.has_authority(ARRAY['schema:manage']) THEN
        RAISE EXCEPTION 'insufficient privileges to discard a schema draft'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_draft FROM public.schemas WHERE id = p_schema_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'schema % not found', p_schema_id USING ERRCODE = 'no_data_found';
    END IF;

    -- THE WHOLE REASON THIS FUNCTION EXISTS. An active or archived schema is part of the record of
    -- what devices were judged against, and deleting one would detach every device bound to it
    -- through two different foreign keys, silently.
    IF v_draft.status <> 'draft' THEN
        RAISE EXCEPTION
            'schema "%" is %, not a draft; only a draft can be discarded',
            v_draft.schema_name, v_draft.status
            USING ERRCODE = 'check_violation';
    END IF;

    -- Counted BEFORE the delete, because the CASCADE is what removes them and it reports nothing.
    -- A draft can be attached to a machine to try it out -- publish_schema_version() relies on
    -- that being possible -- so this is a real number rather than always zero.
    SELECT count(*) INTO v_detached
      FROM public.device_submodels WHERE schema_id = p_schema_id;

    -- Attributes the audit row this DELETE fires to the person who asked for it. SET LOCAL, so it
    -- is discarded at COMMIT and cannot bleed into the connection's next user.
    PERFORM set_config('acs_cymru.actor_id', v_actor::text, true);

    DELETE FROM public.schemas WHERE id = p_schema_id;

    RETURN jsonb_build_object(
        'discarded_schema_id',   p_schema_id,
        'discarded_schema_name', v_draft.schema_name,
        'version',               v_draft.version,
        'parent_schema_id',      v_draft.parent_schema_id,
        'devices_detached',      v_detached
    );
END;
$$;

COMMENT ON FUNCTION public.discard_schema_draft(uuid) IS 'Delete a draft schema version, returning it to the state before the fork. Refuses anything that is not a draft: devices.schema_id is ON DELETE SET NULL and device_submodels.schema_id is ON DELETE CASCADE, so deleting an active schema would silently detach every device bound to it. Returns the count of draft attachments the cascade removed.';

REVOKE ALL ON FUNCTION public.discard_schema_draft(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.discard_schema_draft(uuid) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- Self-check
-- -------------------------------------------------------------------------------------------------
DO $$
BEGIN
    -- The grant, asserted rather than assumed: a function `authenticated` cannot execute is a
    -- button that fails for everybody, and the failure looks like a permissions bug in the UI.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'discard_schema_draft'
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) THEN
        RAISE EXCEPTION '0091 self-check failed: authenticated cannot execute discard_schema_draft()';
    END IF;

    RAISE NOTICE '0091: a draft can be discarded, and only a draft.';
END $$;
