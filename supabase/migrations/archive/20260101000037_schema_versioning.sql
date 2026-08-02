-- Migration: 20260101000037_schema_versioning.sql
-- Description: Strict, auto-incremented schema versioning (v1 -> v2 -> v3) with immutable history
-- and a mandatory change trail.
--
-- NUMBERING. The brief called this `0035`, but `20260101000035_asset_3d_models.sql` already owns
-- that slot and migrations replay in filename order on every supabase-db-init boot, so renumbering
-- an applied migration is not available. This is the next free number after 0036.
--
-- WHY VERSION AT ALL. `metric_catalog.name` is immutable because a physical device is configured
-- against that exact string, and `schemas` is what says which of those names a device is expected
-- to publish. Editing a schema in place therefore silently redefines the contract every device
-- already attached to it is being judged against: `deviceTags.js` derives "Unmodelled" by
-- subtracting the modelled set from the declared set, so widening or narrowing a schema
-- reclassifies a fleet with no record of what changed or when. Versioning makes that edit an
-- explicit, dated, described act that produces a NEW row, leaving the old one readable forever.
--
-- THE MODEL, and what each piece buys:
--   * `version` is auto-incremented from the parent, never supplied. A caller who could choose a
--     version number could renumber history, so `enforce_schema_version_provenance()` refuses any
--     INSERT from an app-facing role that names a version other than 1 or a parent at all. The
--     only way to reach v2 is `fork_schema()`.
--   * `parent_schema_id` is the lineage edge, `ON DELETE SET NULL` -- a deleted ancestor orphans
--     the chain but must never cascade away the versions that superseded it, which are live.
--   * `status` is the lifecycle: exactly one of a lineage is `active`, its predecessors are
--     `archived`, and at most one `draft` hangs off the active head (a partial unique index below
--     enforces the last part -- two concurrent forks of one parent would both claim the same
--     version number).
--   * `change_description` is why the version exists. Nullable because the brief makes it optional,
--     but backfilled to 'Initial release' for the schemas that predate versioning so the column is
--     never silently empty for a row nobody chose to leave empty.
--
-- IMMUTABILITY IS ENFORCED BY DENY-LIST-BY-DEFAULT, not by enumerating the columns to freeze.
-- `prevent_active_schema_mutation()` diffs `to_jsonb(NEW)` against `to_jsonb(OLD)` with `status`
-- removed, so a column added to `schemas` next year is frozen the moment it exists rather than
-- when someone remembers to add it to a list. That is the same failure mode the metric-group
-- separator CI check exists to prevent, caught structurally instead of by review.
--
-- THE GUARD APPLIES TO APP-FACING ROLES ONLY (`authenticated`, `anon`, `service_role`), and that
-- is load-bearing rather than a loophole:
--   * migrations 0019 and 0033 UPDATE seeded schemas by name on EVERY boot. Those rows are v1
--     `active`, so a guard that applied to `postgres` would fail db-init the first time anyone
--     published a v2 -- the stack would stop booting because a user had used a feature.
--   * `fork_schema()` and `publish_schema_version()` are SECURITY DEFINER, so inside them
--     `current_user` is the owner and the sanctioned transitions go through. Mutation is not
--     forbidden; it is routed.
-- The status-transition legality check sits BEFORE that bypass, so it binds every caller including
-- the migrations and the RPCs themselves.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.schemas ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.schemas ADD COLUMN IF NOT EXISTS parent_schema_id UUID NULL
  REFERENCES public.schemas(id) ON DELETE SET NULL;
ALTER TABLE public.schemas ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE public.schemas ADD COLUMN IF NOT EXISTS change_description TEXT NULL;

-- Constraints are dropped and re-added rather than guarded with IF NOT EXISTS so that tightening
-- one later is a one-line edit that actually takes effect on replay.
ALTER TABLE public.schemas DROP CONSTRAINT IF EXISTS schemas_status_valid;
ALTER TABLE public.schemas ADD CONSTRAINT schemas_status_valid
  CHECK (status IN ('draft', 'active', 'archived'));

ALTER TABLE public.schemas DROP CONSTRAINT IF EXISTS schemas_version_positive;
ALTER TABLE public.schemas ADD CONSTRAINT schemas_version_positive CHECK (version >= 1);

-- A version above 1 has to have come from somewhere, and a v1 cannot have. Without this a row
-- could claim to be v7 of nothing, and the lineage the UI walks would dead-end.
ALTER TABLE public.schemas DROP CONSTRAINT IF EXISTS schemas_version_lineage_coherent;
ALTER TABLE public.schemas ADD CONSTRAINT schemas_version_lineage_coherent
  CHECK ((version = 1 AND parent_schema_id IS NULL) OR (version > 1 AND parent_schema_id IS NOT NULL));

