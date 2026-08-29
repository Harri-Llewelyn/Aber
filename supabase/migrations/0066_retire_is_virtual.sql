-- =============================================================================================
-- Migration: 0066_retire_is_virtual.sql
-- The word goes, and with it the last place three meanings could hide behind one name
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- THE END OF ROADMAP §15's RENAME
--
--   0064  added `deployment` ('host' | 'remote') and kept it in step with `is_virtual`.
--   0065  moved every SQL predicate onto it.
--   here  moves the last reader, drops the transitional trigger, and drops the column.
--
-- The frontend, the edge functions and provisioning move in the same commit. Nothing reads
-- `is_virtual` by the time this runs, which is the only reason it can run at all: PostgreSQL
-- refuses to drop a column a view depends on, and `gateway_status` is `SELECT g.*`.
--
-- ---------------------------------------------------------------------------------------------
-- WHY `gateway_health_rows()` WAITED FOR THIS FILE
--
-- Its RETURNS TABLE signature NAMES the column, so this is not a body swap: PostgreSQL will not
-- replace a function whose return type changes, and the `gateway_health` view is built on it. The
-- pair has to be dropped and recreated together, which is a heavier act than 0065's six and belongs
-- with the column's removal rather than beside them.
--
-- WHAT CONSUMES IT: Grafana's gateway-health panel, through `grafana_reader`. It selects columns by
-- name and does not name this one -- checked before changing the shape rather than after.
--
-- ---------------------------------------------------------------------------------------------
-- THE VIEW MUST BE DROPPED BEFORE THE COLUMN, AND REBUILT AFTER
--
-- `gateway_status` is `SELECT g.*`, which PostgreSQL freezes into an explicit column list at
-- creation. That is what makes `ensure_gateway_status_view()` necessary when a column is ADDED --
-- the rule `check-docs-drift.mjs` enforces -- and it is the same fact from the other side here: the
-- frozen list is a hard dependency, so `ALTER TABLE ... DROP COLUMN` fails outright while the view
-- exists. Nothing else depends on it (checked in pg_depend: no view is built on `gateway_status`),
-- so dropping and rebuilding it is contained.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IS DELIBERATELY LEFT CARRYING THE OLD WORD
--
--   * `0025_physical_gateway_enrollment.sql` and every other migration filename. The chain is
--     immutable; a rename would break the ledger nothing keeps.
--   * `authorize_virtual_gateway_credential()`. It is an RPC name, called from the frontend, and
--     renaming it is a client-visible change with its own blast radius. It stays until there is a
--     reason to touch it that is not tidiness -- and its comment now says what it actually asks.
--   * Every `CREDENTIAL_ISSUED` audit row written before 0065, which records `is_virtual` in its
--     `new_data`. An audit row states what was true in the vocabulary of its time.
--
-- Related: 0064 (the column), 0065 (the predicates), 0036 (gateway_health_rows), README.md §15.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. The health view, whose signature has to change rather than its body
-- ---------------------------------------------------------------------------------------------
DROP VIEW IF EXISTS public.gateway_health;
DROP FUNCTION IF EXISTS public.gateway_health_rows();

CREATE FUNCTION public.gateway_health_rows()
RETURNS TABLE (
    sparkplug_id          text,
    gateway_name          text,
    live_status           text,
    is_stale              boolean,
    deployment            text,
    heartbeat_age_seconds bigint,
    health_reported_at    timestamptz,
    health_age_seconds    bigint,
    uptime_seconds        bigint,
    load_1m               real,
    mem_available_bytes   bigint,
    disk_free_bytes       bigint,
    cert_expires_at       timestamptz,
    cert_expires_in_days  numeric,
    agent_version         text,
    flow_hash             text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
    SELECT
        g.sparkplug_id,
        g.name,
        g.live_status,
        g.is_stale,
        g.deployment,
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
  'and this does not cross it. Reports `deployment` since 0066, where it reported is_virtual.';

CREATE VIEW public.gateway_health AS
SELECT now() AS collected_at, r.* FROM public.gateway_health_rows() r;

COMMENT ON VIEW public.gateway_health IS
  'Per-gateway health for the Grafana panel, read through grafana_reader. See '
  'gateway_health_rows() for what it deliberately does not carry.';

-- DROP discards grants with the object, so they are re-applied rather than assumed. Same reasoning
-- as ensure_gateway_status_view()'s own re-grant block.
REVOKE ALL ON public.gateway_health FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_health_rows() FROM PUBLIC, anon, authenticated;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    GRANT SELECT   ON public.gateway_health      TO grafana_reader;
    GRANT EXECUTE  ON FUNCTION public.gateway_health_rows() TO grafana_reader;
    RAISE NOTICE '0066: grafana_reader may read public.gateway_health.';
  ELSE
    RAISE NOTICE '0066: grafana_reader does not exist; skipping its grant (0027 creates it).';
  END IF;
END;
$grants$;


-- ---------------------------------------------------------------------------------------------
-- 2. The transitional sync goes with the column it was syncing
-- ---------------------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_gateways_sync_deployment ON public.gateways;
DROP FUNCTION IF EXISTS public.sync_gateway_deployment();


-- ---------------------------------------------------------------------------------------------
-- 3. The column
-- ---------------------------------------------------------------------------------------------
DROP VIEW IF EXISTS public.gateway_status;
ALTER TABLE public.gateways DROP COLUMN IF EXISTS is_virtual;
SELECT public.ensure_gateway_status_view();


-- ---------------------------------------------------------------------------------------------
-- 4. Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
  v_count int;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'gateways' AND column_name = 'is_virtual'
  ) THEN
    RAISE EXCEPTION '0066 self-check: gateways.is_virtual is still present.';
  END IF;

  -- The view has to come back, and with the surviving column in it. A DROP that rebuilt nothing
  -- would take the whole read surface with it -- every consumer of gateway_status reads through
  -- this view, including gateway_health_rows() two sections above.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'gateway_status' AND column_name = 'deployment'
  ) THEN
    RAISE EXCEPTION
      '0066 self-check: public.gateway_status is missing or does not expose `deployment`.';
  END IF;

  SELECT count(*) INTO v_count FROM public.gateway_health;
  RAISE NOTICE '0066 self-check passed: is_virtual is gone, gateway_status carries deployment, '
               'and gateway_health answers for % gateway(s).', v_count;
END;
$selfcheck$;
