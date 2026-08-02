-- Migration: 20260101000032_effectiveness_and_mtconnect_semantics.sql
-- Description: Two vocabulary refinements.
--   1. Supersede `OEE/PERFORMANCE` with `OEE/EFFECTIVENESS`, matching ISO 22400-2's own term.
--   2. Give every MTConnect metric a semantic id in this deployment's local namespace, instead of
--      leaving them unmapped.
--
-- ============================================================================
-- 1. OEE/PERFORMANCE -> OEE/EFFECTIVENESS
-- ============================================================================
--
-- THIS IS NOT A RENAME, AND CANNOT BE ONE. `metric_catalog.name` is immutable, enforced by
-- enforce_metric_catalog_immutability() since migration 0013, because a physical device is
-- configured to publish that exact string. `UPDATE metric_catalog SET name = ...` raises. The
-- codebase's answer -- and the only correct one -- is deprecate-and-supersede: the old entry stays,
-- marked `deprecated` with `superseded_by` pointing at its replacement, so the Schemas tab shows it
-- struck through with the successor named. That row *is* the migration instruction for anyone with
-- a device still publishing the old name.
--
-- The vocabulary row is a different case and was simply edited in 0030: iso22400_vocabulary is
-- reference data with no wire contract behind it.
--
-- BOTH METRICS CARRY THE SAME SEMANTIC ID. They are two names for one ISO 22400 concept, which is
-- exactly what a semanticId exists to express -- and why the index on it is deliberately not
-- unique (see 0029). An AAS export of historical data can therefore still say what the old metric
-- meant, rather than losing that once the name is retired.
--
-- THE SCHEMA KEEPS BOTH NAMES. `ISO-22400-OEE-Schema` gains OEE/EFFECTIVENESS in `properties`
-- while retaining OEE/PERFORMANCE. Dropping the old name would make every device still publishing
-- it report as Unmodelled the moment this migration ran -- flagging a device that is doing exactly
-- what it was provisioned to do. `required` is untouched, so neither name is forced.

-- The stale vocabulary row, for a database that ran the earlier version of 0030. Harmless and a
-- no-op everywhere else. 0030 now seeds EFFECTIVENESS directly, so this never fights it on replay.
DELETE FROM public.iso22400_vocabulary WHERE name = 'PERFORMANCE';

-- The replacement metric. UUID pinned in the same block 0019 used for the starter catalog, so a
-- fresh stack and an upgraded one agree on its identity.
INSERT INTO public.metric_catalog
  (id, name, datatype, category, units, sub_type, standard, semantic_id, semantic_id_type, description)
VALUES
  ('c0000001-0000-4000-8000-000000000010', 'OEE/EFFECTIVENESS', 10, 'SAMPLE', 'PERCENT', NULL,
   'ISO 22400', 'https://factoryplus.local/semantics/iso22400/EFFECTIVENESS', 'IRI',
   'ISO 22400 effectiveness ratio (E) -- the OEE factor commonly called Performance. Supersedes OEE/PERFORMANCE.')
ON CONFLICT (name) DO NOTHING;

-- Retire the old one and point it at its replacement. Guarded on `NOT deprecated` so the UPDATE is
-- a genuine no-op on replay rather than rewriting an unchanged row every boot.
UPDATE public.metric_catalog
   SET deprecated       = TRUE,
       superseded_by    = (SELECT id FROM public.metric_catalog WHERE name = 'OEE/EFFECTIVENESS'),
       -- Same concept, so the same semantic id. Not a duplicate to be cleaned up.
       semantic_id      = 'https://factoryplus.local/semantics/iso22400/EFFECTIVENESS',
       semantic_id_type = 'IRI'
 WHERE name = 'OEE/PERFORMANCE'
   AND NOT deprecated;

-- Re-applied here rather than edited into 0019, because 0019's UPDATE is unconditional and replays
-- on every boot -- editing it alone would be overwritten by itself. This runs after it.
UPDATE public.schemas SET
  schema_definition = '{"type": "object", "properties": {"OEE/AVAILABILITY": {"type": "number"}, "OEE/EFFECTIVENESS": {"type": "number"}, "OEE/PERFORMANCE": {"type": "number"}, "OEE/QUALITY": {"type": "number"}}, "required": ["OEE/AVAILABILITY"]}'::jsonb
 WHERE schema_name = 'ISO-22400-OEE-Schema';

