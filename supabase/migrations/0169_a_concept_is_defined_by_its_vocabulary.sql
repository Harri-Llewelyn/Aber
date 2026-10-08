-- 0169: A concept is defined by its vocabulary, not by the text of one metric that carries it.
--
-- `concept_definitions` is one row per semantic id that a vocabulary defines, with that
-- vocabulary's own text. The AAS exporter reads it for each ConceptDescription's IEC 61360
-- `definition`, and falls back to catalog text only for an id no vocabulary holds. Before this, the
-- ASHRAE 223P TemperatureSensor concept was defined as "Zone air temperature", the description of
-- the one example metric that carries it.
--
-- MTConnect contributes no rows: `mtconnect_vocabulary` has no description column. Its ids keep the
-- catalog text, or the sentence naming the concept, until the vocabulary stores definitions.

-- -------------------------------------------------------------------------------------------------
-- The view
-- -------------------------------------------------------------------------------------------------
-- An id held by two vocabularies takes the first in this order, whose ids are issued furthest from
-- this deployment: IDTA (issued by IDTA, IEC CDD and ECLASS), ASHRAE 223P (the ontology's own IRIs),
-- OPC UA (derived from a published namespace), ISO 22400 (minted under aber.local). Within one
-- vocabulary, the first by its key. No id is shared today. A row with no text defines nothing, so
-- it is left out and the exporter falls back as it would for an id no vocabulary holds.
CREATE OR REPLACE VIEW public.concept_definitions WITH (security_invoker='true') AS
 SELECT DISTINCT ON (c.semantic_id)
    c.semantic_id,
    c.name,
    c.definition,
    c.standard
   FROM ( SELECT 1 AS precedence, t.template_id || ' ' || t.id_short AS tiebreak,
            t.semantic_id, t.id_short AS name, t.description AS definition, 'IDTA'::text AS standard
           FROM public.idta_submodel_templates t
        UNION ALL
         SELECT 2, v.name, v.semantic_id, v.name, v.description, 'ASHRAE 223P'::text
           FROM public.ashrae223_vocabulary v
        UNION ALL
         SELECT 3, v.companion_spec || ' ' || v.name, v.semantic_id, v.name, v.description,
            'OPC UA'::text
           FROM public.opcua_vocabulary v
        UNION ALL
         SELECT 4, v.name, v.semantic_id, v.name, v.description, 'ISO 22400'::text
           FROM public.iso22400_vocabulary v) c
  WHERE (NULLIF(btrim(c.semantic_id), '') IS NOT NULL)
    AND (NULLIF(btrim(c.definition), '') IS NOT NULL)
  ORDER BY c.semantic_id, c.precedence, c.tiebreak;

ALTER VIEW public.concept_definitions OWNER TO postgres;

COMMENT ON VIEW public.concept_definitions IS 'One row per semantic id a vocabulary defines: the concept''s name and its vocabulary''s own definition text. IDTA, ASHRAE 223P, OPC UA and ISO 22400; MTConnect has no description column. An id held by two vocabularies takes the first in that order. The AAS exporter reads it for ConceptDescription definitions.';

-- Reference data, read as the vocabularies are: security_invoker applies their SELECT policies to
-- the caller, so aas-api's caller-bound client reads it as itself.
REVOKE ALL ON TABLE public.concept_definitions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.concept_definitions TO authenticated, service_role;

DO $$
BEGIN
  IF has_table_privilege('anon', 'public.concept_definitions', 'SELECT') THEN
    RAISE EXCEPTION '0169: anon may read concept_definitions';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.concept_definitions', 'SELECT') THEN
    RAISE EXCEPTION '0169: authenticated may not read concept_definitions; aas-api reads it as the caller';
  END IF;
  IF EXISTS (SELECT 1 FROM public.concept_definitions GROUP BY semantic_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0169: concept_definitions holds a semantic id twice';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
