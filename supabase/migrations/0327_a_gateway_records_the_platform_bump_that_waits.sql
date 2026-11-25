-- 0327: A gateway records the platform bump that waits for approval.
--
-- Aber opens the pull request that moves a Remote gateway to the platform of the release the site runs,
-- and only the forge said that it waits. gateways.forge_bump_tag and forge_bump_number hold the release
-- proposed and the pull request's number, for the gateway drawer's Platform row. forge-sweep writes and
-- clears them, and forge-events clears them when the merge arrives. A copy of what the forge holds is a
-- machine's own record, so audit_telemetry_columns() names both and a change to them is not an event.
--
-- Redefines public.audit_telemetry_columns: the two columns join the heartbeat's readings
--
-- Reasoning: supabase/README.md, "A gateway records the platform bump that waits (0327)". Idempotent.

ALTER TABLE public.gateways
    ADD COLUMN IF NOT EXISTS forge_bump_tag text,
    ADD COLUMN IF NOT EXISTS forge_bump_number integer;

COMMENT ON COLUMN public.gateways.forge_bump_tag IS
  'The platform release whose pull request from Aber waits for an Administrator''s approval in this '
  'gateway''s repository (0327). Written and cleared by forge-sweep, and cleared by forge-events when the '
  'merge arrives. Null means none waits, as far as the last pass saw. The forge holds the proposal; not audited.';
COMMENT ON COLUMN public.gateways.forge_bump_number IS
  'The number of the pull request forge_bump_tag names, set and cleared with it (0327).';

CREATE OR REPLACE FUNCTION public.audit_telemetry_columns() RETURNS text[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'public'
    AS $$
    SELECT ARRAY[
        'last_heartbeat',
        'health_reported_at',
        'uptime_seconds',
        'load_1m',
        'mem_available_bytes',
        'disk_free_bytes',
        'flow_hash',
        'forge_bump_tag',
        'forge_bump_number'
    ]::text[];
$$;

ALTER FUNCTION public.audit_telemetry_columns() OWNER TO postgres;

COMMENT ON FUNCTION public.audit_telemetry_columns() IS 'The gateways columns whose change alone is not an event. A heartbeat rewrites liveness, the health readings (0035) and flow_hash, whose change ingest_record_gateway_health() records as its own FLOW_DEPLOYED row. The forge sweep rewrites the platform bump that waits (0327), which the forge holds. log_audit_trail_event() subtracts these before deciding whether an UPDATE is an event.';

-- gateway_status is SELECT g.*, frozen at creation: rebuilt so it carries the new columns.
SELECT public.ensure_gateway_status_view();

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_column text;
BEGIN
  FOREACH v_column IN ARRAY ARRAY['forge_bump_tag', 'forge_bump_number'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'gateway_status'
                      AND column_name = v_column) THEN
      RAISE EXCEPTION '0327: gateway_status does not carry %', v_column;
    END IF;
    IF v_column <> ALL (public.audit_telemetry_columns()) THEN
      RAISE EXCEPTION '0327: a change to % alone would be an audit event', v_column;
    END IF;
  END LOOP;
  -- What the function held before, so that a heartbeat is still no event.
  IF NOT (ARRAY['last_heartbeat', 'health_reported_at', 'uptime_seconds', 'load_1m', 'mem_available_bytes',
                'disk_free_bytes', 'flow_hash'] <@ public.audit_telemetry_columns()) THEN
    RAISE EXCEPTION '0327: audit_telemetry_columns() has lost a column a heartbeat rewrites';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
