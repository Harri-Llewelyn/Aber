-- =============================================================================================
-- 0047 · The ingestion daemon's write surface, as functions. Roadmap §16.
-- =============================================================================================
-- 0046 created `Service_Ingestor` and gave it `Operator`, which cannot perform a single one of the
-- daemon's writes. This file is the other half: the narrow gates those writes go through instead.
--
-- THE DAEMON STILL HOLDS `service_role` AFTER THIS MIGRATION. Nothing here takes anything away --
-- `service_role` bypasses RLS and could always perform these writes directly, and still can. What
-- changes is that there is now a route a NARROW credential can use, which is the precondition for
-- swapping the credential in a later commit. That ordering is 0046's answer to the mid-upgrade
-- question and this file keeps to it: a deployed daemon that has never heard of these functions
-- keeps working.
--
-- ---------------------------------------------------------------------------------------------
-- THE PATTERN IS 0026'S, APPLIED FIVE MORE TIMES
--
-- `record_ingestion_rejection()` established it: a SECURITY DEFINER function that PINS what must
-- not be forgeable, VALIDATES what the caller supplies, and refuses an unknown subject. Its header
-- says why -- "a direct insert lets any holder of the service key write an audit row saying
-- anything" -- and every function here is the same argument about a different table.
--
-- The counted write surface is five sites across three tables: the quarantine INSERT on `devices`,
-- the re-quarantine and state UPDATEs on `devices`, the birth-metrics UPDATE on `devices`, the
-- `asset_config` upsert of birth parameters, and the health UPDATE on `gateways`. Telemetry is not
-- here because telemetry never touches Supabase -- it goes to TimescaleDB over the daemon's own
-- connection.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THESE GATES ADD BEYOND NARROWING THE CREDENTIAL, WHICH IS THE PART WORTH READING
--
-- Three rules the daemon currently enforces IN PYTHON move into SQL here, and they are the reason
-- this file is worth more than a permissions exercise. A rule enforced by the caller is only as
-- good as the caller, and the whole point of §16 is to stop trusting that process so much.
--
--   1. RESERVED GATEWAY STATUSES. `RESERVED_GATEWAY_STATUSES` in ingestion.py refuses to let a
--      gateway assert PENDING_ENROLLMENT, AWAITING_BIRTH or STALE about itself, because all three
--      short-circuit ahead of the staleness arm in `public.gateway_status` -- a gateway claiming
--      one "would go on looking healthy after it stopped publishing, which is the one thing the
--      derived status exists to prevent". That is a load-bearing rule sitting in a filter in the
--      process most exposed to the plant network. Here it is a CHECK in the gate.
--
--   2. THE OFFLINE WRITE-ON-CHANGE FILTER. The watchdog's UPDATE carries `status = 'ONLINE'` as a
--      predicate so an already-OFFLINE row matches nothing and `log_digital_thread_event()` does
--      not append to an append-only table once per tick. That predicate is a caller convention
--      today; `ingest_mark_device_offline()` makes it part of the function.
--
--   3. `first_dbirth_at` IS WRITE-ONCE. The daemon implements this by checking the cached row
--      before adding the field. A stale or evicted cache entry would silently overwrite the
--      original birth timestamp. COALESCE in the gate makes it unconditional.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE VOCABULARIES ARE VALIDATED BY PREFIX RATHER THAN BY EQUALITY
--
-- `devices.quarantine_reason` is documented in ingestion.py as "<CODE>: <detail>" and both shapes
-- are live: `process_dbirth` passes the bare `REASON_UNKNOWN_DEVICE`, while `verify_gateway_binding`
-- returns `GATEWAY_MISMATCH: device is bound to gateway '...' but ...`. Validating by equality
-- against the four codes would refuse every detailed reason the daemon produces and quarantine
-- would stop working -- so the check is that the value IS one of the codes or BEGINS with one
-- followed by a colon. That pins the vocabulary, which is the part worth pinning, and leaves the
-- detail free text.
--
-- Note that `devices.quarantine_reason`'s own COMMENT lists only three codes and predates
-- GATEWAY_MISMATCH. It is corrected at the bottom of this file, because a gate that refuses a
-- value the column comment does not mention would be the confusing kind of correct.
-- =============================================================================================

SET search_path TO public;


