-- 0087: the schema RPCs stop being the way around the policy 0069 installed.
--
-- 0069 withdrew `schema:manage` from `Shopfloor_Manager` and narrowed the write policies on
-- `public.schemas` to Administrator, but `fork_schema()` and `publish_schema_version()` are
-- SECURITY DEFINER, do not consult those policies, and went on checking
-- `has_role(ARRAY['Administrator', 'Shopfloor_Manager'])`. Measured: a Shopfloor_Manager's direct
-- UPDATE was refused and the RPC performed it, archiving the predecessor and repointing every
-- attached device.
--
-- `has_authority(ARRAY['schema:manage'])` rather than `has_role(ARRAY['Administrator'])`, so the
-- gate is the permission that was withdrawn rather than a second spelling a later role change can
-- put out of step again. It fails closed for a machine principal.
--
-- Reading is unchanged. The bodies are the baseline's, copied verbatim except for the gate, and
-- both are recorded in INTENDED_REDECLARATIONS in scripts/check-docs-drift.mjs.

-- -------------------------------------------------------------------------------------------------
-- 1. Forking a schema is a schema-management act
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fork_schema(parent_schema_id uuid, change_description text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  -- Copied out of the parameters immediately: both are named after columns of `schemas`, and
  -- plpgsql would raise "column reference is ambiguous" on the first `WHERE id = parent_schema_id`.
  v_parent_id  UUID := parent_schema_id;
  v_change     TEXT := NULLIF(btrim(COALESCE(change_description, '')), '');
  parent       public.schemas%ROWTYPE;
  child        public.schemas%ROWTYPE;
  v_base       TEXT;
  v_next       INTEGER;
  v_name       TEXT;
  v_suffix     INTEGER := 1;
BEGIN
  -- Fail closed, before anything else observable happens. `has_authority` rather than a role name,
  -- so the gate is the permission 0069 withdrew.
  IF NOT public.has_authority(ARRAY['schema:manage']) THEN
    RAISE EXCEPTION 'insufficient privileges to version a schema'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_parent_id IS NULL THEN
    RAISE EXCEPTION 'parent_schema_id is required' USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- FOR UPDATE, not a bare SELECT: two operators forking the same schema at the same moment would
  -- otherwise both read version N and both insert N+1. The partial unique index catches the
  -- collision either way, but the lock turns a confusing constraint violation into a wait.
  SELECT * INTO parent FROM public.schemas WHERE id = v_parent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'schema % not found', v_parent_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Only the head of a lineage may be forked. Forking an archived version would produce a second
  -- claimant to the same version number, and forking a draft would branch something that has never
  -- been in force -- edit the draft instead, which is what a draft is for.
  IF parent.status <> 'active' THEN
    RAISE EXCEPTION 'only an active schema can be versioned; "%" is %', parent.schema_name, parent.status
      USING ERRCODE = 'check_violation',
            HINT = 'Fork the active version of this lineage.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.schemas s
              WHERE s.parent_schema_id = v_parent_id AND s.status = 'draft') THEN
    RAISE EXCEPTION 'a draft version of "%" already exists; publish or delete it first', parent.schema_name
      USING ERRCODE = 'unique_violation';
  END IF;

  v_next := parent.version + 1;
  v_base := public.schema_version_base_name(parent.schema_name);
  v_name := v_base || '_v' || v_next;

  -- A discarded draft leaves its name behind, so the obvious one can already be taken. Suffixing
  -- beats failing: the operator asked for a version, not for a naming negotiation.
  WHILE EXISTS (SELECT 1 FROM public.schemas s WHERE s.schema_name = v_name) LOOP
    v_suffix := v_suffix + 1;
    v_name := v_base || '_v' || v_next || '_' || v_suffix;
  END LOOP;

  -- The metric links are the definition: a schema's membership of the catalog lives in
  -- `schema_definition.properties` / `.required`, which deviceTags.js and validate.py both read.
  INSERT INTO public.schemas (
    schema_name, description, schema_definition,
    semantic_id, semantic_id_type,
    version, parent_schema_id, status, change_description
  ) VALUES (
    v_name, parent.description, parent.schema_definition,
    parent.semantic_id, parent.semantic_id_type,
    v_next, parent.id, 'draft', v_change
  )
  RETURNING * INTO child;

  RETURN to_jsonb(child);
END;
$$;