-- A schema is not its own parent. The deeper cycle (A -> B -> A) is unreachable because a fork
-- only ever inserts a fresh row whose parent already exists, and `parent_schema_id` is frozen by
-- the immutability guard from that point on.
ALTER TABLE public.schemas DROP CONSTRAINT IF EXISTS schemas_parent_not_self;
ALTER TABLE public.schemas ADD CONSTRAINT schemas_parent_not_self
  CHECK (parent_schema_id IS NULL OR parent_schema_id <> id);

COMMENT ON COLUMN public.schemas.version IS
  'Auto-incremented lineage position. Never supplied by a caller -- fork_schema() derives it from the parent.';
COMMENT ON COLUMN public.schemas.parent_schema_id IS
  'The version this one was forked from. NULL only for a v1 root.';
COMMENT ON COLUMN public.schemas.status IS
  'draft (editable) | active (in force, immutable) | archived (superseded, immutable).';
COMMENT ON COLUMN public.schemas.change_description IS
  'Why this version exists. Captured at fork time; immutable once the version is published.';

CREATE INDEX IF NOT EXISTS idx_schemas_parent ON public.schemas(parent_schema_id);
CREATE INDEX IF NOT EXISTS idx_schemas_status ON public.schemas(status);

-- At most one open draft per parent. Two operators forking the same active schema would otherwise
-- both compute `parent.version + 1` and produce two rows claiming to be v2 of one lineage, with
-- nothing to say which one publishing should archive against. `fork_schema()` also checks and
-- raises a readable error; this index is what makes the check hold under concurrency, since the
-- two transactions cannot see each other's uncommitted row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_schemas_one_draft_per_parent
  ON public.schemas(parent_schema_id) WHERE status = 'draft' AND parent_schema_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Backfill
-- ---------------------------------------------------------------------------

-- Scoped `WHERE change_description IS NULL`, and further to genuine roots, for the same reason the
-- semantic-id backfills in 0029/0032 are scoped: this migration replays on every boot, and a
-- blanket UPDATE would re-stamp rows an operator had deliberately worded otherwise. `version` and
-- `status` need no backfill at all -- the column defaults gave every pre-existing row v1/active,
-- which is exactly the intended reading of a schema that predates versioning.
UPDATE public.schemas
   SET change_description = 'Initial release'
 WHERE change_description IS NULL
   AND version = 1
   AND parent_schema_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Immutability guard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_active_schema_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  -- Everything a caller is allowed to move on a frozen row. `status` alone: a published version's
  -- name, definition, description, semantic id, version number and parent are all part of what
  -- devices were provisioned against or of the historical record, and none of them is correctable
  -- in place -- the correction is a new version, which is the whole point of this migration.
  allowed CONSTANT text[] := ARRAY['status'];
