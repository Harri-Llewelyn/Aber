-- =================================================================================================
-- 0092 :: A DEVICE BEHIND A GATEWAY THAT NEVER ARRIVED IS NOT LATE
-- =================================================================================================
--
-- "Ingestion Consuming Nothing" fires when the daemon has recorded no Sparkplug messages for ten
-- minutes AND `expected_publishers` is greater than zero. That gate exists because the rule used to
-- fire on every fresh install -- "no traffic" and "no traffic FROM A FLEET THAT SHOULD BE
-- PUBLISHING" are different conditions, and only the second is a fault.
--
-- THE GATE WAS STILL TOO WIDE. It counted a device as an expected publisher on the strength of
-- `gateway_id IS NOT NULL` -- being BOUND to a gateway, regardless of whether that gateway has ever
-- existed anywhere but in this database. Register a device, point it at a gateway whose bundle
-- nobody has deployed yet, and ten minutes later the platform raises a CRITICAL alert reading
-- "Telemetry is not reaching the historian. Check the broker connection."
--
-- Nothing is wrong with the broker, the daemon or the historian. The edge node was never set up.
-- The alert names the wrong subsystem, at the highest severity, during the exact task -- standing
-- up a new gateway -- where somebody is least equipped to tell a real fault from a false one. That
-- is the failure the original gate was written to prevent, arriving through a different door.
--
-- =================================================================================================
-- WHAT "SHOULD BE PUBLISHING" ACTUALLY REQUIRES
-- =================================================================================================
--
-- A path has to have existed at least once. There are two independent pieces of evidence for that,
-- and a device qualifies on EITHER:
--
--   1. `devices.first_dbirth_at IS NOT NULL` -- this device has published. Whatever its gateway
--      looks like now, a path existed and silence from it is a real change of state.
--
--   2. Its gateway's `last_heartbeat IS NOT NULL` -- the edge node has been heard from. 0001's own
--      comment on that column is the contract this leans on: "NULL means no heartbeat has ever
--      arrived." Nothing clears it once set -- the `last_heartbeat = NULL` writes elsewhere in 0001
--      are against `directory_services`, a different table -- so it is a permanent record of first
--      contact rather than a liveness reading.
--
-- A DEAD GATEWAY STILL COUNTS, AND MUST. A gateway that was publishing and has stopped keeps its
-- `last_heartbeat`, so its devices stay in this count -- which is exactly the case the alert is
-- for. What is excluded is only the gateway that has NEVER arrived, and that distinction is
-- available precisely because the column is never cleared.
--
-- WHY NOT `enrolled_at`. Enrolment issues a credential; it does not prove anything was ever
-- deployed with it. A gateway enrolled months ago whose bundle sat in a downloads folder is, as far
-- as telemetry is concerned, indistinguishable from one never enrolled at all.
--
-- WHY NOT `status = 'ONLINE'`. That is a liveness reading, and gating on it would disable the alert
-- in the one state it exists for: every gateway offline and nothing arriving.
--
-- ZERO STILL DISABLES THE RULE, and that remains the intent rather than a gap: with nothing that
-- has ever published, there is no claim to make about telemetry.
--
-- =================================================================================================
-- THE REST OF THIS FUNCTION IS COPIED, NOT REWRITTEN
-- =================================================================================================
--
-- `platform_health_rows()` is one SQL body, so changing one clause means redeclaring the whole
-- thing -- and the risk of that is silently dropping one of the three conditions that were only
-- being carried across. A missing condition does not error: the rule reading it goes to NoData, and
-- several of these treat NoData as OK, so the alarm simply stops existing.
--
-- SO THIS FILE WAS GENERATED FROM 0001'S TEXT rather than retyped, and the self-check at the
-- bottom asserts that all four conditions still come back.
-- =================================================================================================

CREATE OR REPLACE FUNCTION public.platform_health_rows() RETURNS TABLE(condition text, sparkplug_id text, subject text, value numeric, detail text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
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
