-- =============================================================================================
-- 0015_sparkplug_group_rebrand.sql
--
-- Moves the default Sparkplug B group id from 'FactoryPlus' to 'ACS-Cymru', completing the
-- application rename on the one identifier that is ON THE WIRE.
--
-- WHY A MIGRATION AND NOT JUST THE COLUMN DEFAULT. 0008 sets `DEFAULT 'FactoryPlus'`, and a
-- default only applies to rows inserted after it. Every gateway registered before this migration
-- carries the literal string, and `gateways.sparkplug_group` is half of the edge-node address
-- ingestion resolves: verify_gateway_binding() looks up (group, node), so a gateway row saying
-- 'FactoryPlus' while its device publishes on `spBv1.0/ACS-Cymru/...` resolves to nothing and the
-- message is quarantined as an unknown publisher.
--
-- ⚠ THIS IS A COORDINATED CHANGE, NOT A COSMETIC ONE. The group id is chosen by whatever
-- publishes, so a PHYSICAL gateway keeps sending the old group until it is reconfigured. Two ways
-- to land it safely:
--
--   * Re-point the gateway first, then run this. Its next DBIRTH arrives on the new group and
--     resolves against the updated row.
--   * Or run this, accept that the affected gateway's devices quarantine until it is
--     reconfigured, and approve them afterwards. Nothing is lost -- quarantine is the
--     fail-closed state, not a discard -- but telemetry stops being stored in the meantime.
--
-- The bundled Node-RED simulator and ingestion/validate.py both publish on the new group already,
-- so the demo stack needs no manual step.
--
-- ONLY ROWS STILL CARRYING THE OLD LITERAL ARE TOUCHED. A gateway an operator has deliberately
-- put on some other group -- 'Wales', a site code, a customer name -- is left exactly as it is.
-- The group is a free choice, and this migration is a rename of OUR default, not a policy.
--
-- Idempotent: db-init replays it on every boot and the second run matches no rows.
-- =============================================================================================

SET search_path TO public;

DO $$
DECLARE
  v_rows INTEGER;
BEGIN
  -- The column default itself, so rows inserted from here on need no correction. Guarded because
  -- ALTER COLUMN SET DEFAULT is not idempotent-by-nature the way the UPDATE below is -- it simply
  -- re-applies, which is harmless, but stating it explicitly keeps the intent readable.
  ALTER TABLE public.gateways ALTER COLUMN sparkplug_group SET DEFAULT 'ACS-Cymru';

  UPDATE public.gateways
     SET sparkplug_group = 'ACS-Cymru'
   WHERE sparkplug_group = 'FactoryPlus';
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows > 0 THEN
    RAISE NOTICE '0015: % gateway(s) moved from the FactoryPlus group to ACS-Cymru. Any PHYSICAL '
                 'gateway among them must be reconfigured to publish on the new group, or its '
                 'devices will quarantine until it is.', v_rows;
  ELSE
    RAISE NOTICE '0015: no gateway left on the FactoryPlus group.';
  END IF;
END;
$$;

-- Self-check. Proves the default moved as well as the rows -- a migration that updated the data
-- and left the default behind would look correct until the next gateway was registered.
DO $$
DECLARE
  v_default TEXT;
  v_stale   INTEGER;
BEGIN
  SELECT column_default INTO v_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'gateways' AND column_name = 'sparkplug_group';

  IF v_default IS NULL OR v_default NOT LIKE '%ACS-Cymru%' THEN
    RAISE EXCEPTION '0015 self-check: sparkplug_group default is %, expected ACS-Cymru', v_default;
  END IF;

  SELECT count(*) INTO v_stale FROM public.gateways WHERE sparkplug_group = 'FactoryPlus';
  IF v_stale > 0 THEN
    RAISE EXCEPTION '0015 self-check: % gateway(s) still on the FactoryPlus group', v_stale;
  END IF;

  RAISE NOTICE '0015 self-check passed: default and every row are on the ACS-Cymru group.';
END;
$$;

NOTIFY pgrst, 'reload schema';
