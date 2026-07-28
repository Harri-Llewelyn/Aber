-- Migration: 20260101000002_add_documents_and_config.sql
-- Description: Add documents, asset_config, schemas, and directory_services tables with RLS and seed data.

-- 1. Documents Table
CREATE TABLE IF NOT EXISTS public.documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    url TEXT NOT NULL,
    document_tag TEXT NOT NULL DEFAULT 'other',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_entity ON public.documents(entity_type, entity_id);

-- 2. Asset Config Table
CREATE TABLE IF NOT EXISTS public.asset_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    val_double DOUBLE PRECISION,
    val_string TEXT,
    val_bool BOOLEAN,
    datatype INT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_asset_config_metric UNIQUE (asset_id, metric_name)
);

-- 3. Schemas Table
CREATE TABLE IF NOT EXISTS public.schemas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schema_name TEXT UNIQUE NOT NULL,
    description TEXT,
    schema_definition JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Directory Services Table
CREATE TABLE IF NOT EXISTS public.directory_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_name TEXT UNIQUE NOT NULL,
    service_type TEXT NOT NULL,
    endpoint_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
    registered_schema_id UUID REFERENCES public.schemas(id) ON DELETE SET NULL
);

-- Seed Standard Schemas
INSERT INTO public.schemas (id, schema_name, description, schema_definition) VALUES
  ('e1111111-2222-3333-4444-555555555555', 'SparkplugB-Telemetry-Standard-Schema', 'Standard Sparkplug B metric schema for temperature, status, and safety interlock',
   '{"type": "object", "properties": {"temperature": {"type": "number"}, "status": {"type": "string"}, "safety_ok": {"type": "boolean"}}, "required": ["temperature", "status"]}'),
  ('e2222222-3333-4444-5555-666666666666', 'ISO-22400-OEE-Schema', 'ISO 22400 standard OEE metrics for industrial machinery',
   '{"type": "object", "properties": {"availability": {"type": "number"}, "performance": {"type": "number"}, "quality": {"type": "number"}}, "required": ["availability"]}')
ON CONFLICT (schema_name) DO NOTHING;

-- Seed Stack Service Directory
INSERT INTO public.directory_services (id, service_name, service_type, endpoint_url, status) VALUES
  ('f1111111-0000-0000-0000-000000000002', 'Factory+ Web Dashboard', 'GRAPHICAL_UI', 'http://localhost:3000', 'ACTIVE'),
  ('f1111111-0000-0000-0000-000000000003', 'Node-RED Edge Gateway', 'EDGE_NODE', 'http://localhost:1880', 'ACTIVE'),
  ('f1111111-0000-0000-0000-000000000004', 'Mosquitto MQTT Broker', 'MQTT_BROKER', 'mqtt://localhost:1883', 'ACTIVE'),
  ('f1111111-0000-0000-0000-000000000006', 'Grafana Dashboards', 'MONITORING', 'http://localhost:3002', 'ACTIVE')
ON CONFLICT (service_name) DO NOTHING;

-- Enable RLS
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.directory_services ENABLE ROW LEVEL SECURITY;

-- Policies for Documents
DROP POLICY IF EXISTS "documents_select_authenticated" ON public.documents;
CREATE POLICY "documents_select_authenticated" ON public.documents FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "documents_insert_privileged" ON public.documents;
CREATE POLICY "documents_insert_privileged" ON public.documents FOR INSERT TO authenticated WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));
DROP POLICY IF EXISTS "documents_update_privileged" ON public.documents;
CREATE POLICY "documents_update_privileged" ON public.documents FOR UPDATE TO authenticated USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager')) WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));
DROP POLICY IF EXISTS "documents_delete_privileged" ON public.documents;
CREATE POLICY "documents_delete_privileged" ON public.documents FOR DELETE TO authenticated USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

-- Policies for Asset Config
DROP POLICY IF EXISTS "asset_config_select_authenticated" ON public.asset_config;
CREATE POLICY "asset_config_select_authenticated" ON public.asset_config FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "asset_config_insert_privileged" ON public.asset_config;
CREATE POLICY "asset_config_insert_privileged" ON public.asset_config FOR INSERT TO authenticated WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));
DROP POLICY IF EXISTS "asset_config_update_privileged" ON public.asset_config;
CREATE POLICY "asset_config_update_privileged" ON public.asset_config FOR UPDATE TO authenticated USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager')) WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));
DROP POLICY IF EXISTS "asset_config_delete_privileged" ON public.asset_config;
CREATE POLICY "asset_config_delete_privileged" ON public.asset_config FOR DELETE TO authenticated USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

-- Policies for Schemas
DROP POLICY IF EXISTS "schemas_select_authenticated" ON public.schemas;
CREATE POLICY "schemas_select_authenticated" ON public.schemas FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "schemas_insert_privileged" ON public.schemas;
CREATE POLICY "schemas_insert_privileged" ON public.schemas FOR INSERT TO authenticated WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));
DROP POLICY IF EXISTS "schemas_update_privileged" ON public.schemas;
CREATE POLICY "schemas_update_privileged" ON public.schemas FOR UPDATE TO authenticated USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager')) WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));
DROP POLICY IF EXISTS "schemas_delete_privileged" ON public.schemas;
CREATE POLICY "schemas_delete_privileged" ON public.schemas FOR DELETE TO authenticated USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

-- Policies for Directory Services
DROP POLICY IF EXISTS "directory_services_select_authenticated" ON public.directory_services;
CREATE POLICY "directory_services_select_authenticated" ON public.directory_services FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "directory_services_insert_privileged" ON public.directory_services;
CREATE POLICY "directory_services_insert_privileged" ON public.directory_services FOR INSERT TO authenticated WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));
DROP POLICY IF EXISTS "directory_services_update_privileged" ON public.directory_services;
CREATE POLICY "directory_services_update_privileged" ON public.directory_services FOR UPDATE TO authenticated USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager')) WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));
DROP POLICY IF EXISTS "directory_services_delete_privileged" ON public.directory_services;
CREATE POLICY "directory_services_delete_privileged" ON public.directory_services FOR DELETE TO authenticated USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));
