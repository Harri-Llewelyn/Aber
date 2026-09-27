-- 0124: archiving an asset is a lifecycle rather than a flag.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- Archiving was one flag, a timestamp and a retention timer on three tables, and an area could
-- not be archived at all. Four things change here, each enforced where it is stated:
--
--   1. `areas` carries the same three columns as cells, gateways and devices, and the purge job in
--      0002 takes a fourth DELETE for it. AN ARCHIVED AREA KEEPS ITS NAME IN EVERY uns/ TOPIC
--      BENEATH IT: `device_locations` has never consulted `cells.is_archived`, so an archived cell
--      already publishes under its own name, and an area follows the same rule. Archiving a
--      container never moves what is under it; deleting one un-files it (0097, 0112). The Site Map
--      draws an archived area muted and keeps drawing its plan for the same reason: the cells are
--      still filed in it.
--   2. A replay lane follows its original (`devices.shadow_of`): archived with it, restored with
--      it, deleted before it. One function, attached twice. `devices_shadow_of_fkey` stays
--      ON DELETE SET NULL for the lanes that reached that state before this file.
--   3. A row that was archived and is then deleted leaves a tombstone in `retired_entities`,
--      written by the same event that writes the DELETE audit row. A table rather than a query
--      over `digital_thread`: the thread is month-partitioned for an eventual DETACH (0079), and a
--      tombstone has to outlive the partition that recorded the delete.
--   4. `asset_exports` records each bundle `aas-export` stores beside the cold tier (its `bundle`
--      format), so a tombstone can point at what survives.
--
-- Decided, and not built here: the export is not a row in the historian's manifest, which is keyed
-- by chunk and exists to make dropping one safe; a tombstone is written only for a row that was
-- archived when it was deleted, because a device rejected from quarantine or a row a cleanup
-- removed was never in service; and `is_archived` stays outside every proposal lane (0086), so
-- "archived" is a lifecycle stage and never a proposal.

SET search_path TO public;

-- -------------------------------------------------------------------------------------------------
-- 1. Areas archive like everything else
-- -------------------------------------------------------------------------------------------------
-- NOT NULL where the three older tables left the flag nullable, so no reader needs COALESCE.
ALTER TABLE public.areas
    ADD COLUMN IF NOT EXISTS is_archived    boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS archived_at    timestamp with time zone,
    ADD COLUMN IF NOT EXISTS auto_delete_at timestamp with time zone;

COMMENT ON COLUMN public.areas.is_archived IS
    'Out of commission but not gone: listed on the Archived Entities page, restorable, and still the <area> segment of every uns/ topic beneath it. Its cells stay filed in it. Never proposable.';
COMMENT ON COLUMN public.areas.archived_at IS 'When the area was archived; NULL while it is in service.';
COMMENT ON COLUMN public.areas.auto_delete_at IS
    'When purge_expired_archives (0002) may delete the row; NULL is permanent retention. The delete is skipped, not attempted, while an Area-Wide asset still names the area.';

-- -------------------------------------------------------------------------------------------------
-- 2. An archived area cannot be proposed against
-- -------------------------------------------------------------------------------------------------
-- The 0123 body, with the areas arm now testing `is_archived` like every other arm. Recorded in
-- check-docs-drift.mjs's INTENDED_REDECLARATIONS.
CREATE OR REPLACE FUNCTION public.validate_change_proposal() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_allowed text[] := public.proposable_columns(NEW.entity_type);
    v_key     text;
    v_exists  boolean;
