-- 0100: a deployed flow is an event, and a reading is not.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- A Remote gateway reports seven health readings on every heartbeat (0035), and the audit
-- trigger compared whole rows minus `last_heartbeat` (0005). Uptime moves every thirty seconds,
-- so every heartbeat that carried health wrote an UPDATE row to digital_thread: an append-only
-- table gaining 2,880 rows a day per appliance, none of them an event, with the one change that
-- IS an event -- the appliance deploying a different flow -- buried among them.
--
-- Two changes. audit_telemetry_columns() names the columns a heartbeat writes, and the trigger
-- subtracts them all before comparing, as it did `last_heartbeat` alone. And the flow hash, which
-- is in that list, is recorded on change by ingest_record_gateway_health() itself as a
-- FLOW_DEPLOYED row: old and new digest, the identity at the time, and what the forge's `main`
-- held at that moment, pinned to actor 'ingestion' with no user, the way SCHEMA_REJECTION is.
--
-- WHY NO FOURTH ACTOR KIND. The puller on the appliance deploys the flow and never touches this
-- database; what it deployed reaches the platform on the heartbeat, and the daemon records what
-- the appliance reported. The daemon is the witness, so the row is 'ingestion', and the approvals
-- queue's expiry timer stays 'service'. `cert_expires_at` and `agent_version` stay in the generic
-- comparison: both change rarely, and a re-enrolment or an in-place upgrade is an event.
--
-- Both functions are CREATE OR REPLACE over the baseline's definitions: the ACLs persist, and the
-- next squash folds them in.
-- =================================================================================================

-- -------------------------------------------------------------------------------------------------
-- 1. The columns a heartbeat writes
-- -------------------------------------------------------------------------------------------------
-- One list, read by the trigger. `flow_hash` is here because its change is recorded explicitly
-- below; a generic UPDATE row for it as well would say the same thing twice.
CREATE OR REPLACE FUNCTION public.audit_telemetry_columns() RETURNS text[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'public'
    AS $$
    SELECT ARRAY[
        'last_heartbeat',
        'health_reported_at',
        'uptime_seconds',
        'load_1m',
        'mem_available_bytes',
        'disk_free_bytes',
        'flow_hash'
    ]::text[];
$$;

COMMENT ON FUNCTION public.audit_telemetry_columns() IS
    'The gateways columns a heartbeat rewrites: liveness and the health readings (0035), and flow_hash, whose change ingest_record_gateway_health() records as its own FLOW_DEPLOYED row. log_digital_thread_event() subtracts these before deciding whether an UPDATE is an event.';

REVOKE ALL ON FUNCTION public.audit_telemetry_columns() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_telemetry_columns() TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 2. The trigger, comparing rows minus those columns
-- -------------------------------------------------------------------------------------------------
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
BEGIN
    -- -----------------------------------------------------------------------------------------
    -- Suppression. UPDATE only: an INSERT or DELETE is always an event.
    -- -----------------------------------------------------------------------------------------
    -- One comparison covers every case, because subtracting an absent key is a no-op: identical
    -- rows are a no-op write, and rows differing only in the columns audit_telemetry_columns()
    -- names are a heartbeat's readings, which arrive every thirty seconds and are not events.
    -- `IS NOT DISTINCT FROM` so a NULL on either side compares as equal.
    IF TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - public.audit_telemetry_columns())
           IS NOT DISTINCT FROM (to_jsonb(OLD) - public.audit_telemetry_columns())
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
    -- A person, not merely a `sub`: machine principals carry one too. A machine falls through to
    -- the declared-header path below and is recorded as what it is, while `changed_by` still
    -- receives v_actor so the row names it.
    IF v_actor IS NOT NULL AND NOT public.is_machine_principal(v_actor) THEN
        v_source := 'user';
    ELSE
        -- A caller may declare itself with an `X-ACS-Cymru-Actor` request header, which PostgREST
        -- exposes as request.headers. That is how the ingestion daemon is told apart from an edge
        -- function; the branch above declines to read a machine's `sub` as evidence of a person.
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
            -- Which role is calling, and not `current_user`: this function is SECURITY DEFINER, so
            -- `current_user` is the owner (`postgres`). PostgREST connects as `authenticator` and SET ROLEs,
            -- so `role` holds the effective role; a direct psql session reports 'none', where
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
$$;

