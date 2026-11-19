-- 0305: An OEE KPI cites the source it was read from.
--
-- iso22400_vocabulary held eight KPIs that were written without the standard. The archived migration that
-- first seeded them says ISO 22400-2 is paywalled and that nothing in it was checked against the
-- published text, and nobody has since. A purchased ISO standard is licensed to its reader, and Aber is
-- distributed publicly, so rows taken from it would raise a question this project should not have to
-- answer. Each row needs a source anyone can read. For four of them there is one: OPC 40501-1 v1.02.0,
-- Annex C, *KPI Calculation (Informative)*, which is free to read and says "The KPI definitions used are
-- taken from the ISO 22400-2 specification".
--
--   * iso22400_vocabulary gains `source text`, filled for the four OEE rows: AVAILABILITY,
--     EFFECTIVENESS, QUALITY and OEE. It names the annex, its clause and the formula the annex gives.
--     The other four rows have none, and the panel and an export show none for them.
--   * The four descriptions are corrected to the annex. They quoted ISO 22400-2 names the annex does not
--     use ("Quality ratio", "OEE index") and so could not be checked. Each now says what the annex says:
--     the abbreviations it defines, and no name it does not give. The formulas are unchanged: they are the
--     annex's, with the symbol of the KPI in front.
--   * public.concept_sources is new: `(semantic_id, source)`, one row per semantic id whose vocabulary
--     says where its definition comes from. Its arms are QUDT (every seeded kind, "QUDT 3.5.2, QUDT.org,
--     CC BY 4.0") and ISO 22400 (a row with a source). The AAS exporter reads it for the IEC 61360
--     `sourceOfDefinition` of a ConceptDescription. It is a view of its own, not a column of
--     concept_definitions: that view's four columns are stated inline by 0169, 0301, 0302 and 0304,
--     db-init replays each of them on every boot, and a view that gained a column would be redeclared
--     narrower by the next boot of the earlier file ("cannot drop columns from view"). This view's
--     columns are fixed from the start, so a later vocabulary adds an arm and nothing else.
--
-- ⚠ VERIFIED against OPC 40501-1 v1.02.0, Annex C, read at reference.opcfoundation.org (the page's
-- version badge says v1.02.0, the Machine Tools version the seed pins). C.1 defines the abbreviations
-- APT (Actual Production Time), PBT (Planned Busy Time), PQ (Produced Quantity), GQ (Good Quantity), PRI
-- (Planned Run Time Per Item) and OEE (Overall Equipment Effectiveness). C.2.4, *Calculation of the OEE*,
-- says: "The OEE (Overall Equipment Effectiveness) is the product of Availability, Effectiveness and
-- Quality Rate. These measures are calculated as follows: Availability = APT / PBT; Effectiveness = PRI x
-- PQ / APT; Quality rate = GQ / PQ", and "the planned variables PBT (Planned busy time) and PRI (Planned
-- run time per item) are required. This information usually comes from an MES or ERP and not from the
-- machine". C.2.1 to C.2.3 map PQ, GQ, APT, AUST and ADET to OPC UA variables. The annex is informative,
-- and it states the formulas without prose definitions, so the descriptions below say no more than its
-- abbreviations do. Nothing here was read from ISO 22400-2 itself: where this file says "taken from
-- ISO 22400-2" it is the annex's own statement, which this file did not check.
--
-- UTILIZATION, SCRAP_RATIO, MTBF and MTTR are not cited. No free source publishes their formulas, and
-- UTILIZATION is not an ISO 22400 KPI at all, so they are deprecated: `deprecated_reason` holds why (NULL
-- means live) and the ISO 22400 tab says so. They stay in 1.9, with their groups and their example metrics,
-- and are removed no sooner than 1.10 (docs/releases.md, Deprecation). An install keeps any metric that
-- carries one of their ids, since an id is only a value. A site that owns ISO 22400-2 can import it on the
-- Vocabulary page.
--
-- 0002 is released, and db-init replays it on every boot before this file: its upsert puts the four
-- descriptions it holds back, and this file puts the corrected text over them. The four rows are written
-- twice a boot, and the table ends the boot as this file leaves it. `source` and `deprecated_reason` are
-- not in 0002's column list, so they are never put back.
--
-- Reasoning: supabase/README.md, "An OEE KPI cites the source it was read from (0305)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The column
-- -------------------------------------------------------------------------------------------------
ALTER TABLE public.iso22400_vocabulary ADD COLUMN IF NOT EXISTS source text;

COMMENT ON COLUMN public.iso22400_vocabulary.source IS
  'Where the definition was read from, as a citation anyone can check: the OEE KPIs cite OPC 40501-1 v1.02.0, '
  'Annex C.2.4. NULL for a KPI no free source publishes. An AAS export carries it as the ConceptDescription''s '
  'sourceOfDefinition (0305).';
COMMENT ON TABLE public.iso22400_vocabulary IS
  'ISO 22400-2 key performance indicator names and formulas, the four OEE KPIs cited to OPC 40501-1 Annex C. '
  'Reference data, not deployment state: a row is a KPI the standard defines, not a metric a device publishes.';

-- -------------------------------------------------------------------------------------------------
-- 2. The four OEE rows
-- -------------------------------------------------------------------------------------------------
-- One statement, and a row is written only where its text or its source differs from this file's.
UPDATE public.iso22400_vocabulary v
   SET description = c.description,
       source = c.source
  FROM (VALUES
    ('AVAILABILITY',
     'Availability: actual production time (APT) as a share of planned busy time (PBT). NOT MTConnect AVAILABILITY, which is an EVENT meaning the device is connected.',
     'OPC 40501-1 v1.02.0, Annex C.2.4 (informative): "Availability = APT / PBT". The annex takes its KPI definitions from ISO 22400-2.'),
    ('EFFECTIVENESS',
     'Effectiveness: the planned run time per item (PRI) times the produced quantity (PQ), as a share of actual production time (APT). It is the factor commonly called Performance.',
     'OPC 40501-1 v1.02.0, Annex C.2.4 (informative): "Effectiveness = PRI x PQ / APT". The annex takes its KPI definitions from ISO 22400-2.'),
    ('QUALITY',
     'Quality rate: good quantity (GQ) as a share of produced quantity (PQ).',
     'OPC 40501-1 v1.02.0, Annex C.2.4 (informative): "Quality rate = GQ / PQ". The annex takes its KPI definitions from ISO 22400-2.'),
    ('OEE',
     'Overall equipment effectiveness: the product of Availability, Effectiveness and Quality rate. A composite: derive it from the three rather than having a device report it independently, or the four values can disagree.',
     'OPC 40501-1 v1.02.0, Annex C.2.4 (informative): "The OEE (Overall Equipment Effectiveness) is the product of Availability, Effectiveness and Quality Rate". The annex takes its KPI definitions from ISO 22400-2.')
  ) AS c(name, description, source)
 WHERE v.name = c.name
   AND (v.description, v.source) IS DISTINCT FROM (c.description, c.source);

-- -------------------------------------------------------------------------------------------------
-- 2b. The four KPIs no free source publishes
-- -------------------------------------------------------------------------------------------------
-- No vocabulary table has a deprecation of its own, so this one is a column: the reason, NULL for a live
-- row. A row is written only where its reason or its text differs. UTILIZATION's description loses the
-- sentence that asked a reader to verify it against the standard: what was checked is the reason.
ALTER TABLE public.iso22400_vocabulary ADD COLUMN IF NOT EXISTS deprecated_reason text;

COMMENT ON COLUMN public.iso22400_vocabulary.deprecated_reason IS
  'Why the KPI is deprecated, announced in 1.9.0 and removed no sooner than 1.10.0. NULL for a live row. '
  'The ISO 22400 tab marks a deprecated KPI and says why (0305).';

UPDATE public.iso22400_vocabulary v
   SET deprecated_reason = c.reason,
       description = COALESCE(c.description, v.description)
  FROM (VALUES
    ('UTILIZATION',
     'Utilization (loading) ratio: planned busy time as a share of calendar time. The common industry ratio, not a KPI of ISO 22400-2 itself: it answers "how much of the day was this asset scheduled to work?", which availability deliberately does not.',
     'Not an ISO 22400 KPI: it is the common loading ratio, so it cannot stay in a table whose name says it is. Deprecated in 1.9.0 and removed no sooner than 1.10.0.'),
    ('SCRAP_RATIO', NULL,
     'No free source publishes this KPI''s formula, and ISO 22400-2 is a purchased standard, so Aber ships no unchecked copy. A site that owns ISO 22400-2 can import it on the Vocabulary page. Deprecated in 1.9.0 and removed no sooner than 1.10.0.'),
    ('MTBF', NULL,
     'No free source publishes this KPI''s formula, and ISO 22400-2 is a purchased standard, so Aber ships no unchecked copy. A site that owns ISO 22400-2 can import it on the Vocabulary page. Deprecated in 1.9.0 and removed no sooner than 1.10.0.'),
    ('MTTR', NULL,
     'No free source publishes this KPI''s formula, and ISO 22400-2 is a purchased standard, so Aber ships no unchecked copy. A site that owns ISO 22400-2 can import it on the Vocabulary page. Deprecated in 1.9.0 and removed no sooner than 1.10.0.')
  ) AS c(name, description, reason)
 WHERE v.name = c.name
   AND (v.description, v.deprecated_reason) IS DISTINCT FROM (COALESCE(c.description, v.description), c.reason);

-- The four OEE rows are live, whatever a hand edit left on them.
UPDATE public.iso22400_vocabulary
   SET deprecated_reason = NULL
 WHERE name IN ('AVAILABILITY', 'EFFECTIVENESS', 'QUALITY', 'OEE')
   AND deprecated_reason IS NOT NULL;

-- -------------------------------------------------------------------------------------------------
-- 3. Where a definition comes from
-- -------------------------------------------------------------------------------------------------
-- One row per semantic id. The arms are in this order, the first taking an id both hold, as
-- concept_definitions' are: QUDT, which issues its own IRIs, then ISO 22400, whose ids are minted here.
-- A QUDT kind with no description has no definition, but its source is still QUDT: the export defines it
-- as QUDT defines it. A later vocabulary adds an arm in a migration that redeclares the view from this
-- one's body; the columns stay these two.
CREATE OR REPLACE VIEW public.concept_sources WITH (security_invoker='true') AS
 SELECT DISTINCT ON (c.semantic_id)
    c.semantic_id,
    c.source
   FROM ( SELECT 1 AS precedence, v.semantic_id, v.semantic_id AS tiebreak,
            'QUDT 3.5.2, QUDT.org, CC BY 4.0'::text AS source
           FROM public.qudt_quantity_kinds v
        UNION ALL
         SELECT 2, v.semantic_id, v.name, v.source
           FROM public.iso22400_vocabulary v) c
  WHERE (NULLIF(btrim(c.semantic_id), '') IS NOT NULL)
    AND (NULLIF(btrim(c.source), '') IS NOT NULL)
  ORDER BY c.semantic_id, c.precedence, c.tiebreak;

ALTER VIEW public.concept_sources OWNER TO postgres;

COMMENT ON VIEW public.concept_sources IS 'One row per semantic id whose vocabulary says where its definition comes from: the id and that citation. QUDT and ISO 22400, in that order where an id is in both. The AAS exporter reads it for a ConceptDescription''s sourceOfDefinition. Its two columns are fixed: a vocabulary added later is a new arm.';

-- Reference data, read as concept_definitions is: security_invoker applies the vocabularies' SELECT
-- policies to the caller, so aas-api's caller-bound client reads it as itself.
REVOKE ALL ON TABLE public.concept_sources FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.concept_sources TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'iso22400_vocabulary' AND column_name = 'source') THEN
    RAISE EXCEPTION '0305: iso22400_vocabulary has no source column';
  END IF;
  -- The four OEE rows cite OPC 40501-1 Annex C.2.4, and the formula it gives is in the text.
  IF NOT EXISTS (SELECT 1 FROM public.iso22400_vocabulary
                  WHERE name = 'AVAILABILITY' AND source LIKE 'OPC 40501-1 v1.02.0, Annex C.2.4 (informative)%Availability = APT / PBT%') THEN
    RAISE EXCEPTION '0305: AVAILABILITY does not cite OPC 40501-1 Annex C.2.4';
  END IF;
  IF EXISTS (SELECT 1 FROM public.iso22400_vocabulary
              WHERE name IN ('AVAILABILITY', 'EFFECTIVENESS', 'QUALITY', 'OEE') AND NULLIF(btrim(source), '') IS NULL) THEN
    RAISE EXCEPTION '0305: an OEE KPI has no source';
  END IF;
  -- The four deprecated rows say why, and the four OEE rows are live.
  IF EXISTS (SELECT 1 FROM public.iso22400_vocabulary
              WHERE name IN ('UTILIZATION', 'SCRAP_RATIO', 'MTBF', 'MTTR') AND NULLIF(btrim(deprecated_reason), '') IS NULL) THEN
    RAISE EXCEPTION '0305: a deprecated KPI gives no reason';
  END IF;
  IF EXISTS (SELECT 1 FROM public.iso22400_vocabulary
              WHERE name IN ('AVAILABILITY', 'EFFECTIVENESS', 'QUALITY', 'OEE') AND deprecated_reason IS NOT NULL) THEN
    RAISE EXCEPTION '0305: an OEE KPI is deprecated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.concept_sources s
                   JOIN public.iso22400_vocabulary v ON v.semantic_id = s.semantic_id
                  WHERE v.name = 'AVAILABILITY' AND s.source = v.source) THEN
    RAISE EXCEPTION '0305: concept_sources does not carry the source of AVAILABILITY';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.concept_sources
                  WHERE semantic_id = 'http://qudt.org/vocab/quantitykind/Temperature'
                    AND source = 'QUDT 3.5.2, QUDT.org, CC BY 4.0') THEN
    RAISE EXCEPTION '0305: concept_sources does not credit QUDT for the Temperature quantity kind';
  END IF;
  IF has_table_privilege('anon', 'public.concept_sources', 'SELECT') THEN
    RAISE EXCEPTION '0305: anon may read concept_sources';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.concept_sources', 'SELECT') THEN
    RAISE EXCEPTION '0305: authenticated may not read concept_sources; aas-api reads it as the caller';
  END IF;
  IF has_table_privilege('authenticated', 'public.concept_sources', 'INSERT')
     OR has_table_privilege('authenticated', 'public.concept_sources', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.concept_sources', 'DELETE') THEN
    RAISE EXCEPTION '0305: authenticated may write concept_sources';
  END IF;
  IF EXISTS (SELECT 1 FROM public.concept_sources GROUP BY semantic_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0305: concept_sources holds a semantic id twice';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