-- ---------------------------------------------------------------------------------------------
-- 1. Who is allowed through these gates
-- ---------------------------------------------------------------------------------------------
-- GRANTED TO `authenticated`, NOT ONLY TO `service_role`, and that difference is the entire point.
-- 0026 could grant to `service_role` alone because the daemon held that key and nothing else was
-- ever going to call it. After §16 the daemon authenticates as `Service_Ingestor` -- an ordinary
-- `authenticated` principal holding `Operator` -- so the grant has to admit `authenticated` or the
-- narrow credential cannot call its own functions.
--
-- That alone would let ANY signed-in user perform the daemon's writes, including the four seeded
-- demonstration personas, which would be a wider hole than the one this item closes. So the grant
-- is paired with an identity check: the caller must BE the ingestion principal.
--
-- `service_role` is admitted too, and ONLY for the transition. A daemon deployed before the
-- credential swap presents the service key, which carries no `sub` claim and therefore no
-- `auth.uid()`. Dropping that arm is the last commit of §16, and it is deliberately one line so
-- that it is a decision rather than a refactor.
CREATE OR REPLACE FUNCTION public.is_ingestion_caller()
    RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $fn$
    SELECT
        -- The narrow credential, after the swap.
        COALESCE(auth.uid()::text = 'b0000000-0000-4000-8000-000000000002', false)
        -- The service key, before it. `auth.role()` reads the same JWT claims PostgREST sets, so
        -- a direct psql session (no claims at all) matches neither arm and is refused -- which is
        -- correct: these gates exist for the daemon, and a human at a psql prompt is already
        -- superuser and does not need them.
        OR COALESCE(auth.role() = 'service_role', false);
$fn$;

COMMENT ON FUNCTION public.is_ingestion_caller() IS
  'True when the caller is the Service_Ingestor principal (0046) or still presenting the '
  'service-role key. Guards every ingest_* write gate. The service_role arm is transitional -- '
  'roadmap §16 removes it once the deployed daemon holds the narrow credential.';


CREATE OR REPLACE FUNCTION public.require_ingestion_caller(p_fn text)
    RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
BEGIN
    IF NOT public.is_ingestion_caller() THEN
        -- 42501, the same code a failed RLS WITH CHECK raises, so a caller that loses this
        -- privilege fails the way it would have failed against the policy.
        RAISE EXCEPTION '%: only the ingestion principal may call this', p_fn
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$fn$;


-- The quarantine vocabulary, in one place so five call sites cannot drift from each other.
CREATE OR REPLACE FUNCTION public.is_valid_quarantine_reason(p_reason text)
    RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $fn$
    SELECT p_reason IS NOT NULL AND EXISTS (
        SELECT 1
          FROM unnest(ARRAY['UNKNOWN_DEVICE', 'MALFORMED_IDENTITY',
                            'IDENTITY_MISMATCH', 'GATEWAY_MISMATCH']) AS code
         WHERE p_reason = code OR p_reason LIKE code || ': %'
    );
$fn$;

COMMENT ON FUNCTION public.is_valid_quarantine_reason(text) IS
  'True when the reason is one of the four quarantine codes, bare or followed by ": <detail>". '
  'Both shapes are produced by ingestion.py -- see 0047''s header for why this is a prefix check '
  'rather than an equality check.';


