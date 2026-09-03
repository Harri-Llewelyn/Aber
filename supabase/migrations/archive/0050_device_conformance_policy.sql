-- =============================================================================================
-- 0050 · `devices.conformance_policy` — the switch that lets a violation drop a metric.
-- =============================================================================================
-- The daemon has evaluated every DDATA metric against its device's attached
-- schemas since 0026, and has never rejected one: `record_ingestion_rejection()` records an
-- observation, and `SCHEMA_CACHE_TTL_SECONDS` justifies its staleness window by observing that it
-- "cannot cause a wrong DROP, because nothing is dropped for non-conformance". This column is what
-- makes dropping possible, one device at a time.
--
-- NOTHING CHANGES WHEN THIS APPLIES. The default is `audit`, which is exactly today's behaviour --
-- evaluate, record, write the sample anyway. A device only starts losing readings when somebody
-- sets it to `enforce`, which is a deliberate act against one asset.
--
-- ---------------------------------------------------------------------------------------------
-- PER DEVICE, AND NOT PER DAEMON, WHICH IS THE WHOLE REASON THIS IS A COLUMN
--
-- `AUDIT_PAYLOAD_REJECTIONS` is an environment variable: it governs the process, so switching it
-- affects every device the daemon serves and takes a restart. That was tolerable for a flag whose
-- only effect was whether an audit row got written.
--
-- Dropping telemetry is not tolerable on those terms. Enforcement is a judgement about ONE asset's
-- schema being trustworthy enough to reject against, and the fleet is not uniform: a machine whose
-- submodel was written carefully last week and a twenty-year-old press whose schema is a first
-- guess do not deserve the same treatment. A per-daemon switch forces the strictest device's
-- policy onto the loosest one, or the other way round, and there is no third option.
--
-- ---------------------------------------------------------------------------------------------
-- WHY NOT A `system_settings` DEFAULT WITH NULL MEANING INHERIT
--
-- That shape is used elsewhere here and was the first design -- `devices.cell_id` is exactly it,
-- NULL meaning "inherit from the gateway". It was dropped for a specific reason rather than a
-- stylistic one: the ingestion daemon does not read `system_settings` anywhere, and giving it that
-- ability means a cached settings read on the hottest path in the process, with its own TTL and
-- its own staleness question, to resolve a value that is already sitting in a row the daemon has
-- just fetched and cached.
--
-- NOT NULL with a default keeps the answer where the question is asked. The cost is that there is
-- no single switch to enforce fleet-wide -- which is `UPDATE public.devices SET conformance_policy
-- = 'enforce'`, a statement an operator can read, rather than a setting whose blast radius is
-- invisible from the page that sets it.
--
-- ---------------------------------------------------------------------------------------------
-- TWO VALUES, NOT THREE
--
-- `off` was considered and refused. Recording a violation costs one deduplicated audit row per
-- distinct fault per device -- `_violation_signature()` already collapses a device screaming the
-- same thing forever into a single finding -- and a device nobody is auditing is a device whose
-- schema nobody can trust enough to enforce against later. The daemon-wide
-- `AUDIT_PAYLOAD_REJECTIONS=false` remains the way to switch recording off, and it stays
-- per-daemon because that is the shape of the cost it controls.
-- =============================================================================================

SET search_path TO public;


-- ---------------------------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------------------------
-- ADD COLUMN IF NOT EXISTS rather than a change to 0001, which is the opposite of what 0049
-- needed. 0049 renamed a table, so a baseline still creating the old name would have recreated it
-- on the next boot; this only ADDS, so 0001 creates the table and this adds the column on every
-- boot, idempotently, exactly as 0025 and 0035 do for the columns they introduce.
ALTER TABLE public.devices
    ADD COLUMN IF NOT EXISTS conformance_policy text NOT NULL DEFAULT 'audit';

-- The CHECK is added separately and guarded, because ADD COLUMN IF NOT EXISTS does not re-apply a
-- constraint on a replay and ADD CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'devices_conformance_policy_valid'
           AND conrelid = 'public.devices'::regclass
    ) THEN
        ALTER TABLE public.devices
            ADD CONSTRAINT devices_conformance_policy_valid
            CHECK (conformance_policy IN ('audit', 'enforce'));
    END IF;
END $$;

COMMENT ON COLUMN public.devices.conformance_policy IS
  '''audit'' (default) evaluates every DDATA metric against the device''s attached schemas and '
  'records what fails, writing the sample regardless -- the behaviour since 0026. ''enforce'' '
  'additionally DROPS a metric whose value contradicts a constraint its bound schema states. '
  'Per device and not per daemon: enforcement is a judgement about one asset''s schema being '
  'trustworthy enough to reject against, and a fleet is not uniform. An unmodelled metric is '
  'dropped only when a schema closes the set with additionalProperties: false.';


-- ---------------------------------------------------------------------------------------------
-- 2. Self-check
-- ---------------------------------------------------------------------------------------------
-- WHAT IS WORTH ASSERTING is that this applies INERT -- that the DEFAULT is ''audit'', so no device
-- starts rejecting telemetry because a migration ran. Telemetry that was never written cannot be
-- recovered from anywhere, unlike a schema edit, which can be reverted.
--
-- What is NOT asserted is the fleet''s current state; see the note below, which is a replay trap
-- this file walked into on its first draft.
DO $selfcheck$
DECLARE
    v_total     integer;
    v_enforcing integer;
    v_default   text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'devices'
           AND column_name = 'conformance_policy'
    ) THEN
        RAISE EXCEPTION '0050 self-check: devices.conformance_policy was not created.';
    END IF;

    SELECT column_default INTO v_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'devices'
       AND column_name = 'conformance_policy';

    IF v_default IS NULL OR v_default NOT LIKE '%audit%' THEN
        RAISE EXCEPTION
            '0050 self-check: the column default is %, expected ''audit''. A device created '
            'without an explicit policy must not start rejecting telemetry.',
            coalesce(v_default, 'NULL');
    END IF;

    SELECT count(*), count(*) FILTER (WHERE conformance_policy = 'enforce')
      INTO v_total, v_enforcing
      FROM public.devices;

    -- COUNTED AND REPORTED, DELIBERATELY NOT ASSERTED. The first draft raised if any device was
    -- enforcing, to prove the migration applied inert. That is true only on the FIRST application:
    -- db-init replays every migration on every boot, so the assertion would have started failing
    -- the moment an operator legitimately opted an asset in -- taking db-init, and with it every
    -- later migration, down on the next restart because somebody used the feature.
    --
    -- The property that actually holds on every run is the one asserted above: the DEFAULT is
    -- 'audit', so nothing here opts a device in. What operators have chosen since is their record
    -- to keep, and it belongs in the notice rather than in a constraint on their choices.

    -- The CHECK has to actually refuse, or the column is free text with a comment attached.
    BEGIN
        UPDATE public.devices SET conformance_policy = 'whatever-i-like'
         WHERE id = (SELECT id FROM public.devices LIMIT 1);
        IF v_total > 0 THEN
            RAISE EXCEPTION
                '0050 self-check: devices.conformance_policy accepted an unlisted value, so the '
                'CHECK is missing and a typo would read as ''not enforce''.';
        END IF;
    EXCEPTION WHEN check_violation THEN
        NULL;  -- refused, which is the point
    END;

    RAISE NOTICE '0050 self-check passed: % device(s) carry conformance_policy (% enforcing), '
                 'the default is ''audit'', and the CHECK refuses anything else.',
                 v_total, v_enforcing;
END;
$selfcheck$;
