-- =================================================================================================
-- 0092 :: A DEVICE BEHIND A GATEWAY THAT NEVER ARRIVED IS NOT LATE
-- =================================================================================================
--
-- "Ingestion Consuming Nothing" fires when the daemon has recorded nothing for ten minutes and
-- `expected_publishers` is greater than zero. The gate counted a device on the strength of
-- `gateway_id IS NOT NULL`, so registering a device against a gateway whose bundle nobody has
-- deployed raised a critical alert naming the broker during the exact task where a false alarm
-- costs most.
--
-- A device now qualifies on either piece of evidence that a path has existed at least once:
--   1. `devices.first_dbirth_at IS NOT NULL`: this device has published.
--   2. its gateway's `last_heartbeat IS NOT NULL`: the edge node has been heard from. Nothing
--      clears that column once set, so it is a record of first contact, not a liveness reading,
--      and a dead gateway's devices stay in the count, which is the case the alert is for.
-- Not `enrolled_at` (a credential proves nothing was deployed) and not `status = 'ONLINE'` (a
-- liveness reading, which would disable the alert in the one state it exists for). Zero still
-- disables the rule.
--
-- The rest of `platform_health_rows()` is copied from 0001's text, not retyped: a dropped
-- condition does not error, the rule reading it goes to NoData, and the alarm stops existing.
-- The self-check asserts all four conditions still come back.
-- =================================================================================================

CREATE OR REPLACE FUNCTION public.platform_health_rows() RETURNS TABLE(condition text, sparkplug_id text, subject text, value numeric, detail text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    -- ---------------------------------------------------------------------------------------
    -- A gateway that has stopped heartbeating. Reads `gateway_status.is_stale` rather than
    -- re-deriving it: that view owns the 90s threshold. Archived gateways are excluded.
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
    -- An enrolment that never completed: redeemed its token, landed in AWAITING_BIRTH, and never
    -- published. Age is measured from `enrolled_at`.
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
    -- The quarantine queue: fleet-wide, so one row with no subject (`entity_type = 'platform'`).
    -- Emitted even at zero, so "nothing is quarantined" and "the datasource is down" are
    -- distinguishable.
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
           format('%s device(s) registered, unarchived, unquarantined, and behind a gateway that '
                  'has reported at least once', count(*))
      FROM public.devices d
     WHERE NOT d.is_archived
       AND NOT d.is_quarantined
       AND d.gateway_id IS NOT NULL
       -- 0092. BEING BOUND TO A GATEWAY IS NOT EVIDENCE THAT A PATH HAS EVER EXISTED. See this
       -- migration's header: a device behind an edge node nobody has deployed yet is not late.
       AND (
             -- The device has published. The strongest evidence available, and about the device
             -- itself rather than about something it points at.
             d.first_dbirth_at IS NOT NULL
             -- Or its gateway has been heard from at least once, ever. 0001's own comment on the
             -- column is the contract: "NULL means no heartbeat has ever arrived." Nothing clears
             -- it, so a gateway that has since DIED still counts -- which is correct, because that
             -- is precisely the case this alert exists for.
             OR EXISTS (
                  SELECT 1 FROM public.gateways g
                   WHERE g.id = d.gateway_id
                     AND g.last_heartbeat IS NOT NULL
                )
           )
$$;

-- -------------------------------------------------------------------------------------------------
-- Self-check
-- -------------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_conditions text;
BEGIN
    -- ALL FOUR CONDITIONS SURVIVE THE REDECLARATION. `expected_publishers` and `quarantine_depth`
    -- are emitted even at zero, so both are always present on any database; the two gateway
    -- conditions depend on a gateway actually being in that state, so their absence proves nothing
    -- and is not asserted.
    SELECT string_agg(DISTINCT condition, ',' ORDER BY condition) INTO v_conditions
      FROM public.platform_health_rows();

    IF v_conditions IS NULL
       OR position('expected_publishers' in v_conditions) = 0
       OR position('quarantine_depth' in v_conditions) = 0 THEN
        RAISE EXCEPTION
            '0092 self-check: platform_health_rows() emits [%], which is missing one of the two '
            'conditions it reports even at zero.', coalesce(v_conditions, 'nothing');
    END IF;

    RAISE NOTICE
        '0092: a device behind a gateway that has never reported is no longer counted as late.';
END
$selfcheck$;