-- ---------------------------------------------------------------------------------------------
-- 2. Registering a device nobody registered
-- ---------------------------------------------------------------------------------------------
-- WHAT IS PINNED AND WHY. `is_quarantined` is forced true and `status` to 'ONLINE': this function
-- exists for exactly one situation -- a DBIRTH arrived from an id the platform does not know --
-- and a caller that could pass `is_quarantined => false` would be able to register an unknown
-- device as a trusted one. That is the same failure `record_ingestion_rejection()` was built to
-- prevent on the audit table, one table over.
--
-- The return shape is `_DEVICE_COLUMNS` from ingestion.py, in that order, because the daemon
-- caches the returned row and reads exactly these fields from it. `sparkplug_id` is generated, so
-- returning it here saves the re-resolve the current code falls back to when PostgREST is
-- configured not to return a representation.
CREATE OR REPLACE FUNCTION public.ingest_register_quarantined_device(
    p_name              text,
    p_gateway_id        uuid,
    p_reported_identity text,
    p_quarantine_reason text,
    p_identity_source   text,
    p_declared_metrics  text[] DEFAULT NULL,
    p_observed_at       timestamptz DEFAULT now()
) RETURNS TABLE (
    id                    uuid,
    name                  text,
    sparkplug_id          text,
    reported_identity     text,
    gateway_id            uuid,
    is_quarantined        boolean,
    first_dbirth_at       timestamptz,
    last_birth_metrics    text[],
    status                text,
    identity_source       text
)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
-- The RETURNS TABLE names are `_DEVICE_COLUMNS` verbatim, so several of them -- `id`, `name`,
-- `status` -- are also column names on `devices`. Resolve in favour of the column: this function
-- never assigns to an output variable, it returns a query.
#variable_conflict use_column
BEGIN
    PERFORM public.require_ingestion_caller('ingest_register_quarantined_device');

    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RAISE EXCEPTION 'ingest_register_quarantined_device: p_name is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF NOT public.is_valid_quarantine_reason(p_quarantine_reason) THEN
        RAISE EXCEPTION
            'ingest_register_quarantined_device: % is not a recognised quarantine reason',
            coalesce(p_quarantine_reason, 'NULL')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_identity_source IS NULL OR p_identity_source NOT IN
       ('sparkplug_id', 'reported_identity', 'instance_uuid', 'legacy_name') THEN
        RAISE EXCEPTION 'ingest_register_quarantined_device: % is not a recognised identity source',
            coalesce(p_identity_source, 'NULL')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- A gateway_id that names nothing would leave an orphan the dashboard cannot file. NULL is
    -- allowed -- a device can announce itself through an edge node the platform has never seen,
    -- and that is precisely one of the cases this function is for.
    IF p_gateway_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.id = p_gateway_id) THEN
        RAISE EXCEPTION 'ingest_register_quarantined_device: no gateway with id %', p_gateway_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- Wrapped in a CTE because `RETURN QUERY INSERT ... RETURNING` is not accepted; RETURN QUERY
    -- takes a query, and a data-modifying statement only becomes one inside WITH.
    RETURN QUERY
    WITH inserted AS (
        INSERT INTO public.devices (
            name, status, is_quarantined, first_dbirth_at, reported_identity,
            quarantine_reason, identity_source, gateway_id,
            last_birth_metrics, last_birth_metrics_at
        )
        VALUES (
            p_name,
            'ONLINE',        -- pinned: a DBIRTH just arrived, by definition
            true,            -- pinned: this function is the quarantine path and nothing else
            p_observed_at,
            p_reported_identity,
            p_quarantine_reason,
            p_identity_source,
            p_gateway_id,
            p_declared_metrics,
            CASE WHEN p_declared_metrics IS NULL THEN NULL ELSE p_observed_at END
        )
        RETURNING devices.id, devices.name, devices.sparkplug_id, devices.reported_identity,
                  devices.gateway_id, devices.is_quarantined, devices.first_dbirth_at,
                  devices.last_birth_metrics, devices.status, devices.identity_source
    )
    SELECT inserted.id, inserted.name, inserted.sparkplug_id, inserted.reported_identity,
           inserted.gateway_id, inserted.is_quarantined, inserted.first_dbirth_at,
           inserted.last_birth_metrics, inserted.status, inserted.identity_source
      FROM inserted;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 3. Re-quarantining a device that is already registered
-- ---------------------------------------------------------------------------------------------
-- The mirror of the above for a row that already exists: a registered device published an identity
-- that no longer reliably names it, or was announced by a gateway it is not bound to. `true` is
-- pinned for the same reason -- this direction only ever tightens.
CREATE OR REPLACE FUNCTION public.ingest_requarantine_device(
    p_device_id         uuid,
    p_quarantine_reason text,
    p_reported_identity text
) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_rows integer;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_requarantine_device');

    IF p_device_id IS NULL THEN
        RAISE EXCEPTION 'ingest_requarantine_device: p_device_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF NOT public.is_valid_quarantine_reason(p_quarantine_reason) THEN
        RAISE EXCEPTION 'ingest_requarantine_device: % is not a recognised quarantine reason',
            coalesce(p_quarantine_reason, 'NULL')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    UPDATE public.devices d
       SET is_quarantined    = true,
           quarantine_reason = p_quarantine_reason,
           reported_identity = p_reported_identity
     WHERE d.id = p_device_id;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
        RAISE EXCEPTION 'ingest_requarantine_device: no device with id %', p_device_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN true;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 4. The ordinary birth-time state write
