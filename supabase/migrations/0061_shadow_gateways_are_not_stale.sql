-- =============================================================================================
-- Migration: 0061_shadow_gateways_are_not_stale.sql
-- A gateway nothing publishes as cannot also be a gateway whose silence is a fault
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- THE DEFECT, AND WHY IT IS AN ORDERING STORY RATHER THAN AN OVERSIGHT.
--
-- `platform_health`'s `gateway_stale` arm (0029) excludes archived gateways and nothing else. The
-- `Playback` gateway seeded by 0060 is not archived and never heartbeats:
--
--    sparkplug_id             | name     | is_shadow | is_archived | is_stale | heartbeat_age
--   --------------------------+----------+-----------+-------------+----------+---------------
--    gwy160000000000400080000 | Playback | t         | f           | t        | 4509
--
-- so it was the only row the view reported under `gateway_stale`, permanently, and the Grafana
-- rule `acs-gateway-stale` (`for: 5m`) alarms on any row at all. The alert fired five minutes after
-- every boot and never cleared.
--
-- 0029 was CORRECT WHEN WRITTEN. `is_shadow` arrives in 0059 and the gateway itself in 0060, thirty
-- one migrations later -- the rule was made wrong by something added beside it, which is the shape
-- of defect no amount of care inside 0029 could have prevented.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT A SHADOW GATEWAY IS, AND WHY ITS SILENCE IS THE DESIGN.
--
-- Nothing publishes as it until a playback runs. That is deliberate and is the reason
-- `start_playback_job()` gates on credential possession rather than on `status = 'ONLINE'`:
-- requiring liveness "would refuse every first playback and pass only after one had already
-- succeeded". A stack can go months without a playback and the lane is behaving correctly
-- throughout.
--
-- 0029's own comment states the cost of alerting on it, about archived appliances:
--
--     "A decommissioned appliance is not heartbeating on purpose, and alerting on it would train an
--      operator to ignore the rule."
--
-- That was happening to the one rule that exists to say a real appliance has gone quiet -- on most
-- deployments the only gateway alert anyone will ever have seen, wrong, and firing since install.
--
-- ---------------------------------------------------------------------------------------------
-- `is_shadow` IS THE PREDICATE, AND THE OTHER THREE FLAGS WOULD EACH BE WRONG.
--
--   is_simulated  every simulator gateway carries it, and those DO heartbeat -- their silence is a
--                 real fault. Excluding them silences the fleet this stack demonstrates with.
--   is_virtual    answers whether an edge appliance physically exists, not whether anything
--                 publishes as it. A virtual gateway backed by a running flow is expected to report.
--   is_archived   would mean archiving the Playback gateway, which removes it from places it
--                 belongs -- 0060's trigger requires exactly one live shadow gateway to exist.
--
-- ---------------------------------------------------------------------------------------------
-- THE BODY IS REPRODUCED IN FULL, not patched.
--
-- Same discipline 0048 and 0051 record: a redeclaration that edited one WHERE clause would leave
-- the other two arms in a different migration from the one that is live, and a reader would have to
-- assemble the function from two files to know what it emits. Produced by copying 0029's text and
-- adding one line, so the arms this migration does not change are byte-for-byte what they were.
--
-- Registered in `INTENDED_REDECLARATIONS` in scripts/check-docs-drift.mjs, which is where "yes, I
-- meant to replace that" has to be written down.
--
-- PRIVILEGES ARE UNTOUCHED BY DESIGN. `CREATE OR REPLACE FUNCTION` preserves the existing ACL, so
-- 0029's conditional grant to `grafana_reader` -- and its REVOKE from anon and authenticated --
-- survive this without being restated. Restating them would need the psql variable 0029 takes, and
-- a migration that silently skipped the grant when run without it would be worse than one that
-- never touches it.
--
-- NOT CHANGED HERE, and left as a deliberate open question: `gateway_health` (0036) carries the
-- same archived-only exclusion, so the Playback lane still appears in the health PANEL with a stale
-- heartbeat. A panel is an inventory and an alert is a demand for action -- a row an operator can
-- see and understand may be right to keep, and answering both with one predicate would be fixing
-- the second by reflex.
--
-- Related: 0029 (the view this replaces one arm of), 0059 (is_shadow), 0060 (the gateway),
--          grafana/provisioning/alerting/alert-rules.yaml (`acs-gateway-stale`),
--          ingestion/README.md (why a playback target is legitimately OFFLINE).
-- =============================================================================================

