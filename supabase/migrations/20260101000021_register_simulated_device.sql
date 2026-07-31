-- Migration: 20260101000021_register_simulated_device.sql
-- Description: Pre-register the demo device `Simulated_CNC_01` with a pinned UUID and an assigned
-- schema, instead of leaving it to be auto-discovered by the ingestion daemon.
--
-- Why pin the UUID (same reasoning as the Virtual_Gateway_NodeRED edge node in migration 0009):
-- sparkplug_id is generated from the primary key, so an auto-discovered device gets a *different*
-- wire identity every time it is discovered. On this stack that happened repeatedly -- each rebuild
-- minted a new device row, a new sparkplug_id, and therefore a new telemetry.asset_id, silently
-- detaching every previously recorded sample from the device that produced it. Pinning the UUID
-- makes the demo device's identity stable across rebuilds, which is exactly the property the whole
-- immutable-identity scheme exists to provide. 20000000-0000-4000-8000-000000000002 is the UUID
-- behind the documented id `dev200000000000400080000` that node_red_flow.json publishes under.
--
-- Why assign a schema: device type tags, the unmodelled-metric finding, and the tag filters on the
-- Devices, Telemetry and Digital Thread pages are all derived from the device's schema. With no
-- schema assigned they are all correctly empty -- which left every one of those features invisible
-- in a freshly started stack, looking broken rather than unused.
--
-- Why still quarantined: `is_quarantined = TRUE` is deliberate and preserves the Zero-Touch
-- onboarding demo the README documents -- an Administrator still has to approve the device before
-- its telemetry is stored. The difference is that the row now exists up front with its schema
-- already attached, so approving it lights up tags, unmodelled detection, telemetry and the
-- Grafana dashboards together, instead of leaving them blank until someone also picks a schema.

INSERT INTO public.devices (id, name, gateway_id, schema_id, status, is_quarantined, quarantine_reason, asset_type, connection_method)
VALUES (
  '20000000-0000-4000-8000-000000000002',
  'Simulated_CNC_01',
  '10000000-0000-4000-8000-000000000001',   -- Virtual_Gateway_NodeRED, pinned by migration 0009
  'e1111111-2222-3333-4444-555555555555',   -- SparkplugB-Telemetry-Standard-Schema, seeded by 0002
  'OFFLINE',
  TRUE,
  'UNKNOWN_DEVICE',
  NULL,                                      -- classification is derived from the schema now
  'Sparkplug B'
)
ON CONFLICT (id) DO UPDATE SET
  gateway_id = EXCLUDED.gateway_id,
  schema_id  = EXCLUDED.schema_id;

-- A device auto-discovered by an earlier run holds the same wire identity under a different UUID.
-- Its telemetry is keyed by that old sparkplug_id and cannot be moved (the id is generated), so the
-- row is removed rather than merged: leaving it would mean two rows claiming the same device, and
-- resolve_device() would log an ambiguous-identity warning on every message.
DELETE FROM public.devices
 WHERE name = 'Simulated_CNC_01'
   AND id <> '20000000-0000-4000-8000-000000000002';

NOTIFY pgrst, 'reload schema';
