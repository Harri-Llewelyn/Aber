-- =============================================================================================
-- 0074_expected_publishers.sql
--
-- Adds an `expected_publishers` row to `platform_health_rows()`, so the "Ingestion Consuming
-- Nothing" alert can tell "no telemetry" apart from "no telemetry FROM A FLEET THAT SHOULD BE
-- SENDING SOME". Only the second is a fault.
--
-- WHY THE RULE NEEDED THIS. It fired on `sum(rate(acs_ingestion_messages_total[5m])) < 0.001` and
-- nothing else, which is permanently true on a stack with no devices. That was indistinguishable
-- from healthy while a demonstration floor published from the moment the stack booted. A fresh
-- install now comes up with no devices at all, so the daemon correctly consumes nothing, correctly
-- reports it, and the rule fired on every new install -- an alert whose first appearance is on a
-- stack nobody has configured yet, which is how people learn to close the panel without reading it.
--
-- ---------------------------------------------------------------------------------------------
-- WHY IT IS A VIEW ROW AND NOT A QUERY IN THE ALERT RULE
--
-- The obvious version puts `SELECT count(*) FROM public.devices` straight in the rule. That fails,
-- and 0029 already decided it should: `grafana_reader` holds SELECT on `platform_health` and on
-- nothing else, and 0029's own self-check ASSERTS the reader has no privilege on `public.devices`
-- -- the view exists precisely so that alerting never needs the inventory. The failure is not a
-- refusal a reader would understand either: the rule goes to `error` health reporting
-- `permission denied for table devices`, which reads as a broken datasource rather than as a grant
-- doing its job. (Measured here, not predicted -- that is exactly what the first attempt did.)
--
-- So the count comes through the same SECURITY DEFINER function every other platform condition
-- already uses. It emits a number and nothing about any asset.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT COUNTS AS "EXPECTED TO PUBLISH", AND WHY EACH EXCLUSION IS THERE
--
--   * NOT archived      -- a decommissioned device is silent on purpose.
--   * NOT quarantined   -- a held device's telemetry is DROPPED BY DESIGN until it is approved.
--                          Counting it would make approving a quarantine look like the fix for an
--                          alert about ingestion.
--   * HAS a gateway     -- a device bound to no edge node has nothing to arrive through.
--
-- ZERO DISABLES THE ALERT, and that is the intent rather than a gap: with nothing provisioned there
-- is no claim to make about telemetry. The first device somebody registers re-arms it.
--
-- EMITTED EVEN AT ZERO, for the reason the `quarantine_depth` arm gives in full: a query that
-- returns no rows when healthy cannot be told apart from a datasource that is down, because Grafana
-- reads an empty frame as NoData.
--
-- ---------------------------------------------------------------------------------------------
-- THE WHOLE FUNCTION IS RESTATED, WHICH IS NOT A STYLE CHOICE
--
-- PostgreSQL has no way to append an arm to a function, so `CREATE OR REPLACE` carries 0029's three
-- conditions verbatim plus the new one. The self-check below asserts the older conditions survived,
-- because the failure mode of restating a body is dropping a line out of it -- and a missing
-- `gateway_stale` arm would present as a fleet that never goes stale, which nothing else would
-- notice.
--
-- Related: 0029 (the view, the narrow grant, and the self-check that forbids the shortcut),
--          0073 (which made an empty shopfloor the default and so surfaced this).
-- =============================================================================================

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.platform_health_rows()
RETURNS TABLE (
    condition     text,
    sparkplug_id  text,
    subject       text,
    value         numeric,
    detail        text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
    -- ---------------------------------------------------------------------------------------
    -- A gateway that has stopped heartbeating.
    --
    -- READS `gateway_status.is_stale` RATHER THAN RE-DERIVING IT. That view owns the staleness
    -- threshold (90 seconds, mirrored into the frontend and checked by check-mirror-drift.mjs), and
    -- a second copy of the arithmetic here would be a second place for it to drift. The alert rule
    -- adds its own `for:` duration on top, which is the part that belongs to alerting rather than
    -- to the definition of stale.
    --
    -- ARCHIVED GATEWAYS ARE EXCLUDED. A decommissioned appliance is not heartbeating on purpose,
    -- and alerting on it would train an operator to ignore the rule.
    -- ---------------------------------------------------------------------------------------
    SELECT 'gateway_stale'::text,
           g.sparkplug_id,
           g.name,
           g.heartbeat_age_seconds::numeric,
           format('%s has not reported for %s seconds', g.name, g.heartbeat_age_seconds)
      FROM public.gateway_status g
     WHERE g.is_stale
       AND NOT g.is_archived

    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- An enrolment that never completed.
    --
    -- A physical gateway redeems its token, lands in AWAITING_BIRTH, and leaves that state on its
    -- first NBIRTH. One that stays there has authenticated to the broker and then failed to
    -- publish -- a flow that did not deploy, a credential the appliance did not persist. 0025
    -- introduced the state and NOTHING has ever alarmed on it, so the failure mode today is a
    -- gateway that silently never arrives.
    --
    -- The age is measured from `enrolled_at`, which 0025 stamps at redemption.
    -- ---------------------------------------------------------------------------------------
    SELECT 'enrolment_stuck'::text,
           g.sparkplug_id,
           g.name,
           EXTRACT(EPOCH FROM (now() - g.enrolled_at))::numeric,
           format('%s has been AWAITING_BIRTH since %s', g.name, g.enrolled_at)
      FROM public.gateways g
     WHERE g.status = 'AWAITING_BIRTH'
       AND g.enrolled_at IS NOT NULL
       AND NOT g.is_archived

    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- The quarantine queue.
    --
    -- FLEET-WIDE, AND THEREFORE ONE ROW WITH NO SUBJECT. A queue depth is a property of the queue;
    -- naming one of its members would be arbitrary. This is the condition `entity_type = 'platform'`
    -- was added to `platform_alerts` for.
    --
    -- EMITTED EVEN AT ZERO, which is deliberate. A rule whose query returns NO ROWS when healthy
    -- cannot distinguish "nothing is quarantined" from "the datasource is down" -- Grafana treats
    -- an empty frame as NoData and the rule's NoData handling decides what happens, which is a
    -- second thing to configure correctly. A row carrying 0 makes the healthy case explicit and
    -- lets the threshold do the work.
    -- ---------------------------------------------------------------------------------------
    SELECT 'quarantine_depth'::text,
           NULL::text,
           'fleet'::text,
           count(*)::numeric,
           format('%s device(s) awaiting an approval decision', count(*))
      FROM public.devices d
     WHERE d.is_quarantined
       AND NOT d.is_archived
    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- Devices that SHOULD be publishing. See this migration's header for why each exclusion is
    -- here and why zero is the answer that disables the alert rather than a gap in it.
    -- ---------------------------------------------------------------------------------------
    SELECT 'expected_publishers'::text,
           NULL::text,
           'fleet'::text,
           count(*)::numeric,
           format('%s device(s) registered, unarchived, unquarantined and bound to a gateway',
                  count(*))
      FROM public.devices d
     WHERE NOT d.is_archived
       AND NOT d.is_quarantined
       AND d.gateway_id IS NOT NULL
$fn$;
COMMENT ON FUNCTION public.platform_health_rows() IS
  'One row per platform condition worth alerting on: stale gateways, stuck enrolments, the '
  'quarantine queue depth, and how many devices are expected to be publishing. SECURITY DEFINER so '
  'the Grafana reader needs no privilege on gateways or devices -- it emits a count and, where the '
  'condition names an asset, that asset''s wire id, and nothing else about it.';

DO $roles$
BEGIN
    -- CREATE OR REPLACE preserves existing grants, so this is belt-and-braces rather than
    -- load-bearing -- but a future DROP/CREATE would not preserve them, and the symptom would be
    -- every platform alert going to `error` at once with a permission message about a function
    -- nobody had touched.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.platform_health_rows() TO grafana_reader';
    END IF;
END;
$roles$;

DO $selfcheck$
DECLARE
    v_conditions text;
BEGIN
    -- The view resolves lazily, so replacing the function proves nothing about whether it runs.
    SELECT string_agg(DISTINCT condition, ', ' ORDER BY condition)
      INTO v_conditions FROM public.platform_health;

    IF v_conditions IS NULL OR position('expected_publishers' IN v_conditions) = 0 THEN
        RAISE EXCEPTION
          '0074 self-check: platform_health did not emit expected_publishers. That row is emitted '
          'unconditionally -- at zero as well as above it -- and the ingestion-silence rule reads '
          'it to decide whether silence is a fault at all. Emitted: %',
          coalesce(v_conditions, '(nothing)');
    END IF;

    -- 0029'S ARMS MUST SURVIVE THE RESTATEMENT. This is the check that earns its keep: dropping one
    -- while retyping the body would present as a condition that never fires, which no other test
    -- here would see.
    IF position('quarantine_depth' IN v_conditions) = 0 THEN
        RAISE EXCEPTION
          '0074 self-check: replacing platform_health_rows() lost 0029''s quarantine_depth arm. '
          'Emitted: %', v_conditions;
    END IF;

    -- The grant this view exists to avoid needing, asserted from the direction 0029 asserts it.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader')
       AND has_table_privilege('grafana_reader', 'public.devices', 'SELECT') THEN
        RAISE EXCEPTION
          '0074 self-check: grafana_reader can SELECT public.devices. The count above exists so '
          'that it does not have to.';
    END IF;

    RAISE NOTICE '0074 self-check passed: platform_health emits %.', v_conditions;
END;
$selfcheck$;

NOTIFY pgrst, 'reload schema';