SET check_function_bodies = false;

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
    --
    -- SHADOW GATEWAYS ARE EXCLUDED FOR THE SAME REASON (0061). Nothing publishes as the Playback
    -- gateway until a playback runs, so its silence is the design rather than a symptom -- see this
    -- migration's header for why `is_shadow` and not one of the other three flags.
    -- ---------------------------------------------------------------------------------------
    SELECT 'gateway_stale'::text,
           g.sparkplug_id,
           g.name,
           g.heartbeat_age_seconds::numeric,
           format('%s has not reported for %s seconds', g.name, g.heartbeat_age_seconds)
      FROM public.gateway_status g
     WHERE g.is_stale
       AND NOT g.is_archived
       AND NOT g.is_shadow

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
    --
    -- NO SHADOW ARM NEEDED HERE, and that is a fact about the data rather than an omission: a
    -- shadow gateway is seeded rather than enrolled, so `enrolled_at IS NULL` and it can never
    -- reach AWAITING_BIRTH.
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
$fn$;

COMMENT ON FUNCTION public.platform_health_rows() IS
  'One row per platform condition worth alerting on: stale gateways, stuck enrolments, and the '
  'quarantine queue depth. SECURITY DEFINER so the Grafana reader needs no privilege on gateways '
  'or devices -- it emits a count and, where the condition names an asset, that asset''s wire id, '
  'and nothing else about it. Shadow gateways are outside `gateway_stale` (0061): nothing '
  'publishes as one until a playback runs, so its silence is not a fault.';


-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
-- BOTH DIRECTIONS IN ONE COMPARISON, because either alone passes in a state that is broken. An
-- empty `gateway_stale` set proves nothing if the arm now excludes everything, and a shadow gateway
-- being absent proves nothing on a stack where it happens to be within its heartbeat window.
--
-- So the assertion is that the view emits EXACTLY the gateways the predicate names -- no shadow
-- among them, and every non-shadow stale one still there. That holds on a healthy stack with no
-- stale gateway at all (0 = 0) and keeps meaning as soon as one appears.
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_emitted  integer;
    v_expected integer;
    v_shadows  text;
BEGIN
    SELECT count(*) INTO v_emitted
      FROM public.platform_health
     WHERE condition = 'gateway_stale';

    SELECT count(*) INTO v_expected
      FROM public.gateway_status g
     WHERE g.is_stale AND NOT g.is_archived AND NOT g.is_shadow;

    IF v_emitted IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION
          '0061 self-check: platform_health emits % gateway_stale row(s) where the predicate names '
          '%. The arm and the rule behind it have come apart.', v_emitted, v_expected;
    END IF;

    SELECT string_agg(h.subject, ', ' ORDER BY h.subject) INTO v_shadows
      FROM public.platform_health h
      JOIN public.gateways g ON g.sparkplug_id = h.sparkplug_id
     WHERE h.condition = 'gateway_stale' AND g.is_shadow;

    IF v_shadows IS NOT NULL THEN
        RAISE EXCEPTION
          '0061 self-check: shadow gateway(s) [%] are still reported as stale. Nothing publishes '
          'as a shadow gateway until a playback runs, so alerting on it teaches an operator to '
          'ignore the rule that says a real appliance has gone quiet.', v_shadows;
    END IF;

    RAISE NOTICE
      '0061 self-check passed: gateway_stale emits % row(s) and no shadow gateway among them.',
      v_emitted;
END;
$selfcheck$;
