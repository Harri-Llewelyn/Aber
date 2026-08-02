-- Migration: 20260101000029_semantic_identifiers.sql
-- Description: Phase 1 of the AAS (IEC 63278) alignment -- a place to record what a metric or a
-- schema *means*, independently of what it is called on the wire.
--
-- Why this and not the AAS metamodel: an AAS Submodel is a container, and `semanticId` is the one
-- part of it that carries information this database does not already hold. A metric's name is a
-- Sparkplug wire contract, its group is a display taxonomy, and its MTConnect facets describe how
-- it behaves -- none of them say which *concept* it is an instance of. Two deployments both
-- publishing `Axes/C/ANGLE` agree only by convention until something resolvable says so. That
-- resolvable thing is the semantic id, and it costs two nullable columns rather than a metamodel.
--
-- These columns are what an AAS export layer reads to emit `semanticId` on each SubmodelElement,
-- and what an OPC UA or MTConnect crosswalk writes. Nothing in the application requires them.
--
-- MUTABILITY -- deliberately different from name/datatype.
--   metric_catalog.name and .datatype are immutable (enforce_metric_catalog_immutability, 0013)
--   because a physical device is configured against them. A semantic id is not on the wire: it is
--   an assertion *about* the metric, made by whoever mapped it, and mappings get corrected as
--   crosswalks are published. Freezing it would mean deprecating a metric -- and reconfiguring a
--   device -- to fix a mistyped IRI. So it stays editable, like category/units/sub_type/standard.
--   The existing trigger only tests name and datatype, so it already permits this; the assertion
--   at the foot of this migration is here so that a later edit widening that trigger fails loudly
--   rather than silently making semantic ids unfixable.

ALTER TABLE public.metric_catalog ADD COLUMN IF NOT EXISTS semantic_id TEXT;
ALTER TABLE public.metric_catalog ADD COLUMN IF NOT EXISTS semantic_id_type TEXT;

ALTER TABLE public.schemas ADD COLUMN IF NOT EXISTS semantic_id TEXT;
ALTER TABLE public.schemas ADD COLUMN IF NOT EXISTS semantic_id_type TEXT;

-- The AAS metamodel's ReferenceTypes, narrowed to the three that can appear here. Constrained
-- because -- unlike `units` or `standard` -- this is a closed set in the standard rather than a
-- vocabulary a local extension might legitimately need to grow. An unconstrained value here would
-- silently produce an invalid AAS Reference at export time, which is the expensive place to find
-- out.
--   IRI            -- an http(s) URI, e.g. an OPC UA companion-spec namespace concept
--   IRDI           -- an ISO/IEC 11179-6 identifier, e.g. an ECLASS or IEC CDD entry
--   ModelReference -- a reference to an element inside another AAS
ALTER TABLE public.metric_catalog DROP CONSTRAINT IF EXISTS metric_catalog_semantic_id_type_valid;
ALTER TABLE public.metric_catalog ADD CONSTRAINT metric_catalog_semantic_id_type_valid
  CHECK (semantic_id_type IS NULL OR semantic_id_type IN ('IRI', 'IRDI', 'ModelReference'));

ALTER TABLE public.schemas DROP CONSTRAINT IF EXISTS schemas_semantic_id_type_valid;
ALTER TABLE public.schemas ADD CONSTRAINT schemas_semantic_id_type_valid
  CHECK (semantic_id_type IS NULL OR semantic_id_type IN ('IRI', 'IRDI', 'ModelReference'));

COMMENT ON COLUMN public.metric_catalog.semantic_id IS
  'AAS (IEC 63278) semanticId for this metric -- the globally-resolvable identity of the concept it measures. NULL means unmapped, which is a legitimate state for a local extension.';
COMMENT ON COLUMN public.metric_catalog.semantic_id_type IS
  'Which kind of AAS Reference semantic_id is: IRI, IRDI, or ModelReference.';
COMMENT ON COLUMN public.schemas.semantic_id IS
  'AAS semanticId for the Submodel this schema corresponds to, e.g. an IDTA submodel template id.';

-- Partial: the overwhelming majority of rows are unmapped and indexing NULLs buys nothing. This
-- supports the crosswalk direction -- "which metric did we map to this concept?" -- which is what
-- an importer and a duplicate-mapping check both ask.
CREATE INDEX IF NOT EXISTS idx_metric_catalog_semantic_id
  ON public.metric_catalog (semantic_id) WHERE semantic_id IS NOT NULL;

-- Deliberately NOT unique. Two catalog entries may legitimately share a concept: ACTUAL and
-- COMMANDED of the same data item type are separate metrics (they must be -- Sparkplug keys on the
-- name) that mean the same thing, and AAS models that difference as a qualifier on the element,
-- not as a different semanticId.

-- MTConnect metrics are deliberately left unmapped. MTConnect publishes no per-data-item-type IRI
-- or IRDI, and no maintained crosswalk to ECLASS or IEC CDD is known, so any value invented here
-- would be a local identifier wearing a standard's name -- worse than NULL, because NULL is
-- honestly "not mapped" whereas a fabricated IRI asserts an interoperability that does not exist.
-- The ISO 22400 and OPC UA vocabularies that follow (0030, 0031) carry ids that are derivable from
-- a published namespace, and those are backfilled there.

-- Regression guard for the mutability decision documented above. If a later edit adds semantic_id
-- to enforce_metric_catalog_immutability, this fails the migration rather than shipping a column
-- that can only be corrected by deprecating the metric.
-- This migration is replayed on every supabase-db-init boot, so the probe clears any row a
-- previous run failed to remove before re-inserting -- UNIQUE(name) would otherwise turn one
-- interrupted boot into a permanently failing migration.
DO $$
DECLARE
  probe_id UUID;
BEGIN
  DELETE FROM public.metric_catalog WHERE name = '__semantic_id_mutability_probe__';

  INSERT INTO public.metric_catalog (name, datatype, description)
  VALUES ('__semantic_id_mutability_probe__', 12, 'transient; removed by this migration')
  RETURNING id INTO probe_id;

  BEGIN
    UPDATE public.metric_catalog
       SET semantic_id = 'https://example.invalid/probe', semantic_id_type = 'IRI'
     WHERE id = probe_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'semantic_id must remain updatable on metric_catalog, but an UPDATE was rejected (%). '
      'See the MUTABILITY note in 20260101000029.', SQLERRM;
  END;

  DELETE FROM public.metric_catalog WHERE id = probe_id;
END $$;

NOTIFY pgrst, 'reload schema';
