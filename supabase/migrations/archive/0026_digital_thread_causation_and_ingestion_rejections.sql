-- =============================================================================================
-- Migration: 0026_digital_thread_causation_and_ingestion_rejections.sql
-- Say which audit rows were one act, and give the ingestion daemon a way to record a refusal
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- TWO CHANGES, related by what the Digital Thread could not previously answer.
--
--   1. CAUSATION. Every audit row named an entity and an actor, and nothing tied two rows
--      together. One operator action routinely writes several: approving a quarantined device
--      updates the device AND rebinds its schema, and a cell deletion cascades. Read back, those
--      arrive as N independent events that merely happen to share a second. There was no way to
--      say "these were one act", so a reviewer reconstructed it from timestamps -- which is
--      guesswork the moment two operators work at once.
--
--      `txid_current()` is the answer already sitting in the session. Every row a single
--      transaction writes shares it, and it costs nothing to obtain -- the trigger is already
--      inside the transaction whose id it is asking for.
--
--      NOT A UUID ISSUED PER STATEMENT, which was the obvious alternative. A uuid would have to be
--      supplied by the caller and threaded through every write path, so every path that forgot
--      would silently record nothing. The transaction id is supplied by PostgreSQL and cannot be
--      forgotten. Its limits are stated on the column comment rather than left to be discovered.
--
--   2. A RECORDED REFUSAL. The daemon drops Sparkplug metrics for reasons that are facts about the
--      ASSET -- a metric whose alias no birth certificate declares, a timestamp from a broken
--      clock, a value whose type contradicts the schema the device is judged against. Every one of
--      those was a `logger.warning` and nothing else: gone the moment the container restarted, and
--      absent from the one table that is supposed to hold what happened to this machine.
--
--      `record_ingestion_rejection()` is how the daemon writes it down. The row lands in
--      `digital_thread` like any other, so it inherits append-only enforcement (0003), attribution
--      (0005) and the entire read path the dashboard already has.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE RPC EXISTS RATHER THAN AN INSERT FROM PYTHON. `service_role` holds GRANT ALL on
-- `digital_thread`, so the daemon COULD insert directly -- the append-only trigger guards UPDATE
-- and DELETE, not INSERT. That is exactly the problem: a direct insert lets any holder of the
-- service key write an audit row saying anything, including `actor_source = 'user'` with a
-- `changed_by` naming an operator who was not there. A SECURITY DEFINER function that PINS the
-- actor, pins the action and refuses an unknown device is a narrow gate; section 4 revokes the
-- wide grant so the gate is the only way through.
-- =============================================================================================

SET check_function_bodies = false;


-- ---------------------------------------------------------------------------------------------
-- 1. Causation column
-- ---------------------------------------------------------------------------------------------
-- bigint because `txid_current()` returns bigint -- a 64-bit epoch-extended counter, NOT the
-- 32-bit xid that wraps. `pg_current_xact_id()` (PG13+) is the non-deprecated spelling of the same
-- number, but it returns xid8, which has no btree opclass and therefore cannot carry the index
-- below. bigint can, and the value is identical.
ALTER TABLE public.digital_thread ADD COLUMN IF NOT EXISTS causation_id bigint;

COMMENT ON COLUMN public.digital_thread.causation_id IS
  'The transaction that wrote this row (txid_current()). Rows sharing it were written by ONE act '
  '-- an operator approval that also rebound a schema, a delete that cascaded. NOT a global '
  'identifier: it is unique only within this database, and only until the epoch counter is reset '
  'by a restore from a dump. Group by it; never store it as a foreign reference.';

-- Partial rather than plain: every row written before this migration has a NULL causation and
-- there is no honest value to backfill, because those transactions are long over. Excluding them
-- keeps the index proportional to the rows that can actually be grouped by it.
CREATE INDEX IF NOT EXISTS idx_digital_thread_causation
    ON public.digital_thread (causation_id)
    WHERE causation_id IS NOT NULL;


