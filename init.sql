-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Cells table (Shopfloor Zones)
CREATE TABLE IF NOT EXISTS cells (
    cell_id SERIAL PRIMARY KEY,
    cell_name VARCHAR(100) NOT NULL UNIQUE,
    access_url VARCHAR(255),
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMPTZ,
    auto_delete_at TIMESTAMPTZ
);

-- Gateways table
CREATE TABLE IF NOT EXISTS gateways (
    gateway_id VARCHAR(100) PRIMARY KEY,
    gateway_name VARCHAR(100) NOT NULL,
    ip_address VARCHAR(50),
    status VARCHAR(50) NOT NULL DEFAULT 'OFFLINE',
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMPTZ,
    auto_delete_at TIMESTAMPTZ,
    is_virtual BOOLEAN NOT NULL DEFAULT FALSE,
    access_url VARCHAR(255),
    last_seen TIMESTAMPTZ
);

-- Assets / Devices table
CREATE TABLE IF NOT EXISTS assets (
    asset_id VARCHAR(100) PRIMARY KEY,
    asset_name VARCHAR(100) NOT NULL,
    asset_type VARCHAR(100),
    cell_id INT REFERENCES cells(cell_id) ON DELETE SET NULL,
    connection_method VARCHAR(100),
    active_gateway_id VARCHAR(100) REFERENCES gateways(gateway_id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'ONLINE',
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMPTZ,
    auto_delete_at TIMESTAMPTZ
);

-- Documents table (External Link Management)
CREATE TABLE IF NOT EXISTS documents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type   VARCHAR(50) NOT NULL,
    entity_id     VARCHAR(100) NOT NULL,
    display_name  VARCHAR(255) NOT NULL,
    url           TEXT NOT NULL,
    document_tag  VARCHAR(50) NOT NULL DEFAULT 'other',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_type, entity_id);

-- Telemetry table (TimescaleDB)
CREATE TABLE IF NOT EXISTS telemetry (
    time TIMESTAMPTZ NOT NULL,
    asset_id VARCHAR(100) NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    metric_name VARCHAR(100) NOT NULL,
    val_double DOUBLE PRECISION,
    val_string TEXT,
    val_bool BOOLEAN,
    PRIMARY KEY (time, asset_id, metric_name)
);

-- Asset Configuration table
CREATE TABLE IF NOT EXISTS asset_config (
    asset_id     VARCHAR(100) NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    metric_name  VARCHAR(100) NOT NULL,
    val_double   DOUBLE PRECISION,
    val_string   TEXT,
    val_bool     BOOLEAN,
    datatype     INT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, metric_name)
);

-- Digital Thread Event Log Table
CREATE TABLE IF NOT EXISTS digital_thread (
    event_id     SERIAL PRIMARY KEY,
    timestamp    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    entity_type  VARCHAR(20) NOT NULL, -- CELL, GATEWAY, DEVICE
    entity_id    VARCHAR(100) NOT NULL,
    event_type   VARCHAR(50) NOT NULL,
    description  TEXT NOT NULL,
    metadata     JSONB
);