-- -------------------------------------------------------------------------------------------------
-- 2. So is publishing one, and this is the one with the reach
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.publish_schema_version(draft_schema_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_draft_id       UUID := draft_schema_id;
  draft            public.schemas%ROWTYPE;
  parent           public.schemas%ROWTYPE;
  published        public.schemas%ROWTYPE;
  v_submodels      INTEGER := 0;
  v_legacy         INTEGER := 0;
  v_merged         INTEGER := 0;
BEGIN
  -- NARROWED BY 0087. This admitted the pair while the RLS write policies it is the transactional
  -- form of admitted Administrator alone, and being SECURITY DEFINER it did not consult them --
  -- so it was the way around 0069 rather than an application of it.
  IF NOT public.has_authority(ARRAY['schema:manage']) THEN
    RAISE EXCEPTION 'insufficient privileges to publish a schema version'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_draft_id IS NULL THEN
    RAISE EXCEPTION 'draft_schema_id is required' USING ERRCODE = 'null_value_not_allowed';
  END IF;

  SELECT * INTO draft FROM public.schemas WHERE id = v_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'schema % not found', v_draft_id USING ERRCODE = 'no_data_found';
  END IF;

  IF draft.status <> 'draft' THEN
    RAISE EXCEPTION 'schema "%" is %, not a draft', draft.schema_name, draft.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF draft.parent_schema_id IS NOT NULL THEN
    SELECT * INTO parent FROM public.schemas WHERE id = draft.parent_schema_id FOR UPDATE;

    -- Rebind before archiving, so no window exists in which a device points at an archived schema. A
    -- device already carrying both versions as submodels would collide on `uq_device_submodels` when
    -- repointed, so the redundant old-version rows are dropped first.
    DELETE FROM public.device_submodels old_link
     WHERE old_link.schema_id = parent.id
       AND EXISTS (
         SELECT 1 FROM public.device_submodels new_link
          WHERE new_link.device_id = old_link.device_id
            AND new_link.schema_id = draft.id
       );
    GET DIAGNOSTICS v_merged = ROW_COUNT;

    UPDATE public.device_submodels SET schema_id = draft.id WHERE schema_id = parent.id;
    GET DIAGNOSTICS v_submodels = ROW_COUNT;

    -- The legacy 1:1 pointer moves too: `devices.schema_id` is the fallback arm of the
    -- `device_schemas` view. This UPDATE fires `log_digital_thread_event()`, so the rebinding lands in
    -- the audit trail per device.
    UPDATE public.devices SET schema_id = draft.id WHERE schema_id = parent.id;
    GET DIAGNOSTICS v_legacy = ROW_COUNT;

    IF parent.status = 'active' THEN
      UPDATE public.schemas SET status = 'archived' WHERE id = parent.id;
    END IF;
  END IF;

  UPDATE public.schemas SET status = 'active' WHERE id = draft.id RETURNING * INTO published;

  RETURN jsonb_build_object(
    'schema', to_jsonb(published),
    'archived_schema_id', parent.id,
    'archived_schema_name', parent.schema_name,
    'devices_rebound', v_submodels + v_legacy,
    'submodels_rebound', v_submodels,
    'legacy_pointers_rebound', v_legacy,
    'duplicate_submodels_removed', v_merged
  );
END;
$$;

-- -------------------------------------------------------------------------------------------------
-- 3. The ACLs, restated rather than assumed
-- -------------------------------------------------------------------------------------------------
-- `CREATE OR REPLACE FUNCTION` does not reset a function's ACL, so the baseline's grants survive.
-- Restated because it costs one line and test_anon_privilege_baseline.py exists.
REVOKE ALL ON FUNCTION public.fork_schema(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_schema_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fork_schema(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.publish_schema_version(uuid) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 4. Self-check
-- -------------------------------------------------------------------------------------------------
-- Read-only. Asserts the gate by reading the function's own source, because no other artefact
-- carries the property.
DO $selfcheck$
DECLARE
    v_problems text[] := ARRAY[]::text[];
    v_def      text;
BEGIN
    FOR v_def IN
        SELECT pg_get_functiondef(p.oid)
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname IN ('fork_schema', 'publish_schema_version')
    LOOP
        IF v_def LIKE '%Shopfloor_Manager%' THEN
            v_problems := v_problems || 'a schema RPC still names Shopfloor_Manager in its gate';
        END IF;
        IF v_def NOT LIKE '%schema:manage%' THEN
            v_problems := v_problems || 'a schema RPC does not gate on schema:manage';
        END IF;
    END LOOP;

    -- The premise the narrowing rests on. If a second role is ever granted schema:manage this stops
    -- being equivalent to Administrator-only, which is a decision somebody should make deliberately
    -- rather than discover.
    IF EXISTS (
        SELECT 1 FROM public.role_permissions rp
          JOIN public.permissions p ON p.id = rp.permission_id
         WHERE p.name = 'schema:manage' AND rp.role_id <> 1
    ) THEN
        v_problems := v_problems || 'schema:manage is granted to a role other than Administrator';
    END IF;

    IF array_length(v_problems, 1) IS NOT NULL THEN
        RAISE EXCEPTION '0087 self-check failed: %', array_to_string(v_problems, '; ');
    END IF;
END $selfcheck$;
