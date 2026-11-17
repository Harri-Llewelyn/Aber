-- 0298: A schema's AAS Submodel id follows its lineage, not the name of the version.
--
-- Publishing a schema version gives the new version its own name (fork_schema() names version n
-- <base>_v<n>), and the exporter minted each Submodel's id from that name. So a device's
-- OperationalTelemetry Submodel changed id at every publish, aas-api answered 404 for the old one, and
-- a third-party AAS server collected one Submodel per version. The id now comes from the lineage:
-- the name the first version was built with, which the lineage keeps for good.
--
--   * schemas gains lineage_root_id and lineage_name: the first version of the lineage (itself, for a
--     first version) and its schema_name. Both are NOT NULL, and a BEFORE trigger sets them on every
--     insert from the parent's, so fork_schema(), apply_device_schemas() and a direct insert (which
--     always starts a lineage, enforce_schema_version_provenance()) all name their lineage without
--     any of them being redeclared. Neither is ever supplied by a caller: the trigger derives them
--     again from parent_schema_id on an insert and on any update that touches either column, so
--     they cannot disagree with it. The root's name is stored on each version so that no reader walks
--     the chain or joins the root: the exporter, aas-api, i3X and the dashboard read one row.
--     A first version that is renamed (only a draft can be) renames its lineage too.
--   * Existing rows are filled through parent_schema_id, in a transaction of its own behind a lock
--     that holds writers off schemas, after the trigger exists, so the previous release's dashboard
--     cannot insert a row the NOT NULL would then refuse. The fill is not an Audit Trail event: it
--     records no choice anybody made, and one row per schema would read as an edit of every schema.
--     A replay finds the columns NOT NULL and does nothing.
--   * device_submodels.submodel_key stays an override (NULL means the lineage's name), and its CHECK
--     is tightened to start with a letter, as an idShort must. The new CHECK is a second constraint
--     and the old one is left as 0001 declares it, because 0001 replays first and would add its
--     own back on every boot. A key that began with an underscore is rewritten without it first,
--     and the number rewritten is a NOTICE.
--
-- Nothing else is stored twice: which Submodel id a version gets, and the clash rules, are the
-- exporter's (supabase/functions/_shared/aas/submodelKeys.ts).
--
-- Reasoning: supabase/README.md, "A schema's Submodel id follows its lineage (0298)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The trigger functions. Inert until the trigger exists, so they come first.
-- -------------------------------------------------------------------------------------------------
-- SECURITY DEFINER, because the row they read is the parent's or the root's, which must not depend on
-- the caller's RLS, and because a rename reaches rows an app role may not edit
-- (prevent_active_schema_mutation() lets the owner through).
CREATE OR REPLACE FUNCTION public.schemas_take_their_lineage() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_root_id uuid;
BEGIN
  IF NEW.parent_schema_id IS NULL THEN
    NEW.lineage_root_id := NEW.id;
    NEW.lineage_name := NEW.schema_name;
    RETURN NEW;
  END IF;

  SELECT p.lineage_root_id INTO v_root_id FROM public.schemas p WHERE p.id = NEW.parent_schema_id;
  IF v_root_id IS NULL THEN
    RAISE EXCEPTION 'parent_schema_id % names no schema with a lineage', NEW.parent_schema_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.lineage_root_id := v_root_id;
  -- The root's own name, read from the root: a copy carried from the parent could be a step behind
  -- a rename that is still being passed down the lineage.
  SELECT r.schema_name INTO NEW.lineage_name FROM public.schemas r WHERE r.id = v_root_id;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.schemas_take_their_lineage() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.schemas_take_their_lineage() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.schemas_take_their_lineage() IS
  'BEFORE INSERT, and BEFORE UPDATE of schema_name, parent_schema_id, lineage_root_id or lineage_name, '
  'on schemas: sets lineage_root_id and lineage_name from parent_schema_id (a first version is its own '
  'root and carries its own name), so a caller never supplies them and they cannot disagree (0298).';

CREATE OR REPLACE FUNCTION public.schemas_rename_their_lineage() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.lineage_root_id = NEW.id THEN
    UPDATE public.schemas
       SET lineage_name = NEW.schema_name
     WHERE lineage_root_id = NEW.id
       AND id <> NEW.id
       AND lineage_name IS DISTINCT FROM NEW.schema_name;
  END IF;
  RETURN NULL;
END;
$$;

ALTER FUNCTION public.schemas_rename_their_lineage() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.schemas_rename_their_lineage() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.schemas_rename_their_lineage() IS
  'AFTER UPDATE of schema_name on schemas: when the first version of a lineage is renamed, every later '
  'version carries the new lineage_name. An active or archived first version cannot be renamed by an '
  'app role, so this is for a draft and for a migration (0298).';

-- -------------------------------------------------------------------------------------------------
-- 2. The columns, the triggers, the fill
-- -------------------------------------------------------------------------------------------------
-- Three steps, each its own transaction, in an order that never leaves an insert failing: the columns
-- are added nullable; the trigger is made; then, behind a lock that holds writers off schemas, every
-- row still without a lineage is filled and the columns are made NOT NULL. A row the previous
-- release's dashboard inserts between the first two has none, and the third step fills it. The lock is
-- taken only where a column is still nullable, so a replay locks nothing.
ALTER TABLE public.schemas
    ADD COLUMN IF NOT EXISTS lineage_root_id uuid,
    ADD COLUMN IF NOT EXISTS lineage_name text;

SELECT public.replay_trigger('public.schemas', 'trg_schemas_take_their_lineage', $ddl$
CREATE TRIGGER trg_schemas_take_their_lineage BEFORE INSERT OR UPDATE OF schema_name, parent_schema_id, lineage_root_id, lineage_name ON public.schemas FOR EACH ROW EXECUTE FUNCTION public.schemas_take_their_lineage();
$ddl$);

SELECT public.replay_trigger('public.schemas', 'trg_schemas_rename_their_lineage', $ddl$
CREATE TRIGGER trg_schemas_rename_their_lineage AFTER UPDATE OF schema_name ON public.schemas FOR EACH ROW EXECUTE FUNCTION public.schemas_rename_their_lineage();
$ddl$);

-- A first version is its own root; every other version takes its parent's, one hop a pass, so the
-- loop ends when no row whose parent is filled is left (a lineage is as long as it has versions).
-- Neither the audit trigger nor the lineage trigger runs for the fill: it records no choice, and the
-- lineage trigger would refuse a version whose parent is not filled yet. Both are enabled again
-- before the transaction ends, and the self-check below reads them.
DO $fill$
DECLARE
  v_filled integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.schemas'::regclass
                AND attname IN ('lineage_root_id', 'lineage_name') AND NOT attnotnull AND NOT attisdropped) THEN
    LOCK TABLE public.schemas IN SHARE ROW EXCLUSIVE MODE;

    ALTER TABLE public.schemas DISABLE TRIGGER trg_schemas_audit_trail;
    ALTER TABLE public.schemas DISABLE TRIGGER trg_schemas_take_their_lineage;
    UPDATE public.schemas SET lineage_root_id = id, lineage_name = schema_name
     WHERE parent_schema_id IS NULL AND (lineage_root_id IS NULL OR lineage_name IS NULL);
    LOOP
      UPDATE public.schemas s
         SET lineage_root_id = p.lineage_root_id, lineage_name = p.lineage_name
        FROM public.schemas p
       WHERE s.parent_schema_id = p.id
         AND p.lineage_root_id IS NOT NULL
         AND (s.lineage_root_id IS NULL OR s.lineage_name IS NULL);
      GET DIAGNOSTICS v_filled = ROW_COUNT;
      EXIT WHEN v_filled = 0;
    END LOOP;
    ALTER TABLE public.schemas ENABLE TRIGGER trg_schemas_take_their_lineage;
    ALTER TABLE public.schemas ENABLE TRIGGER trg_schemas_audit_trail;

    ALTER TABLE public.schemas
        ALTER COLUMN lineage_root_id SET NOT NULL,
        ALTER COLUMN lineage_name SET NOT NULL;
  END IF;