BEGIN
  -- Transition legality binds EVERY caller, including migrations and the SECURITY DEFINER RPCs
  -- below, which is why it sits above the role bypass. Backwards transitions are what would let
  -- history be rewritten: re-opening an archived version as a draft would make the row mutable
  -- again while devices are still attached to its successor.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'draft'  AND NEW.status IN ('active', 'archived'))
      OR (OLD.status = 'active' AND NEW.status = 'archived')
    ) THEN
      RAISE EXCEPTION
        'illegal schema status transition % -> % for "%" (v%)',
        OLD.status, NEW.status, OLD.schema_name, OLD.version
        USING ERRCODE = 'check_violation',
              HINT = 'Legal transitions are draft->active, draft->archived and active->archived.';
    END IF;
  END IF;

  -- See the header: migrations 0019 and 0033 rewrite seeded schemas by name on every boot, and the
  -- RPCs below run as the owner. Only app-facing roles are held to immutability.
  IF current_user NOT IN ('authenticated', 'anon', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF OLD.status NOT IN ('active', 'archived') THEN
    RETURN NEW;
  END IF;

  -- Deny-list by default. Anything outside `allowed` that actually changed is a mutation of a
  -- frozen row, whether or not this migration knew the column existed.
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION
      'schema "%" is % (v%) and immutable; create v% with fork_schema() instead',
      OLD.schema_name, OLD.status, OLD.version, OLD.version + 1
      USING ERRCODE = 'check_violation',
            HINT = 'Only a draft version can be edited. Fork this schema, edit the draft, then publish it.';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.prevent_active_schema_mutation() IS
  'Freezes every column except `status` on an active or archived schema, and rejects illegal status transitions for all callers.';

DROP TRIGGER IF EXISTS trg_prevent_active_schema_mutation ON public.schemas;
CREATE TRIGGER trg_prevent_active_schema_mutation
  BEFORE UPDATE ON public.schemas
  FOR EACH ROW EXECUTE FUNCTION public.prevent_active_schema_mutation();

-- ---------------------------------------------------------------------------
-- 4. Version provenance on INSERT
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_schema_version_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Same role split as the guard above: migrations seed rows directly and fork_schema() runs as
  -- the owner, so both are past this. What it stops is the only remaining path -- a PostgREST
  -- client POSTing a row that names its own version or parent, which is how "auto-incremented"
  -- would otherwise be a UI convention rather than a database fact.
  IF current_user NOT IN ('authenticated', 'anon', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF NEW.version <> 1 OR NEW.parent_schema_id IS NOT NULL THEN
    RAISE EXCEPTION
      'a schema version cannot be created directly; use fork_schema() to derive v% from its parent',
      NEW.version
      USING ERRCODE = 'check_violation',
            HINT = 'Direct inserts always start a new lineage at v1.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_schema_version_provenance ON public.schemas;
CREATE TRIGGER trg_enforce_schema_version_provenance
  BEFORE INSERT ON public.schemas
  FOR EACH ROW EXECUTE FUNCTION public.enforce_schema_version_provenance();

-- ---------------------------------------------------------------------------
-- 5. Lineage naming
-- ---------------------------------------------------------------------------

-- `schemas.schema_name` is UNIQUE and CANNOT be relaxed: migration 0033 uses
-- `ON CONFLICT (schema_name) DO UPDATE`, which requires the unique index, and migrations 0019,
-- 0021 and 0033 all resolve a schema by name with a scalar subquery that would start raising
-- "more than one row returned" the moment two versions shared a name. So a version gets a derived
-- name rather than sharing its parent's.
--
-- The base is recovered by stripping a trailing `_v<n>`, so the suffix does not accumulate:
-- `Foo` -> `Foo_v2` -> `Foo_v3`, never `Foo_v2_v3`. Only `[A-Za-z0-9_]` is used because the
-- exporter turns a schema name into an AAS idShort (`toIdShort` in functions/aas-export), and an
-- idShort admits nothing else.
CREATE OR REPLACE FUNCTION public.schema_version_base_name(schema_name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(COALESCE(schema_name, ''), '_v[0-9]+$', '');
$$;

COMMENT ON FUNCTION public.schema_version_base_name(TEXT) IS
  'The lineage stem of a versioned schema name. Mirrored by baseSchemaName() in frontend/src/utils/schemaVersion.js -- keep the two in step.';

-- ---------------------------------------------------------------------------
-- 6. fork_schema()
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.fork_schema(UUID, TEXT);
CREATE FUNCTION public.fork_schema(parent_schema_id UUID, change_description TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  -- Fail closed, and check authority before anything else observable happens. Same allow-list as
  -- the RLS write policies on `schemas` and as approve-quarantine: forking is a schema-management
  -- act, so it carries schema-management authority.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
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

COMMENT ON FUNCTION public.fork_schema(UUID, TEXT) IS
  'Derives the next draft version of an active schema, copying its definition. The version number is computed, never supplied.';

REVOKE ALL ON FUNCTION public.fork_schema(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fork_schema(UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. publish_schema_version()
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.publish_schema_version(UUID);
CREATE FUNCTION public.publish_schema_version(draft_schema_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
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

    -- The legacy 1:1 pointer moves too. Migration 0034 kept `devices.schema_id` as the fallback
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

COMMENT ON FUNCTION public.publish_schema_version(UUID) IS
  'Activates a draft version, archives its parent, and atomically repoints every device_submodels row and legacy devices.schema_id from the parent to it.';

REVOKE ALL ON FUNCTION public.publish_schema_version(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_schema_version(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Boot reconciliation: no asset may be left pointing at an archived version
-- ---------------------------------------------------------------------------

-- THIS EXISTS BECAUSE EARLIER MIGRATIONS RE-PIN BINDINGS BY NAME AND BY PINNED UUID, on every
-- boot. Migration 0021 resolves the demo device's schema with
-- `WHERE schema_name = 'Simulated_CNC_01_Schema'`, and 0033 sets `devices.schema_id` to the
-- literal UUID `e3333333-...`. Both of those identify the row that was v1. So the moment anyone
-- publishes a v2 of that lineage, the next db-init replay silently drags the device back onto the
-- ARCHIVED version -- observed, not theorised: `device_submodels` stayed on v2 while
-- `devices.schema_id` reverted to v1, which is the worst shape of the bug because the
-- `device_schemas` view prefers the join rows and the disagreement stays invisible.
--
-- Fixing it inside 0021/0033 is not available: they run BEFORE this file in filename order, so
-- they cannot call a function defined here, and a fresh database would fail on the first boot.
-- Repairing it here instead works precisely because 0037 runs last -- which is a dependency on
-- ordering, and therefore a thing to preserve. A LATER MIGRATION THAT RE-PINS A SCHEMA BINDING
-- MUST EITHER RESOLVE THE ACTIVE VERSION ITSELF OR RE-RUN THIS RECONCILIATION AFTER ITSELF.
--
-- Stated as a general invariant rather than as a patch for the demo device: no binding anywhere
-- may reference an archived version while a successor is in force.

CREATE OR REPLACE FUNCTION public.active_schema_version(schema_id UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_id     UUID := schema_id;
  v_status TEXT;
  v_next   UUID;
  hops     INTEGER := 0;
BEGIN
  LOOP
    SELECT s.status INTO v_status FROM public.schemas s WHERE s.id = v_id;
    -- Not archived (or gone) means this is already the answer: an active version is the head, and
    -- a draft was deliberately attached by someone trialling it.
    IF v_status IS NULL OR v_status <> 'archived' THEN
      RETURN v_id;
    END IF;

    -- Drafts are excluded: an unpublished version is not in force, and forwarding a live binding
    -- onto one would activate it by the back door.
    SELECT s.id INTO v_next
      FROM public.schemas s
     WHERE s.parent_schema_id = v_id AND s.status IN ('active', 'archived')
     ORDER BY s.version
     LIMIT 1;

    -- An archived version whose successor was deleted: the chain ends, so it stays where it is.
    -- Better a stale pointer than a NULL one, which would read as "this device has no model".
    IF v_next IS NULL THEN
      RETURN v_id;
    END IF;

    v_id := v_next;
    hops := hops + 1;
    -- A cycle is unreachable (a CHECK forbids self-parenting, the guard freezes parent_schema_id,
    -- and a fork only ever points at a row that already exists), but an unbounded loop inside a
    -- migration is not a risk worth carrying on reasoning alone.
    IF hops > 1000 THEN
      RAISE EXCEPTION 'schema lineage from % does not terminate', schema_id;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.active_schema_version(UUID) IS
  'Follows a lineage forward from any version to the one currently in force. Returns the input unchanged when it is already active, is a draft, or has no published successor.';

-- Drop the redundant attachment before repointing, exactly as publish_schema_version() does and
-- for the same reason: a device attached to both an archived version and its successor would
-- collide on uq_device_submodels the moment the old row was forwarded.
DELETE FROM public.device_submodels old_link
 WHERE old_link.schema_id IS DISTINCT FROM public.active_schema_version(old_link.schema_id)
   AND EXISTS (
     SELECT 1 FROM public.device_submodels new_link
      WHERE new_link.device_id = old_link.device_id
        AND new_link.schema_id = public.active_schema_version(old_link.schema_id)
   );

UPDATE public.device_submodels ds
   SET schema_id = public.active_schema_version(ds.schema_id)
 WHERE ds.schema_id IS DISTINCT FROM public.active_schema_version(ds.schema_id);

-- Guarded with IS DISTINCT FROM, not run unconditionally: `log_digital_thread_event()` fires on
-- every UPDATE to `devices` whether or not a value changed, so an unguarded statement here would
-- append a row to an append-only audit table on every boot, forever -- the same trap 0021 and
-- 0033 each document avoiding.
UPDATE public.devices d
   SET schema_id = public.active_schema_version(d.schema_id)
 WHERE d.schema_id IS NOT NULL
   AND d.schema_id IS DISTINCT FROM public.active_schema_version(d.schema_id);

-- ---------------------------------------------------------------------------
-- 9. Self-check
-- ---------------------------------------------------------------------------

-- Asserts the guard is actually attached and actually bites, in the same spirit as 0029's probe
-- that semantic ids stayed mutable and 0034's orphan check. A trigger that silently failed to fire
-- would leave the whole feature looking correct while the invariant it exists for was gone, and
-- nothing else in the stack would report a problem.
--
-- It probes the TRANSITION arm (active -> draft), not the column-freeze arm, because that is the
-- arm that binds every caller. Probing the freeze would mean running as `authenticated`, and at
-- that point the RLS policy on `schemas` filters the UPDATE to zero rows *before* the trigger is
-- reached -- so the probe would report "not blocked" for a guard that was working perfectly. The
-- freeze arm is covered instead by supabase/migrations/test_schema_versioning.py, which sets the
-- JWT claims needed to get past RLS first.
DO $$
DECLARE
  probe_id UUID;
  blocked  BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.schemas (schema_name, description, schema_definition, status)
  VALUES ('__versioning_probe__', 'migration self-check', '{"type":"object"}'::jsonb, 'active')
  RETURNING id INTO probe_id;

  BEGIN
    UPDATE public.schemas SET status = 'draft' WHERE id = probe_id;
  EXCEPTION WHEN OTHERS THEN
    blocked := TRUE;
  END;

  DELETE FROM public.schemas WHERE id = probe_id;

  IF NOT blocked THEN
    RAISE EXCEPTION
      'prevent_active_schema_mutation() did not reject an active -> draft transition -- versioning is not enforced';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