BEGIN
    -- Fail closed, naming the real problem: the CHECK constraint admits the known lanes and this
    -- trigger runs before it. This is also how the schema lane's withdrawal is enforced: the string
    -- is admitted by the constraint and has no allowlist.
    IF array_length(v_allowed, 1) IS NULL THEN
        RAISE EXCEPTION
            'nothing is proposable on %; proposable_columns() has no allowlist for it',
            NEW.entity_type
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    FOREACH v_key IN ARRAY ARRAY(SELECT jsonb_object_keys(NEW.patch)) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            -- NAMED, not merely refused. The proposer chose this field in a form; "invalid patch"
            -- would send them to an administrator to find out which one.
            RAISE EXCEPTION
                'column % is not proposable on %; proposable columns are: %',
                v_key, NEW.entity_type, array_to_string(v_allowed, ', ')
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
    END LOOP;

    -- ---------------------------------------------------------------------------------------------
    -- The target has to exist and be in service, and no foreign key can say so: `entity_id`
    -- addresses a different table depending on `entity_type`.
    -- ---------------------------------------------------------------------------------------------
    v_exists := CASE
        WHEN NEW.entity_type IN ('devices', 'device_nameplate') THEN
            EXISTS (SELECT 1 FROM public.devices d
                     WHERE d.id = NEW.entity_id AND d.is_archived = false)
        WHEN NEW.entity_type = 'areas' THEN
            EXISTS (SELECT 1 FROM public.areas a
                     WHERE a.id = NEW.entity_id AND a.is_archived = false)
        WHEN NEW.entity_type = 'cells' THEN
            EXISTS (SELECT 1 FROM public.cells c
                     WHERE c.id = NEW.entity_id AND COALESCE(c.is_archived, false) = false)
        WHEN NEW.entity_type = 'gateways' THEN
            EXISTS (SELECT 1 FROM public.gateways g
                     WHERE g.id = NEW.entity_id AND COALESCE(g.is_archived, false) = false)
        ELSE false
    END;

    IF NOT v_exists THEN
        RAISE EXCEPTION 'no live target % to propose a % change against',
            NEW.entity_id, NEW.entity_type
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END;
$$;

-- -------------------------------------------------------------------------------------------------
-- 3. A shadow follows its original
-- -------------------------------------------------------------------------------------------------
-- Invoker rights, like 0083's gate: the lanes are rows of the same table under the same policies as
-- the original, so whoever may archive or delete the original may do the same to its lanes. The
-- nested write reaches no lane of a lane -- nothing carries a `shadow_of` that names a lane.
CREATE OR REPLACE FUNCTION public.shadow_follows_its_original() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    -- BEFORE the row goes, so the lanes are deleted as themselves -- each with its own audit row
    -- and tombstone in this transaction -- rather than being SET NULL into a lane for nothing.
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public.devices WHERE shadow_of = OLD.id;
        RETURN OLD;
    END IF;

    -- ON THE TRANSITION, IN EITHER DIRECTION. `UPDATE OF is_archived` fires whenever the column
    -- appears in a SET list, and PostgREST sends the whole row on a PATCH.
    IF NEW.is_archived IS DISTINCT FROM COALESCE(OLD.is_archived, false) THEN
        UPDATE public.devices
           SET is_archived    = NEW.is_archived,
               archived_at    = NEW.archived_at,
               auto_delete_at = NEW.auto_delete_at
         WHERE shadow_of = NEW.id
           AND COALESCE(is_archived, false) IS DISTINCT FROM NEW.is_archived;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_follows_its_original() FROM PUBLIC;
GRANT ALL ON FUNCTION public.shadow_follows_its_original() TO service_role;

COMMENT ON FUNCTION public.shadow_follows_its_original() IS
    'Archiving, restoring or deleting a device does the same to every replay lane whose shadow_of names it: the lane carries the original''s archived_at and auto_delete_at, and goes before it on a delete. A lane is a recording of an asset, not a second asset, so it has no lifecycle of its own.';

DROP TRIGGER IF EXISTS trg_devices_shadow_follows_archive ON public.devices;
CREATE TRIGGER trg_devices_shadow_follows_archive
    AFTER UPDATE OF is_archived ON public.devices
    FOR EACH ROW EXECUTE FUNCTION public.shadow_follows_its_original();

DROP TRIGGER IF EXISTS trg_devices_shadow_follows_delete ON public.devices;
CREATE TRIGGER trg_devices_shadow_follows_delete
    BEFORE DELETE ON public.devices
    FOR EACH ROW EXECUTE FUNCTION public.shadow_follows_its_original();

