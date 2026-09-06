-- 0087: the schema RPCs stop being the way around the policy 0069 installed.
--
-- =================================================================================================
-- THE FINDING, AND HOW IT WAS CONFIRMED
--
-- `0069` withdrew `schema:manage` from `Shopfloor_Manager` -- "what contract ingestion validates
-- against" -- and narrowed the three write policies on `public.schemas` to Administrator alone. Its
-- own header states the principle it was applying: a revoked permission whose policy still admits
-- the role is "a frontend flag and therefore never an access control".
--
-- IT NARROWED POLICIES. `fork_schema()` and `publish_schema_version()` are SECURITY DEFINER, so
-- they do not consult those policies at all -- they run as the owner -- and both went on checking
-- `has_role(ARRAY['Administrator', 'Shopfloor_Manager'])`. The result is that the exact write 0069
-- withdrew stayed reachable, through the RPC the UI already calls.
--
-- Measured on the shipped stack, in one transaction as a Shopfloor_Manager holding neither
-- `Administrator` nor `schema:manage`:
--
--     UPDATE public.schemas SET status = 'archived' ...   -> UPDATE 0     (0069's policy holds)
--     SELECT public.publish_schema_version(<draft>)       -> succeeded
--     SELECT status FROM public.schemas WHERE id = parent -> 'archived'
--
-- The direct write was refused and the RPC performed it. Publishing activates a draft, archives its
-- predecessor and repoints every `device_submodels` row and legacy `devices.schema_id` onto the new
-- version -- so this is not a cosmetic status flip, it changes what every attached device is judged
-- against by ingestion.
--
-- `fork_schema()` carries the same gate and the same bypass. Its comment claimed "Same allow-list as
-- the RLS write policies on `schemas`", which was TRUE WHEN WRITTEN and became false when 0069
-- moved those policies underneath it. That is the failure this repository already knows about in
-- another form -- an analysis that was right when written and wrong when read -- and the reason the
-- roadmap tells a reader to sweep back over what cited a thing as settled.
--
-- =================================================================================================
-- WHY `has_authority` AND NOT `has_role(ARRAY['Administrator'])`
--
-- The seven policies 0069 narrowed name the ROLE. These two name the PERMISSION instead, so the gate
-- is the thing that was withdrawn rather than a second spelling of it that a later role change can
-- put out of step again -- which is precisely how these two functions came to disagree with the
-- policies they were written to match. Today the two resolve identically: Administrator alone holds
-- `schema:manage`.
--
-- It also fails closed for a machine principal, on 0080's argument: a machine resolves through
-- `principal_permissions`, where none holds `schema:manage`.
--
-- =================================================================================================
-- WHAT THIS DOES NOT CHANGE
--
-- Reading. `0069` deliberately left all three SELECT policies open -- the Devices page resolves a
-- device's schema through them -- and nothing here touches a read path.
--
-- The bodies below are the baseline's, copied verbatim except for the gate and the comment above it,
-- so this file is a change to WHO MAY CALL and to nothing else. Both are recorded in
-- INTENDED_REDECLARATIONS in scripts/check-docs-drift.mjs, because the last declaration in filename
-- order is the one that runs.
-- =================================================================================================


-- -------------------------------------------------------------------------------------------------
-- 1. Forking a schema is a schema-management act
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fork_schema(parent_schema_id uuid, change_description text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  -- Copied out of the parameters immediately, and the parameters never referenced again. Both are
  -- named after columns of `schemas` -- which is what the brief specifies and what the RPC's JSON
  -- body must use -- and plpgsql would raise "column reference is ambiguous" on the first
  -- `WHERE id = parent_schema_id`. A DECLARE initialiser has no table in scope, so the copy is
  -- unambiguous.
  v_parent_id  UUID := parent_schema_id;
  v_change     TEXT := NULLIF(btrim(COALESCE(change_description, '')), '');
  parent       public.schemas%ROWTYPE;
  child        public.schemas%ROWTYPE;
  v_base       TEXT;
  v_next       INTEGER;
  v_name       TEXT;
  v_suffix     INTEGER := 1;
BEGIN
  -- Fail closed, and check authority before anything else observable happens. NARROWED BY 0087:
  -- this said "same allow-list as the RLS write policies on `schemas`" and named the pair, which
  -- was true when it was written and stopped being true when 0069 narrowed those three policies to
  -- Administrator. The comment went on asserting an agreement that no longer held.
  --
  -- `has_authority` rather than a role name, so the gate IS the permission 0069 withdrew rather
  -- than a second spelling of it that the next role change can put out of step again. Today that
  -- resolves to Administrator alone, because Administrator alone holds `schema:manage`.
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

  -- THE METRIC LINKS ARE THE DEFINITION. There is no `schema_metrics` table in this database --
  -- a schema's membership of the catalog lives in `schema_definition.properties` / `.required`,
  -- which is what `modelledMetrics()` in deviceTags.js and its Python mirror in validate.py both
  -- read. Copying the JSONB document IS duplicating the parent's metric links; a join table would
  -- have to be copied row by row here instead.
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

    -- REBIND BEFORE ARCHIVING, so no window exists in which a device points at an archived schema.
    -- The whole function is one transaction, so this is ordering for readability rather than for
    -- observability -- but the read-backwards rule from the 3D-model upload applies: write the
    -- pointer, then retire what it pointed at.
    --
    -- A device already carrying BOTH versions as submodels would collide on
    -- `uq_device_submodels (device_id, schema_id)` when the old row is repointed. That is a real
    -- state -- someone can attach a draft to a device to try it out before publishing -- so the
    -- redundant old-version rows are dropped first rather than allowed to abort the publish.
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

    -- The legacy 1:1 pointer moves too. Archived migration 0034 kept `devices.schema_id` as the fallback
    -- arm of the `device_schemas` view, and migrations 0021/0033 still write it -- a device
    -- provisioned only through that column would otherwise stay pinned to an archived version and
    -- start reporting the new version's metrics as Unmodelled. This UPDATE also fires
    -- `log_digital_thread_event()`, so the rebinding lands in the audit trail per device, which is
    -- where the history of "what was this machine judged against, when" belongs.
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
-- `CREATE OR REPLACE FUNCTION` does not reset a function's ACL, so the baseline's grants survive
-- this file and no PUBLIC grant is reintroduced. Restated anyway because it costs one line and
-- test_anon_privilege_baseline.py exists because this exact assumption was wrong once.
REVOKE ALL ON FUNCTION public.fork_schema(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_schema_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fork_schema(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.publish_schema_version(uuid) TO authenticated, service_role;


-- -------------------------------------------------------------------------------------------------
-- 4. Self-check
-- -------------------------------------------------------------------------------------------------
-- READ-ONLY. It asserts the gate by reading the function's own source, because the property is
-- "this function no longer admits the pair" and there is no other artefact that carries it.
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
