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

-- The schema is resolved by name rather than by a pinned UUID, and prefers the tri-standard schema
-- migration 0033 creates. Every migration replays on each boot, so a hardcoded id here would reset
-- the device to the legacy schema on every boot and 0033 would move it back -- and because
-- log_digital_thread_event() fires on every UPDATE to `devices`, that round trip would append an
-- audit row to an append-only table once per boot, forever. The COALESCE makes 0021 and 0033 agree,
-- so after the first boot 0033's assignment is a genuine no-op. The fallback keeps this migration
-- standalone-correct on a database that has not reached 0033 yet.
INSERT INTO public.devices (id, name, gateway_id, schema_id, status, is_quarantined, quarantine_reason, asset_type, connection_method)
VALUES (
  '20000000-0000-4000-8000-000000000002',
  'Simulated_CNC_01',
  '10000000-0000-4000-8000-000000000001',   -- Virtual_Gateway_NodeRED, pinned by migration 0009
  COALESCE(
    (SELECT id FROM public.schemas WHERE schema_name = 'Simulated_CNC_01_Schema'),
    (SELECT id FROM public.schemas WHERE schema_name = 'SparkplugB-Telemetry-Standard-Schema')
  ),
  'OFFLINE',
  TRUE,
  'UNKNOWN_DEVICE',
  NULL,                                      -- classification is derived from the schema now
  'Sparkplug B'
)
ON CONFLICT (id) DO UPDATE SET
  gateway_id = EXCLUDED.gateway_id,
  -- COALESCE, NOT EXCLUDED: this assigns a schema to a device that has none, it does not impose
  -- one on a device that already has one. Schema versioning (migration 0037) is what made the
  -- difference matter. Once a v2 of this schema is published, the name above still resolves to the
  -- ARCHIVED v1, so an unconditional assignment dragged the demo device back onto a superseded
  -- version on every db-init replay -- and 0037's reconciliation then forwarded it again, so the
  -- pair churned two rows per boot into an append-only audit table while the end state looked
  -- correct. Leaving an existing binding alone is both the fix and the more honest behaviour: the
  -- purpose here is pre-registration, not re-provisioning.
  schema_id  = COALESCE(public.devices.schema_id, EXCLUDED.schema_id)
-- Write only on change. An UPDATE fires log_digital_thread_event() whether or not any value
-- actually differs, so an unguarded DO UPDATE appended one audit row to an append-only table on
-- every single boot -- the same trap record_declared_metrics() avoids in ingestion.py.
WHERE public.devices.gateway_id IS DISTINCT FROM EXCLUDED.gateway_id
   OR (public.devices.schema_id IS NULL AND EXCLUDED.schema_id IS NOT NULL);

-- A device auto-discovered by an earlier run holds the same wire identity under a different UUID.
-- Its telemetry is keyed by that old sparkplug_id and cannot be moved (the id is generated), so the
-- row is removed rather than merged: leaving it would mean two rows claiming the same device, and
-- resolve_device() would log an ambiguous-identity warning on every message.
DELETE FROM public.devices
 WHERE name = 'Simulated_CNC_01'
   AND id <> '20000000-0000-4000-8000-000000000002';

NOTIFY pgrst, 'reload schema';