-- ---------------------------------------------------------------------------------------------
-- 2. The trigger, re-declared to stamp causation
-- ---------------------------------------------------------------------------------------------
-- REPRODUCED IN FULL FROM 0005, not patched. There is no applied-migrations ledger: every file is
-- replayed on every boot in filename order, so the LAST `CREATE OR REPLACE FUNCTION` of this name
-- is the one that runs. A partial redefinition here would silently drop 0005's suppression guard
-- and its attribution logic, and the only symptom would be the audit table growing again -- which
-- is precisely the regression `test_digital_thread_guard.py` exists to catch.
--
-- The ONLY differences from 0005 are the two lines naming causation_id.
CREATE OR REPLACE FUNCTION public.log_digital_thread_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_old_data  JSONB := NULL;
    v_new_data  JSONB := NULL;
    v_entity_id UUID;
    v_actor     UUID;
    v_source    TEXT;
    v_declared  TEXT;
    v_role      TEXT;
BEGIN
    -- -----------------------------------------------------------------------------------------
    -- Suppression. UPDATE only: an INSERT or DELETE is always an event.
    -- -----------------------------------------------------------------------------------------
    -- ONE comparison covers both cases, because subtracting a key that is absent is a no-op:
    --
    --   * rows identical            -> equal with or without last_heartbeat  -> a no-op write
    --   * only last_heartbeat moved -> equal once it is removed              -> liveness telemetry
    --
    -- `IS NOT DISTINCT FROM` rather than `=` so a NULL on either side compares as equal instead
    -- of yielding NULL and falling through to log the row.
    IF TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - 'last_heartbeat') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'last_heartbeat')
    THEN
        RETURN NEW;
    END IF;

    IF (TG_OP = 'DELETE') THEN
        v_old_data := to_jsonb(OLD);
        v_entity_id := OLD.id;
    ELSIF (TG_OP = 'UPDATE') THEN
        v_old_data := to_jsonb(OLD);
        v_new_data := to_jsonb(NEW);
        v_entity_id := NEW.id;
    ELSIF (TG_OP = 'INSERT') THEN
        v_new_data := to_jsonb(NEW);
        v_entity_id := NEW.id;
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- Who
    -- -----------------------------------------------------------------------------------------
    v_actor := auth.uid();

    IF v_actor IS NULL THEN
        -- Set with SET LOCAL by a SECURITY DEFINER RPC acting on a user's behalf -- the
        -- approve-quarantine path, where the request arrives on the service-role key but a
        -- specific operator authorised it. See 0003.
        BEGIN
            v_actor := NULLIF(current_setting('acs_cymru.actor_id', true), '')::UUID;
        EXCEPTION WHEN others THEN
            v_actor := NULL;
        END;
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- What kind of actor
    -- -----------------------------------------------------------------------------------------
    IF v_actor IS NOT NULL THEN
        v_source := 'user';
    ELSE
        -- A caller may declare itself with an `X-ACS-Cymru-Actor` request header, which
        -- PostgREST exposes as request.headers. That is how the ingestion daemon is told apart
        -- from an edge function -- both arrive on the same service-role key, so the connection
        -- alone cannot distinguish them.
        BEGIN
            v_declared := NULLIF(
                current_setting('request.headers', true)::json ->> 'x-acs-cymru-actor', ''
            );
        EXCEPTION WHEN others THEN
            v_declared := NULL;
        END;

        IF v_declared IN ('ingestion', 'service', 'migration') THEN
            -- 'user' is deliberately NOT accepted from a header: claiming a human author is
            -- exactly the assertion a client must not be able to make about itself.
            v_source := v_declared;
        ELSE
            -- WHICH ROLE IS CALLING, and NOT `current_user`. This function is SECURITY DEFINER,
            -- so inside it `current_user` is the function's OWNER -- always `postgres` -- which
            -- silently labelled every ingestion write as 'migration'. PostgREST connects as
            -- `authenticator` and then SET ROLEs, so the effective role is what `role` holds;
            -- a direct psql session never SET ROLE at all and reports 'none', where
            -- `session_user` is the honest answer.
            v_role := NULLIF(current_setting('role', true), 'none');
            IF v_role IS NULL OR v_role = '' THEN
                v_role := session_user;
            END IF;

            IF v_role IN ('postgres', 'supabase_admin') THEN
                v_source := 'migration';
            ELSE
                -- service_role with nothing declared: automation we cannot name more precisely.
                v_source := 'service';
            END IF;
        END IF;
    END IF;

    INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        TG_TABLE_NAME, v_entity_id, TG_OP, v_old_data, v_new_data, v_actor, v_source,
        txid_current(), NOW()
    );

    RETURN COALESCE(NEW, OLD);
