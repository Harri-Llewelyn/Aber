-- =============================================================================================
-- 0051: record_ingestion_rejection() is reachable by the principal that calls it
-- =============================================================================================
--
-- A REGRESSION FROM 0046, AND A SILENT ONE. Moving the daemon off `service_role` onto the
-- `Service_Ingestor` principal changed which grants it needs, and 0047 re-granted the seven
-- functions it created. `record_ingestion_rejection()` was not one of them -- it dates from 0026 --
-- so it kept the grant it was born with, `service_role` only, and the daemon has been calling it
-- as `authenticated` ever since:
--
--     permission denied for function record_ingestion_rejection (42501)
--
-- WHAT THAT COSTS, AND WHY IT IS WORSE NOW THAN IT WOULD HAVE BEEN BEFORE 0050.
--
-- The daemon catches this and logs it, so telemetry keeps flowing and nothing goes red. What stops
-- is the SCHEMA_REJECTION half of the digital thread: every payload conformance violation since
-- 0046 has been detected, reported to the log, and then not written down.
--
-- Under `conformance_policy = 'enforce'` (0050) it is not merely unrecorded, it is DATA LOSS. That
-- path drops the offending metric, and the ingestion README says of the audit row that it "is then
-- the ONLY remaining evidence the device sent anything -- which is why enforcement does not switch
-- recording off". With this grant missing, enforcement discards the reading AND fails to record
-- that it did. Both halves of the evidence go.
--
-- HOW IT WAS FOUND, since "nobody noticed" deserves an explanation. The live simulated fleet does
-- not violate its own schemas, so the call site is never reached on an ordinary stack. It surfaced
-- while exercising broker capture and playback: replaying one machine class's
-- metrics under another's identity produced the first real violations this deployment has seen,
-- and the error appeared within two seconds.
--
-- IDEMPOTENT. CREATE OR REPLACE and GRANT are both re-runnable, which db-init requires: every
-- migration replays on every boot.
--
-- Related: 0026 (the function and its argument), 0046 (the principal), 0047 (the gate pattern),
--          0048 (is_ingestion_caller()'s single arm), 0050 (why the loss is now twofold).
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. The function, unchanged but for the guard
-- ---------------------------------------------------------------------------------------------
-- REPRODUCED FROM 0026 RATHER THAN PATCHED IN PLACE, because a migration must state the whole
-- definition it wants -- and reproduced by copying that text rather than by retyping it, after a
-- previous attempt at hand-reconstructing a function in this schema invented two variable names
-- and a helper that did not exist. Everything below the guard is 0026's, character for character.

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
    -- THE GATE THIS FUNCTION HAS ALWAYS RELIED ON, NOW STATED IN THE BODY. Until 0046 the only
    -- caller was `service_role` and the GRANT was the access control. The daemon no longer holds
    -- that key, so the grant below has to widen to `authenticated` -- and a bare widening would
    -- let every signed-in user, the four seeded demonstration personas included, forge
    -- SCHEMA_REJECTION rows into an append-only table no application role can prune.
    --
    -- Same shape as the seven gates in 0047, deliberately: granted broadly, gated on identity
    -- inside. This is the one daemon RPC that predates that pattern, which is exactly how it came
    -- to be the one left behind by it.
    PERFORM public.require_ingestion_caller('record_ingestion_rejection');

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

-- ---------------------------------------------------------------------------------------------
-- 2. The grant
-- ---------------------------------------------------------------------------------------------
-- `service_role` KEEPS ITS GRANT and is nonetheless refused by the guard above, which is the same
-- state 0047 leaves its seven gates in. The grant says who may reach the function; the guard says
-- who may use it. Revoking here would say something narrower and less true -- `service_role`
-- bypasses RLS and can always write this table directly, so what is denied is the NARROW GATE,
-- not the capability.
GRANT EXECUTE ON FUNCTION public.record_ingestion_rejection(uuid, jsonb, timestamptz)
    TO authenticated;

COMMENT ON FUNCTION public.record_ingestion_rejection(uuid, jsonb, timestamptz) IS
  'Record a Sparkplug payload the ingestion daemon refused, as a SCHEMA_REJECTION row in '
  'digital_thread. The violation list is capped at 50 entries with the true count kept alongside. '
  'actor_source is pinned to ''ingestion'' and changed_by to NULL: this is the narrow gate that '
  'replaces service_role''s direct INSERT on the audit table. Callable only by the Service_Ingestor '
  'principal (0051), which is what makes the grant to `authenticated` safe.';


-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
-- BOTH DIRECTIONS, because each alone passes in a state that is broken. Asserting only that the
-- ingestion principal can call it would pass with the guard deleted and the function open to every
-- signed-in user; asserting only that a stranger is refused would pass with the grant reverted and
-- the daemon locked out exactly as it is today.
--
-- The probe row is rolled back. This writes into an append-only table, and a self-check that left
-- audit evidence of itself behind on every boot would be a worse problem than the one it checks.
DO $selfcheck$
DECLARE
    v_ingestor CONSTANT text := 'b0000000-0000-4000-8000-000000000002';
    v_stranger CONSTANT text := 'b0000000-0000-4000-8000-000000000001';
    v_device   uuid;
    v_id       bigint;
    v_refused  boolean;
BEGIN
    SELECT id INTO v_device FROM public.devices ORDER BY created_at LIMIT 1;
    IF v_device IS NULL THEN
        RAISE NOTICE '0051 self-check: no devices present, skipping.';
        RETURN;
    END IF;

    BEGIN
        -- ---- As the daemon: it must get through. ----
        PERFORM set_config('request.jwt.claims',
                           json_build_object('sub', v_ingestor, 'role', 'authenticated')::text,
                           true);
        SET LOCAL ROLE authenticated;

        v_id := public.record_ingestion_rejection(
            v_device,
            '[{"metric": "_selfcheck_0051", "code": "unmodelled_metric"}]'::jsonb);

        IF v_id IS NULL THEN
            RAISE EXCEPTION
              '0051 self-check: record_ingestion_rejection() returned NULL for a non-empty '
              'violation list. The daemon would report success and record nothing.';
        END IF;

        -- ---- As anyone else: it must not. ----
        PERFORM set_config('request.jwt.claims',
                           json_build_object('sub', v_stranger, 'role', 'authenticated')::text,
                           true);
        v_refused := false;
        BEGIN
            PERFORM public.record_ingestion_rejection(
                v_device, '[{"metric": "_selfcheck_0051_forged"}]'::jsonb);
        EXCEPTION WHEN insufficient_privilege THEN
            v_refused := true;
        END;

        IF NOT v_refused THEN
            RAISE EXCEPTION
              '0051 self-check: a principal that is not Service_Ingestor forged a SCHEMA_REJECTION '
              'row. The function is granted to `authenticated`, so without the guard every '
              'signed-in user can write the audit table the rest of the schema treats as '
              'authoritative.';
        END IF;

        -- Undo the probe row. Nothing above is meant to survive this block.
        RAISE EXCEPTION SQLSTATE 'ACS51' USING MESSAGE = 'rollback';
    EXCEPTION
        WHEN SQLSTATE 'ACS51' THEN
            RESET ROLE;
            PERFORM set_config('request.jwt.claims', NULL, true);
            RAISE NOTICE
              '0051 self-check: the ingestion principal can record a rejection, and no one else '
              'can.';
        WHEN OTHERS THEN
            RESET ROLE;
            PERFORM set_config('request.jwt.claims', NULL, true);
            RAISE;
    END;
END;
$selfcheck$;