-- ============================================================================
-- 2. MTConnect semantic ids
-- ============================================================================
--
-- 0029 left MTConnect metrics unmapped on the grounds that MTConnect publishes no per-data-item-type
-- IRI or IRDI, and that inventing one in *MTConnect's* namespace would assert an interoperability
-- that does not exist. Minting them in this deployment's own namespace does not have that problem:
-- `factoryplus.local` plainly says whose identifier it is, exactly as the ISO 22400 ids already do,
-- and it is a stable, deterministic, resolvable-within-this-deployment handle that an AAS export
-- can emit today. What it does NOT do is make two organisations agree -- only a published crosswalk
-- would, and if one appears these are replaceable by a single UPDATE.
--
-- WHY v2.0 AND NOT 2.8. The vocabulary is generated from MTConnect schema 2.8 (SCHEMA_VERSION in
-- scripts/generate-mtconnect-vocabulary.mjs), but the namespace pins the *major* line. A semantic
-- id whose value changed every time the schema was regenerated would defeat the purpose of having
-- one; the major version is the granularity at which the concepts themselves actually change.
--
-- TWO LEVELS, DELIBERATELY.
--   * mtconnect_vocabulary gets CONCEPT ids, scoped by kind: .../v2.0/DataItemType/ANGLE. `ANGLE`
--     as a type is one concept no matter which axis reports it. The kind segment is required
--     because the vocabularies are separate namespaces that can collide -- a component and a data
--     item type could share a name, and (kind, name) is the table's own primary key.
--   * metric_catalog gets OBSERVATION ids built from the metric name: .../v2.0/Axes/C/ANGLE. A
--     catalog entry is a specific data item on a specific component path, which is what an AAS
--     SubmodelElement corresponds to.
--
-- Keep the metric_catalog expression below in step with mtconnectSemanticId() in
-- frontend/src/utils/standards.js -- same obligation as utils/metricGroup.js and utils/sparkplugId.js
-- carry against their own migrations.

ALTER TABLE public.mtconnect_vocabulary ADD COLUMN IF NOT EXISTS semantic_id TEXT;

COMMENT ON COLUMN public.mtconnect_vocabulary.semantic_id IS
  'Local-namespace IRI for this vocabulary concept. Minted by this deployment, not issued by MTConnect -- see migration 0032.';

-- Derived rather than listed, so a regenerated 0018 (which is a GENERATED file and must never be
-- hand-edited) is re-covered automatically the next time this migration replays.
UPDATE public.mtconnect_vocabulary
   SET semantic_id = 'https://factoryplus.local/semantics/mtconnect/v2.0/'
                     || CASE kind
                          WHEN 'DATA_ITEM_TYPE' THEN 'DataItemType'
                          WHEN 'COMPONENT'      THEN 'Component'
                          WHEN 'SUB_TYPE'       THEN 'SubType'
                          WHEN 'UNIT'           THEN 'Unit'
                          WHEN 'NATIVE_UNIT'    THEN 'NativeUnit'
                          ELSE kind
                        END
                     || '/' || name
 WHERE semantic_id IS NULL;

-- Backfill the catalog. Scoped to MTConnect provenance so an ISO 22400 or OPC UA metric is never
-- claimed, and to NULL so a hand-corrected id is never overwritten -- semantic_id is mutable
-- precisely so it can be corrected, and a migration that stamped over corrections on every boot
-- would make that impossible.
UPDATE public.metric_catalog
   SET semantic_id      = 'https://factoryplus.local/semantics/mtconnect/v2.0/' || name,
       semantic_id_type = 'IRI'
 WHERE standard = 'MTConnect'
   AND semantic_id IS NULL;

-- The MTConnect-derived schema is the Submodel those metrics belong to.
UPDATE public.schemas
   SET semantic_id      = 'https://factoryplus.local/semantics/mtconnect/v2.0/OperationalTelemetry',
       semantic_id_type = 'IRI'
 WHERE schema_name = 'SparkplugB-Telemetry-Standard-Schema'
   AND semantic_id IS NULL;

-- Local extensions stay unmapped: `standard` is NULL for them precisely because no standard
-- describes them, and a semantic id in a standard-shaped namespace would say otherwise. They can
-- still be given one by hand in the Add Metric form.

NOTIFY pgrst, 'reload schema';
