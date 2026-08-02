-- Migration: 20260101000009_gateway_heartbeat_and_service_directory.sql
-- Description:
--   1. Adds the gateway columns the dashboard already renders but the schema never had
--      (last_heartbeat, ip_address, is_virtual), so Sparkplug B node-level heartbeats
--      (NBIRTH / NDATA / NDEATH) have somewhere to land and the Gateways page stops
--      showing permanently empty columns.
--   2. Registers the edge node published by node_red_flow.json so heartbeats have a
--      matching gateway row on a fresh stack.
--   3. Completes the service directory: the original seed listed 4 of the stack's
--      services and omitted Supabase Studio, Kong, Auth, PostgREST, Edge Functions,
--      the Supabase database itself, TimescaleDB, and the ingestion daemon.

-- 1. Gateway heartbeat / presentation columns -------------------------------------
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ;
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS is_virtual BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.gateways.last_heartbeat IS
  'When the ingestion daemon last received a Sparkplug B node-level message '
  '(NBIRTH/NDATA/NDEATH) from this edge node -- receipt time, not the payload timestamp, '
  'so it stays comparable with server time regardless of edge clock drift. '
  'NULL means no heartbeat has ever arrived.';

-- The ingestion daemon used to look gateways up by name (the Sparkplug B edge node id in
-- the topic). As of migration 0014 it resolves them by `sparkplug_id` instead, and `name`
-- is a free-form label; both columns are indexed there.

-- 1b. Device classification columns -------------------------------------------------
-- The device form has always collected these and the device table has always rendered
-- them, but there were no columns to store them in, so every save silently dropped them.
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS asset_type TEXT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS connection_method TEXT;

-- 2. Register the Node-RED simulator edge node ------------------------------------
-- node_red_flow.json publishes on spBv1.0/FactoryPlus/<TYPE>/gwy100000000000400080000.
-- That edge node id is derived from this row's primary key (see migration 0014), so the
-- UUID must be pinned rather than generated -- otherwise the flow's hardcoded topics
-- would break on every fresh stack. The name is now just a display label.
--
-- ON CONFLICT targets `id`, not `name`: migration 0014 drops the UNIQUE constraint on
-- name, and supabase-db-init re-runs every migration against a persistent volume, so a
-- name-targeted upsert would fail on the second run.
INSERT INTO public.gateways (id, name, access_url, status, is_virtual)
VALUES ('10000000-0000-4000-8000-000000000001', 'Virtual_Gateway_NodeRED', 'http://localhost:1880', 'OFFLINE', TRUE)
ON CONFLICT (id) DO NOTHING;

-- 3. Complete the stack service directory ------------------------------------------
-- Endpoints are the host-facing URLs from docker-compose.yml. DO UPDATE (not DO NOTHING)
-- so corrected endpoints and a fresh heartbeat are applied on every stack start --
-- supabase-db-init re-runs every migration against a persistent volume.
INSERT INTO public.directory_services (id, service_name, service_type, endpoint_url, status, last_heartbeat) VALUES
  ('f1111111-0000-0000-0000-000000000001', 'Supabase Studio',            'GRAPHICAL_UI',   'http://127.0.0.1:54323',        'ACTIVE', NOW()),
  ('f1111111-0000-0000-0000-000000000002', 'Factory+ Web Dashboard',     'GRAPHICAL_UI',   'http://localhost:3000',         'ACTIVE', NOW()),
  ('f1111111-0000-0000-0000-000000000003', 'Node-RED Edge Gateway',      'EDGE_NODE',      'http://localhost:1880',         'ACTIVE', NOW()),
  ('f1111111-0000-0000-0000-000000000004', 'Mosquitto MQTT Broker',      'MQTT_BROKER',    'mqtt://localhost:1883',         'ACTIVE', NOW()),
  ('f1111111-0000-0000-0000-000000000005', 'TimescaleDB Telemetry Store','TIME_SERIES_DB', 'postgres://localhost:5433',     'ACTIVE', NOW()),
  ('f1111111-0000-0000-0000-000000000006', 'Grafana Dashboards',         'MONITORING',     'http://localhost:3002',         'ACTIVE', NOW()),
  ('f1111111-0000-0000-0000-000000000007', 'Supabase API Gateway (Kong)','API_GATEWAY',    'http://127.0.0.1:54321',        'ACTIVE', NOW()),
  ('f1111111-0000-0000-0000-000000000008', 'Supabase Auth (GoTrue)',     'AUTHENTICATION', 'http://127.0.0.1:54321/auth/v1','ACTIVE', NOW()),
  ('f1111111-0000-0000-0000-000000000009', 'Supabase PostgREST API',     'REST_API',       'http://127.0.0.1:54321/rest/v1','ACTIVE', NOW()),
  ('f1111111-0000-0000-0000-00000000000a', 'Supabase Edge Functions',    'SERVERLESS',     'http://127.0.0.1:54321/functions/v1', 'ACTIVE', NOW()),
  ('f1111111-0000-0000-0000-00000000000b', 'Supabase PostgreSQL',        'DATABASE',       'postgres://localhost:54322',    'ACTIVE', NOW()),
  ('f1111111-0000-0000-0000-00000000000c', 'Sparkplug B Ingestion Engine','INGESTION',     'mqtt://mosquitto:1883/spBv1.0/#','ACTIVE', NOW()),
  ('f1111111-0000-0000-0000-00000000000d', 'API Reference (Swagger UI)', 'DOCUMENTATION',  'http://localhost:8088',         'ACTIVE', NOW())
ON CONFLICT (service_name) DO UPDATE SET
  service_type   = EXCLUDED.service_type,
  endpoint_url   = EXCLUDED.endpoint_url,
  status         = EXCLUDED.status,
  last_heartbeat = EXCLUDED.last_heartbeat;

NOTIFY pgrst, 'reload schema';