END $fill$;

-- The key to the first version. Added after the fill, and guarded, as 0001's constraints are: a drop
-- and a re-add would read every row again.
DO $fk$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schemas_lineage_root_id_fkey'
                    AND conrelid = 'public.schemas'::regclass) THEN
    ALTER TABLE public.schemas
        ADD CONSTRAINT schemas_lineage_root_id_fkey FOREIGN KEY (lineage_root_id) REFERENCES public.schemas(id);
  END IF;
END $fk$;

CREATE INDEX IF NOT EXISTS idx_schemas_lineage_root ON public.schemas USING btree (lineage_root_id);

COMMENT ON COLUMN public.schemas.lineage_root_id IS 'The first version of this lineage: this row for a first version, else the root of the parent. Set by trg_schemas_take_their_lineage, never by a caller. The AAS Submodel id of every version of a schema is made from the root''s name.';
COMMENT ON COLUMN public.schemas.lineage_name IS 'The schema_name of the lineage''s first version, carried on every version so a reader needs no join. Set by trg_schemas_take_their_lineage and kept in step by trg_schemas_rename_their_lineage. The label a person reads is this name and the version, once: Robot_Arm_Schema v2.';

-- -------------------------------------------------------------------------------------------------
-- 3. device_submodels.submodel_key starts with a letter
-- -------------------------------------------------------------------------------------------------
-- An idShort starts with a letter (shell.ts toIdShort()), and the exporter uses the key unchanged.
-- 0001's CHECK admits a leading underscore. A key that has one is rewritten as toIdShort() writes
-- it, without the underscores, and a key of nothing else goes back to the lineage's name. The move
-- and the CHECK are one transaction, taken only where the CHECK is missing. Each rewrite is an UPDATE
-- the audit trigger records, as 0293's moves are, because it changes a Submodel id a site may hold.
DO $key$
DECLARE
  v_rewritten integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_submodels_key_starts_with_a_letter'
                    AND conrelid = 'public.device_submodels'::regclass) THEN
    LOCK TABLE public.device_submodels IN SHARE ROW EXCLUSIVE MODE;

    WITH moved AS (
      UPDATE public.device_submodels
         SET submodel_key = NULLIF(regexp_replace(submodel_key, '^_+', ''), '')
       WHERE submodel_key ~ '^_'
      RETURNING 1
    )
    SELECT count(*) INTO v_rewritten FROM moved;
    RAISE NOTICE '0298: % device_submodels key(s) began with an underscore and were rewritten without it', v_rewritten;

    ALTER TABLE public.device_submodels
        ADD CONSTRAINT device_submodels_key_starts_with_a_letter CHECK (((submodel_key IS NULL) OR (submodel_key ~ '^[A-Za-z][A-Za-z0-9_]*$'::text)));
  END IF;