-- ---------------------------------------------------------------------------------------------
-- NULL MEANS "LEAVE IT ALONE", which is what lets the daemon keep its write-only-what-moved
-- discipline through a fixed signature. Neither column is ever legitimately set to NULL by this
-- path -- `status` and `identity_source` are always a value when the daemon has one to write -- so
-- NULL is free to carry the "unchanged" meaning without becoming ambiguous.
--
-- `first_dbirth_at` IS WRITE-ONCE AND THAT IS ENFORCED HERE RATHER THAN TRUSTED. COALESCE keeps
-- whatever is already stored, so a caller passing a fresh timestamp for a device that already has
-- one cannot move it. The daemon's cache-based check stays where it is -- it saves a round trip --
-- but it is no longer the thing the property depends on.
--
-- RETURNS whether anything actually changed, so the caller can keep its `device_state_writes` and
-- `device_state_writes_skipped` counters honest without a second read.
CREATE OR REPLACE FUNCTION public.ingest_set_device_state(
    p_device_id       uuid,
    p_status          text DEFAULT NULL,
    p_identity_source text DEFAULT NULL,
    p_first_dbirth_at timestamptz DEFAULT NULL
) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_rows integer;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_set_device_state');

    IF p_device_id IS NULL THEN
        RAISE EXCEPTION 'ingest_set_device_state: p_device_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF p_identity_source IS NOT NULL AND p_identity_source NOT IN
       ('sparkplug_id', 'reported_identity', 'instance_uuid', 'legacy_name') THEN
        RAISE EXCEPTION 'ingest_set_device_state: % is not a recognised identity source',
            p_identity_source
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- This gate deliberately cannot quarantine or un-quarantine. Those are separate functions
    -- with their own vocabulary checks, and folding them together here would let the ordinary
    -- per-birth write clear a quarantine flag by omission.
    UPDATE public.devices d
       SET status          = COALESCE(p_status, d.status),
           identity_source = COALESCE(p_identity_source, d.identity_source),
           first_dbirth_at = COALESCE(d.first_dbirth_at, p_first_dbirth_at)
     WHERE d.id = p_device_id
       AND (
            (p_status          IS NOT NULL AND d.status          IS DISTINCT FROM p_status)
         OR (p_identity_source IS NOT NULL AND d.identity_source IS DISTINCT FROM p_identity_source)
         OR (p_first_dbirth_at IS NOT NULL AND d.first_dbirth_at IS NULL)
       );

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 5. The watchdog's OFFLINE sweep
-- ---------------------------------------------------------------------------------------------
-- A separate function from the one above rather than `ingest_set_device_state(id, 'OFFLINE')`,
-- because the predicate is the point. `log_digital_thread_event()` fires on every UPDATE to
-- `devices`, so a sweep that rewrote OFFLINE every tick would append to a deliberately append-only
-- table forever. The daemon carries `status = 'ONLINE'` as a filter to prevent that; here it is
-- part of the gate, so a future caller that forgets cannot reintroduce the problem.
--
-- `IS DISTINCT FROM 'OFFLINE'` RATHER THAN `= 'ONLINE'`, which is not the same predicate and is
-- the one the daemon's own comment actually describes: "an already-OFFLINE row matches nothing".
-- The two agree for every value `devices.status` currently holds -- it is written from four places
-- and only ever ONLINE or OFFLINE -- and disagree on NULL, which the column permits. The DDEATH
-- path today writes OFFLINE unconditionally, so `= 'ONLINE'` would have made a NULL-status device
-- stay NULL where it used to become OFFLINE. Suppressing the rewrite is the intent; refusing to
-- write anything that is not already ONLINE is an accident of how the filter was spelled.
CREATE OR REPLACE FUNCTION public.ingest_mark_device_offline(p_device_id uuid)
    RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_rows integer;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_mark_device_offline');

    IF p_device_id IS NULL THEN
        RAISE EXCEPTION 'ingest_mark_device_offline: p_device_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    UPDATE public.devices d
       SET status = 'OFFLINE'
     WHERE d.id = p_device_id
       AND d.status IS DISTINCT FROM 'OFFLINE';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 6. The declared metric set