END;
$fn$;

REVOKE ALL ON FUNCTION public.log_digital_thread_event() FROM PUBLIC;
GRANT ALL ON FUNCTION public.log_digital_thread_event() TO service_role;


-- ---------------------------------------------------------------------------------------------
-- 3. The recorded refusal
-- ---------------------------------------------------------------------------------------------
-- `action` has always held TG_OP -- INSERT / UPDATE / DELETE -- and this adds a fourth value that
-- no trigger can produce. It is deliberately NOT another TG_OP-shaped word: a reader filtering
-- `action IN ('INSERT','UPDATE','DELETE')` keeps working and simply does not see these, and a
-- reader that wants them has to ask for them by name.
--
-- THE PAYLOAD GOES IN `new_data`, `old_data` STAYS NULL. That is the same shape an INSERT has, and
-- it is the honest one: a rejection has no prior state. `frontend/.../DigitalThreadTab.jsx` renders
-- a one-sided snapshot for exactly this case already.
--
-- WHAT IT IS NOT. This is not a validation ENGINE. The daemon decides what conforms; this records
-- the verdict. Keeping the judgement in Python and the record in SQL is the same split the
-- quarantine path already uses, and it is what stops a schema edit having to be a migration.

CREATE OR REPLACE FUNCTION public.record_ingestion_rejection(
    p_device_id   uuid,
    p_violations  jsonb,
    p_observed_at timestamptz DEFAULT now()
) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_device     RECORD;
    v_count      INTEGER;
    v_id         BIGINT;
    -- A CAP, not a guess. The daemon already deduplicates per device, but a payload with a
    -- thousand unmodelled metrics would otherwise put a thousand objects into one jsonb column of
    -- an append-only table that cannot be pruned. Fifty names is far more than an operator will
    -- read and enough to diagnose any real fault; the total is recorded separately so the
    -- truncation is visible rather than silent.
    c_max_listed CONSTANT INTEGER := 50;
BEGIN
    IF p_device_id IS NULL THEN
        RAISE EXCEPTION 'record_ingestion_rejection: p_device_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF jsonb_typeof(p_violations) <> 'array' THEN
        RAISE EXCEPTION 'record_ingestion_rejection: p_violations must be a JSON array, got %',
            coalesce(jsonb_typeof(p_violations), 'null')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_count := jsonb_array_length(p_violations);
    IF v_count = 0 THEN
        -- Nothing was refused, so there is nothing to record. Returning NULL rather than raising:
        -- the daemon computing an empty violation list is the ordinary healthy case, and a caller
        -- should not have to guard against its own success.
        RETURN NULL;
    END IF;

    -- FAIL ON AN UNKNOWN DEVICE rather than writing an audit row about an entity that does not
    -- exist. `entity_id` is a bare uuid with no foreign key -- deliberately, so history survives a
    -- purge -- which means nothing else would catch a typo'd id, and the row would sit in the
    -- thread forever describing nothing.
    SELECT id, name, sparkplug_id, schema_id INTO v_device
      FROM public.devices WHERE id = p_device_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_ingestion_rejection: no device with id %', p_device_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'devices',
        v_device.id,
        'SCHEMA_REJECTION',
        NULL,
        jsonb_build_object(
            -- The identity as it was AT THE TIME. `name` is mutable and the device may later be
            -- renamed or purged; an audit row that could only be read by joining to a live row
            -- would lose its meaning in exactly the cases it matters most.
            'name',            v_device.name,
            'sparkplug_id',    v_device.sparkplug_id,
            'schema_id',       v_device.schema_id,
            'observed_at',     p_observed_at,
            'violation_count', v_count,
            'violations',      CASE
                                 WHEN v_count <= c_max_listed THEN p_violations
                                 ELSE (
                                   SELECT jsonb_agg(value)
                                     FROM jsonb_array_elements(p_violations) WITH ORDINALITY t(value, n)
                                    WHERE n <= c_max_listed
                                 )
                               END,
            'truncated',       v_count > c_max_listed
        ),
        NULL,
        -- PINNED, not taken from a header. This function is the daemon's only route into the
        -- table, and what it records about the author is not negotiable by its caller.
        'ingestion',
        txid_current(),
        now()
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$fn$;