END
$key$;

COMMENT ON COLUMN public.device_submodels.submodel_key IS 'An override for the AAS Submodel id''s key and, on a device with several schemas, for the idShort. NULL, which is every row the Devices page writes, means the schema''s lineage_name. It survives a publish, because publishing moves the row to the new version. Starts with a letter (device_submodels_key_starts_with_a_letter).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schemas WHERE lineage_root_id IS NULL OR lineage_name IS NULL) THEN
    RAISE EXCEPTION '0298: a schema has no lineage';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.schemas'::regclass AND attname = 'lineage_root_id' AND attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute
                     WHERE attrelid = 'public.schemas'::regclass AND attname = 'lineage_name' AND attnotnull) THEN
    RAISE EXCEPTION '0298: schemas.lineage_root_id or schemas.lineage_name admits NULL';
  END IF;
  -- A lineage has one first version, and it is its own root.
  IF EXISTS (SELECT 1
               FROM public.schemas s
               JOIN public.schemas r ON r.id = s.lineage_root_id
              WHERE r.parent_schema_id IS NOT NULL OR r.lineage_root_id <> r.id) THEN
    RAISE EXCEPTION '0298: a schema names a lineage root that is not a first version';
  END IF;
  IF EXISTS (SELECT 1
               FROM public.schemas s
               JOIN public.schemas p ON p.id = s.parent_schema_id
              WHERE s.lineage_root_id <> p.lineage_root_id) THEN
    RAISE EXCEPTION '0298: a schema is in a different lineage from its parent';
  END IF;
  IF EXISTS (SELECT 1
               FROM public.schemas s
               JOIN public.schemas r ON r.id = s.lineage_root_id
              WHERE s.lineage_name <> r.schema_name) THEN
    RAISE EXCEPTION '0298: a schema carries a lineage name that is not its root''s';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.schemas'::regclass
                    AND t.tgname IN ('trg_schemas_take_their_lineage', 'trg_schemas_rename_their_lineage')
                    AND t.tgenabled <> 'D'
                  HAVING count(*) = 2) THEN
    RAISE EXCEPTION '0298: a trigger that names a schema''s lineage is missing or disabled, so an insert would fail';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.schemas'::regclass
                    AND t.tgname = 'trg_schemas_audit_trail' AND t.tgenabled <> 'D') THEN
    RAISE EXCEPTION '0298: trg_schemas_audit_trail is disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.schemas'::regclass
                    AND conname = 'schemas_lineage_root_id_fkey' AND convalidated)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid = 'public.device_submodels'::regclass
                       AND conname = 'device_submodels_key_starts_with_a_letter' AND convalidated) THEN
    RAISE EXCEPTION '0298: a constraint this file adds is missing or NOT VALID, so a row may still break it';
  END IF;
  IF public.live_constraint_definition('public.device_submodels'::regclass, 'device_submodels_key_starts_with_a_letter')
       IS DISTINCT FROM 'CHECK (((submodel_key IS NULL) OR (submodel_key ~ ''^[A-Za-z][A-Za-z0-9_]*$''::text)))' THEN
    RAISE EXCEPTION '0298: device_submodels_key_starts_with_a_letter does not read as this file declares it';
  END IF;
  IF has_function_privilege('anon', 'public.schemas_take_their_lineage()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.schemas_rename_their_lineage()', 'EXECUTE') THEN
    RAISE EXCEPTION '0298: anon may execute a lineage trigger function';
  END IF;
END
$check$;