-- -------------------------------------------------------------------------------------------------
-- 4. A deleted asset leaves a tombstone
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retired_entities (
    entity_type      text NOT NULL,
    entity_id        uuid NOT NULL,
    name             text,
    -- The historian's key. Telemetry outlives the row under this id until retention or the cold
    -- tier takes it, and nothing else on the platform can say which id that was.
    sparkplug_id     text,
    archived_at      timestamp with time zone,
    retired_at       timestamp with time zone DEFAULT now() NOT NULL,
    retired_by       uuid,
    -- In words at write time, as 0089 does for a proposal's author: the id alone resolves to
    -- nobody once the account is gone.
    retired_by_email text,
    -- The DELETE row in digital_thread, when it was found; NULL is "look it up by entity_id".
    thread_id        bigint,
    -- The whole row as it was, so the tombstone answers questions without the thread.
    old_data         jsonb NOT NULL,
    CONSTRAINT retired_entities_pkey PRIMARY KEY (entity_type, entity_id),
    CONSTRAINT retired_entities_type_known
        CHECK (entity_type = ANY (ARRAY['areas'::text, 'cells'::text, 'gateways'::text, 'devices'::text]))
);

COMMENT ON TABLE public.retired_entities IS
    'One row per asset that was archived and then deleted, written by record_retired_entity() on the DELETE. Not derived from digital_thread, which is partitioned for an eventual DETACH: a tombstone outlives the month that recorded the delete. Readable by whoever may read the Archived Entities page or the thread''s asset lane; written by nothing but the trigger.';
COMMENT ON COLUMN public.retired_entities.old_data IS
    'The deleted row, as the DELETE audit row carries it. A gateway''s forge repository is derived from it (gateway-<sparkplug_id>) as it is everywhere else.';

CREATE OR REPLACE FUNCTION public.record_retired_entity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_row    jsonb := to_jsonb(OLD);
    v_actor  uuid;
    v_email  text;
    v_thread bigint;
BEGIN
    -- ONLY A ROW THAT WENT THROUGH THE LIFECYCLE. A device rejected from quarantine, a fixture a
    -- suite removes, a row a cleanup migration deletes: none was in service, and a tombstone for
    -- it would be noise beside the ones that matter.
    IF NOT COALESCE((v_row ->> 'is_archived')::boolean, false) THEN
        RETURN OLD;
    END IF;

    -- Who, the way log_digital_thread_event() answers it: the session's user, else the actor a
    -- SECURITY DEFINER RPC declared with SET LOCAL.
    v_actor := auth.uid();
    IF v_actor IS NULL THEN
        BEGIN
            v_actor := NULLIF(current_setting('acs_cymru.actor_id', true), '')::uuid;
        EXCEPTION WHEN others THEN
            v_actor := NULL;
        END;
    END IF;
    v_email := NULLIF(auth.jwt() ->> 'email', '');

    -- The DELETE audit row this same event wrote. AFTER triggers on one event fire in name order
    -- and trg_<table>_retired sorts after trg_<table>_digital_thread, so it is there to find;
    -- looked up by the transaction rather than assumed, so a renamed trigger leaves this NULL
    -- rather than pointing at the wrong row.
    SELECT t.id INTO v_thread
      FROM public.digital_thread t
     WHERE t.entity_type = TG_TABLE_NAME
       AND t.entity_id = OLD.id
       AND t.action = 'DELETE'
       AND t.causation_id = txid_current()
     ORDER BY t.id DESC
     LIMIT 1;

    -- An upsert: a pinned-id fixture can be archived and deleted more than once, and the latest
    -- retirement is the one that describes the row.
    INSERT INTO public.retired_entities
        (entity_type, entity_id, name, sparkplug_id, archived_at, retired_at,
         retired_by, retired_by_email, thread_id, old_data)
    VALUES
        (TG_TABLE_NAME, OLD.id, v_row ->> 'name', v_row ->> 'sparkplug_id',
         (v_row ->> 'archived_at')::timestamp with time zone, now(),
         v_actor, v_email, v_thread, v_row)
    ON CONFLICT (entity_type, entity_id) DO UPDATE
       SET name             = EXCLUDED.name,
           sparkplug_id     = EXCLUDED.sparkplug_id,
           archived_at      = EXCLUDED.archived_at,
           retired_at       = EXCLUDED.retired_at,
           retired_by       = EXCLUDED.retired_by,
           retired_by_email = EXCLUDED.retired_by_email,
           thread_id        = EXCLUDED.thread_id,
           old_data         = EXCLUDED.old_data;

    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.record_retired_entity() FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_retired_entity() TO service_role;

