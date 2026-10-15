-- 0186: The Playback gateway holds no health.
--
-- A replay republishes the recorded appliance's node messages as the Playback gateway, and the
-- ingestion daemon used to record their health as the gateway's own: uptime, load, memory, free
-- disk, the CA expiry date, the agent version and the flow hash, stamped with health_reported_at.
-- The Fleet Health dashboard showed another machine's figures as Playback's, Gateway CA Expiring
-- fired for it from the replayed date, and a replayed flow hash that differed wrote a
-- FLOW_DEPLOYED row. The daemon now records none of it for a gateway with is_shadow (it reads the
-- flag with the rest of the row). This clears what earlier replays left behind.
--
-- A column goes back to NULL, which every reader already treats as "does not report health"
-- (health_reported_at, 0035). The WHERE keeps a second boot from touching a row that is already
-- clear. agent_version is NULL for a host-run gateway and a shadow gateway is one; cert_expires_at
-- and agent_version are not among audit_telemetry_columns(), so clearing them leaves one UPDATE row
-- in audit_trail, attributed to the migration. FLOW_DEPLOYED rows already written are history and
-- stay.
UPDATE public.gateways
   SET health_reported_at  = NULL,
       uptime_seconds      = NULL,
       load_1m             = NULL,
       mem_available_bytes = NULL,
       disk_free_bytes     = NULL,
       cert_expires_at     = NULL,
       flow_hash           = NULL,
       agent_version       = NULL
 WHERE is_shadow
   AND (health_reported_at  IS NOT NULL
     OR uptime_seconds      IS NOT NULL
     OR load_1m             IS NOT NULL
     OR mem_available_bytes IS NOT NULL
     OR disk_free_bytes     IS NOT NULL
     OR cert_expires_at     IS NOT NULL
     OR flow_hash           IS NOT NULL
     OR agent_version       IS NOT NULL);

-- -------------------------------------------------------------------------------------------------
-- Self-check: the daemon's database role can read the flag it now tests. The daemon authenticates
-- as `authenticated` (Service_Ingestor's token), and a missing column grant would fail every
-- directory read, which stops all ingestion rather than one message.
-- -------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT has_column_privilege('authenticated', 'public.gateways', 'is_shadow', 'SELECT') THEN
    RAISE EXCEPTION '0186: the ingestion daemon''s role cannot read gateways.is_shadow';
  END IF;
END
$$;
