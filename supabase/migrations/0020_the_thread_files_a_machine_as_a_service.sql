-- =============================================================================================
-- Migration: 0020_the_thread_files_a_machine_as_a_service.sql
-- A caller's X-Aber-Actor header is believed only when it describes that caller (#534)
-- =============================================================================================
--
-- log_digital_thread_event() took actor_source from the caller's X-Aber-Actor header for any
-- caller that is not a person, and accepted 'ingestion', 'service' and 'migration' from anyone.
-- Since 0013 a machine identity may write (schema:manage, proposal:create), so a machine sending
-- `X-Aber-Actor: migration` had its own fork_schema() INSERT filed as a migration.
--
-- Each declared value is now accepted only from the caller it describes: 'ingestion' when
-- is_ingestion_caller() is true, 'migration' from the owner's own session with no JWT, and
-- 'service' from any other caller that is not a person. A machine identity is filed as 'service'
-- whatever it declares. Anything else falls through to the effective role, as before. 'user' is
-- never taken from the header.
--
-- The function is 0001's otherwise, recorded in check-docs-drift.mjs's INTENDED_REDECLARATIONS,
-- and folds into it at the next squash.
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.log_digital_thread_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_old_data  JSONB := NULL;
    v_new_data  JSONB := NULL;
    v_entity_id UUID;
    v_actor     UUID;
    v_source    TEXT;
    v_declared  TEXT;
    v_role      TEXT;
    v_key       TEXT;
BEGIN
    -- -----------------------------------------------------------------------------------------
    -- Suppression. UPDATE only: an INSERT or DELETE is always an event.
    -- -----------------------------------------------------------------------------------------
    -- Identical rows are a no-op write, and rows differing only in the columns
    -- audit_telemetry_columns() names are a heartbeat's readings, not events. Subtracting an
    -- absent key is a no-op, so one comparison covers both; NULLs compare as equal.
    IF TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - public.audit_telemetry_columns())
           IS NOT DISTINCT FROM (to_jsonb(OLD) - public.audit_telemetry_columns())
    THEN
        RETURN NEW;
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- Which column names the entity
    -- -----------------------------------------------------------------------------------------
    -- `id` unless the trigger argument names another: `device_nameplate` is keyed by `device_id`.
    -- One attribution ladder for every table; log_role_assignment() carries a reduced copy.
    v_key := COALESCE(TG_ARGV[0], 'id');

    IF (TG_OP = 'DELETE') THEN
        v_old_data := to_jsonb(OLD);
        v_entity_id := (v_old_data ->> v_key)::UUID;
    ELSIF (TG_OP = 'UPDATE') THEN
        v_old_data := to_jsonb(OLD);
        v_new_data := to_jsonb(NEW);
        v_entity_id := (v_new_data ->> v_key)::UUID;
    ELSIF (TG_OP = 'INSERT') THEN
        v_new_data := to_jsonb(NEW);
        v_entity_id := (v_new_data ->> v_key)::UUID;
    END IF;

    -- A mistyped trigger argument reads as NULL through `->>`; refused here so the error names
    -- the trigger rather than digital_thread's NOT NULL.
    IF v_entity_id IS NULL THEN
        RAISE EXCEPTION
            'log_digital_thread_event: % has no % to name the entity by -- check the column named '
            'in the trigger argument', TG_TABLE_NAME, v_key
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- Who
    -- -----------------------------------------------------------------------------------------
    v_actor := auth.uid();

    IF v_actor IS NULL THEN
        -- Set with SET LOCAL by a SECURITY DEFINER RPC acting on a person's behalf, such as
        -- approve_quarantined_device() and approve_proposal().
        BEGIN
            v_actor := NULLIF(current_setting('aber.actor_id', true), '')::UUID;
        EXCEPTION WHEN others THEN
            v_actor := NULL;
        END;
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- What kind of actor
    -- -----------------------------------------------------------------------------------------
    -- A person, not merely a `sub`: machine principals carry one too. changed_by receives
    -- v_actor either way, so a machine's row still names it.
    IF v_actor IS NOT NULL AND NOT public.is_machine_principal(v_actor) THEN
        v_source := 'user';
    ELSE
        -- The `X-Aber-Actor` request header, which PostgREST exposes as request.headers. Each value
        -- is believed only from the caller it describes. 'user' never is: claiming a human author
        -- is exactly the assertion a client must not be able to make about itself.
        BEGIN
            v_declared := NULLIF(
                current_setting('request.headers', true)::json ->> 'x-aber-actor', ''
            );
        EXCEPTION WHEN others THEN
            v_declared := NULL;
        END;

        IF v_declared = 'ingestion' AND public.is_ingestion_caller() THEN
            v_source := 'ingestion';
        ELSIF v_declared = 'migration'
              AND NULLIF(current_setting('request.jwt.claims', true), '') IS NULL
              AND session_user IN ('postgres', 'supabase_admin') THEN
            -- The owner's own session with no token, which PostgREST never is.
            v_source := 'migration';
        ELSIF v_declared = 'service' OR v_actor IS NOT NULL THEN
            -- Any other caller that is not a person may call itself a service. A machine identity
            -- is one whatever it declares.
            v_source := 'service';
        ELSE
            -- The effective role, not `current_user`, which is this SECURITY DEFINER function's
            -- owner. PostgREST SET ROLEs, so `role` holds it; a direct psql session reports
            -- 'none', where `session_user` is the honest answer.
            v_role := NULLIF(current_setting('role', true), 'none');
            IF v_role IS NULL OR v_role = '' THEN
                v_role := session_user;
            END IF;

            IF v_role IN ('postgres', 'supabase_admin') THEN
                v_source := 'migration';
            ELSE
                -- service_role with nothing believable declared: automation we cannot name more
                -- precisely.
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
$$;