-- ---------------------------------------------------------------------------------------------
-- WRITE-ON-CHANGE IS IN THE GATE for the same reason as above, and the daemon's own comment
-- explains the cost of getting it wrong: "writing an unchanged array on every rebirth would append
-- an audit row each time to a table that is deliberately immutable and append-only". A birth
-- certificate is repeated on a timer, so this is not a rare path.
--
-- `IS DISTINCT FROM` rather than `<>` because both sides are nullable: a device that has never
-- declared a metric set has NULL here, and `NULL <> ARRAY[...]` is NULL, which would make the
-- first real birth look like no change and never write.
CREATE OR REPLACE FUNCTION public.ingest_record_declared_metrics(
    p_device_id   uuid,
    p_metrics     text[],
    p_observed_at timestamptz DEFAULT now()
) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_rows integer;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_record_declared_metrics');

    IF p_device_id IS NULL THEN
        RAISE EXCEPTION 'ingest_record_declared_metrics: p_device_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    UPDATE public.devices d
       SET last_birth_metrics    = p_metrics,
           last_birth_metrics_at = p_observed_at
     WHERE d.id = p_device_id
       AND d.last_birth_metrics IS DISTINCT FROM p_metrics;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 7. Birth parameters
-- ---------------------------------------------------------------------------------------------
-- TAKES THE WHOLE BATCH AS jsonb, not one call per metric. The daemon builds a list and upserts it
-- in a single PostgREST request; making this per-metric would turn one round trip into as many as
-- the birth certificate has metrics, on the hot path, for no gain.
--
-- `asset_id` IS PINNED FROM THE ARGUMENT, NOT READ FROM THE ROWS. The daemon sets the same
-- `sparkplug_id` on every row it builds, so taking it once and ignoring whatever the objects
-- carry means a malformed batch cannot write parameters against somebody else's asset.
CREATE OR REPLACE FUNCTION public.ingest_store_birth_parameters(
    p_asset_id    text,
    p_rows        jsonb,
    p_observed_at timestamptz DEFAULT now()
) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_rows integer;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_store_birth_parameters');

    IF p_asset_id IS NULL OR btrim(p_asset_id) = '' THEN
        RAISE EXCEPTION 'ingest_store_birth_parameters: p_asset_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'ingest_store_birth_parameters: p_rows must be a JSON array, got %',
            coalesce(jsonb_typeof(p_rows), 'null')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The asset must be one this platform knows. `asset_config.asset_id` is loose text with no
    -- foreign key -- it holds a `sparkplug_id`, not a uuid -- so nothing else would catch a batch
    -- written against an id that names no device.
    IF NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.sparkplug_id = p_asset_id) THEN
        RAISE EXCEPTION 'ingest_store_birth_parameters: no device with sparkplug_id %', p_asset_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    INSERT INTO public.asset_config (asset_id, metric_name, val_double, val_string, val_bool,
                                     datatype, updated_at)
    SELECT p_asset_id,
           r.metric_name,
           r.val_double,
           r.val_string,
           r.val_bool,
           r.datatype,
           p_observed_at
      FROM jsonb_to_recordset(p_rows) AS r(
               metric_name text,
               val_double  double precision,
               val_string  text,
               val_bool    boolean,
               datatype    integer
           )
     WHERE r.metric_name IS NOT NULL
    ON CONFLICT (asset_id, metric_name) DO UPDATE
       SET val_double = EXCLUDED.val_double,
           val_string = EXCLUDED.val_string,
           val_bool   = EXCLUDED.val_bool,
           datatype   = EXCLUDED.datatype,
           updated_at = EXCLUDED.updated_at;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 8. Gateway heartbeat and health
-- ---------------------------------------------------------------------------------------------
-- THE RESERVED-STATUS RULE LIVES HERE NOW, and this is the strongest single argument in the file.
-- `gateways.status` is deliberately unconstrained text because the vocabulary belongs to the
-- fleet -- but three values are the platform's own, and `public.gateway_status` short-circuits on
-- all three ahead of its staleness arm. A gateway that asserts one renders itself permanently
-- not-stale on the dashboard: it goes on looking healthy after it has stopped publishing, which is
-- the single thing the derived status exists to prevent.
--
-- That rule is enforced today by a frozenset in ingestion.py, in the process most exposed to the
-- plant network, against a string that arrived from the plant network. Moving it into the gate
-- means a compromised or simply buggy daemon cannot write a status that blinds the dashboard.
-- REJECTED, NOT TRUNCATED OR REMAPPED -- the daemon's own comment argues for that and it holds
-- here: there is no legitimate reading of a gateway claiming to await its own birth.
--
-- `last_heartbeat` IS NOT SUPPRESSIBLE and is written on every call, unlike every other write in
-- this file. `public.gateway_status` derives staleness from it at read time, so skipping the write
-- would make a live gateway report STALE. Migration 0005 is what keeps this out of the audit
-- trail: it subtracts `last_heartbeat` before comparing, so a heartbeat that moves only the
-- timestamp writes no digital_thread row.
CREATE OR REPLACE FUNCTION public.ingest_record_gateway_health(
    p_gateway_id   uuid,
    p_status       text,
    p_heartbeat_at timestamptz,
    p_health       jsonb DEFAULT NULL
) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_rows integer;
    v_has_health boolean;
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

    RETURN true;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------------------------
