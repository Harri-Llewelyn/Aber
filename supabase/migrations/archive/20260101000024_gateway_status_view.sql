-- Migration: 20260101000024_gateway_status_view.sql
-- Description: Server-side mirror of frontend/src/utils/gatewayStatus.js, so consumers that
--              cannot run JavaScript -- Grafana, the alerting engine, any SQL client -- can
--              see gateway staleness.
--
-- WHY A VIEW AND NOT A pg_cron WRITER
--
-- The obvious implementation is a scheduled job that sweeps gateways and writes
-- status = 'STALE'. That is wrong here, for three reasons:
--
--   1. AUDIT BLOAT. log_digital_thread_event() is an unconditional AFTER INSERT OR UPDATE
--      OR DELETE trigger on public.gateways (migration 0000). Every sweep that touched a row
--      would append to digital_thread, which migration 0006 makes immutable -- unbounded
--      growth that cannot be cleaned up in place. This is the same failure mode the archive
--      already documents for birth-metric rewrites: "write only on change".
--   2. IT WOULD BE LESS ACCURATE, NOT MORE. Staleness is a pure function of NOW() and
--      last_heartbeat. Derived at read time it is exact; written by a job it is correct only
--      as of the last tick. A cron job trades precision for nothing.
--   3. A THIRD SOURCE OF TRUTH. last_heartbeat, gatewayStatus.js, and a stored STALE flag
--      would inevitably disagree.
--
-- This keeps last_heartbeat authoritative and computes the verdict on read -- the same
-- pattern the codebase already uses for device tags, unmodelled metrics and metric grouping.
--
-- KEEP IN STEP: the 90-second threshold below mirrors HEARTBEAT_STALE_MS in
-- frontend/src/utils/gatewayStatus.js (three missed beats of the Node-RED flow's 30s
-- heartbeat). Same mirroring obligation as utils/sparkplugId.js and utils/metricGroup.js.
--
-- WHY THIS IS A FUNCTION AND NOT A BARE `CREATE OR REPLACE VIEW`
--
-- The view selects `g.*`, which is expanded to a fixed column list at creation time and NOT
-- re-expanded afterwards. CREATE OR REPLACE VIEW only tolerates new columns APPENDED to the
-- end of the existing list. So the moment any later migration adds a column to
-- public.gateways, that column lands in the middle -- before live_status -- and replaying
-- this file fails with `cannot change name of view column "live_status"`.
--
-- That is not a theoretical hazard: supabase-db-init replays every migration on every boot,
-- so the failure is a stack that will not come up, triggered by an unrelated ALTER TABLE in
-- a file numbered above this one. No migration had added a gateways column since this view
-- was written, which is the only reason it had not been hit.
--
-- Dropping first removes the constraint entirely: the view is rebuilt from whatever
-- public.gateways looks like at that moment. Wrapping it in a function means a migration
-- that adds a gateways column can call this to refresh the view in the SAME boot, rather
-- than leaving it a column short until the next one -- and it keeps the 90s threshold in one
-- place instead of copied into every such migration. Same idiom, and same reason, as
-- ensure_cron_job() in migration 0025.
--
-- The DROP is deliberately NOT `CASCADE`. Nothing depends on this view today; if something
-- ever does, this should fail loudly and be dealt with, not silently drop the dependent.

CREATE OR REPLACE FUNCTION public.ensure_gateway_status_view()
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  DROP VIEW IF EXISTS public.gateway_status;

  -- security_invoker is load-bearing. Without it the view executes as its owner (postgres)
  -- and silently bypasses the RLS on public.gateways, exposing every gateway to any role
  -- holding SELECT on the view. With it, each caller's own policies apply exactly as on the
  -- base table. Requires PG15+; this stack is on supabase/postgres 15.6.
  CREATE VIEW public.gateway_status
  WITH (security_invoker = true) AS
  SELECT
    g.*,
    -- Mirrors gatewayLiveStatus(): a stored OFFLINE wins outright (an explicit NDEATH is not
    -- staleness), a gateway that has never reported keeps its stored status rather than being
    -- called stale, and anything else ages out.
    CASE
      WHEN g.status = 'OFFLINE'                                      THEN 'OFFLINE'
      WHEN g.last_heartbeat IS NULL                                  THEN g.status
      WHEN NOW() - g.last_heartbeat > INTERVAL '90 seconds'          THEN 'STALE'
      ELSE g.status
    END AS live_status,
    -- Mirrors isHeartbeatStale(): a gateway that has never reported is NOT stale (false),
    -- which is why this is not simply `live_status = 'STALE'`.
    (g.last_heartbeat IS NOT NULL
     AND NOW() - g.last_heartbeat > INTERVAL '90 seconds')           AS is_stale,
    EXTRACT(EPOCH FROM (NOW() - g.last_heartbeat))::BIGINT           AS heartbeat_age_seconds
  FROM public.gateways g;

  COMMENT ON VIEW public.gateway_status IS
    'public.gateways with heartbeat staleness derived at read time. Mirrors '
    'frontend/src/utils/gatewayStatus.js -- keep the 90s threshold in step. Deliberately a '
    'view, not a stored column or a pg_cron writer: writing status would append to the '
    'immutable digital_thread audit table on every sweep and would be stale between ticks. '
    'Rebuilt by public.ensure_gateway_status_view() -- call it after adding a gateways column.';

  -- DROP VIEW discards the grants with the view, so they are re-applied here rather than
  -- left outside the function where they would silently stop being re-run.
  --
  -- The revoke names `authenticated` and runs BEFORE the grant: Supabase's default privileges
  -- grant ALL on a new table in `public` to anon and authenticated, so the recreated view
  -- arrives holding INSERT/UPDATE/DELETE and a bare GRANT SELECT would leave them there. This
  -- view is not auto-updatable, so nothing could have written through it, but the privilege
  -- should say what is meant.
  REVOKE ALL ON public.gateway_status FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON public.gateway_status TO authenticated;
END $fn$;

-- Not callable by application roles: it performs DDL in the public schema.
REVOKE ALL ON FUNCTION public.ensure_gateway_status_view() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.ensure_gateway_status_view() IS
  'Drop-and-recreate public.gateway_status. Called here and by any later migration that adds '
  'a column to public.gateways -- the view selects g.*, which CREATE OR REPLACE VIEW cannot '
  'widen in place once a new column lands ahead of the derived ones.';

SELECT public.ensure_gateway_status_view();

NOTIFY pgrst, 'reload schema';
