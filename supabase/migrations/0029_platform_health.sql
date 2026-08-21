-- =============================================================================================
-- Migration: 0029_platform_health.sql
-- The platform's own condition, in the shape a Grafana alert rule can evaluate
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- Takes the same psql variable 0027 does, for the same role:
--
--     -v bi_reader_password='...'
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS EXISTS AT ALL, WHEN THE DATA ALREADY DOES.
--
-- The platform alert rules alert on PLATFORM conditions -- a gateway gone stale, an enrolment stuck
-- in AWAITING_BIRTH, a quarantine queue filling. Every one of those signals is already in this
-- database. None of them was reachable, and `grafana/provisioning/alerting/alert-rules.yaml` says
-- why in its own header:
--
--     "`asset_config` is NOT among them and could not be: it lives in Supabase, and postgres_fdw
--      runs Supabase -> TimescaleDB, not the reverse."
--
-- Grafana could only see the historian. 0027 gave it a second datasource against THIS database, so
-- the blocker is gone -- but that datasource connects as `grafana_reader`, which may SELECT one
-- view and nothing else, deliberately.
--
-- ---------------------------------------------------------------------------------------------
-- SO THIS IS A SECOND NARROW VIEW, NOT A WIDER GRANT.
--
-- The obvious alternative is to grant `grafana_reader` SELECT on `gateway_status` and `devices`.
-- That would hand a service fronted by browser SSO the plant's asset inventory -- every machine,
-- its wire identity, its cell, its quarantine reason -- to evaluate three counts. The narrow grant
-- exists precisely to prevent that, and widening it the first time something needs one column is
-- how narrow grants stop being narrow.
--
-- What an alert rule needs is a NUMBER and, for the per-asset rules, the identity to label the
-- instance with. So this view emits exactly that: one row per condition worth alerting on, carrying
-- a count and -- where the condition is about a specific asset -- that asset's wire id. No cell, no
-- description, no quarantine reason, no telemetry.
--
-- ---------------------------------------------------------------------------------------------
-- ONE ROW PER SUBJECT, NOT ONE COLUMN PER CONDITION.
--
-- The shape is long rather than wide because that is what makes a Grafana rule MULTI-DIMENSIONAL:
-- one rule over `WHERE condition = 'gateway_stale'` produces one alert instance per gateway, with
-- the gateway in the labels. The alternative -- a single row of counts -- gives one alert that says
-- "three gateways are stale" and names none of them, which is the shape alert-rules.yaml already
-- rejected for the machine rules ("a rule that groups by asset_id covers whatever is on the floor").
--
-- The fleet-wide conditions carry `sparkplug_id = NULL` and a count, because there genuinely is no
-- subject -- which is the same admission `platform_alerts.entity_type = 'platform'` makes.
-- =============================================================================================

SET check_function_bodies = false;

\if :{?bi_reader_password}
\else
\set bi_reader_password ''
\endif

SELECT set_config('acs_cymru.bi_reader_password', :'bi_reader_password', false);


-- ---------------------------------------------------------------------------------------------
-- 1. The view
-- ---------------------------------------------------------------------------------------------
-- SECURITY DEFINER FUNCTION BEHIND IT, for the same reason 0027's storage view has one: the reader
-- needs no privilege on `gateways` or `devices`, and a non-security_invoker view alone would still
-- require the function it calls to be executable. Both mechanisms are load-bearing.
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
$fn$;

COMMENT ON FUNCTION public.platform_health_rows() IS
  'One row per platform condition worth alerting on: stale gateways, stuck enrolments, and the '
  'quarantine queue depth. SECURITY DEFINER so the Grafana reader needs no privilege on gateways '
  'or devices -- it emits a count and, where the condition names an asset, that asset''s wire id, '
  'and nothing else about it.';

CREATE OR REPLACE VIEW public.platform_health AS
SELECT now() AS collected_at, r.* FROM public.platform_health_rows() r;

COMMENT ON VIEW public.platform_health IS
  'The platform''s own condition, long-form so a Grafana rule over one `condition` value produces '
  'one alert instance per subject. Read by the `supabase` datasource; see '
  'grafana/provisioning/alerting/alert-rules.yaml.';

-- NOT A POSTGREST ENDPOINT, for the same reason storage_footprint is not: `public` is in
-- PGRST_DB_SCHEMAS and Supabase's bootstrap grants defaults in it, so a view added here is
-- browser-readable unless something says otherwise. The dashboard already has this information
-- through its own queries, with RLS applied.
REVOKE ALL ON public.platform_health FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_health_rows() FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- 2. The dashboard reader gains exactly one more view
-- ---------------------------------------------------------------------------------------------
DO $roles$
DECLARE
    v_password text := btrim(coalesce(current_setting('acs_cymru.bi_reader_password', true), ''));
    v_role     CONSTANT text := 'grafana_reader';
BEGIN
    IF v_password = '' OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        RAISE NOTICE '0029: % not configured; skipping the grant.', v_role;
        RETURN;
    END IF;

    EXECUTE format('GRANT SELECT ON public.platform_health TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.platform_health_rows() TO %I', v_role);

    RAISE NOTICE
      '0029: % may now SELECT public.platform_health as well as public.storage_footprint.', v_role;
END;
$roles$;


-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_conditions text;
BEGIN
    -- The view resolves lazily, so creating it proves nothing about whether it runs.
    SELECT string_agg(DISTINCT condition, ', ' ORDER BY condition)
      INTO v_conditions FROM public.platform_health;

    IF v_conditions IS NULL OR position('quarantine_depth' IN v_conditions) = 0 THEN
        RAISE EXCEPTION
          '0029 self-check: platform_health did not emit quarantine_depth. That row is emitted '
          'unconditionally -- at zero as well as above it -- so its absence means the view is not '
          'returning what the alert rules read.';
    END IF;

    -- The narrow grant, asserted from the other direction: the reader must NOT have acquired the
    -- inventory this view exists to avoid exposing.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader')
       AND has_table_privilege('grafana_reader', 'public.devices', 'SELECT') THEN
        RAISE EXCEPTION
          '0029 self-check: grafana_reader can read public.devices. platform_health exists so that '
          'it does not need to.';
    END IF;

    RAISE NOTICE '0029 self-check passed: platform_health emits [%].', v_conditions;
END;
$selfcheck$;