COMMENT ON FUNCTION public.record_ingestion_rejection(uuid, jsonb, timestamptz) IS
  'Record a Sparkplug payload the ingestion daemon refused, as a SCHEMA_REJECTION row in '
  'digital_thread. The violation list is capped at 50 entries with the true count kept alongside. '
  'actor_source is pinned to ''ingestion'' and changed_by to NULL: this is the narrow gate that '
  'replaces service_role''s direct INSERT on the audit table.';

REVOKE ALL ON FUNCTION public.record_ingestion_rejection(uuid, jsonb, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_ingestion_rejection(uuid, jsonb, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ingestion_rejection(uuid, jsonb, timestamptz) TO service_role;


-- ---------------------------------------------------------------------------------------------
-- 4. Close the direct-INSERT path the RPC replaces
-- ---------------------------------------------------------------------------------------------
-- 0003 made the table append-only by rejecting UPDATE and DELETE. INSERT was left alone because
-- the trigger was the only thing inserting, and it runs SECURITY DEFINER as the owner -- so
-- `service_role`'s INSERT privilege was unused rather than needed.
--
-- It stops being unused the moment a daemon has a reason to write an audit row. Revoking it now
-- means the reason it has is the RPC above, which pins the actor; leaving it would mean the RPC is
-- a convention rather than a boundary, and a convention is not what an audit trail rests on.
--
-- SELECT is untouched: reading its own writes back is ordinary. The trigger is unaffected -- a
-- SECURITY DEFINER function executes with its owner's privileges, not its caller's, which is the
-- same indirection that lets `powerbi_reader` read a rollup over a hypertable it cannot select.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.digital_thread FROM service_role;
REVOKE ALL ON SEQUENCE public.digital_thread_id_seq FROM service_role;


-- ---------------------------------------------------------------------------------------------
-- 5. Self-check
-- ---------------------------------------------------------------------------------------------
-- Every assertion here is about something that would otherwise fail silently and late: a column
-- that did not apply, a trigger body that lost the stamp on a re-declaration, or a grant that
-- reopened the direct write path.
DO $selfcheck$
DECLARE
    v_src TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'digital_thread'
           AND column_name = 'causation_id'
    ) THEN
        RAISE EXCEPTION '0026 self-check: digital_thread.causation_id was not added';
    END IF;

    SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'log_digital_thread_event';
    IF v_src IS NULL THEN
        RAISE EXCEPTION '0026 self-check: log_digital_thread_event() is not defined';
    END IF;

    IF position('txid_current()' IN v_src) = 0 THEN
        RAISE EXCEPTION
            '0026 self-check: log_digital_thread_event() does not stamp causation_id. A later '
            'migration has re-declared it without the stamp.';
    END IF;

    -- The suppression guard from 0005, re-asserted here because THIS file is now the last
    -- declaration and is therefore the one that has to carry it.
    IF position('last_heartbeat' IN v_src) = 0 THEN
        RAISE EXCEPTION
            '0026 self-check: log_digital_thread_event() lost the 0005 heartbeat suppression '
            'guard in this re-declaration.';
    END IF;

    IF has_table_privilege('service_role', 'public.digital_thread', 'INSERT') THEN
        RAISE EXCEPTION
            '0026 self-check: service_role can still INSERT into digital_thread directly, which '
            'defeats record_ingestion_rejection() as a boundary';
    END IF;

    IF NOT has_function_privilege(
           'service_role',
           'public.record_ingestion_rejection(uuid, jsonb, timestamptz)',
           'EXECUTE') THEN
        RAISE EXCEPTION
            '0026 self-check: service_role cannot execute record_ingestion_rejection(), so the '
            'ingestion daemon has no route into the audit table at all';
    END IF;

    RAISE NOTICE
        '0026 self-check passed: audit rows carry causation, and ingestion writes refusals '
        'through record_ingestion_rejection() rather than by direct INSERT.';
END;
$selfcheck$;
