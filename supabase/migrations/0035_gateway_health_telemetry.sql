-- =============================================================================================
-- Migration: 0035_gateway_health_telemetry.sql
-- What an appliance is actually doing, on its own row
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- THE COMPLAINT THIS ANSWERS. `0025` stamps `agent_version` and `enrolled_at` once, at enrolment,
-- and never refreshes them. So "what is this appliance doing" -- is its disk filling, is its
-- bundle current, is the flow the one we deployed -- is answerable only by getting a shell on it,
-- across a plant, per gateway. The appliance already holds an authenticated MQTT connection and
-- already publishes NDATA every 30s. These columns are the other end of that.
--
-- ---------------------------------------------------------------------------------------------
-- WHY COLUMNS ON `gateways` AND NOT A TABLE OR THE HISTORIAN.
--
-- Node-level Sparkplug messages do not reach the historian at all: `on_message()` routes
-- spBv1.0/<group>/<NBIRTH|NDATA|NDEATH>/<node> to `process_node_message()` and RETURNS before
-- `process_ddata()`. So none of this passes through `metric_catalog`, none of it needs a semantic
-- id, and none of it creates a `telemetry` row. That is what makes the item cheap.
--
-- IT IS ALSO WHAT MAKES IT NARROW, AND THE LIMIT BELONGS HERE RATHER THAN IN A LATER SURPRISE:
-- THESE COLUMNS HOLD CURRENT VALUES AND NO HISTORY. "Is the disk filling" is not answerable from
-- them -- only "how full is it now". A trend needs the metrics to arrive as DDATA under a device,
-- which means catalog registration and a semantic id, and that is a different, much larger item.
-- Current state is what an operator needs to answer "should I drive out to that cabinet", and it
-- is all `Cert_Expires_At` needs to be useful, so it is the right first half.
--
-- ---------------------------------------------------------------------------------------------
-- `Cert_Expires_At` IS THE ONE THAT JUSTIFIES THE ITEM ON ITS OWN.
--
-- The internal CA is distributed BY HAND into every appliance's trust store, and re-minting it
-- does not fail loudly: it succeeds, and every gateway drops off at once (docs/incidents.md).
-- There is no other signal -- an expired CA presents as the whole fleet going quiet, which is the
-- same shape as a broker outage and gets diagnosed as one. One column and one alert rule turn the
-- worst fleet-wide failure mode into a 30-day warning.
--
-- ---------------------------------------------------------------------------------------------
-- WHY `health_reported_at` IS SEPARATE FROM `last_heartbeat`.
--
-- `last_heartbeat` moves on EVERY node-level message, including one carrying no health metrics at
-- all -- which is what every appliance on an older bundle sends, and what the platform's own
-- simulators send. Without a second timestamp a NULL disk figure cannot be told apart from a
-- gateway that reported one an hour ago and has since gone quiet on that metric alone. One means
-- "this bundle does not report health"; the other means "it stopped". Those call for different
-- actions, so they get different columns.
--
-- ---------------------------------------------------------------------------------------------
-- NO CHECK CONSTRAINTS ON THE VALUES, AND THAT IS THE OPPOSITE OF `0032` ON PURPOSE.
--
-- `0032` refuses an out-of-range setting AT THE CONSTRAINT, because the alternative was a write
-- that succeeds while meaning something other than it says. The trade runs the other way here.
-- These values arrive from an APPLIANCE, in the same UPDATE that carries `status` and
-- `last_heartbeat`. A CHECK violation would fail that whole statement -- so a gateway reporting
-- one nonsensical disk figure would stop reporting ONLINE, and a cosmetic fault would present as
-- an outage. The daemon validates each metric and drops the ones that fail while keeping the
-- heartbeat: see `extract_gateway_health()` in ingestion/ingestion.py, which is where a rejection
-- is logged and counted.
-- =============================================================================================

SET search_path TO public;


-- ---------------------------------------------------------------------------------------------
-- 1. The health columns
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS health_reported_at   timestamp with time zone;
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS uptime_seconds       bigint;
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS load_1m              real;
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS mem_available_bytes  bigint;
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS disk_free_bytes      bigint;
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS cert_expires_at      timestamp with time zone;
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS flow_hash            text;

COMMENT ON COLUMN public.gateways.health_reported_at IS
  'When a node-level message last carried at least one recognised health metric. Distinct from '
  'last_heartbeat, which moves on every node-level message including those carrying none: NULL '
  'here alongside a recent last_heartbeat means the appliance is alive on a bundle that does not '
  'report health, which is a different situation from one that has stopped reporting it.';
COMMENT ON COLUMN public.gateways.uptime_seconds IS
  'Seconds since the appliance''s Node-RED runtime started, from the Uptime_s metric. Process '
  'uptime, not host uptime -- a restarted container resets it while the machine stays up.';
COMMENT ON COLUMN public.gateways.load_1m IS
  'Host 1-minute load average, from node_exporter''s node_load1 via the Load_1m metric. Not '
  'normalised by core count, so compare a gateway against itself over time rather than against '
  'another gateway.';
COMMENT ON COLUMN public.gateways.mem_available_bytes IS
  'Host MemAvailable in bytes, from node_exporter''s node_memory_MemAvailable_bytes. Available, '
  'not free: it counts reclaimable cache, which is the number that predicts whether an allocation '
  'will succeed.';
COMMENT ON COLUMN public.gateways.disk_free_bytes IS
  'Free bytes on the appliance''s root filesystem, from node_exporter''s '
  'node_filesystem_avail_bytes. The metric that earns the collector: an appliance that fills its '
  'disk stops publishing and reports nothing about why.';
COMMENT ON COLUMN public.gateways.cert_expires_at IS
  'notAfter of the CA this appliance trusts for the broker, reported by the appliance itself. The '
  'CA is hand-distributed into every appliance''s trust store, so re-minting it takes the whole '
  'fleet offline at once with no other signal -- this is what makes that a dated warning instead '
  'of an outage. Reported, not observed: it is what the appliance HAS, which is the question.';
COMMENT ON COLUMN public.gateways.flow_hash IS
  'Hash of the flow the appliance is running, reported by it. Answers "is this gateway running '
  'what we deployed" without a shell on it. An appliance whose operator edited the flow in the '
  'Node-RED editor reports a hash matching nothing that was ever deployed, which is the point.';


-- ---------------------------------------------------------------------------------------------
-- 2. `agent_version` starts being refreshed, and its comment has to say so
-- ---------------------------------------------------------------------------------------------
-- 0025 wrote "reported at enrolment ... Re-enrolment overwrites it", and that WAS the complaint:
-- a bundle generated once lives on somebody's hardware indefinitely, and enrolment is the only
-- moment the platform ever hears about it. The heartbeat now carries it, so an appliance upgraded
-- in place is visible without re-enrolling. The column does not change; what writes it does.
COMMENT ON COLUMN public.gateways.agent_version IS
  'Version stamp of the bundle the appliance is running. Written at enrolment and REFRESHED from '
  'the Agent_Version metric on every node-level message that carries one, so an appliance upgraded '
  'in place is visible without re-enrolment. Lets the fleet''s vintage be seen without reaching '
  'into every appliance. NULL for a virtual gateway and for one that has never enrolled.';
