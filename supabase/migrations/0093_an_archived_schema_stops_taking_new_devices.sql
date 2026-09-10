-- =================================================================================================
-- 0093 :: AN ARCHIVED SCHEMA STOPS TAKING NEW DEVICES
-- =================================================================================================
--
-- `publish_schema_version()` repoints every device onto the new version before archiving the
-- parent, so no device is judged against a superseded contract; nothing stopped an operator
-- putting one back afterwards from the Edit Details dialog. Reattaching v1 to a machine
-- publishing v2's metrics makes every added metric Unmodelled, and under
-- `conformance_policy = 'enforce'` the daemon drops readings from a healthy machine.
--
-- WHAT IS FORBIDDEN IS THE MOVE, NOT THE STATE. A device sitting on an archived schema is a
-- migration that has not finished, and `/v1/schema/{uuid}` deliberately reports it. Rejected:
-- an INSERT naming an archived schema, and an UPDATE that changes schema_id to one. Allowed: an
-- UPDATE that leaves schema_id where it was, so renaming such a device still works. A draft
-- stays assignable: attaching a draft to one device is how a version is tried before publishing.
-- Shadow devices are exempt: `ensure_shadow_devices()` copies the origin's contract, and a
-- replay lane must be able to mirror an unfinished migration.
--
-- A trigger, not a CHECK (cannot see another table), a policy (bypassed by every SECURITY
-- DEFINER path, including the proposal lane) or the UI alone (`assignableSchemas()` in
-- frontend/src/utils/schemaVersion.js fixes the dropdown, but PostgREST is a public write
-- surface).
-- =================================================================================================

CREATE OR REPLACE FUNCTION public.reject_archived_schema_assignment() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_device_id  uuid;
    v_is_shadow  boolean := false;
    v_status     text;
    v_name       text;
    v_version    integer;
    v_successor  text;
BEGIN
    -- One function, two tables: `devices.schema_id` and `device_submodels.schema_id` are the two
    -- arms of the `device_schemas` view, and a guard on one of them is not a guard.
    IF TG_TABLE_NAME = 'devices' THEN
        v_device_id := NEW.id;
        -- READ OFF `NEW`, NOT OUT OF THE TABLE. On INSERT the row is not visible to a query yet,
        -- so a lookup would report "not a shadow" for every shadow device at the moment it is
        -- created -- which is the only moment ensure_shadow_devices() writes this column.
        v_is_shadow := NEW.shadow_of IS NOT NULL;
    ELSE
        v_device_id := NEW.device_id;
        -- The submodel rows are written AFTER the shadow device exists, so here the lookup is both
        -- possible and necessary -- the join row carries no shadow marker of its own.
        SELECT d.shadow_of IS NOT NULL INTO v_is_shadow
          FROM public.devices d WHERE d.id = v_device_id;
    END IF;

    -- Detaching is always allowed. So is leaving the pointer exactly where it was: see the header
    -- for why the unchanged-value case is the one that keeps an unfinished migration editable.
    IF NEW.schema_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.schema_id IS NOT DISTINCT FROM OLD.schema_id THEN
        RETURN NEW;
    END IF;

    IF coalesce(v_is_shadow, false) THEN
        RETURN NEW;
    END IF;

    SELECT s.status::text, s.schema_name, s.version
      INTO v_status, v_name, v_version
      FROM public.schemas s
     WHERE s.id = NEW.schema_id;

    -- A schema_id naming nothing is left to the foreign key, which states that better than this
    -- trigger could. `IS DISTINCT FROM` rather than `<>` so a NULL status falls through here too.
    IF v_status IS DISTINCT FROM 'archived' THEN
        RETURN NEW;
    END IF;

    -- THE ERROR NAMES THE WAY OUT, because the operator reaching this is not doing something
    -- absurd -- they are looking at a version history and picked the wrong row. The successor is
    -- resolved here rather than left for them to find: it is one query, and "use v2 instead" is
    -- the entire remedy in most cases.
    SELECT s.schema_name INTO v_successor
      FROM public.schemas s
     WHERE s.parent_schema_id = NEW.schema_id
       AND s.status::text = 'active'
     ORDER BY s.version DESC
     LIMIT 1;

    RAISE EXCEPTION
        'schema "%" (v%) is archived and cannot be assigned to a device',
        v_name, v_version
        USING ERRCODE = 'check_violation',
              HINT = coalesce(
                  'Assign ' || v_successor || ', which replaced it.',
                  'This lineage has no active version. Publish one from the Schemas page, or leave '
                  'the device without a schema.'
              );
