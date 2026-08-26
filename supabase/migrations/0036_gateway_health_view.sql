-- =============================================================================================
-- Migration: 0036_gateway_health_view.sql
-- The fleet's condition, in the shape a Grafana dashboard can select a gateway from
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- Takes the same psql variable 0027 and 0029 do, for the same role:
--
--     -v bi_reader_password='...'
--
-- ---------------------------------------------------------------------------------------------
-- WHY A THIRD VIEW RATHER THAN A WIDER GRANT, WHICH IS THE QUESTION 0029 ALREADY ANSWERED ONCE.
--
-- The Grafana reader may SELECT `storage_footprint` (0027) and `platform_health` (0029) and
-- nothing else; 0027 re-revokes the rest of the schema on every boot. Neither view can back a
-- gateway dashboard:
--
--   * `platform_health` is a list of CONDITIONS -- stale gateways, stuck enrolments, the
--     quarantine depth. A dashboard variable built from it would offer only the UNHEALTHY
--     gateways, which is precisely backwards for a fleet view.
--   * It carries none of 0035's telemetry, because none of that is a condition.
--
-- 0029's header rejected the obvious alternative in terms that apply here too: granting SELECT on
-- `gateway_status` and `devices` would hand a service fronted by browser SSO the plant's asset
-- inventory, and "widening it the first time something needs one column is how narrow grants stop
-- being narrow". That reasoning stands. This follows the pattern it established instead.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS DOES AND DOES NOT CROSS, STATED PRECISELY, BECAUSE IT LOOKS LIKE A WIDENING.
--
-- The line 0029 drew is around the ASSET INVENTORY: devices, cells, quarantine reasons, machine
-- descriptions. GATEWAY IDENTITY IS ALREADY ACROSS IT -- `platform_health` emits `g.name` as
-- `subject` for every stale gateway and every stuck enrolment, and has since 0029. So exposing
-- gateway names and their appliance health is the same subject class the reader already sees, for
-- the same purpose (platform operations), not a step toward the inventory.
--
-- NOTHING ABOUT A DEVICE APPEARS HERE. No cell, no device count, no quarantine state, no
-- `description`, no `access_url`. If a future panel wants one of those, it needs its own argument
-- rather than a column quietly added to this list.
--
-- ---------------------------------------------------------------------------------------------
-- IT READS `gateway_status`, NOT `gateways`, AND THAT IS NOT A DETAIL.
--
-- That view owns the 90-second staleness threshold -- mirrored into the frontend and asserted by
-- check-mirror-drift.mjs -- and 0029 reads it for the same reason: a second copy of the arithmetic
-- here would be a second place for it to drift.
--
-- It is also why 0035 had to end with `SELECT public.ensure_gateway_status_view()`. That view is
-- declared `SELECT g.*`, which Postgres freezes at creation, so the seven health columns would
-- otherwise be invisible through it -- and this view would return NULLs for all of them while
-- erroring at nothing. check-docs-drift.mjs now asserts that every migration adding a gateways
-- column is followed by a rebuild.
--
-- ---------------------------------------------------------------------------------------------
-- CURRENT VALUES, AND THE DASHBOARD IS BUILT KNOWING IT.
--
-- 0035 says plainly that these columns hold a latest reading and no history, so a time-series
-- panel over this view draws a flat line at `now`. That is why the ingestion daemon also exports
-- load, memory, disk and uptime as labelled Prometheus gauges: the trend lives there, the
-- authoritative current state and the identity live here, and the dashboard uses both. The
-- exclusions from the Prometheus half -- `agent_version`, `flow_hash`, `cert_expires_at` -- are
-- argued in ingestion/metrics.py's header and are exactly why this view still has to exist.
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
-- SECURITY DEFINER behind it, as with 0027's storage view and 0029's health view: the reader needs
-- no privilege on `gateways`, and a non-security_invoker view alone would still require the
-- function it calls to be executable.
CREATE OR REPLACE FUNCTION public.gateway_health_rows()
RETURNS TABLE (
    sparkplug_id           text,
    gateway_name           text,
    live_status            text,
    is_stale               boolean,
    is_virtual             boolean,
    heartbeat_age_seconds  bigint,
    health_reported_at     timestamptz,
    health_age_seconds     bigint,
    uptime_seconds         bigint,
    load_1m                real,
    mem_available_bytes    bigint,
    disk_free_bytes        bigint,
    cert_expires_at        timestamptz,
    cert_expires_in_days   numeric,
    agent_version          text,
    flow_hash              text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
    SELECT
        g.sparkplug_id,
        g.name,
        g.live_status,
        g.is_stale,
        g.is_virtual,
        g.heartbeat_age_seconds,
        g.health_reported_at,
        EXTRACT(EPOCH FROM (now() - g.health_reported_at))::bigint,
        g.uptime_seconds,
        g.load_1m,
        g.mem_available_bytes,
        g.disk_free_bytes,
        g.cert_expires_at,
        -- DERIVED HERE SO THE ALERT RULE AND THE PANEL CANNOT DISAGREE. A rule computing its own
        -- day count from the timestamp, and a stat panel computing another, is two expressions to
        -- keep in step for one number an operator acts on. Fractional on purpose: rounding to
        -- whole days would make a threshold of 30 fire a day early or late depending on the hour.
        EXTRACT(EPOCH FROM (g.cert_expires_at - now())) / 86400.0,
        g.agent_version,
        g.flow_hash
      FROM public.gateway_status g
     -- A DECOMMISSIONED APPLIANCE IS NOT A FAULT. Archived gateways are excluded for the same
     -- reason 0029 excludes them from `gateway_stale`: showing them trains an operator to ignore
     -- the panel that is meant to be scanned.
     WHERE NOT g.is_archived
$fn$;

COMMENT ON FUNCTION public.gateway_health_rows() IS
  'One row per live gateway: its identity, its heartbeat freshness, and the appliance health it '
  'reports (0035). SECURITY DEFINER so the Grafana reader needs no privilege on `gateways`. '
  'Carries NOTHING about devices, cells or quarantine -- that inventory is the boundary 0029 drew '
  'and this does not cross it.';

CREATE OR REPLACE VIEW public.gateway_health AS
SELECT now() AS collected_at, r.* FROM public.gateway_health_rows() r;

COMMENT ON VIEW public.gateway_health IS
  'The fleet''s current condition, one row per non-archived gateway. Read by the `supabase` '
  'datasource: backs the gateway variable and the panels in the "Gateway Fleet Health" dashboard, '
  'and the certificate-expiry alert rule. Current values only -- the trends are Prometheus gauges '
  'exported by the ingestion daemon.';

-- NOT A POSTGREST ENDPOINT, for the same reason storage_footprint and platform_health are not:
-- `public` is in PGRST_DB_SCHEMAS and Supabase's bootstrap grants defaults in it, so a view added
-- here is browser-readable unless something says otherwise. The dashboard already has this
-- information through its own queries, with RLS applied.
REVOKE ALL ON public.gateway_health FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_health_rows() FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- 2. The dashboard reader gains exactly one more view
-- ---------------------------------------------------------------------------------------------
DO $roles$
DECLARE
    v_password text := btrim(coalesce(current_setting('acs_cymru.bi_reader_password', true), ''));
    v_role     CONSTANT text := 'grafana_reader';
BEGIN
    IF v_password = '' OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        RAISE NOTICE '0036: % not configured; skipping the grant.', v_role;
        RETURN;
    END IF;

    EXECUTE format('GRANT SELECT ON public.gateway_health TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.gateway_health_rows() TO %I', v_role);

    RAISE NOTICE
      '0036: % may now SELECT public.gateway_health, alongside storage_footprint and '
      'platform_health.', v_role;
END;
$roles$;


-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_rows        int;
    v_health_cols int;
BEGIN
    -- The view resolves lazily, so creating it proves nothing about whether it runs.
    SELECT count(*) INTO v_rows FROM public.gateway_health;

    -- THE FAILURE THIS EXISTS FOR IS NOT AN ERROR, IT IS NULLS. If `gateway_status` were rebuilt
    -- without 0035's columns -- the trap 0035 section 3 describes -- this view would still resolve
    -- and would return NULL for every health field, and the dashboard would show blank tiles that
    -- read as "no appliance has reported yet". So the columns are asserted to EXIST on the view
    -- this one reads, rather than the query merely being asserted to run.
    SELECT count(*) INTO v_health_cols
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'gateway_status'
       AND column_name IN ('health_reported_at', 'uptime_seconds', 'load_1m',
                           'mem_available_bytes', 'disk_free_bytes', 'cert_expires_at',
                           'flow_hash');

    IF v_health_cols <> 7 THEN
        RAISE EXCEPTION
          '0036 self-check: public.gateway_status exposes % of 0035''s 7 health columns. The view '
          'is declared SELECT g.* and Postgres freezes that at creation, so it must be rebuilt '
          'after a column is added -- 0035 ends with SELECT public.ensure_gateway_status_view() '
          'for exactly this reason. Without it gateway_health returns NULLs and errors at nothing.',
          v_health_cols;
    END IF;

    -- The narrow grant, asserted from the other direction, exactly as 0029 does: this view exists
    -- so the reader does NOT acquire the inventory.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
        IF has_table_privilege('grafana_reader', 'public.devices', 'SELECT') THEN
            RAISE EXCEPTION
              '0036 self-check: grafana_reader can read public.devices. gateway_health exists so '
              'that it does not need to.';
        END IF;
        IF has_table_privilege('grafana_reader', 'public.gateways', 'SELECT') THEN
            RAISE EXCEPTION
              '0036 self-check: grafana_reader can read public.gateways directly. The SECURITY '
              'DEFINER function is what makes the base-table grant unnecessary.';
        END IF;
    END IF;

    RAISE NOTICE '0036 self-check passed: gateway_health returns % row(s).', v_rows;
END;
$selfcheck$;
