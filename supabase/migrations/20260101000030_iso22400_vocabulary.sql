-- Migration: 20260101000030_iso22400_vocabulary.sql
-- Description: The ISO 22400-2 key performance indicators as a reference vocabulary, plus semantic
-- ids for the OEE metrics already in the catalog.
--
-- Same stance as mtconnect_vocabulary (0018): this is a *vocabulary*, not a catalog. `AVAILABILITY`
-- here is a KPI definition; `OEE/AVAILABILITY` in metric_catalog is a metric a device publishes.
-- Seeding KPI definitions into metric_catalog would assert that every device reports every KPI.
--
-- WHY ISO 22400 AT ALL, GIVEN MTCONNECT IS ADOPTED
-- MTConnect deliberately reports raw machine state and excludes computed KPIs, so availability /
-- performance / quality have no MTConnect equivalent and never will. The two standards are
-- complementary, not alternatives. Note again that MTConnect's own AVAILABILITY is an EVENT
-- meaning "the device is connected" and is NOT the ISO 22400 availability ratio -- see 0018.
--
-- NAMING -- this vocabulary uses ISO 22400-2's own terminology, including EFFECTIVENESS for the
-- second OEE factor that industry usually calls Performance. `description` records the industry
-- term so the entry is still findable by the word most people search for.
--
-- The seed is edited here rather than renamed by 0032, because every migration is replayed on each
-- supabase-db-init boot: a 0032 that renamed the row would fight this INSERT's ON CONFLICT DO
-- UPDATE forever, re-creating PERFORMANCE on every boot and then colliding on the rename. 0032
-- deletes the stale row instead, for databases that already ran the earlier version of this file.
-- The catalog metric is a different matter -- see 0032 for why a metric cannot simply be renamed.
--
-- ⚠ VERIFY BEFORE CITING. ISO 22400-2 is a paywalled document. The formulas below are recorded in
-- the standard's symbol language (APT actual production time, PBT planned busy time, PRI planned
-- run time per item, PQ produced quantity, GQ good quantity, SQ scrap quantity) and the `kpi_id`
-- values are the KPI symbols, not clause numbers -- no clause numbers are asserted here precisely
-- because they could not be checked against the published text. UTILIZATION in particular is the
-- common loading/utilization ratio rather than a verbatim ISO 22400-2 KPI; it is marked as such in
-- its description. Confirm all of this against the standard before quoting it in a deliverable.

CREATE TABLE IF NOT EXISTS public.iso22400_vocabulary (
    -- The token as it appears in a metric name (`OEE/AVAILABILITY` -> `AVAILABILITY`), which is
    -- what makes this joinable to the catalog without a mapping table.
    name TEXT PRIMARY KEY,
    -- The ISO 22400-2 KPI symbol (A, E, Q, OEE, ...). Not a clause number -- see the warning above.
    kpi_id TEXT NOT NULL,
    description TEXT,
    -- The family a KPI belongs to. Doubles as the suggested metric group in the Add Metric form,
    -- which is why the values match metric_groups entries seeded below.
    category TEXT,
    unit TEXT,
    -- In ISO 22400-2 symbol language, so it stays checkable against the standard.
    formula TEXT,
    semantic_id TEXT
);

COMMENT ON TABLE public.iso22400_vocabulary IS
  'ISO 22400-2 key performance indicator definitions. Reference data, not deployment state -- a row here is a KPI the standard defines, not a metric a device publishes.';

ALTER TABLE public.iso22400_vocabulary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "iso22400_vocabulary_select_authenticated" ON public.iso22400_vocabulary;
CREATE POLICY "iso22400_vocabulary_select_authenticated" ON public.iso22400_vocabulary
  FOR SELECT TO authenticated USING (true);

-- Reference data maintained by editing this migration, never by the application -- same as
-- mtconnect_vocabulary. No INSERT/UPDATE/DELETE policy exists, so PostgREST cannot write it even
-- with a privileged role.
REVOKE ALL ON public.iso22400_vocabulary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.iso22400_vocabulary TO authenticated;