-- -------------------------------------------------------------------------------------------------
-- 3. The health gate, recording a changed flow hash as an event
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_record_gateway_health(p_gateway_id uuid, p_status text, p_heartbeat_at timestamp with time zone, p_health jsonb DEFAULT NULL::jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_rows       integer;
    v_has_health boolean;
    v_before     record;
    v_flow_hash  text;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_record_gateway_health');

    IF p_gateway_id IS NULL THEN
        RAISE EXCEPTION 'ingest_record_gateway_health: p_gateway_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF p_status IS NULL OR btrim(p_status) = '' THEN
        RAISE EXCEPTION 'ingest_record_gateway_health: p_status is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF upper(p_status) IN ('PENDING_ENROLLMENT', 'AWAITING_BIRTH', 'STALE') THEN
        RAISE EXCEPTION
            'ingest_record_gateway_health: % is reserved to the platform and may not be asserted '
            'by a gateway about itself -- it would short-circuit the staleness arm of '
            'public.gateway_status and leave a silent gateway looking healthy', p_status
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The same cap ingestion.py applies (MAX_GATEWAY_STATUS_LENGTH). A gateway supplies this
    -- string, so it is length-checked rather than trusted.
    IF length(p_status) > 32 THEN
        RAISE EXCEPTION 'ingest_record_gateway_health: status is % characters, limit is 32',
            length(p_status)
            USING ERRCODE = 'string_data_right_truncation';
    END IF;

    v_has_health := p_health IS NOT NULL AND jsonb_typeof(p_health) = 'object'
                    AND p_health <> '{}'::jsonb;

    -- What the row said before this heartbeat, for the one reading that is an event: the flow
    -- the appliance last deployed. Read before the UPDATE, with the forge's head beside it, so
    -- the row below can say what main held at the moment the appliance reported.
    SELECT g.flow_hash, g.name, g.sparkplug_id, g.forge_head_sha, g.forge_head_flow_sha256
      INTO v_before
      FROM public.gateways g
     WHERE g.id = p_gateway_id;

    UPDATE public.gateways g
       SET status         = p_status,
           last_heartbeat = COALESCE(p_heartbeat_at, now()),
           -- STAMPED ONLY WHEN SOMETHING WAS RECOGNISED, which is what makes the column mean what
           -- 0035 says it means: an appliance on a bundle predating health reporting leaves this
           -- NULL, reading as "does not report health" rather than "has stopped reporting it".
           health_reported_at  = CASE WHEN v_has_health
                                      THEN COALESCE(p_heartbeat_at, now())
                                      ELSE g.health_reported_at END,
           uptime_seconds      = COALESCE((p_health->>'uptime_seconds')::bigint,      g.uptime_seconds),
           load_1m             = COALESCE((p_health->>'load_1m')::real,               g.load_1m),
           mem_available_bytes = COALESCE((p_health->>'mem_available_bytes')::bigint, g.mem_available_bytes),
           disk_free_bytes     = COALESCE((p_health->>'disk_free_bytes')::bigint,     g.disk_free_bytes),
           cert_expires_at     = COALESCE((p_health->>'cert_expires_at')::timestamptz, g.cert_expires_at),
           flow_hash           = COALESCE( p_health->>'flow_hash',                    g.flow_hash),
           -- `agent_version` is stamped once at enrolment by 0025 and REFRESHED here, which is
           -- the whole complaint 0035 answers. It is part of GATEWAY_HEALTH_METRICS in
           -- ingestion.py and belongs in this list; omitting it would drop the reading silently,
           -- leaving the page showing whatever version enrolled however long ago.
           agent_version       = COALESCE( p_health->>'agent_version',                g.agent_version)
     WHERE g.id = p_gateway_id;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
        RAISE EXCEPTION 'ingest_record_gateway_health: no gateway with id %', p_gateway_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- A DEPLOYED FLOW IS AN EVENT. The audit trigger no longer sees this column (it is in
    -- audit_telemetry_columns(), with the readings), so the change is recorded here, once per
    -- change, as a FLOW_DEPLOYED row pinned to 'ingestion': the daemon is the witness to what the
    -- appliance reported, the way record_ingestion_rejection() is the witness to what it refused.
    -- No fourth actor kind: the puller on the appliance never touches this database, and the
    -- heartbeat is its only channel. `matches_main` is what the forge held at that moment.
    v_flow_hash := p_health->>'flow_hash';
    IF v_has_health AND v_flow_hash IS NOT NULL AND v_flow_hash IS DISTINCT FROM v_before.flow_hash THEN
        INSERT INTO public.digital_thread (
            entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
            causation_id, recorded_at
        ) VALUES (
            'gateways',
            p_gateway_id,
            'FLOW_DEPLOYED',
            jsonb_build_object('flow_hash', v_before.flow_hash),
            jsonb_build_object(
                'flow_hash',              v_flow_hash,
                -- The identity as it was AT THE TIME, as the rejection row keeps it.
                'name',                   v_before.name,
                'sparkplug_id',           v_before.sparkplug_id,
                'reported_at',            COALESCE(p_heartbeat_at, now()),
                'forge_head_sha',         v_before.forge_head_sha,
                'forge_head_flow_sha256', v_before.forge_head_flow_sha256,
                'matches_main',           v_flow_hash = v_before.forge_head_flow_sha256
            ),
            NULL,
            'ingestion',
            txid_current(),
            now()
        );
    END IF;

    RETURN true;
END;
$$;

-- -------------------------------------------------------------------------------------------------
-- 4. Self-check
-- -------------------------------------------------------------------------------------------------
-- Read-only, and about this file's own changes: the trigger reads the list, the gate writes the
-- row, and `anon` can call neither.
DO $$
DECLARE
    v_problems text[] := ARRAY[]::text[];
BEGIN
    IF pg_get_functiondef('public.log_digital_thread_event()'::regprocedure)
       NOT LIKE '%audit_telemetry_columns()%' THEN
        v_problems := v_problems || 'log_digital_thread_event() does not subtract the telemetry columns'::text;
    END IF;

    IF pg_get_functiondef('public.ingest_record_gateway_health(uuid, text, timestamptz, jsonb)'::regprocedure)
       NOT LIKE '%FLOW_DEPLOYED%' THEN
        v_problems := v_problems || 'ingest_record_gateway_health() does not record FLOW_DEPLOYED'::text;
    END IF;

    IF NOT ('flow_hash' = ANY (public.audit_telemetry_columns())) THEN
        v_problems := v_problems || 'flow_hash is not a telemetry column, so a deploy would be recorded twice'::text;
    END IF;

    IF has_function_privilege('anon', 'public.ingest_record_gateway_health(uuid, text, timestamptz, jsonb)', 'EXECUTE') THEN
        v_problems := v_problems || 'ingest_record_gateway_health() is callable by anon'::text;
    END IF;

    IF array_length(v_problems, 1) > 0 THEN
        RAISE EXCEPTION '0100 self-check failed: %', array_to_string(v_problems, '; ');
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
