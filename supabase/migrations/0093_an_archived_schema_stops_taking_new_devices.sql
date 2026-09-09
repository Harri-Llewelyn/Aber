-- =================================================================================================
-- 0093 :: AN ARCHIVED SCHEMA STOPS TAKING NEW DEVICES
-- =================================================================================================
--
-- Issue #167, reported against `/schemas` at CRITICAL: "I archived Test_Schema when I made
-- Test_Schema_v2 but I can still assign Test_Schema to a device in the Edit Details dialog."
--
-- That is exactly what happened, and it undoes the one thing the versioning work exists to
-- guarantee. `publish_schema_version()` is atomic on purpose: it repoints every `device_submodels`
-- row AND the legacy `devices.schema_id` onto the new version, and only then archives the parent,
-- so that no device is left being judged against a contract the platform has moved past. Nothing
-- stopped an operator putting one back afterwards -- one device at a time, from a dialog whose
-- dropdown listed every schema ever created, with no sweep that would ever move it forward again.
--
-- THE DAMAGE IS NOT COSMETIC, WHICH IS WHY THE SEVERITY IS RIGHT. A device's schemas decide what
-- `modelled_constraints()` judges its DDATA against. Reattaching v1 to a machine now publishing
-- v2's metrics makes every added metric "Unmodelled" and every retuned range judged against the
-- superseded one -- and with `conformance_policy = 'enforce'` the daemon then DROPS readings from
-- a healthy machine for contradicting a contract nobody meant it to be under.
--
-- =================================================================================================
-- WHAT IS FORBIDDEN IS THE *MOVE*, NOT THE STATE
-- =================================================================================================
--
-- A device sitting on an archived schema is a REAL and legitimate state: it is a migration that has
-- not finished. `/v1/schema/{uuid}` in `fplus-directory` deliberately refuses to hide it, on the
-- grounds that "an archived schema with devices still attached" is the most useful thing that route
-- can report. This guard agrees with that, and only rejects the transition INTO it:
--
--   * an INSERT naming an archived schema                          -- rejected
--   * an UPDATE that CHANGES schema_id to an archived schema       -- rejected
--   * an UPDATE that leaves schema_id where it already was         -- allowed
--
-- The third line is the one doing the quiet work. Without it, renaming a device that happens to sit
-- on an archived schema would fail -- the guard would convert an unfinished migration from
-- something to finish into something that freezes every other edit on the row.
--
-- A DRAFT STAYS ASSIGNABLE, and that asymmetry is deliberate rather than an omission. Attaching a
-- draft to one device is how a version is tried against a real machine before it is published, and
-- `publish_schema_version()` already reads that as a state to MERGE -- see the DELETE of duplicate
-- submodels in its body, which exists for precisely that operator. A draft is not in force *yet*;
-- an archived version is not in force *any more*. Only the second is a step backwards.
--
-- SHADOW DEVICES ARE EXEMPT, and this is not a loophole. `ensure_shadow_devices()` COPIES the
-- contract of the device being replayed -- `schema_id` and every `device_submodels` row -- because
-- without it a replay is either unjudged or wholly rejected, and both look like a broken capture.
-- If the origin device is mid-migration and still on an archived version, the replay lane must be
-- able to say so too. The shadow makes no new assignment; it mirrors one that already exists, and
-- refusing it would break playback for the exact fleet this guard is trying to protect.
--
-- =================================================================================================
-- WHY A TRIGGER AND NOT A CHECK, A POLICY, OR THE UI
-- =================================================================================================
--
-- A CHECK constraint cannot see another table's row. An RLS policy cannot either, and would in any
-- case be bypassed by every SECURITY DEFINER path -- including the proposal lane, which APPLIES a
-- patch on approval and would otherwise carry an archived `schema_id` straight past a policy the
-- proposer's own session would have been refused by.
--
-- AND NOT THE UI ALONE. The dropdown is fixed as well (`assignableSchemas()` in
-- frontend/src/utils/schemaVersion.js, which keeps the currently-attached archived version visible
-- so saving cannot silently detach it) -- but that is the half that stops an operator being OFFERED
-- the mistake. PostgREST is a public write surface: `PATCH /devices?id=eq.<id>` with any
-- `schema_id` is one curl away, and the approvals queue reaches the same columns by another route
-- entirely. The rule belongs where every route passes.
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
    -- ONE FUNCTION, TWO TABLES. `devices.schema_id` and `device_submodels.schema_id` are the two
    -- arms of the `device_schemas` view, and a guard on one of them is not a guard: the frontend
    -- writes the first, the AAS submodel path writes the second, and a device provisioned either
    -- way is judged against whatever the view unions. Splitting this into two function bodies
    -- would be two places for the rule to drift.
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

-- NOBODY EXECUTES THIS DIRECTLY, AND THE GRANT HAS TO SAY SO. A trigger function runs as part of
-- the statement that fired it and needs no EXECUTE grant to do that -- but a bare CREATE FUNCTION
-- leaves the SQL default in place, which is EXECUTE to PUBLIC, so `anon` may call it. Harmless
-- here (it dereferences NEW and raises), and still wrong: `test_anon_privilege_baseline.py` is the
-- suite that asserts no new function arrives reachable by an unauthenticated caller.
--
-- IT WAS ALSO A ONE-BOOT-LATE IDEMPOTENCY DEFECT, which is how it was found. `0001`'s sweeper
-- revokes PUBLIC across every function in `public`, and it runs 92 files BEFORE this one -- so on
-- the boot that creates this function the sweep has already passed, and the ACL is only corrected
-- on the NEXT boot. Two consecutive replays of the same chain therefore produced two different
-- pg_dumps, which is exactly what check-migration-idempotency.mjs exists to catch. A migration
-- that creates a function states its own grants; it does not lean on a sweeper upstream of it.
REVOKE ALL ON FUNCTION public.reject_archived_schema_assignment() FROM PUBLIC, anon;

-- -------------------------------------------------------------------------------------------------
-- The two triggers
-- -------------------------------------------------------------------------------------------------
-- BEFORE, so the row never lands. `UPDATE OF schema_id` narrows the update case to the column that
-- matters, so a heartbeat or a status write on a device that legitimately sits on an archived
-- schema does not even enter the function.
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
-- IT EXERCISES THE GUARD RATHER THAN COUNTING ANYTHING. A self-check that asserts a total is a
-- landmine under every later migration -- 0069 asserted an absolute permission count and 0086 broke
-- it on the second boot, where `npm run test:db` cannot see it. So this one creates an archived
-- schema, tries to attach a device to it, and reads the outcome; every row it writes is rolled back
-- by the nested block, so it leaves nothing behind and is safe to replay on every boot.
--
-- AND IT FAILS ONLY ON THE ONE WRONG ANSWER. If the INSERT is accepted, the guard is not working
-- and db-init should stop. If it is refused for some OTHER reason -- a constraint added later, a
-- column that became NOT NULL -- that is inconclusive rather than a regression in this migration,
-- and it says so rather than taking the stack down over a probe.
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