ALTER FUNCTION public.log_digital_thread_event() OWNER TO postgres;

COMMENT ON FUNCTION public.log_digital_thread_event() IS 'AFTER trigger that appends to digital_thread. Suppresses an UPDATE that changed nothing and one that moved only the columns audit_telemetry_columns() names. The entity id is read from the column named in the trigger argument, defaulting to `id`. Attribution is auth.uid(), then aber.actor_id; a person is ''user''. Otherwise the X-Aber-Actor header is believed only from the caller it describes -- ''ingestion'' when is_ingestion_caller(), ''migration'' from the owner''s session with no JWT, ''service'' from any other non-person -- a machine identity is ''service'' whatever it declares, and anything else falls to the effective role.';

-- 0001's ACL, restated; CREATE OR REPLACE keeps it either way.
REVOKE ALL ON FUNCTION public.log_digital_thread_event() FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.log_digital_thread_event() TO service_role;

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
    v_src  text;
    v_part text;
BEGIN
    SELECT p.prosrc INTO v_src
      FROM pg_proc p
     WHERE p.oid = 'public.log_digital_thread_event()'::regprocedure;

    -- The header is no longer believed as a set from anyone.
    IF v_src ~ 'v_declared\s+IN\s*\(' THEN
        RAISE EXCEPTION '0020 self-check: log_digital_thread_event() still accepts a declared source from any caller.';
    END IF;

    -- Each value is tied to its caller, and a machine is a service.
    FOREACH v_part IN ARRAY ARRAY[
        'v_declared = ''ingestion'' AND public.is_ingestion_caller()',
        'v_declared = ''migration''',
        'current_setting(''request.jwt.claims'', true)',
        'v_declared = ''service'' OR v_actor IS NOT NULL'
    ] LOOP
        IF position(v_part IN v_src) = 0 THEN
            RAISE EXCEPTION '0020 self-check: log_digital_thread_event() lost "%".', v_part;
        END IF;
    END LOOP;

    -- The parts a copy could drop silently: the suppression, the key argument, both actor arms,
    -- the person test and the transaction stamp.
    FOREACH v_part IN ARRAY ARRAY[
        'audit_telemetry_columns()', 'TG_ARGV[0]', 'auth.uid()', 'aber.actor_id',
        'public.is_machine_principal(v_actor)', 'txid_current()'
    ] LOOP
        IF position(v_part IN v_src) = 0 THEN
            RAISE EXCEPTION '0020 self-check: log_digital_thread_event() lost "%".', v_part;
        END IF;
    END LOOP;

    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.log_digital_thread_event()'::regprocedure) THEN
        RAISE EXCEPTION '0020 self-check: log_digital_thread_event() is not SECURITY DEFINER, and digital_thread refuses application roles.';
    END IF;

    IF has_function_privilege('anon', 'public.log_digital_thread_event()', 'EXECUTE') THEN
        RAISE EXCEPTION '0020 self-check: anon can execute log_digital_thread_event().';
    END IF;
END
$check$;