END;
$$;

COMMENT ON FUNCTION public.reject_archived_schema_assignment() IS 'Refuses a NEW binding of a device to an archived schema, on either arm of the device_schemas view. Leaving an existing binding in place is allowed -- an archived schema with devices still attached is an unfinished migration, not a fault -- and shadow devices are exempt because they copy the contract of the device they replay. Issue #167.';

-- A trigger function needs no EXECUTE grant, but a bare CREATE FUNCTION leaves EXECUTE to
-- PUBLIC, so `anon` may call it. 0001's sweeper runs before this file, so the ACL would only be
-- corrected on the next boot, which check-migration-idempotency.mjs catches. A migration that
-- creates a function states its own grants.
REVOKE ALL ON FUNCTION public.reject_archived_schema_assignment() FROM PUBLIC, anon;

-- -------------------------------------------------------------------------------------------------
-- The two triggers
-- -------------------------------------------------------------------------------------------------
-- BEFORE, so the row never lands. `UPDATE OF schema_id` keeps a heartbeat or status write on a
-- device that sits on an archived schema out of the function.
DROP TRIGGER IF EXISTS trg_devices_reject_archived_schema ON public.devices;
CREATE TRIGGER trg_devices_reject_archived_schema
    BEFORE INSERT OR UPDATE OF schema_id ON public.devices
    FOR EACH ROW EXECUTE FUNCTION public.reject_archived_schema_assignment();

DROP TRIGGER IF EXISTS trg_device_submodels_reject_archived_schema ON public.device_submodels;
CREATE TRIGGER trg_device_submodels_reject_archived_schema
    BEFORE INSERT OR UPDATE OF schema_id ON public.device_submodels
    FOR EACH ROW EXECUTE FUNCTION public.reject_archived_schema_assignment();

-- -------------------------------------------------------------------------------------------------
-- Self-check
-- -------------------------------------------------------------------------------------------------
-- Exercises the guard rather than counting anything (docs/incidents.md, "Self-checks must not
-- count totals"): creates an archived schema, tries to attach a device, reads the outcome, and
-- rolls every row back. It fails only if the INSERT is accepted; a refusal for some other reason
-- is inconclusive and says so.
DO $selfcheck$
DECLARE
    v_probe_schema uuid := gen_random_uuid();
    v_outcome      text;
BEGIN
    BEGIN
        INSERT INTO public.schemas (id, schema_name, schema_definition, status)
        VALUES (v_probe_schema, '0093 self-check probe', '{"metrics": []}'::jsonb, 'archived');

        INSERT INTO public.devices (name, schema_id)
        VALUES ('0093 self-check probe', v_probe_schema);

        -- Reached only if the guard let it through. Recorded BEFORE unwinding, because plpgsql
        -- variables survive the rollback of the block that assigned them and the rows do not.
        v_outcome := 'accepted';
        RAISE EXCEPTION 'unwinding the 0093 probe' USING ERRCODE = 'raise_exception';
    EXCEPTION
        WHEN check_violation THEN
            v_outcome := 'rejected';
        WHEN OTHERS THEN
            IF v_outcome IS NULL THEN
                v_outcome := 'inconclusive: ' || SQLERRM;
            END IF;
    END;

    IF v_outcome = 'accepted' THEN
        RAISE EXCEPTION
            '0093 self-check: a device was attached to an archived schema. The trigger is not in '
            'force, which is the whole of issue #167.';
    ELSIF v_outcome = 'rejected' THEN
        RAISE NOTICE
            '0093: an archived schema no longer takes new devices; existing bindings are untouched.';
    ELSE
        RAISE NOTICE
            '0093 self-check could not run (%). The triggers are installed; the probe is not '
            'evidence either way.', v_outcome;
    END IF;
END
$selfcheck$;
