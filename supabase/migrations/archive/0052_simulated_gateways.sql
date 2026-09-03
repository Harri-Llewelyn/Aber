-- =============================================================================================
-- 0052: a gateway can say that its telemetry is synthetic
-- =============================================================================================
--
-- Broker playback (`ingestion/capture.py`) publishes a recorded capture back into the stack as a
-- real gateway, through the real broker, down the real ingestion path. That is the whole point --
-- a spoofed fault is only useful if it is indistinguishable from a real one downstream -- and it
-- is also the problem: once it lands, nothing in the historian says the reading was replayed.
--
-- THIS COLUMN IS THE ANSWER, AND IT IS ON THE OTHER TABLE FROM THE ONE PLAYBACK ASKED FOR.
-- Marking the DEVICE is the obvious move -- an ordinary device flagged synthetic carries the
-- marking in `devices` -- and it is the wrong one. The argument against it is mechanical rather
-- than stylistic:
--
--   * a device-level flag has to agree with its gateway's, and a CHECK constraint cannot reference
--     another table. Keeping them in step needs a trigger on `devices` for insert and re-parenting
--     AND a trigger on `gateways` for the update that flips the flag under devices that already
--     exist -- two triggers that must agree, to maintain an invariant inheritance gives for free;
--   * "no simulated device on a real gateway" and "no real device on a simulated gateway" are one
--     rule stated twice, and a derived value cannot disagree with its source;
--   * `devices.cell_id` is already an override whose NULL means "inherit from the gateway", and its
--     own comment says to resolve it through a view "never by reading this column alone". The same
--     shape applies, and this needs even less: there is no override, so there is no NULL case.
--
-- Playback also makes the choice for us in practice. A capture cannot be published under the
-- identity it was recorded from -- mosquitto.acl pins the topic's edge-node segment to the
-- connecting username -- so playback IS one gateway rewriting captured identities onto its own
-- devices. The thing being marked is a gateway whether or not the column is.
--
-- WHAT THIS DELIBERATELY DOES NOT DO, because it belongs to item 15 and not here:
--
--   * it does not add `deployment` ('host' | 'remote'), and therefore does not add item 15's
--     `CHECK (NOT is_simulated OR deployment = 'host')`. That constraint needs both columns;
--   * it does not touch `is_virtual`, which item 15 shows carries three incompatible definitions.
--     Renaming it is that item's work and would be a poor thing to smuggle in beside a feature;
--   * it does not add the `simulated` lane to `device_locations`. That view answers WHERE an asset
--     is, and this is not a location.
--
-- Item 15 can add the other column and the cross-column CHECK on top of this without rework, which
-- is the test of whether taking a slice was legitimate.
--
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS and a guarded COMMENT: db-init replays every migration on
-- every boot in filename order.
--
-- Related: 0001 (gateways, is_virtual, the device_locations inheritance precedent),
--          item 15 in README.md (the argument this follows), ingestion/README.md (playback).
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------------------------
-- NOT NULL DEFAULT false, matching `is_virtual` beside it. A three-state flag would invite
-- "unknown", and there is no such gateway: either this deployment decided its data is synthetic or
-- it did not, and silence is the ordinary answer rather than a missing one.
ALTER TABLE public.gateways
    ADD COLUMN IF NOT EXISTS is_simulated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.gateways.is_simulated IS
  'True when this gateway''s telemetry is generated rather than observed -- a broker playback '
  'target, or a simulator. Devices INHERIT this through their gateway_id and carry no flag of '
  'their own (see 0052''s header): the containment rules a stored device-level '
  'copy would need two triggers to maintain are given for nothing by the join. Distinct from '
  'is_virtual, which is about whether an edge appliance exists, not about whether the readings are '
  'real -- a physical appliance replaying a capture is virtual=false, simulated=true.';


-- ---------------------------------------------------------------------------------------------
-- 2. Rebuild gateway_status
-- ---------------------------------------------------------------------------------------------
-- WITHOUT THIS THE COLUMN IS INVISIBLE AND NOTHING ERRORS. `gateway_status` is defined as
-- `SELECT g.*`, which Postgres expands and FREEZES at creation time -- so a column added
-- afterwards never appears through the view, which goes on returning exactly what it was born
-- with. db-init replays migrations in filename order on every boot, so an earlier rebuild cannot
-- pick this up either and the state does not self-correct.
--
-- The frontend reads gateways through this view. The SIMULATED badge would simply never render,
-- with no error anywhere to say why -- and the unit tests would not catch it, because they mock
-- the API and assert the component given the column, not the view that has to supply it.
--
-- Found by scripts/check-docs-drift.mjs, which asserts exactly this pairing.
SELECT public.ensure_gateway_status_view();


-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
-- ASSERTING THAT A DEVICE INHERITS THE FLAG THROUGH A JOIN WOULD BE VACUOUS -- a join always
-- reflects the column it selects, so such a check passes for any column on any table and proves
-- only that UPDATE works. The first version of this block did exactly that and is not what is
-- below.
--
-- WHAT CAN ACTUALLY FAIL is the decision itself: that `devices` carries NO flag of its own. A
-- later migration adding `devices.is_simulated` would look entirely reasonable in isolation -- it
-- is the obvious move described above -- and would silently reintroduce the
-- problem this design exists to avoid, with a stored copy free to disagree with its source. That
-- is checkable, and it is the only thing here that is.
DO $selfcheck$
DECLARE
    v_simulated integer;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'gateways' AND column_name = 'is_simulated'
    ) THEN
        RAISE EXCEPTION '0052 self-check: gateways.is_simulated was not created.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'devices' AND column_name = 'is_simulated'
    ) THEN
        RAISE EXCEPTION
          '0052 self-check: devices.is_simulated exists. Whether a device''s telemetry is synthetic '
          'is inherited from its gateway and must not be stored twice -- a CHECK cannot span two '
          'tables, so keeping a device-level copy honest needs a trigger on devices for insert and '
          're-parenting AND one on gateways for the flip, and a stored copy that drifts is worse '
          'than no marking at all. See this migration''s header.';
    END IF;

    -- Reported rather than asserted: on a fresh install nothing is simulated yet, and on a
    -- long-lived one any number is legitimate. The count is here so an operator reading db-init's
    -- output can see whether the flag is in use at all.
    SELECT count(*) INTO v_simulated FROM public.gateways WHERE is_simulated;
    RAISE NOTICE
      '0052 self-check: gateways.is_simulated exists, devices carry no copy of it, and % gateway(s) '
      'are currently flagged simulated.', v_simulated;
END;
$selfcheck$;