CREATE INDEX IF NOT EXISTS idx_digital_thread_entity ON digital_thread(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_digital_thread_time ON digital_thread(timestamp DESC);

-- Quarantine Devices Table
CREATE TABLE IF NOT EXISTS quarantine_devices (
    quarantine_id  SERIAL PRIMARY KEY,
    asset_id       VARCHAR(100) UNIQUE NOT NULL,
    gateway_id     VARCHAR(100) NOT NULL,
    entity_type    VARCHAR(20) NOT NULL DEFAULT 'DEVICE',
    discovered_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    birth_payload  TEXT,
    status         VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'))
);

-- ════════════════════════════════════════════════════════════════════════════
-- FEATURE 2: Authorisation Service (Fine-Grained RBAC & ACLs)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS roles (
    role_id SERIAL PRIMARY KEY,
    role_name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
    permission_uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    permission_name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INT REFERENCES roles(role_id) ON DELETE CASCADE,
    permission_uuid UUID REFERENCES permissions(permission_uuid) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_uuid)
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id VARCHAR(100) NOT NULL,
    role_id INT REFERENCES roles(role_id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- Seed Roles
INSERT INTO roles (role_id, role_name, description) VALUES
  (1, 'Administrator', 'Full unrestricted access to shopfloor configuration, archives, and onboarding approval'),
  (2, 'Shopfloor_Manager', 'Can manage devices, cells, gateways, and approve quarantined onboarding'),
  (3, 'Operator', 'Operational dashboard view, live telemetry streaming, and document viewing'),
  (4, 'Auditor', 'Read-only audit trace and digital thread access')
ON CONFLICT (role_id) DO NOTHING;

-- Seed Permission UUIDs
-- NOTICE: Docker Compose initializes PostgreSQL volumes once on first container launch.
-- Schema changes or seed data additions to init.sql will NOT automatically apply to an
-- existing volume. Re-create the volume (`docker compose down -v` followed by `docker compose up -d`)
-- to force init.sql to run fresh against a clean database.

-- Seed Fine-Grained Permissions
INSERT INTO permissions (permission_uuid, permission_name, description) VALUES
  ('cb46a943-42e1-4c1d-8706-933e08544e30', 'quarantine:view', 'View zero-touch onboarding quarantine queue in read-only mode'),
  ('cb46a943-42e1-4c1d-8706-933e08544e31', 'quarantine:approve', 'Approve discovered quarantined edge devices'),
  ('a123b456-7890-4c1d-8706-933e08544e32', 'quarantine:reject', 'Reject quarantined edge device discovery'),
  ('d987c654-3210-4c1d-8706-933e08544e33', 'device:manage', 'Create, edit, and reassign manufacturing devices'),
  ('c456d789-0123-4c1d-8706-933e08544e34', 'cell:manage', 'Create, update, and delete shopfloor cells'),
  ('e789a012-3456-4c1d-8706-933e08544e35', 'gateway:manage', 'Register and manage edge gateways'),
  ('f012a345-6789-4c1d-8706-933e08544e36', 'telemetry:read', 'View live telemetry streams and historical data'),
  ('b345c678-9012-4c1d-8706-933e08544e37', 'archive:manage', 'Archive, restore, and set retention auto-delete timers'),
  ('a012b345-6789-4c1d-8706-933e08544e38', 'document:manage', 'Add, edit, and remove external document links attached to assets'),
  ('e012c345-6789-4c1d-8706-933e08544e39', 'authz:manage', 'Manage roles, user permissions, and access checks'),
  ('f123d456-7890-4c1d-8706-933e08544e40', 'schema:manage', 'Register and validate industrial schemas'),
  ('c234e567-8901-4c1d-8706-933e08544e41', 'gitops:manage', 'Deploy flows and manage GitOps edge configurations')
ON CONFLICT (permission_uuid) DO NOTHING;

-- Assign Permissions to Roles
-- Administrator: All permissions
INSERT INTO role_permissions (role_id, permission_uuid) VALUES
  (1, 'cb46a943-42e1-4c1d-8706-933e08544e30'),
  (1, 'cb46a943-42e1-4c1d-8706-933e08544e31'),
  (1, 'a123b456-7890-4c1d-8706-933e08544e32'),
  (1, 'd987c654-3210-4c1d-8706-933e08544e33'),
  (1, 'c456d789-0123-4c1d-8706-933e08544e34'),
  (1, 'e789a012-3456-4c1d-8706-933e08544e35'),
  (1, 'f012a345-6789-4c1d-8706-933e08544e36'),
  (1, 'b345c678-9012-4c1d-8706-933e08544e37'),
  (1, 'a012b345-6789-4c1d-8706-933e08544e38'),
  (1, 'e012c345-6789-4c1d-8706-933e08544e39'),
  (1, 'f123d456-7890-4c1d-8706-933e08544e40'),
  (1, 'c234e567-8901-4c1d-8706-933e08544e41'),
  
  -- Shopfloor Manager: Onboarding, device, cell, gateway, telemetry, archive, document, authz, schema, gitops
  (2, 'cb46a943-42e1-4c1d-8706-933e08544e30'),
  (2, 'cb46a943-42e1-4c1d-8706-933e08544e31'),
  (2, 'a123b456-7890-4c1d-8706-933e08544e32'),
  (2, 'd987c654-3210-4c1d-8706-933e08544e33'),
  (2, 'c456d789-0123-4c1d-8706-933e08544e34'),
  (2, 'e789a012-3456-4c1d-8706-933e08544e35'),
  (2, 'f012a345-6789-4c1d-8706-933e08544e36'),
  (2, 'b345c678-9012-4c1d-8706-933e08544e37'),
  (2, 'a012b345-6789-4c1d-8706-933e08544e38'),
  (2, 'e012c345-6789-4c1d-8706-933e08544e39'),
  (2, 'f123d456-7890-4c1d-8706-933e08544e40'),
  (2, 'c234e567-8901-4c1d-8706-933e08544e41'),

  -- Operator: Telemetry read, Quarantine view
  (3, 'f012a345-6789-4c1d-8706-933e08544e36'),
  (3, 'cb46a943-42e1-4c1d-8706-933e08544e30'),

  -- Auditor: Telemetry read, Quarantine view
  (4, 'f012a345-6789-4c1d-8706-933e08544e36'),
  (4, 'cb46a943-42e1-4c1d-8706-933e08544e30')
ON CONFLICT DO NOTHING;

-- Seed Demo Users
INSERT INTO user_roles (user_id, role_id) VALUES
  ('admin@factoryplus.local', 1),
  ('manager@factoryplus.local', 2),
  ('operator@factoryplus.local', 3),
  ('auditor@factoryplus.local', 4)
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- FEATURE 3: Service Directory & Schema Registry
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS schemas (
    schema_uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schema_name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    schema_definition JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS directory_services (
    service_uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_name VARCHAR(100) UNIQUE NOT NULL,
    service_type VARCHAR(50) NOT NULL,
    endpoint_url VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    last_heartbeat TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    registered_schema_uuid UUID REFERENCES schemas(schema_uuid) ON DELETE SET NULL
);

-- Seed Factory+ Standard Schemas
INSERT INTO schemas (schema_uuid, schema_name, description, schema_definition) VALUES
  ('e1111111-2222-3333-4444-555555555555', 'SparkplugB-Telemetry-Standard-Schema', 'Standard Sparkplug B metric schema for temperature, status, and safety interlock',
   '{"type": "object", "properties": {"temperature": {"type": "number"}, "status": {"type": "string"}, "safety_ok": {"type": "boolean"}}, "required": ["temperature", "status"]}'),
  ('e2222222-3333-4444-5555-666666666666', 'ISO-22400-OEE-Schema', 'ISO 22400 standard OEE metrics for industrial machinery',
   '{"type": "object", "properties": {"availability": {"type": "number"}, "performance": {"type": "number"}, "quality": {"type": "number"}}, "required": ["availability"]}')
ON CONFLICT (schema_uuid) DO NOTHING;

-- Seed Stack Service Directory
INSERT INTO directory_services (service_uuid, service_name, service_type, endpoint_url, status) VALUES
  ('f1111111-0000-0000-0000-000000000002', 'Factory+ Web Dashboard', 'GRAPHICAL_UI', 'http://localhost:3001', 'ACTIVE'),
  ('f1111111-0000-0000-0000-000000000003', 'Node-RED Edge Gateway', 'EDGE_NODE', 'http://localhost:1880', 'ACTIVE'),
  ('f1111111-0000-0000-0000-000000000004', 'Mosquitto MQTT Broker', 'MQTT_BROKER', 'mqtt://localhost:1883', 'ACTIVE'),
  ('f1111111-0000-0000-0000-000000000005', 'PGWeb Database Explorer', 'DATABASE_EXPLORER', 'http://localhost:8082', 'ACTIVE'),
  ('f1111111-0000-0000-0000-000000000006', 'Grafana Dashboards', 'MONITORING', 'http://localhost:3002', 'ACTIVE'),
  ('f1111111-0000-0000-0000-000000000007', 'Prometheus Metrics Engine', 'METRIC_EXPORTER', 'http://localhost:9090', 'ACTIVE'),
  ('f1111111-0000-0000-0000-000000000009', 'MQTTX Web Client', 'MQTT_CLIENT_UI', 'http://localhost:8081', 'ACTIVE')
ON CONFLICT (service_name) DO NOTHING;

-- Convert telemetry table into a TimescaleDB hypertable partitioned by time
SELECT create_hypertable('telemetry', 'time', if_not_exists => TRUE);