COMMENT ON FUNCTION public.record_retired_entity() IS
    'Writes the retired_entities tombstone for an archived row on its DELETE. SECURITY DEFINER because the operator deleting the row holds no grant on the tombstone table, and it must not: a tombstone is evidence of a delete, not something a client writes.';

DROP TRIGGER IF EXISTS trg_areas_retired ON public.areas;
CREATE TRIGGER trg_areas_retired
    AFTER DELETE ON public.areas
    FOR EACH ROW EXECUTE FUNCTION public.record_retired_entity();

DROP TRIGGER IF EXISTS trg_cells_retired ON public.cells;
CREATE TRIGGER trg_cells_retired
    AFTER DELETE ON public.cells
    FOR EACH ROW EXECUTE FUNCTION public.record_retired_entity();

DROP TRIGGER IF EXISTS trg_gateways_retired ON public.gateways;
CREATE TRIGGER trg_gateways_retired
    AFTER DELETE ON public.gateways
    FOR EACH ROW EXECUTE FUNCTION public.record_retired_entity();

DROP TRIGGER IF EXISTS trg_devices_retired ON public.devices;
CREATE TRIGGER trg_devices_retired
    AFTER DELETE ON public.devices
    FOR EACH ROW EXECUTE FUNCTION public.record_retired_entity();

ALTER TABLE public.retired_entities ENABLE ROW LEVEL SECURITY;

-- The page's gate, or the thread's asset lane: a tombstone says nothing the DELETE audit row does
-- not, so anyone who may read that row may read this one. No write policy at all -- the trigger
-- is the only writer and it is SECURITY DEFINER.
DROP POLICY IF EXISTS retired_entities_select_privileged ON public.retired_entities;
CREATE POLICY retired_entities_select_privileged ON public.retired_entities
    FOR SELECT TO authenticated
    USING (public.has_authority(ARRAY['archive:manage'::text, 'digital_thread:read'::text]));

REVOKE ALL ON TABLE public.retired_entities FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.retired_entities TO authenticated;
GRANT ALL ON TABLE public.retired_entities TO service_role;

-- -------------------------------------------------------------------------------------------------
-- 5. An asset can be taken away before it is taken out of service
-- -------------------------------------------------------------------------------------------------
-- One row per bundle aas-export stored: the AASX with the thread, the live telemetry and a manifest
-- naming the cold objects, written to the cold tier's bucket under assets/<sparkplug_id>/. No
-- foreign key to devices, on purpose: the row this describes is expected to be deleted later, and
-- the export is the thing that survives it.
CREATE TABLE IF NOT EXISTS public.asset_exports (
    id             uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    entity_type    text DEFAULT 'devices'::text NOT NULL,
    entity_id      uuid NOT NULL,
    name           text,
    sparkplug_id   text,
    format         text DEFAULT 'aasx'::text NOT NULL,
    object_bucket  text NOT NULL,
    object_key     text NOT NULL,
    object_bytes   bigint,
    sha256         text,
    -- What the bundle holds and what it could not: row counts, caps hit, the horizons it read.
    stats          jsonb DEFAULT '{}'::jsonb NOT NULL,
    taken_at       timestamp with time zone DEFAULT now() NOT NULL,
    taken_by       uuid,
    taken_by_email text,
    CONSTRAINT asset_exports_type_known CHECK (entity_type = 'devices'::text),
    CONSTRAINT asset_exports_format_valid CHECK (format = 'aasx'::text),
    CONSTRAINT asset_exports_object_unique UNIQUE (object_bucket, object_key)
);

CREATE INDEX IF NOT EXISTS asset_exports_entity_idx ON public.asset_exports (entity_id, taken_at DESC);

COMMENT ON TABLE public.asset_exports IS
    'Each per-asset bundle aas-export stored: an AASX carrying the shell, the digital thread, the telemetry still in the live historian and a manifest naming the cold objects that hold the rest. A sibling of the cold tier that shares its bucket, and not a row in the historian''s manifest, which is keyed by chunk and exists to make dropping one safe. Readable by the three roles the bucket admits; written by the function alone.';