-- `anon` NEVER. `authenticated` because the narrow credential is one, guarded by the identity
-- check inside each function. `service_role` because the daemon still holds it until the swap.
--
-- The REVOKE is not redundant with declining to grant: it narrows a DEFAULT ACL, which is 0033's
-- reason and 0026 follows it too. A function created by a superuser is EXECUTE-able by PUBLIC
-- unless something says otherwise.
DO $grants$
DECLARE
    v_fn text;
BEGIN
    FOREACH v_fn IN ARRAY ARRAY[
        'public.ingest_register_quarantined_device(text, uuid, text, text, text, text[], timestamptz)',
        'public.ingest_requarantine_device(uuid, text, text)',
        'public.ingest_set_device_state(uuid, text, text, timestamptz)',
        'public.ingest_mark_device_offline(uuid)',
        'public.ingest_record_declared_metrics(uuid, text[], timestamptz)',
        'public.ingest_store_birth_parameters(text, jsonb, timestamptz)',
        'public.ingest_record_gateway_health(uuid, text, timestamptz, jsonb)'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', v_fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
    END LOOP;
END;
$grants$;

REVOKE ALL ON FUNCTION public.is_ingestion_caller() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_ingestion_caller() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.require_ingestion_caller(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.require_ingestion_caller(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_valid_quarantine_reason(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_valid_quarantine_reason(text) TO authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- 10. The column comment that predates GATEWAY_MISMATCH
-- ---------------------------------------------------------------------------------------------
-- Corrected here rather than left, because section 1 now REFUSES a reason outside this vocabulary
-- and a gate that rejects a value the column comment does not mention is the confusing kind of
-- correct. GATEWAY_MISMATCH is produced by verify_gateway_binding() and has been for some time.
COMMENT ON COLUMN public.devices.quarantine_reason IS
  'Why this device is in the quarantine queue, as "<CODE>" or "<CODE>: <detail>": UNKNOWN_DEVICE '
  '(well-formed id, never seen), MALFORMED_IDENTITY (id failed the 24-char gwy/dev format check), '
  'IDENTITY_MISMATCH (topic device id and Asset_ID payload metric disagreed), or GATEWAY_MISMATCH '
  '(announced by an edge node it is not bound to, or one that is unregistered or archived). '
  'Enforced by is_valid_quarantine_reason() (0047), not by a CHECK -- the detail suffix is free '
  'text and only the code is pinned.';


-- ---------------------------------------------------------------------------------------------
-- 11. Self-check
-- ---------------------------------------------------------------------------------------------
-- WHAT IS WORTH ASSERTING is that the gates are reachable by the principal that will hold them and
-- closed to everyone else. The second half is the one that would rot silently: these functions are
-- granted to `authenticated`, so if the identity check inside them were ever removed or broken,
-- every signed-in user -- including the four seeded demonstration personas -- would be able to
-- quarantine devices and rewrite gateway health, and nothing else in the schema would notice.
DO $selfcheck$
DECLARE
    v_ingestor CONSTANT text := 'b0000000-0000-4000-8000-000000000002';
    v_mcp      CONSTANT text := 'b0000000-0000-4000-8000-000000000001';
    v_device   uuid;
    v_denied   boolean;
    v_moved    boolean;
BEGIN
    SELECT id INTO v_device FROM public.devices ORDER BY created_at LIMIT 1;
    IF v_device IS NULL THEN
        RAISE NOTICE '0047 self-check: no devices present, skipping the round-trip half.';
    END IF;

    BEGIN
        -- ---- As the ingestion principal: the gates must open. ----
        PERFORM set_config('request.jwt.claims',
                           json_build_object('sub', v_ingestor, 'role', 'authenticated')::text,
                           true);
        SET LOCAL ROLE authenticated;

        IF NOT public.is_ingestion_caller() THEN
            RAISE EXCEPTION
              '0047 self-check: the Service_Ingestor principal is not recognised by '
              'is_ingestion_caller(); the daemon would be locked out of its own write gates.';
        END IF;

        IF v_device IS NOT NULL THEN
            -- Idempotence is the property here: the same declared set twice must write once.
            PERFORM public.ingest_record_declared_metrics(v_device, ARRAY['_probe_a', '_probe_b']);
            v_moved := public.ingest_record_declared_metrics(v_device, ARRAY['_probe_a', '_probe_b']);
            IF v_moved THEN
                RAISE EXCEPTION
                  '0047 self-check: ingest_record_declared_metrics() rewrote an unchanged metric '
                  'set. Write-on-change is what keeps a rebirth on a timer out of the append-only '
                  'audit table.';
            END IF;

            -- And the OFFLINE predicate: twice in a row must move at most once.
            PERFORM public.ingest_mark_device_offline(v_device);
            IF public.ingest_mark_device_offline(v_device) THEN
                RAISE EXCEPTION
                  '0047 self-check: ingest_mark_device_offline() moved an already-OFFLINE row. The '
                  'already-OFFLINE predicate is what stops the watchdog appending an audit row '
                  'per tick.';
            END IF;
        END IF;

        -- The reserved-status rule must refuse.
        v_denied := false;
        BEGIN
            PERFORM public.ingest_record_gateway_health(
                (SELECT id FROM public.gateways ORDER BY created_at LIMIT 1),
                'AWAITING_BIRTH', now(), NULL);
        EXCEPTION WHEN invalid_parameter_value THEN
            v_denied := true;
        END;
        IF NOT v_denied AND EXISTS (SELECT 1 FROM public.gateways) THEN
            RAISE EXCEPTION
              '0047 self-check: a gateway was allowed to assert AWAITING_BIRTH about itself. That '
              'short-circuits the staleness arm of public.gateway_status and leaves a silent '
              'gateway looking healthy.';
        END IF;

        -- An unknown quarantine code must refuse.
        v_denied := false;
        BEGIN
            PERFORM public.ingest_requarantine_device(v_device, 'NOT_A_REAL_CODE', 'probe');
        EXCEPTION WHEN invalid_parameter_value THEN
            v_denied := true;
        END;
        IF NOT v_denied AND v_device IS NOT NULL THEN
            RAISE EXCEPTION
              '0047 self-check: an unrecognised quarantine reason was accepted; the vocabulary is '
              'not actually pinned.';
        END IF;

        -- ---- As another authenticated principal: the gates must be shut. ----
        -- The MCP reader stands in for "any signed-in user". It holds Operator exactly as the
        -- ingestion principal does, so this proves the identity check does the work rather than
        -- the role.
        PERFORM set_config('request.jwt.claims',
                           json_build_object('sub', v_mcp, 'role', 'authenticated')::text,
                           true);

        IF public.is_ingestion_caller() THEN
            RAISE EXCEPTION
              '0047 self-check: is_ingestion_caller() admitted the MCP principal. Every ingest_* '
              'gate is granted to `authenticated`, so this check is the only thing standing '
              'between a signed-in user and the daemon''s write surface.';
        END IF;

        v_denied := false;
        BEGIN
            PERFORM public.ingest_mark_device_offline(v_device);
        EXCEPTION WHEN insufficient_privilege THEN
            v_denied := true;
        END;
        IF NOT v_denied AND v_device IS NOT NULL THEN
            RAISE EXCEPTION
              '0047 self-check: a non-ingestion principal called ingest_mark_device_offline().';
        END IF;

        RESET ROLE;
        PERFORM set_config('request.jwt.claims', '', true);
        RAISE EXCEPTION 'rollback_selfcheck';
    EXCEPTION
        WHEN raise_exception THEN
            RESET ROLE;
            PERFORM set_config('request.jwt.claims', '', true);
            IF SQLERRM <> 'rollback_selfcheck' THEN RAISE; END IF;
    END;

    RAISE NOTICE '0047 self-check passed: the ingestion principal reaches all seven write gates, '
                 'write-on-change and the reserved-status rule hold, and no other authenticated '
                 'principal can call them.';
END;
$selfcheck$;
