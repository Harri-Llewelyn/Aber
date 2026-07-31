-- Migration: 20260101000034_device_submodels.sql
-- Description: Phase 5 of the AAS roadmap -- let a device carry more than one schema, so it can
-- have more than one AAS Submodel.
--
-- WHY. `devices.schema_id` is 1:1, which forced migration 0033 to fold MTConnect observations,
-- ISO 22400 KPIs and OPC UA data points into a single schema so the demo device would not report
-- half its metrics as Unmodelled. That works, but it conflates three different *aspects* of an
-- asset into one document: an AAS Submodel is precisely the unit of "one aspect", and a Nameplate
-- has no business sharing a definition with operational telemetry. This table is the join that
-- lets them be attached independently.
--
-- `devices.schema_id` IS RETAINED, DELIBERATELY, as a fallback rather than being dropped:
--   * migrations 0021 and 0033 both write it, and rewriting them would mean re-deriving the demo
--     device's provisioning across three files for no behavioural gain;
--   * every reader (deviceTags.js, validate.py, aas-export) now resolves "this device's schemas"
--     as the union of its device_submodels rows, falling back to schema_id when it has none --
--     so a device provisioned by any path still resolves, and nothing has to be migrated in
--     lockstep;
--   * a stack that has not replayed this migration keeps working unchanged.
-- New code should read the join table. `schema_id` is the compatibility arm, not the source.
--
-- NO IMMUTABILITY TRIGGER, and that is a decision rather than an omission. `metric_catalog.name`
-- is immutable because a physical device is configured against that exact string; attaching or
-- detaching a submodel is the opposite -- ordinary reconfiguration that must stay reversible, and
-- one that changes no wire contract. The `digital_thread` audit trail is on `devices`, so a
-- re-attachment is still recoverable from history via the device row it belongs to.

CREATE TABLE IF NOT EXISTS public.device_submodels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    schema_id UUID NOT NULL REFERENCES public.schemas(id) ON DELETE CASCADE,
    -- The AAS idShort this schema becomes on export. NULL means "derive it from the schema name",
    -- which is what the exporter does -- storing a derived value would let it drift from the name
    -- it was derived from.
    submodel_key TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    -- One attachment per (device, schema). Attaching the same schema twice would duplicate every
    -- one of its metrics in the modelled set and emit two identical Submodels.
    CONSTRAINT uq_device_submodels UNIQUE (device_id, schema_id)
);

COMMENT ON TABLE public.device_submodels IS
  'Schemas attached to a device, one AAS Submodel each. Supersedes the 1:1 devices.schema_id, which is retained as a fallback for devices with no rows here.';

-- Both directions are queried: the exporter and the tag derivation resolve schemas for one device;
-- the Schemas page counts devices per schema.
CREATE INDEX IF NOT EXISTS idx_device_submodels_device ON public.device_submodels(device_id);
CREATE INDEX IF NOT EXISTS idx_device_submodels_schema ON public.device_submodels(schema_id);

-- A submodel_key, where given, is an AAS idShort: letters, digits and underscore, not leading a
-- digit. Checked here because an invalid one produces an invalid AAS document at export time --
-- the same reasoning as the semantic_id_type CHECK in 0029.
ALTER TABLE public.device_submodels DROP CONSTRAINT IF EXISTS device_submodels_key_is_id_short;
ALTER TABLE public.device_submodels ADD CONSTRAINT device_submodels_key_is_id_short
  CHECK (submodel_key IS NULL OR submodel_key ~ '^[A-Za-z_][A-Za-z0-9_]*$');

ALTER TABLE public.device_submodels ENABLE ROW LEVEL SECURITY;

-- Mirrors the policies on `schemas` itself: readable by any authenticated user, writable only by
-- the two roles that may manage schemas. A join row is a provisioning decision, so it carries the
-- same authority as the schema it points at.
DROP POLICY IF EXISTS "device_submodels_select_authenticated" ON public.device_submodels;
CREATE POLICY "device_submodels_select_authenticated" ON public.device_submodels
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "device_submodels_insert_privileged" ON public.device_submodels;
CREATE POLICY "device_submodels_insert_privileged" ON public.device_submodels
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

DROP POLICY IF EXISTS "device_submodels_update_privileged" ON public.device_submodels;
CREATE POLICY "device_submodels_update_privileged" ON public.device_submodels
  FOR UPDATE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']))
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

DROP POLICY IF EXISTS "device_submodels_delete_privileged" ON public.device_submodels;
CREATE POLICY "device_submodels_delete_privileged" ON public.device_submodels
  FOR DELETE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

REVOKE ALL ON public.device_submodels FROM PUBLIC, anon;

-- Backfill from the 1:1 column. Guarded by ON CONFLICT rather than by a NOT EXISTS probe so a
-- replay is a genuine no-op -- every migration re-runs on each supabase-db-init boot, and an
-- unguarded insert here would fail the UNIQUE on the second one.
INSERT INTO public.device_submodels (device_id, schema_id)
SELECT id, schema_id FROM public.devices WHERE schema_id IS NOT NULL
ON CONFLICT (device_id, schema_id) DO NOTHING;

-- Convenience view for readers that want the union without repeating the fallback logic. The
-- fallback arm is what keeps a device provisioned only through `devices.schema_id` resolvable.
CREATE OR REPLACE VIEW public.device_schemas AS
SELECT ds.device_id, ds.schema_id, ds.submodel_key, 'device_submodels'::text AS source
  FROM public.device_submodels ds
UNION
SELECT d.id, d.schema_id, NULL::text, 'devices.schema_id'::text
  FROM public.devices d
 WHERE d.schema_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.device_submodels ds WHERE ds.device_id = d.id);

COMMENT ON VIEW public.device_schemas IS
  'Every schema attached to a device: device_submodels rows, plus the legacy devices.schema_id for devices that have none.';

-- security_invoker so the view is evaluated as the querying user and the underlying RLS still
-- applies. Without it the view would run as its owner and hand out rows the caller's policies
-- would otherwise withhold.
ALTER VIEW public.device_schemas SET (security_invoker = true);

GRANT SELECT ON public.device_schemas TO authenticated;
REVOKE ALL ON public.device_schemas FROM PUBLIC, anon;

-- Assert the backfill actually covered every provisioned device, rather than trusting it. A device
-- whose schema silently failed to carry over would report every metric it publishes as Unmodelled.
DO $$
DECLARE
  orphaned INT;
BEGIN
  SELECT count(*) INTO orphaned
    FROM public.devices d
   WHERE d.schema_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.device_submodels ds
        WHERE ds.device_id = d.id AND ds.schema_id = d.schema_id
     );

  IF orphaned > 0 THEN
    RAISE EXCEPTION
      '% device(s) carry devices.schema_id but were not backfilled into device_submodels', orphaned;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
