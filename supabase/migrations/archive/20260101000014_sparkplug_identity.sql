-- Migration: 20260101000014_sparkplug_identity.sql
-- Description: Move Sparkplug B wire identity off the asset *name* and onto an immutable,
-- machine-generated identifier derived from the existing UUID primary key.
--
-- Before this migration, identity was the device/edge-node name string: the ingestion daemon
-- matched `devices.name` / `gateways.name` against the MQTT topic, and both `asset_config.asset_id`
-- and TimescaleDB's `telemetry.asset_id` stored that same name. Three consequences:
--
--   1. Renaming an asset silently orphaned its telemetry and birth parameters, and made the next
--      DBIRTH re-quarantine it under its old name.
--   2. Names had to be globally UNIQUE because they were the wire key -- two cells could not both
--      contain a 'Pump_01'.
--   3. The frontend and the approve-quarantine edge function had to sniff whether a given string
--      was a UUID or a name before they knew which column to address.
--
-- After this migration `name` is a purely human-facing label that can be edited freely, and
-- `sparkplug_id` carries identity on the wire.

-- 1. The wire identifier -------------------------------------------------------------
-- 3-char type prefix + 21 lowercase hex chars = 24 characters, fixed width. 21 hex chars is
-- 84 bits, which is collision-free at any plausible plant scale.
--
-- GENERATED ALWAYS ... STORED rather than a column + immutability trigger (the approach taken
-- for the metric catalog in migration 0013): deriving from the primary key means there is no
-- second source of truth to keep in sync and no way to write an inconsistent value.
--
-- encode(uuid_send(id), 'hex') rather than replace(id::text, '-', ''): the uuid->text cast is an
-- I/O coercion, whose immutability the generated-column planner is not guaranteed to accept.
-- uuid_send() and encode() are both explicitly IMMUTABLE. Both spellings produce identical
-- lowercase unhyphenated hex, so the frontend can derive the same value locally with
-- `uuid.replace(/-/g, '').slice(0, 21)` and avoid a round-trip.
--
-- Cells are not addressed on the MQTT topic and are deliberately left unchanged.

ALTER TABLE public.gateways
  ADD COLUMN IF NOT EXISTS sparkplug_id TEXT
  GENERATED ALWAYS AS ('gwy' || substr(encode(uuid_send(id), 'hex'), 1, 21)) STORED;

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS sparkplug_id TEXT
  GENERATED ALWAYS AS ('dev' || substr(encode(uuid_send(id), 'hex'), 1, 21)) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gateways_sparkplug_id ON public.gateways (sparkplug_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_sparkplug_id  ON public.devices  (sparkplug_id);

COMMENT ON COLUMN public.gateways.sparkplug_id IS
  'Immutable Sparkplug B edge node id, derived from the primary key. This is what appears in '
  'the MQTT topic (spBv1.0/<group>/<TYPE>/<sparkplug_id>). Never editable; rename the gateway '
  'freely without affecting ingestion.';

COMMENT ON COLUMN public.devices.sparkplug_id IS
  'Immutable Sparkplug B device id, derived from the primary key. This is what appears in the '
  'MQTT topic and keys telemetry in TimescaleDB and birth parameters in asset_config.';

-- 2. Names become free-form ----------------------------------------------------------
-- The global UNIQUE constraints existed only because the name was the wire key. Dropping them is
-- the point of this migration. Plain indexes replace them: the UI search filters and the legacy
-- name-based ingestion fallback (see section 4) both still look assets up by name.
--
-- Constraint names are the ones Postgres generated for the inline `name TEXT UNIQUE` declarations
-- in migration 0000.

ALTER TABLE public.gateways DROP CONSTRAINT IF EXISTS gateways_name_key;
ALTER TABLE public.devices  DROP CONSTRAINT IF EXISTS devices_name_key;

CREATE INDEX IF NOT EXISTS idx_gateways_name ON public.gateways (name);
CREATE INDEX IF NOT EXISTS idx_devices_name  ON public.devices  (name);

-- cells.name stays UNIQUE: cells are operator-managed, few, and never appear on the wire.

-- 3. Quarantine diagnostics ----------------------------------------------------------
-- reported_identity holds the raw identifier string exactly as it arrived on the wire, which is
-- the only way a *malformed* id can be shown back to the operator -- the generated sparkplug_id
-- above is derived from the auto-created row's own random UUID and therefore never equals what a
-- misconfigured gateway actually published.
--
-- It is also load-bearing for correctly-behaving third-party devices: a vendor device with a
-- factory-preset Sparkplug id cannot be made to publish a platform-issued one, so ingestion
-- resolves an incoming id against `sparkplug_id` OR `reported_identity`. On quarantine approval
-- the reported identity is carried onto the target device row so lookups keep resolving.

ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS reported_identity TEXT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS quarantine_reason TEXT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS identity_source TEXT;

-- Deliberately NOT unique: two gateways misconfigured with the same device id is a real condition
-- that must surface in the queue as duplicate rows, not abort the ingestion loop with a constraint
-- violation. ingestion.py warns when this lookup returns more than one row.
CREATE INDEX IF NOT EXISTS idx_devices_reported_identity
  ON public.devices (reported_identity) WHERE reported_identity IS NOT NULL;

COMMENT ON COLUMN public.devices.reported_identity IS
  'The Sparkplug B device id this device actually published under, when it differs from the '
  'platform-issued sparkplug_id. NULL means the device uses its issued id.';

COMMENT ON COLUMN public.devices.quarantine_reason IS
  'Why this device is in the quarantine queue: UNKNOWN_DEVICE (well-formed id, never seen), '
  'MALFORMED_IDENTITY (id failed the 24-char gwy/dev format check), or '
  'IDENTITY_MISMATCH (topic device id and Asset_ID payload metric disagreed).';

COMMENT ON COLUMN public.devices.identity_source IS
  'How ingestion last resolved this device: ''sparkplug_id'' (current scheme) or ''legacy_name'' '
  '(matched by name during the migration window). Drives the deprecation badge in the UI.';

-- 4. Pin the Node-RED simulator identities -------------------------------------------
-- sparkplug_id is derived from the primary key, so the demo edge node needs a *fixed* UUID or its
-- wire id would change on every fresh stack and node_red_flow.json could not hardcode its topics.
-- Migration 0009 originally inserted this row with gen_random_uuid(); it now inserts the pinned id
-- directly, and the repair below fixes stacks provisioned before this migration existed
-- (supabase-db-init re-runs migrations against a persistent volume).
--
-- 10000000-0000-4000-8000-000000000001 -> gwy100000000000400080000
--
-- The simulated device is intentionally NOT seeded: it arrives via DBIRTH and lands in the
-- quarantine queue, which is the demo the stack is built around. Its pinned wire id
-- (dev200000000000400080000) is asserted only by the flow.

DO $$
DECLARE
  v_pinned CONSTANT UUID := '10000000-0000-4000-8000-000000000001';
  v_current UUID;
BEGIN
  SELECT id INTO v_current FROM public.gateways WHERE name = 'Virtual_Gateway_NodeRED';

  IF v_current IS NOT NULL AND v_current <> v_pinned THEN
    -- devices.gateway_id has no ON UPDATE CASCADE, so re-point children before moving the key.
    UPDATE public.devices SET gateway_id = NULL WHERE gateway_id = v_current;
    UPDATE public.gateways SET id = v_pinned WHERE id = v_current;
    UPDATE public.devices SET gateway_id = v_pinned WHERE gateway_id IS NULL AND name = 'Simulated_CNC_01';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
