-- 0119: a device is offline until it says otherwise.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- THE DEFECT. A device registered by hand -- the Devices page, or the schema builder's provisioning
-- step -- was written ONLINE the moment its row was created, and stayed ONLINE. `api.js` defaulted
-- the insert's `status` to 'ONLINE' when the caller sent none, and no caller ever sent one, so the
-- column's own 'OFFLINE' default was overridden on every device ever created through the UI. The
-- dashboard drew a green chip for a machine the platform had never heard from.
--
-- NOTHING WOULD HAVE CORRECTED IT. The liveness watchdog only considers devices ingestion has heard
-- from in its current lifetime -- seeding from the database would mark a whole fleet OFFLINE on
-- every restart. A device that has never published is never a candidate.
--
-- THE INVARIANT. `first_dbirth_at` is write-once, set by ingestion at the first DBIRTH and never
-- cleared, so a device cannot currently be born without ever having been born. A CHECK rather than
-- a convention, because the convention held for nothing and the symptom is indistinguishable from
-- success.
--
-- EVERY PATH THAT WRITES ONLINE ALREADY SETS BOTH, which is what makes the constraint safe:
--   * `ingest_set_device_state()` takes `p_first_dbirth_at` alongside `p_status` and COALESCEs it
--     onto the row; ingestion passes it on the birth that first flips the device ONLINE.
--   * `ingest_register_quarantined_device()` pins 'ONLINE' and `first_dbirth_at = p_observed_at` in
--     the same INSERT -- a DBIRTH has just arrived, by definition. So no quarantined device is in
--     the corrected set below, and none can fail the constraint.
--   * `approve_quarantined_device()`'s merge carries the quarantined row's status onto the
--     surviving row and COALESCEs the two `first_dbirth_at` values, at least one of which is set.
--
-- A NULL status satisfies the constraint. It is not 'ONLINE', and `deviceLifecycleStatus()` reads
-- anything that is not the literal 'ONLINE' as offline; `IS DISTINCT FROM` says so here rather than
-- leaving it to three-valued logic.

SET search_path TO public;

-- =================================================================================================
-- THE CORRECTION. Every device claiming to be running that has never been heard from. Writes one
-- audit row each, which is intended: the status genuinely changes, and the Digital Thread says so.
-- `log_digital_thread_event()` suppresses a no-op UPDATE, so a replay matches nothing.
UPDATE public.devices
   SET status = 'OFFLINE'
 WHERE status = 'ONLINE'
   AND first_dbirth_at IS NULL;

-- =================================================================================================
-- THE CONSTRAINT. Dropped first so a replay re-declares it rather than failing on the second boot;
-- added after the correction above, because ADD CONSTRAINT validates the rows already in the table
-- and would otherwise refuse on exactly the stacks this file is for.
ALTER TABLE public.devices
    DROP CONSTRAINT IF EXISTS devices_online_implies_born;

ALTER TABLE public.devices
    ADD CONSTRAINT devices_online_implies_born
    CHECK (status IS DISTINCT FROM 'ONLINE' OR first_dbirth_at IS NOT NULL);

COMMENT ON CONSTRAINT devices_online_implies_born ON public.devices IS
  'ONLINE is earned, never asserted: a device cannot currently be born without ever having been born. first_dbirth_at is write-once and set by ingestion at the first DBIRTH, so this refuses a row claiming to be running before the platform has heard from it -- the defect 0119 corrects, where the dashboard drew a green chip for a machine that had never connected.';

COMMENT ON COLUMN public.devices.status IS
  'What the platform has OBSERVED of this device, never what an operator intends: ONLINE or OFFLINE. Written only by ingestion -- DBIRTH sets ONLINE, DDEATH and the liveness watchdog set OFFLINE -- and left at its OFFLINE default for a device registered but not yet connected. devices_online_implies_born refuses ONLINE without a first_dbirth_at. A device provisioned and never heard from is OFFLINE with a null first_dbirth_at, which the dashboard draws as awaiting its first birth rather than as a machine that went away.';

-- =================================================================================================
-- SELF-CHECK. Asserted by what the database answers, not by what the catalog says is declared: a
-- constraint that exists and a constraint that refuses are different facts, and only the second is
-- the point of this file.
DO $check$
DECLARE
    v_lying     bigint;
    v_refused   boolean := false;
    v_unborn    bigint;
BEGIN
    -- 1. NOTHING IS LEFT CLAIMING TO BE RUNNING UNHEARD. Stated as a count of violations rather
    --    than a count of devices, so it reads the same on an empty database and on a full one.
    SELECT count(*) INTO v_lying
      FROM public.devices d
     WHERE d.status = 'ONLINE' AND d.first_dbirth_at IS NULL;

    IF v_lying > 0 THEN
        RAISE EXCEPTION
          '0119 self-check: % device(s) still report ONLINE with no first_dbirth_at -- the '
          'correction did not reach them, or something re-wrote them during this migration.',
          v_lying;
    END IF;

    -- 2. THE CONSTRAINT REFUSES THE ROW THIS FILE IS ABOUT. Attempted for real and rolled back,
    --    because a CHECK can be declared NOT VALID, dropped by a later file, or written against the
    --    wrong column, and all three look identical in pg_constraint.
    BEGIN
        INSERT INTO public.devices (name, status)
        VALUES ('0119 self-check -- never committed', 'ONLINE');
        -- Reached only if the INSERT was accepted, which is the failure.
        RAISE EXCEPTION
          '0119 self-check: a device claiming ONLINE with no first_dbirth_at was accepted. '
          'devices_online_implies_born is not enforcing.';
    EXCEPTION
        WHEN check_violation THEN
            v_refused := true;
    END;

    -- 3. AND STILL ADMITS THE HONEST ONE. A constraint that refused everything would satisfy check 2
    --    and break ingestion on the next birth it writes.
    BEGIN
        INSERT INTO public.devices (name, status, first_dbirth_at)
        VALUES ('0119 self-check -- never committed', 'ONLINE', now());
        -- Unwinds this block's own INSERT. Raised unconditionally: the row must not survive, and a
        -- DO block has no transaction of its own to roll back.
        RAISE EXCEPTION '0119 self-check rollback';
    EXCEPTION
        WHEN check_violation THEN
            RAISE EXCEPTION
              '0119 self-check: a device reporting ONLINE WITH a first_dbirth_at was refused. The '
              'constraint is too broad and would reject every birth ingestion writes.';
        WHEN raise_exception THEN
            IF sqlerrm <> '0119 self-check rollback' THEN
                RAISE;
            END IF;
    END;

    -- Reported, not asserted: how many devices are registered and still waiting to be heard from.
    -- Archived ones are excluded -- a decommissioned machine is not overdue, it is finished.
    SELECT count(*) INTO v_unborn
      FROM public.devices d
     WHERE d.first_dbirth_at IS NULL AND NOT d.is_archived;

    RAISE NOTICE '0119: ONLINE now requires a first birth (a claim without one was refused: %). '
                 '% device(s) are registered and awaiting theirs.', v_refused, v_unborn;
END
$check$;