ALTER TABLE public.asset_exports ENABLE ROW LEVEL SECURITY;

-- THE SAME THREE ROLES THE BUCKET ADMITS (telemetry_archive_read_privileged), so a row never names
-- an object its reader cannot fetch.
DROP POLICY IF EXISTS asset_exports_select_privileged ON public.asset_exports;
CREATE POLICY asset_exports_select_privileged ON public.asset_exports
    FOR SELECT TO authenticated
    USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]));

REVOKE ALL ON TABLE public.asset_exports FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.asset_exports TO authenticated;
GRANT ALL ON TABLE public.asset_exports TO service_role;

-- The act reaches the thread as EXPORTED. Written here rather than by the audit trigger: the
-- function writes as service_role, whose row would name nobody, and it has already verified the
-- person it acts for. stamp_audit_domain() files it under the asset lane.
CREATE OR REPLACE FUNCTION public.log_asset_export() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    INSERT INTO public.digital_thread
        (entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
         causation_id, recorded_at)
    VALUES
        (NEW.entity_type, NEW.entity_id, 'EXPORTED', NULL, to_jsonb(NEW), NEW.taken_by,
         CASE WHEN NEW.taken_by IS NULL THEN 'service' ELSE 'user' END,
         txid_current(), NEW.taken_at);
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.log_asset_export() FROM PUBLIC;
GRANT ALL ON FUNCTION public.log_asset_export() TO service_role;

COMMENT ON FUNCTION public.log_asset_export() IS
    'Records an asset_exports row in digital_thread as EXPORTED, attributed to the person the function verified. The one thread row that survives the entity in a form the tombstone can link to.';

DROP TRIGGER IF EXISTS trg_asset_exports_digital_thread ON public.asset_exports;
CREATE TRIGGER trg_asset_exports_digital_thread
    AFTER INSERT ON public.asset_exports
    FOR EACH ROW EXECUTE FUNCTION public.log_asset_export();

-- -------------------------------------------------------------------------------------------------
-- 6. Self-check
-- -------------------------------------------------------------------------------------------------
-- Properties, never totals.
DO $$
DECLARE
    v_missing text[] := ARRAY[]::text[];
    v_job     text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'areas' AND column_name = 'auto_delete_at'
    ) THEN
        v_missing := v_missing || 'areas has no auto_delete_at column';
    END IF;

    SELECT command INTO v_job FROM cron.job WHERE jobname = 'purge_expired_archives';
    IF v_job IS NULL THEN
        v_missing := v_missing || 'purge_expired_archives is not scheduled';
    ELSIF position('DELETE FROM public.areas' IN v_job) = 0 THEN
        v_missing := v_missing || 'purge_expired_archives does not delete areas (0002 carries the job)';
    ELSIF position('DELETE FROM public.areas' IN v_job) < position('DELETE FROM public.cells' IN v_job) THEN
        v_missing := v_missing || 'purge_expired_archives deletes areas before cells';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_devices_shadow_follows_delete'
           AND tgrelid = 'public.devices'::regclass AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_devices_shadow_follows_archive'
           AND tgrelid = 'public.devices'::regclass AND NOT tgisinternal
    ) THEN
        v_missing := v_missing || 'a shadow does not follow its original';
    END IF;

    IF (SELECT count(*) FROM pg_trigger
         WHERE tgname IN ('trg_areas_retired', 'trg_cells_retired', 'trg_gateways_retired', 'trg_devices_retired')
           AND NOT tgisinternal) <> 4 THEN
        v_missing := v_missing || 'not every asset table writes a tombstone';
    END IF;

    -- A tombstone is evidence of a delete, and nothing a client writes.
    IF EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'retired_entities' AND cmd <> 'SELECT'
    ) THEN
        v_missing := v_missing || 'retired_entities has a write policy';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname IN ('retired_entities', 'asset_exports')
           AND c.relrowsecurity
        GROUP BY n.nspname HAVING count(*) = 2
    ) THEN
        v_missing := v_missing || 'retired_entities or asset_exports has RLS off';
    END IF;

    IF array_length(v_missing, 1) IS NOT NULL THEN
        RAISE EXCEPTION '0124 self-check failed: %', array_to_string(v_missing, '; ');
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
