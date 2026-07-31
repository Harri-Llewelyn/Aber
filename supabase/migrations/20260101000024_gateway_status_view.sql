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
--      growth that cannot be cleaned up in place. This is the same failure mode CLAUDE.md
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

CREATE OR REPLACE VIEW public.gateway_status
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
  'immutable digital_thread audit table on every sweep and would be stale between ticks.';

-- security_invoker is load-bearing. Without it the view executes as its owner (postgres) and
-- silently bypasses the RLS on public.gateways, exposing every gateway to any role holding
-- SELECT on the view. With it, each caller's own policies apply exactly as on the base table.
-- Requires PG15+; this stack is on supabase/postgres 15.6.

GRANT SELECT ON public.gateway_status TO authenticated;
REVOKE ALL ON public.gateway_status FROM anon;

NOTIFY pgrst, 'reload schema';