-- semantic_id namespace. ISO does not publish resolvable IRIs for the 22400 KPIs, and no
-- maintained ECLASS/IEC CDD crosswalk for them is known, so these are minted in a stable local
-- namespace and typed IRI. They are honest local identifiers -- deterministic, resolvable within
-- this deployment, and replaceable wholesale by an UPDATE if a published crosswalk appears. What
-- they are NOT is an ISO-issued identifier, and nothing should present them as one.
INSERT INTO public.iso22400_vocabulary (name, kpi_id, description, category, unit, formula, semantic_id) VALUES
  ('AVAILABILITY', 'A',
   'Availability ratio: the share of planned busy time the equipment was actually producing. ISO 22400-2 "Availability". NOT MTConnect AVAILABILITY, which is an EVENT meaning the device is connected.',
   'OEE', 'PERCENT', 'A = APT / PBT',
   'https://factoryplus.local/semantics/iso22400/AVAILABILITY'),

  ('EFFECTIVENESS', 'E',
   'Effectiveness ratio: actual output against what the run time should have produced. ISO 22400-2 calls this KPI "Effectiveness"; it is the factor the industry almost always calls Performance, and the catalog''s superseded OEE/PERFORMANCE metric measured exactly this.',
   'OEE', 'PERCENT', 'E = (PRI x PQ) / APT',
   'https://factoryplus.local/semantics/iso22400/EFFECTIVENESS'),

  ('QUALITY', 'Q',
   'Quality ratio: good quantity as a share of total produced quantity. ISO 22400-2 "Quality ratio".',
   'OEE', 'PERCENT', 'Q = GQ / PQ',
   'https://factoryplus.local/semantics/iso22400/QUALITY'),

  ('OEE', 'OEE',
   'Overall equipment effectiveness: the product of the three factors above. ISO 22400-2 "OEE index". A composite -- derive it from A, E and Q rather than having a device report it independently, or the four values can disagree.',
   'OEE', 'PERCENT', 'OEE = A x E x Q',
   'https://factoryplus.local/semantics/iso22400/OEE'),

  ('SCRAP_RATIO', 'SR',
   'Scrap ratio: scrap quantity as a share of produced quantity. ISO 22400-2 "Scrap ratio". The complement of the quality ratio only when rework is zero -- they are separate KPIs for that reason.',
   'Quality', 'PERCENT', 'SR = SQ / PQ',
   'https://factoryplus.local/semantics/iso22400/SCRAP_RATIO'),

  ('UTILIZATION', 'UR',
   'Utilization (loading) ratio: planned busy time as a share of calendar time. The common industry ratio rather than a verbatim ISO 22400-2 KPI -- it answers "how much of the day was this asset scheduled to work?", which availability deliberately does not. Verify against the standard before citing it as ISO 22400.',
   'Utilization', 'PERCENT', 'UR = PBT / CAL',
   'https://factoryplus.local/semantics/iso22400/UTILIZATION'),

  ('MTBF', 'MTBF',
   'Mean operating time between failures. ISO 22400-2 "Mean operating time between failures".',
   'Maintenance', 'HOUR', 'MTBF = APT / number of failures',
   'https://factoryplus.local/semantics/iso22400/MTBF'),

  ('MTTR', 'MTTR',
   'Mean time to restoration -- the average time to return the asset to service after a failure. ISO 22400-2 "Mean time to restoration"; MTTR is the common abbreviation and is often expanded as "mean time to repair".',
   'Maintenance', 'HOUR', 'MTTR = total repair time / number of repairs',
   'https://factoryplus.local/semantics/iso22400/MTTR')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;

-- The KPI families as metric groups, so the Add Metric form can offer them before any metric uses
-- one. `OEE` already exists from 0017/0018 and keeps its description. Registering these here rather
-- than letting the form create them on first use means the spelling is fixed by a migration --
-- enforce_metric_group_spelling makes the first spelling permanent, so it should not be whichever
-- one an operator happened to type.
INSERT INTO public.metric_groups (name, description, standard) VALUES
  ('Quality',     'ISO 22400 quality outcomes -- scrap, rework and yield ratios', 'ISO 22400'),
  ('Utilization', 'ISO 22400 loading and utilization ratios', 'ISO 22400'),
  ('Maintenance', 'ISO 22400 maintenance KPIs -- MTBF, MTTR and related reliability measures', 'ISO 22400')
ON CONFLICT (lower(name)) DO NOTHING;

-- Backfill the OEE metrics 0019 already created. Matched on the vocabulary token rather than
-- hardcoded names so the two cannot drift, and scoped to rows already marked ISO 22400 so a
-- similarly-named MTConnect or local metric is never claimed by mistake.
UPDATE public.metric_catalog AS mc
   SET semantic_id      = v.semantic_id,
       semantic_id_type = 'IRI'
  FROM public.iso22400_vocabulary AS v
 WHERE mc.standard = 'ISO 22400'
   AND mc.semantic_id IS NULL
   AND split_part(mc.name, '/', 2) = v.name;

-- The ISO 22400 schema seeded in 0002 is the Submodel this vocabulary describes, so it gets the
-- family identifier rather than any single KPI's.
UPDATE public.schemas
   SET semantic_id      = 'https://factoryplus.local/semantics/iso22400/KeyPerformanceIndicators',
       semantic_id_type = 'IRI'
 WHERE schema_name = 'ISO-22400-OEE-Schema'
   AND semantic_id IS NULL;

NOTIFY pgrst, 'reload schema';
