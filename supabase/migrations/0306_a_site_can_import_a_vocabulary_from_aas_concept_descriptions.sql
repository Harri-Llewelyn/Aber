-- 0306: A site can import a vocabulary from AAS ConceptDescriptions.
--
-- A site brings its own vocabulary: a group's naming standard, a customer's specification, or the
-- concepts of a dictionary or a standard it holds a copy of. A ConceptDescription with the IEC 61360
-- data specification is one dictionary entry (an identifier, a preferred name, a definition, a unit and
-- a data type), and Aber already writes one for every semantic id in an export. The Administrator reads
-- a file in the dashboard (an AASX package, or an AAS JSON or XML environment) and hands the rows to
-- import_site_vocabulary(), which checks every one again.
--
--   * site_vocabularies: one row for each imported file, with what the file is (a published standard,
--     named by its name, edition and publisher, or the site's own vocabulary), its format, its SHA-256,
--     the version it states, a licence note, whether the Administrator confirmed that the licence lets
--     the definitions be shared, and who imported it and when. A file whose SHA-256 is already held is
--     refused. The seeded vocabularies stay generated and unwritable; nothing here writes to them.
--   * site_vocabulary_concepts: one row for each concept, keyed by its semantic id, which is unique across
--     every site vocabulary. Removing a file removes its concepts.
--   * Every signed-in role reads both tables, as it reads the seeded vocabularies. Nobody writes them
--     except through three functions, each Administrator only, behind the second factor, and each writing
--     one Audit Trail row: import_site_vocabulary(), remove_site_vocabulary() and
--     set_site_vocabulary_sharing(). Anon is revoked by name.
--   * An import skips every id that is already defined, by a seeded vocabulary, by another site
--     vocabulary or earlier in the same file, and answers with the new row and each skipped id and why.
--     site_vocabulary_holders() says which vocabulary holds an id, so the preview and the import agree.
--   * concept_definitions gains a seventh arm, last in precedence, for the concepts of a vocabulary whose
--     definitions the Administrator confirmed shareable. Its standard is NULL. A vocabulary that is not
--     shareable defines nothing there: an export carries its preferred names and defers to the file.
--   * metric_catalog.site_vocabulary_id links a metric started from an imported concept to the file's
--     row, with `standard` still NULL, so the Metrics page labels it from the file and the exporter
--     files it by the file's standard. Removing the file clears the link and keeps the metric.
--   * The Audit Trail gains the file's three acts in the asset lane: SITE_VOCABULARY_IMPORTED,
--     SITE_VOCABULARY_REMOVED and SITE_VOCABULARY_SHARING_CHANGED.
--
-- Reasoning: supabase/README.md, "A site can import a vocabulary from AAS ConceptDescriptions (0306)". Idempotent.
--
-- Redefines public.audit_domain_for: 0299 files metric_semantic_ids in the asset lane beside the catalogue.
--   0306 files site_vocabularies there too, a table every signed-in role reads and an Administrator
--   alone changes, and carries 0299's other arms unchanged
-- Redefines public.audit_event_class: 0232 sorts an alert's acts, an automation's and a read into their
--   classes before the generic rules. 0306 adds the file's three acts (created, lifecycle, configuration)
--   after the automations', and carries 0232's rules unchanged
-- Redefines public.audit_trail_action_kinds: 0299 lists the Audit Trail's acts by kind. 0306 lists the
--   file's three beside the automations', and carries 0299's rows unchanged

-- -------------------------------------------------------------------------------------------------
-- 1. The file
-- -------------------------------------------------------------------------------------------------
-- One row for each imported file. The CHECK on source_format admits the three AAS formats and is not
-- asserted again below: a later file that reads another format widens it in that file, and a guard
-- here that named the three would narrow it again on the next boot.
CREATE TABLE IF NOT EXISTS public.site_vocabularies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    source_format text NOT NULL,
    kind text NOT NULL,
    standard_name text,
    standard_edition text,
    standard_publisher text,
    sha256 text NOT NULL,
    version text,
    licence_note text,
    definitions_shareable boolean DEFAULT false NOT NULL,
    imported_by uuid,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_vocabularies_pkey PRIMARY KEY (id),
    CONSTRAINT site_vocabularies_sha256_key UNIQUE (sha256),
    CONSTRAINT site_vocabularies_name_valid
        CHECK (((name = btrim(name)) AND (char_length(name) >= 1) AND (char_length(name) <= 200))),
    CONSTRAINT site_vocabularies_source_format_valid
        CHECK ((source_format = ANY (ARRAY['aasx'::text, 'aas-json'::text, 'aas-xml'::text]))),
    CONSTRAINT site_vocabularies_kind_valid
        CHECK ((kind = ANY (ARRAY['published_standard'::text, 'site_own'::text]))),
    CONSTRAINT site_vocabularies_standard_stated
        CHECK ((((kind = 'published_standard'::text)
                 AND (standard_name IS NOT NULL) AND (standard_edition IS NOT NULL) AND (standard_publisher IS NOT NULL)
                 AND (standard_name = btrim(standard_name)) AND (char_length(standard_name) >= 1) AND (char_length(standard_name) <= 200)
                 AND (standard_edition = btrim(standard_edition)) AND (char_length(standard_edition) >= 1) AND (char_length(standard_edition) <= 100)
                 AND (standard_publisher = btrim(standard_publisher)) AND (char_length(standard_publisher) >= 1) AND (char_length(standard_publisher) <= 200))
                OR ((kind = 'site_own'::text)
                    AND (standard_name IS NULL) AND (standard_edition IS NULL) AND (standard_publisher IS NULL)))),
    CONSTRAINT site_vocabularies_sha256_valid CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT site_vocabularies_version_valid
        CHECK (((version IS NULL) OR ((version = btrim(version)) AND (char_length(version) >= 1) AND (char_length(version) <= 100)))),
    CONSTRAINT site_vocabularies_licence_note_valid
        CHECK (((licence_note IS NULL) OR ((licence_note = btrim(licence_note)) AND (char_length(licence_note) >= 1) AND (char_length(licence_note) <= 2000))))
);

ALTER TABLE public.site_vocabularies OWNER TO postgres;
ALTER TABLE public.site_vocabularies ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.site_vocabularies IS
  'One row for each vocabulary a site imported from an AAS file: what the file is (a published standard with its name, edition and publisher, or the site''s own), its format, SHA-256, stated version, licence note, whether its definitions may be shared, and who imported it and when. Written only by import_site_vocabulary(), remove_site_vocabulary() and set_site_vocabulary_sharing() (0306).';
COMMENT ON COLUMN public.site_vocabularies.kind IS
  'published_standard: a standard the site holds a copy of, named by standard_name, standard_edition and standard_publisher. site_own: the site''s own vocabulary, with none of the three (0306).';
COMMENT ON COLUMN public.site_vocabularies.sha256 IS
  'The file''s SHA-256 as lowercase hex. One file is imported once: a second import of the same bytes is refused (0306).';
COMMENT ON COLUMN public.site_vocabularies.definitions_shareable IS
  'The Administrator''s confirmation that the licence lets the definitions be shared. False until given: concept_definitions leaves the file''s definitions out, so an export carries its ids and preferred names and defers to the file (0306).';

-- -------------------------------------------------------------------------------------------------
-- 2. Its concepts
-- -------------------------------------------------------------------------------------------------
-- The semantic id is the key, so one id has one definition across every file. A concept is a
-- ConceptDescription with IEC 61360 content, so the name is required and the rest may be absent.
CREATE TABLE IF NOT EXISTS public.site_vocabulary_concepts (
    vocabulary_id uuid NOT NULL,
    semantic_id text NOT NULL,
    semantic_id_type text NOT NULL,
    preferred_name text NOT NULL,
    definition text,
    unit text,
    unit_id text,
    data_type text,
    CONSTRAINT site_vocabulary_concepts_pkey PRIMARY KEY (semantic_id),
    CONSTRAINT site_vocabulary_concepts_vocabulary_id_fkey FOREIGN KEY (vocabulary_id)
        REFERENCES public.site_vocabularies(id) ON DELETE CASCADE,
    CONSTRAINT site_vocabulary_concepts_id_valid
        CHECK (((semantic_id = btrim(semantic_id)) AND (char_length(semantic_id) >= 1) AND (char_length(semantic_id) <= 2000))),
    CONSTRAINT site_vocabulary_concepts_type_valid
        CHECK ((semantic_id_type = ANY (ARRAY['IRI'::text, 'IRDI'::text, 'ExpandedNodeId'::text]))),
    CONSTRAINT site_vocabulary_concepts_name_valid
        CHECK (((preferred_name = btrim(preferred_name)) AND (char_length(preferred_name) >= 1) AND (char_length(preferred_name) <= 255))),
    CONSTRAINT site_vocabulary_concepts_definition_valid
        CHECK (((definition IS NULL) OR ((definition = btrim(definition)) AND (char_length(definition) >= 1) AND (char_length(definition) <= 1023)))),
    CONSTRAINT site_vocabulary_concepts_unit_valid
        CHECK (((unit IS NULL) OR ((unit = btrim(unit)) AND (char_length(unit) >= 1) AND (char_length(unit) <= 255)))),
    CONSTRAINT site_vocabulary_concepts_unit_id_valid
        CHECK (((unit_id IS NULL) OR ((unit_id = btrim(unit_id)) AND (char_length(unit_id) >= 1) AND (char_length(unit_id) <= 2000)))),
    CONSTRAINT site_vocabulary_concepts_data_type_valid
        CHECK (((data_type IS NULL) OR ((data_type = btrim(data_type)) AND (char_length(data_type) >= 1) AND (char_length(data_type) <= 100))))
);

ALTER TABLE public.site_vocabulary_concepts OWNER TO postgres;
ALTER TABLE public.site_vocabulary_concepts ENABLE ROW LEVEL SECURITY;

-- Listing a file's concepts, and the cascade from a removed file.
CREATE INDEX IF NOT EXISTS idx_site_vocabulary_concepts_vocabulary_id
    ON public.site_vocabulary_concepts USING btree (vocabulary_id);

COMMENT ON TABLE public.site_vocabulary_concepts IS
  'One row for each ConceptDescription with IEC 61360 content an imported file carried: its semantic id (unique across every site vocabulary), the id''s type, preferred name, definition, unit, unit id and data type. Removing the file removes its rows (0306).';

-- Every signed-in role reads, as for the seeded vocabularies. Nobody writes: the three functions below
-- run as the owner. anon is revoked by name, and no role holds a write on either table.
REVOKE ALL ON TABLE public.site_vocabularies FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.site_vocabulary_concepts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.site_vocabularies TO authenticated, service_role;
GRANT SELECT ON TABLE public.site_vocabulary_concepts TO authenticated, service_role;

SELECT public.replay_policy('public.site_vocabularies', 'site_vocabularies_select_authenticated', $ddl$
CREATE POLICY site_vocabularies_select_authenticated ON public.site_vocabularies FOR SELECT TO authenticated USING (true);
$ddl$);
SELECT public.replay_policy('public.site_vocabulary_concepts', 'site_vocabulary_concepts_select_authenticated', $ddl$
CREATE POLICY site_vocabulary_concepts_select_authenticated ON public.site_vocabulary_concepts FOR SELECT TO authenticated USING (true);
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 3. A metric's link to the file it was started from
-- -------------------------------------------------------------------------------------------------
-- NULL for every metric that was not. The link keeps `standard` NULL: a typed standard would carry no
-- evidence and would flow into every export, while a file arrives with its SHA-256, version and
-- importer. No view states metric_catalog's columns, so the column can be added here.
ALTER TABLE public.metric_catalog ADD COLUMN IF NOT EXISTS site_vocabulary_id uuid;

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_site_vocabulary_id_fkey'
                    AND conrelid = 'public.metric_catalog'::regclass) THEN
    ALTER TABLE public.metric_catalog
      ADD CONSTRAINT metric_catalog_site_vocabulary_id_fkey FOREIGN KEY (site_vocabulary_id)
      REFERENCES public.site_vocabularies(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_site_vocabulary_is_local'
                    AND conrelid = 'public.metric_catalog'::regclass) THEN
    ALTER TABLE public.metric_catalog
      ADD CONSTRAINT metric_catalog_site_vocabulary_is_local
      CHECK (((site_vocabulary_id IS NULL) OR (standard IS NULL)));
  END IF;
END
$guard$;

CREATE INDEX IF NOT EXISTS idx_metric_catalog_site_vocabulary_id
    ON public.metric_catalog USING btree (site_vocabulary_id) WHERE (site_vocabulary_id IS NOT NULL);

COMMENT ON COLUMN public.metric_catalog.site_vocabulary_id IS
  'The imported vocabulary this metric was started from, or NULL. A linked metric has no `standard`: the Metrics page labels it from the file''s row, and the AAS export files it by that file''s standard. Removing the file clears the link and keeps the metric (0306).';

-- -------------------------------------------------------------------------------------------------
-- 4. The shape of an id, and who holds one
-- -------------------------------------------------------------------------------------------------
-- The rule the dashboard's inferSemanticIdType() states (frontend/src/utils/standards.js): an IRI is an
-- http(s) URL or a URN, an IRDI is ISO/IEC 11179-6 (ECLASS and the IEC CDD write them), several
-- joined by `/` as an ECLASS property-value pair is, and an ExpandedNodeId is an OPC UA node with its
-- namespace URI. Mirror check 126 holds the two together.
CREATE OR REPLACE FUNCTION public.semantic_id_shape(p_id text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'public'
    AS $fn$
DECLARE
  c_irdi CONSTANT text := '\d{4}(?:[-/][A-Za-z0-9_]*)*#[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*#\d+';
BEGIN
  IF p_id IS NULL THEN
    RETURN NULL;
  ELSIF p_id ~* '^(https?://|urn:)' THEN
    RETURN 'IRI';
  ELSIF p_id ~ ('^' || c_irdi || '(?:/' || c_irdi || ')*$') THEN
    RETURN 'IRDI';
  ELSIF p_id ~ '^nsu=[^;]+;[isgb]=[^\n\r]+$' THEN
    RETURN 'ExpandedNodeId';
  END IF;
  RETURN NULL;
END;
$fn$;

ALTER FUNCTION public.semantic_id_shape(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.semantic_id_shape(text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.semantic_id_shape(text) IS
  'Which kind of AAS Reference an identifier is: IRI, IRDI or ExpandedNodeId, or NULL for another shape. The rule of inferSemanticIdType() in the dashboard; import_site_vocabulary() refuses a row whose type is not its id''s (0306).';

-- Which vocabulary defines each of the ids: a seeded one by its table, whether or not it has text, or
-- any arm of concept_definitions that names a standard, or a site vocabulary by the file's name. The
-- first of those in that order. One row for each held id; the ids nothing holds have none. It runs as
-- the caller, so what it answers is what the caller may read, and the Import dialog's preview and the
-- import itself ask the same question.
CREATE OR REPLACE FUNCTION public.site_vocabulary_holders(p_ids text[]) RETURNS TABLE (semantic_id text, held_by text)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT DISTINCT ON (h.semantic_id) h.semantic_id, h.held_by
    FROM (
      SELECT 1 AS precedence, t.semantic_id, 'IDTA'::text AS held_by
        FROM public.idta_submodel_templates t WHERE t.semantic_id = ANY (p_ids)
      UNION ALL
      SELECT 1, v.semantic_id, 'ASHRAE 223P'::text FROM public.ashrae223_vocabulary v WHERE v.semantic_id = ANY (p_ids)
      UNION ALL
      SELECT 1, v.semantic_id, 'OPC UA'::text FROM public.opcua_vocabulary v WHERE v.semantic_id = ANY (p_ids)
      UNION ALL
      SELECT 1, v.semantic_id, 'ISO 22400'::text FROM public.iso22400_vocabulary v WHERE v.semantic_id = ANY (p_ids)
      UNION ALL
      SELECT 1, v.semantic_id, 'MTConnect'::text FROM public.mtconnect_vocabulary v WHERE v.semantic_id = ANY (p_ids)
      UNION ALL
      SELECT 1, v.semantic_id, 'VDA 5050'::text FROM public.vda5050_vocabulary v WHERE v.semantic_id = ANY (p_ids)
      UNION ALL
      SELECT 2, c.semantic_id, c.standard FROM public.concept_definitions c
       WHERE c.standard IS NOT NULL AND c.semantic_id = ANY (p_ids)
      UNION ALL
      SELECT 3, s.semantic_id, v.name
        FROM public.site_vocabulary_concepts s
        JOIN public.site_vocabularies v ON v.id = s.vocabulary_id
       WHERE s.semantic_id = ANY (p_ids)
    ) h
   ORDER BY h.semantic_id, h.precedence
$$;

ALTER FUNCTION public.site_vocabulary_holders(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.site_vocabulary_holders(text[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.site_vocabulary_holders(text[]) TO authenticated;

COMMENT ON FUNCTION public.site_vocabulary_holders(text[]) IS
  'For each of the semantic ids that a vocabulary already defines, which one: a seeded vocabulary by its name (its table counts, with or without text), any other arm of concept_definitions that names a standard, or a site vocabulary by the file''s name. Ids nothing holds have no row. Read as the caller (0306).';

-- One text field of a file's description or a concept, as the import functions check it. NULL when it is
-- fine, else the sentence. A value of another type, with a space or a line break at either end, empty or
-- too long is refused; an absent key is refused only where it is required.
CREATE OR REPLACE FUNCTION public.site_vocabulary_text_problem(p_object jsonb, p_key text, p_label text, p_max integer,
                                                               p_required boolean) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
    WHEN NOT (p_object ? p_key) OR jsonb_typeof(p_object -> p_key) = 'null'
      THEN CASE WHEN p_required THEN p_label || ' is required.' END
    WHEN jsonb_typeof(p_object -> p_key) <> 'string' THEN p_label || ' must be text.'
    WHEN (p_object ->> p_key) = '' THEN p_label || ' is empty.'
    WHEN (p_object ->> p_key) ~ '^\s|\s$' THEN p_label || ' has a space or a line break at either end.'
    WHEN char_length(p_object ->> p_key) > p_max THEN p_label || ' is longer than ' || p_max || ' characters.'
  END
$$;

ALTER FUNCTION public.site_vocabulary_text_problem(jsonb, text, text, integer, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.site_vocabulary_text_problem(jsonb, text, text, integer, boolean)
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.site_vocabulary_text_problem(jsonb, text, text, integer, boolean) IS
  'The sentence for a text field of an import that the tables would refuse, or NULL when it is fine (0306).';

-- -------------------------------------------------------------------------------------------------
-- 5. The three acts
-- -------------------------------------------------------------------------------------------------
-- SECURITY DEFINER: they write tables no application role may, and the Audit Trail. The role check is the
-- first statement and names the one role, as every writer here does (mirror check 90's rule), and the
-- second factor follows. A refusal before anything is written leaves nothing behind.
CREATE OR REPLACE FUNCTION public.import_site_vocabulary(p_file jsonb, p_concepts jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    c_max_concepts CONSTANT integer := 10000;
    c_file_keys    CONSTANT text[] := ARRAY['name', 'source_format', 'kind', 'standard_name', 'standard_edition',
                                            'standard_publisher', 'sha256', 'version', 'licence_note'];
    c_concept_keys CONSTANT text[] := ARRAY['semantic_id', 'semantic_id_type', 'preferred_name', 'definition',
                                            'unit', 'unit_id', 'data_type'];
    v_uid       uuid := auth.uid();
    v_key       text;
    v_item      jsonb;
    v_ord       bigint;
    v_problem   text;
    v_problems  text[] := ARRAY[]::text[];
    v_kind      text;
    v_sha       text;
    v_existing  record;
    v_ids       text[];
    v_held      jsonb;
    v_skipped   jsonb;
    v_id        uuid;
    v_added     integer;
    v_label     text;
BEGIN
    IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'Only an Administrator may import a vocabulary.'
              USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.require_mfa();
    -- One import at a time, so two of one file cannot both pass the checks below.
    PERFORM pg_advisory_xact_lock(hashtextextended('aber.site_vocabulary_import', 0));

    -- The file's description.
    IF p_file IS NULL OR jsonb_typeof(p_file) <> 'object' THEN
        RAISE EXCEPTION 'The file''s description must be an object.' USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(p_file) LOOP
        IF NOT v_key = ANY (c_file_keys) THEN
            RAISE EXCEPTION 'The file''s description has `%`, which an import does not take. It takes %.',
                  v_key, array_to_string(c_file_keys, ', ') USING ERRCODE = '22023';
        END IF;
    END LOOP;
    v_kind := p_file ->> 'kind';
    IF v_kind IS NULL OR NOT v_kind = ANY (ARRAY['published_standard', 'site_own']) THEN
        RAISE EXCEPTION 'What the file is must be published_standard or site_own.' USING ERRCODE = '22023';
    END IF;
    IF NOT coalesce(p_file ->> 'source_format', '') = ANY (ARRAY['aasx', 'aas-json', 'aas-xml']) THEN
        RAISE EXCEPTION 'The file''s format must be aasx, aas-json or aas-xml.' USING ERRCODE = '22023';
    END IF;
    v_sha := p_file ->> 'sha256';
    IF v_sha IS NULL OR v_sha !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'The file''s SHA-256 must be 64 lowercase hexadecimal characters.' USING ERRCODE = '22023';
    END IF;
    FOREACH v_problem IN ARRAY ARRAY[
        public.site_vocabulary_text_problem(p_file, 'name', 'The name', 200, true),
        public.site_vocabulary_text_problem(p_file, 'version', 'The version', 100, false),
        public.site_vocabulary_text_problem(p_file, 'licence_note', 'The licence note', 2000, false),
        public.site_vocabulary_text_problem(p_file, 'standard_name', 'The standard''s name', 200, v_kind = 'published_standard'),
        public.site_vocabulary_text_problem(p_file, 'standard_edition', 'The standard''s edition', 100, v_kind = 'published_standard'),
        public.site_vocabulary_text_problem(p_file, 'standard_publisher', 'The standard''s publisher', 200, v_kind = 'published_standard')
    ] LOOP
        IF v_problem IS NOT NULL THEN
            RAISE EXCEPTION '%', v_problem USING ERRCODE = '22023';
        END IF;
    END LOOP;
    IF v_kind = 'site_own' AND (p_file ->> 'standard_name' IS NOT NULL OR p_file ->> 'standard_edition' IS NOT NULL
                                OR p_file ->> 'standard_publisher' IS NOT NULL) THEN
        RAISE EXCEPTION 'A vocabulary that is the site''s own names no standard.' USING ERRCODE = '22023';
    END IF;

    SELECT v.id, v.name, v.imported_at INTO v_existing FROM public.site_vocabularies v WHERE v.sha256 = v_sha;
    IF FOUND THEN
        RAISE EXCEPTION 'This file is already imported as "%" (on %).',
              v_existing.name, to_char(v_existing.imported_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
              USING ERRCODE = '23505', DETAIL = v_existing.id::text;
    END IF;

    -- The concepts, every row again.
    IF p_concepts IS NULL OR jsonb_typeof(p_concepts) <> 'array' THEN
        RAISE EXCEPTION 'The concepts must be a list.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_concepts) = 0 THEN
        RAISE EXCEPTION 'The file holds no concept to import.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_concepts) > c_max_concepts THEN
        RAISE EXCEPTION 'One import takes at most % concepts, not %.', c_max_concepts, jsonb_array_length(p_concepts)
              USING ERRCODE = '22023';
    END IF;
    FOR v_ord, v_item IN SELECT t.o, t.e FROM jsonb_array_elements(p_concepts) WITH ORDINALITY AS t(e, o) LOOP
        EXIT WHEN cardinality(v_problems) >= 5;
        v_problem := NULL;
        IF jsonb_typeof(v_item) <> 'object' THEN
            v_problem := 'It must be an object.';
        ELSE
            FOR v_key IN SELECT jsonb_object_keys(v_item) LOOP
                IF NOT v_key = ANY (c_concept_keys) THEN
                    v_problem := format('It has `%s`, which a concept does not take.', v_key);
                    EXIT;
                END IF;
            END LOOP;
            v_problem := coalesce(
                v_problem,
                public.site_vocabulary_text_problem(v_item, 'semantic_id', 'Its id', 2000, true),
                public.site_vocabulary_text_problem(v_item, 'semantic_id_type', 'Its id type', 20, true),
                public.site_vocabulary_text_problem(v_item, 'preferred_name', 'Its preferred name', 255, true),
                public.site_vocabulary_text_problem(v_item, 'definition', 'Its definition', 1023, false),
                public.site_vocabulary_text_problem(v_item, 'unit', 'Its unit', 255, false),
                public.site_vocabulary_text_problem(v_item, 'unit_id', 'Its unit id', 2000, false),
                public.site_vocabulary_text_problem(v_item, 'data_type', 'Its data type', 100, false));
            IF v_problem IS NULL AND public.semantic_id_shape(v_item ->> 'semantic_id') IS DISTINCT FROM (v_item ->> 'semantic_id_type') THEN
                v_problem := CASE
                    WHEN public.semantic_id_shape(v_item ->> 'semantic_id') IS NULL
                      THEN 'Its id is neither an IRI, an IRDI nor an ExpandedNodeId.'
                    ELSE format('Its id is an %s, but it is declared as %s.',
                                public.semantic_id_shape(v_item ->> 'semantic_id'), v_item ->> 'semantic_id_type')
                  END;
            END IF;
        END IF;
        IF v_problem IS NOT NULL THEN
            v_problems := v_problems || format('Concept %s%s: %s', v_ord,
                                               CASE WHEN jsonb_typeof(v_item) = 'object' AND v_item ->> 'semantic_id' IS NOT NULL
                                                    THEN ' (' || left(v_item ->> 'semantic_id', 80) || ')' ELSE '' END,
                                               v_problem);
        END IF;
    END LOOP;
    IF cardinality(v_problems) > 0 THEN
        RAISE EXCEPTION '%', array_to_string(v_problems, E'\n') USING ERRCODE = '22023';
    END IF;

    -- What is already defined, and what the file states twice. The first statement of an id is the one kept.
    SELECT array_agg(DISTINCT e ->> 'semantic_id') INTO v_ids FROM jsonb_array_elements(p_concepts) AS t(e);
    SELECT coalesce(jsonb_object_agg(h.semantic_id, h.held_by), '{}'::jsonb) INTO v_held
      FROM public.site_vocabulary_holders(v_ids) h;
    SELECT coalesce(jsonb_agg(jsonb_build_object('semantic_id', s.semantic_id, 'reason', s.reason, 'held_by', s.held_by)
                              ORDER BY s.o), '[]'::jsonb)
      INTO v_skipped
      FROM (
        SELECT r.o, r.semantic_id,
               CASE WHEN r.n > 1 THEN 'repeated_in_file' ELSE 'already_defined' END AS reason,
               CASE WHEN r.n > 1 THEN NULL ELSE v_held ->> r.semantic_id END AS held_by
          FROM (SELECT t.o, t.e ->> 'semantic_id' AS semantic_id,
                       row_number() OVER (PARTITION BY t.e ->> 'semantic_id' ORDER BY t.o) AS n
                  FROM jsonb_array_elements(p_concepts) WITH ORDINALITY AS t(e, o)) r
         WHERE r.n > 1 OR v_held ? r.semantic_id
      ) s;

    v_label := p_file ->> 'name';
    INSERT INTO public.site_vocabularies (name, source_format, kind, standard_name, standard_edition,
                                          standard_publisher, sha256, version, licence_note, imported_by)
    VALUES (v_label, p_file ->> 'source_format', v_kind, p_file ->> 'standard_name', p_file ->> 'standard_edition',
            p_file ->> 'standard_publisher', v_sha, p_file ->> 'version', p_file ->> 'licence_note', v_uid)
    RETURNING id INTO v_id;

    INSERT INTO public.site_vocabulary_concepts (vocabulary_id, semantic_id, semantic_id_type, preferred_name,
                                                 definition, unit, unit_id, data_type)
    SELECT v_id, r.semantic_id, r.semantic_id_type, r.preferred_name, r.definition, r.unit, r.unit_id, r.data_type
      FROM (SELECT t.e ->> 'semantic_id' AS semantic_id, t.e ->> 'semantic_id_type' AS semantic_id_type,
                   t.e ->> 'preferred_name' AS preferred_name, t.e ->> 'definition' AS definition,
                   t.e ->> 'unit' AS unit, t.e ->> 'unit_id' AS unit_id, t.e ->> 'data_type' AS data_type,
                   row_number() OVER (PARTITION BY t.e ->> 'semantic_id' ORDER BY t.o) AS n
              FROM jsonb_array_elements(p_concepts) WITH ORDINALITY AS t(e, o)) r
     WHERE r.n = 1 AND NOT (v_held ? r.semantic_id);
    GET DIAGNOSTICS v_added = ROW_COUNT;
    IF v_added = 0 THEN
        RAISE EXCEPTION 'Every concept in the file is already defined, so there is nothing to import.'
              USING ERRCODE = '22023';
    END IF;

    -- `name` labels the lane, as every audit row's does.
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source, causation_id, recorded_at
    ) VALUES (
        'site_vocabularies', v_id, 'SITE_VOCABULARY_IMPORTED', NULL,
        jsonb_strip_nulls(jsonb_build_object(
            'name', v_label,
            'kind', v_kind,
            'source_format', p_file ->> 'source_format',
            'standard_name', p_file ->> 'standard_name',
            'standard_edition', p_file ->> 'standard_edition',
            'standard_publisher', p_file ->> 'standard_publisher',
            'version', p_file ->> 'version',
            'sha256', v_sha,
            'concepts', v_added,
            'skipped', jsonb_array_length(v_skipped),
            'definitions_shareable', false,
            'imported_by_email', nullif(auth.jwt() ->> 'email', ''))),
        v_uid, public.audit_actor_source(), txid_current(), now()
    );

    RETURN jsonb_build_object('id', v_id, 'concepts', v_added, 'skipped', v_skipped);
END;
$fn$;

ALTER FUNCTION public.import_site_vocabulary(jsonb, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.import_site_vocabulary(jsonb, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.import_site_vocabulary(jsonb, jsonb) TO authenticated;

COMMENT ON FUNCTION public.import_site_vocabulary(jsonb, jsonb) IS
  'Imports a vocabulary read from an AAS file: p_file describes it (name, source_format, kind, the standard''s name, edition and publisher when published, sha256, version, licence_note) and p_concepts lists its concepts (semantic_id, semantic_id_type, preferred_name, definition, unit, unit_id, data_type). Checks every row again and refuses the import on one it would not store (22023), a file whose SHA-256 is held (23505) and a caller who is not an Administrator behind the second factor (42501). Skips each id a vocabulary already defines or the file states twice. Returns { id, concepts, skipped: [{ semantic_id, reason, held_by }] }, and files SITE_VOCABULARY_IMPORTED (0306).';

CREATE OR REPLACE FUNCTION public.remove_site_vocabulary(p_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_uid      uuid := auth.uid();
    v_row      public.site_vocabularies%ROWTYPE;
    v_concepts integer;
    v_metrics  integer;
BEGIN
    IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'Only an Administrator may remove an imported vocabulary.'
              USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.require_mfa();

    SELECT * INTO v_row FROM public.site_vocabularies WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No imported vocabulary has that id. It may have been removed already.' USING ERRCODE = 'P0002';
    END IF;
    SELECT count(*) INTO v_concepts FROM public.site_vocabulary_concepts WHERE vocabulary_id = p_id;
    SELECT count(*) INTO v_metrics FROM public.metric_catalog WHERE site_vocabulary_id = p_id;

    -- The file's concepts go with it, and a linked metric keeps its id and loses the link.
    DELETE FROM public.site_vocabularies WHERE id = p_id;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source, causation_id, recorded_at
    ) VALUES (
        'site_vocabularies', p_id, 'SITE_VOCABULARY_REMOVED',
        jsonb_strip_nulls(jsonb_build_object(
            'name', v_row.name,
            'kind', v_row.kind,
            'source_format', v_row.source_format,
            'standard_name', v_row.standard_name,
            'standard_edition', v_row.standard_edition,
            'standard_publisher', v_row.standard_publisher,
            'version', v_row.version,
            'sha256', v_row.sha256,
            'concepts', v_concepts,
            'metrics_linked', v_metrics,
            'definitions_shareable', v_row.definitions_shareable)),
        NULL, v_uid, public.audit_actor_source(), txid_current(), now()
    );

    RETURN jsonb_build_object('id', p_id, 'name', v_row.name, 'concepts', v_concepts, 'metrics_linked', v_metrics);
END;
$fn$;

ALTER FUNCTION public.remove_site_vocabulary(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_site_vocabulary(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.remove_site_vocabulary(uuid) TO authenticated;

COMMENT ON FUNCTION public.remove_site_vocabulary(uuid) IS
  'Removes an imported vocabulary and its concepts. A metric that was started from it keeps its id and loses the link, and an export falls back to the catalog description. Administrator only, behind the second factor (42501); an id that is not held is P0002. Returns { id, name, concepts, metrics_linked }, and files SITE_VOCABULARY_REMOVED (0306).';

CREATE OR REPLACE FUNCTION public.set_site_vocabulary_sharing(p_id uuid, p_shareable boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_uid uuid := auth.uid();
    v_row public.site_vocabularies%ROWTYPE;
BEGIN
    IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'Only an Administrator may change whether an imported vocabulary''s definitions are shared.'
              USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.require_mfa();
    IF p_shareable IS NULL THEN
        RAISE EXCEPTION 'Say whether the definitions are shared: true or false.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_row FROM public.site_vocabularies WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No imported vocabulary has that id. It may have been removed.' USING ERRCODE = 'P0002';
    END IF;

    -- The answer it already has is not a change, so it leaves no row.
    IF v_row.definitions_shareable IS DISTINCT FROM p_shareable THEN
        UPDATE public.site_vocabularies SET definitions_shareable = p_shareable WHERE id = p_id;
        INSERT INTO public.audit_trail (
            entity_type, entity_id, action, old_data, new_data, changed_by, actor_source, causation_id, recorded_at
        ) VALUES (
            'site_vocabularies', p_id, 'SITE_VOCABULARY_SHARING_CHANGED',
            jsonb_build_object('name', v_row.name, 'definitions_shareable', v_row.definitions_shareable),
            jsonb_build_object('name', v_row.name, 'definitions_shareable', p_shareable,
                               'changed_by_email', nullif(auth.jwt() ->> 'email', '')),
            v_uid, public.audit_actor_source(), txid_current(), now()
        );
    END IF;

    RETURN jsonb_build_object('id', p_id, 'name', v_row.name, 'definitions_shareable', p_shareable);
END;
$fn$;

ALTER FUNCTION public.set_site_vocabulary_sharing(uuid, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_site_vocabulary_sharing(uuid, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_site_vocabulary_sharing(uuid, boolean) TO authenticated;

COMMENT ON FUNCTION public.set_site_vocabulary_sharing(uuid, boolean) IS
  'The Administrator''s confirmation that the licence lets an imported vocabulary''s definitions be shared (true), or that it does not (false). Until it is true concept_definitions leaves the definitions out and an export carries the ids and preferred names. Administrator only, behind the second factor (42501). A change files SITE_VOCABULARY_SHARING_CHANGED; the answer it already has files nothing (0306).';

-- -------------------------------------------------------------------------------------------------
-- 6. Definitions follow the import
-- -------------------------------------------------------------------------------------------------
-- 0302's view with the seventh arm, the concepts of an imported vocabulary whose definitions are shared
-- (site_vocabularies.definitions_shareable), after every published standard. Their standard is NULL, not
-- a label: a site's own file is no standard Aber ships, and the dashboard's list of standards stays
-- closed. A vocabulary that is not shared defines nothing here, so the exporter carries the file's
-- preferred names and defers the definitions to it. The columns do not change, so the grants and
-- security_invoker stay. 0302 declared the view with six arms, and this file is the one that must stay
-- complete when a later file adds another.
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
           FROM public.iso22400_vocabulary v
        UNION ALL
         SELECT 5, v.kind || ' ' || v.name, v.semantic_id, v.name, v.description, 'MTConnect'::text
           FROM public.mtconnect_vocabulary v
        UNION ALL
         SELECT 6, v.name, v.semantic_id, v.name, v.description, 'VDA 5050'::text
           FROM public.vda5050_vocabulary v
        UNION ALL
         SELECT 7, c.semantic_id, c.semantic_id, c.preferred_name, c.definition, NULL::text
           FROM public.site_vocabulary_concepts c
           JOIN public.site_vocabularies f ON f.id = c.vocabulary_id
          WHERE f.definitions_shareable) c
  WHERE (NULLIF(btrim(c.semantic_id), '') IS NOT NULL)
    AND (NULLIF(btrim(c.definition), '') IS NOT NULL)
  ORDER BY c.semantic_id, c.precedence, c.tiebreak;

ALTER VIEW public.concept_definitions OWNER TO postgres;

COMMENT ON VIEW public.concept_definitions IS 'One row per semantic id a vocabulary defines: the concept''s name and its vocabulary''s own definition text. IDTA, ASHRAE 223P, OPC UA, ISO 22400, MTConnect and VDA 5050, then the concepts of an imported site vocabulary whose definitions the Administrator confirmed shareable, which carry no standard. An id held by two vocabularies takes the first in that order. The AAS exporter reads it for ConceptDescription definitions.';

-- Reference data, read as the vocabularies are: security_invoker applies their SELECT policies to
-- the caller, so aas-api's caller-bound client reads it as itself.
REVOKE ALL ON TABLE public.concept_definitions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.concept_definitions TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 7. The Audit Trail's lane, class and map of kinds
-- -------------------------------------------------------------------------------------------------
-- Each function is redeclared whole, unchanged but for the file's three acts: 0001, 0168, 0193, 0228,
-- 0229, 0232, 0241, 0249 and 0299 replay first on every boot, and the last declaration stands.
CREATE OR REPLACE FUNCTION public.audit_domain_for(p_entity_type text, p_action text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
    -- Identity and authority. Every act on these is Administrator-only to perform AND the table
    -- itself is Administrator-only to read, which is what makes the lane agree with its contents.
    WHEN p_entity_type IN ('service_principals', 'user_roles', 'system_settings')
      THEN 'security'

    -- The asset trail: the shopfloor's own history. CREDENTIAL_ISSUED lands here on `gateways`
    -- deliberately: a Manager may mint a host-run gateway's broker credential. `schemas` and
    -- `metric_catalog` are Administrator-only writes to tables every authenticated user reads.
    -- The capture and playback acts are a Manager's, on tables the same three roles read. An
    -- alert's acknowledgement is an Operator's, a Manager's or an Administrator's. An automation is
    -- written by a Manager or an Administrator, and read by every role. An export of readings is a
    -- Manager's or an Administrator's, and an Auditor reads it with them. A metric's further semantic ids are
    -- written by the catalogue's writers, so they are filed beside it. An imported vocabulary is imported,
    -- removed and shared by an Administrator, and read by every role, as the catalogue is.
    WHEN p_entity_type IN ('areas', 'cells', 'devices', 'gateways', 'links',
                           'schemas', 'device_nameplate', 'device_submodels', 'change_proposals',
                           'cell_links', 'gateway_links', 'device_links',
                           'metric_catalog', 'metric_semantic_ids', 'captures', 'capture_jobs', 'playback_jobs',
                           'platform_alerts', 'automations', 'telemetry', 'site_vocabularies')
      THEN 'asset'

    -- Fail-closed: a new entity_type nobody classified is restricted rather than exposed.
    ELSE 'security'
  END
$$;

ALTER FUNCTION public.audit_domain_for(p_entity_type text, p_action text) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.audit_event_class(p_action text, p_entity_type text, p_audit_domain text,
                                                    p_old_data jsonb, p_new_data jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE
    WHEN p_action IN ('SERVICE_LOGS_READ', 'CREDENTIAL_SHOWN', 'CAPTURE_DOWNLOAD_ISSUED', 'EXPORTED',
                      'TELEMETRY_EXPORTED')
      THEN 'read'
    -- An alert acknowledged or its acknowledgement withdrawn, in either lane.
    WHEN p_action IN ('ALERT_ACKNOWLEDGED', 'ALERT_ACKNOWLEDGEMENT_WITHDRAWN')
      THEN 'operational'
    -- An automation: written, changed, switched on or off, or deleted, whatever its snapshots say.
    WHEN p_action = 'AUTOMATION_CREATED'
      THEN 'created'
    WHEN p_action = 'AUTOMATION_CHANGED'
      THEN 'configuration'
    WHEN p_action IN ('AUTOMATION_ENABLED', 'AUTOMATION_DISABLED')
      THEN 'operational'
    WHEN p_action = 'AUTOMATION_DELETED'
      THEN 'lifecycle'
    -- A site's imported vocabulary: imported, shared or not, or removed, whatever its snapshots say.
    WHEN p_action = 'SITE_VOCABULARY_IMPORTED'
      THEN 'created'
    WHEN p_action = 'SITE_VOCABULARY_SHARING_CHANGED'
      THEN 'configuration'
    WHEN p_action = 'SITE_VOCABULARY_REMOVED'
      THEN 'lifecycle'
    WHEN p_audit_domain = 'security'
      THEN 'configuration'
    WHEN p_action IN ('SCHEMA_REJECTION', 'TOKEN_MINTED', 'TOKEN_REVOKED', 'ROLE_GRANTED', 'ROLE_REVOKED')
      THEN 'configuration'
    -- The capture lane: a start makes the row its lane is about, a deletion ends it.
    WHEN p_action IN ('CAPTURE_STARTED', 'CAPTURE_RECORDED', 'CAPTURE_UPLOADED', 'PLAYBACK_STARTED')
      THEN 'created'
    WHEN p_action = 'CAPTURE_DELETED'
      THEN 'lifecycle'
    WHEN p_action IN ('CAPTURE_STOPPED', 'PLAYBACK_STOPPED')
      THEN 'operational'
    -- A schema attached to or detached from a device, whatever its verb.
    WHEN p_entity_type = 'device_submodels'
      THEN 'configuration'
    WHEN p_action = 'DELETE'
      THEN 'lifecycle'
    WHEN p_action = 'INSERT'
      THEN 'created'
    -- Archived, quarantined, or a metric deprecated: the flag is true now and was not before.
    WHEN (p_new_data -> 'is_archived') = 'true' AND (p_old_data -> 'is_archived') IS DISTINCT FROM 'true'
      OR (p_new_data -> 'is_quarantined') = 'true' AND (p_old_data -> 'is_quarantined') IS DISTINCT FROM 'true'
      OR (p_new_data -> 'deprecated') = 'true' AND (p_old_data -> 'deprecated') IS DISTINCT FROM 'true'
      THEN 'lifecycle'
    -- A configuration field changed. A missing field and a JSON null are the same value.
    WHEN CASE
           WHEN jsonb_typeof(p_old_data) IN ('object', 'array') AND jsonb_typeof(p_new_data) IN ('object', 'array') THEN
                nullif(p_old_data -> 'schema_id', 'null') IS DISTINCT FROM nullif(p_new_data -> 'schema_id', 'null')
             OR nullif(p_old_data -> 'asset_config', 'null') IS DISTINCT FROM nullif(p_new_data -> 'asset_config', 'null')
             OR nullif(p_old_data -> 'connection_method', 'null') IS DISTINCT FROM nullif(p_new_data -> 'connection_method', 'null')
             OR nullif(p_old_data -> 'grafana_url', 'null') IS DISTINCT FROM nullif(p_new_data -> 'grafana_url', 'null')
             OR nullif(p_old_data -> 'access_url', 'null') IS DISTINCT FROM nullif(p_new_data -> 'access_url', 'null')
           WHEN jsonb_typeof(p_new_data) IN ('object', 'array') THEN
                coalesce((p_new_data -> 'schema_id') NOT IN ('null', '""'), false)
             OR coalesce((p_new_data -> 'asset_config') NOT IN ('null', '""'), false)
             OR coalesce((p_new_data -> 'connection_method') NOT IN ('null', '""'), false)
             OR coalesce((p_new_data -> 'grafana_url') NOT IN ('null', '""'), false)
             OR coalesce((p_new_data -> 'access_url') NOT IN ('null', '""'), false)
           WHEN jsonb_typeof(p_old_data) IN ('object', 'array') THEN
                coalesce((p_old_data -> 'schema_id') NOT IN ('null', '""'), false)
             OR coalesce((p_old_data -> 'asset_config') NOT IN ('null', '""'), false)
             OR coalesce((p_old_data -> 'connection_method') NOT IN ('null', '""'), false)
             OR coalesce((p_old_data -> 'grafana_url') NOT IN ('null', '""'), false)
             OR coalesce((p_old_data -> 'access_url') NOT IN ('null', '""'), false)
           ELSE false
         END
      THEN 'configuration'
    ELSE 'operational'
  END
$$;

ALTER FUNCTION public.audit_event_class(text, text, text, jsonb, jsonb) OWNER TO postgres;

COMMENT ON FUNCTION public.audit_event_class(text, text, text, jsonb, jsonb) IS
  'Which class an audit_trail row is in: created, operational, configuration, lifecycle or read (0228). '
  'Read is a row that records access and changes nothing, decided before the security lane''s rule, and '
  'an alert''s acknowledgement and its withdrawal are operational in either lane (0232), and an imported vocabulary''s three acts are created, configuration and lifecycle (0306). '
  'Unpinned on purpose: a SET clause stops the planner inlining it, and the class indexes on audit_trail '
  'are built on it. It reads no table and calls only built-in operators. A change to its rules rebuilds '
  'those indexes in the same file.';

-- The new rules class three actions no row has been written for, so no class index can hold an entry
-- the rules now answer differently, and a site with none rebuilds nothing. The rebuild is the one
-- 0232 makes, each index a statement of its own, in case a row of the new actions exists from a boot
-- between the two files.
SELECT EXISTS (SELECT 1 FROM public.audit_trail
                WHERE action IN ('SITE_VOCABULARY_IMPORTED', 'SITE_VOCABULARY_REMOVED', 'SITE_VOCABULARY_SHARING_CHANGED'))
       AS aber_0306_rebuild_class_indexes
\gset
\if :aber_0306_rebuild_class_indexes
REINDEX INDEX public.idx_audit_trail_class_created;
REINDEX INDEX public.idx_audit_trail_class_operational;
REINDEX INDEX public.idx_audit_trail_class_configuration;
REINDEX INDEX public.idx_audit_trail_class_lifecycle;
REINDEX INDEX public.idx_audit_trail_class_read;
\endif

CREATE OR REPLACE FUNCTION public.audit_trail_action_kinds()
RETURNS TABLE (action text, entity_type text, classes text[])
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'public'
    AS $$
  SELECT m.action, k.kind, m.classes
    FROM (VALUES
      -- The audit trigger, on every table it is attached to.
      ('INSERT', ARRAY['areas', 'cells', 'devices', 'gateways', 'metric_catalog', 'metric_semantic_ids', 'schemas', 'device_nameplate'],
                 ARRAY['created']),
      ('INSERT', ARRAY['device_submodels', 'system_settings', 'service_principals', 'broker_accounts'],
                 ARRAY['configuration']),
      ('UPDATE', ARRAY['areas', 'cells', 'devices', 'gateways', 'metric_catalog', 'metric_semantic_ids', 'schemas', 'device_nameplate'],
                 ARRAY['operational', 'configuration', 'lifecycle']),
      ('UPDATE', ARRAY['device_submodels', 'system_settings'], ARRAY['configuration']),
      ('DELETE', ARRAY['areas', 'cells', 'devices', 'gateways', 'metric_catalog', 'metric_semantic_ids', 'schemas', 'device_nameplate'],
                 ARRAY['lifecycle']),
      ('DELETE', ARRAY['device_submodels', 'system_settings', 'broker_accounts'], ARRAY['configuration']),
      -- The plant and the model.
      ('SCHEMA_REJECTION', ARRAY['devices'], ARRAY['configuration']),
      ('PROPOSAL_APPLIED', ARRAY['areas', 'cells', 'devices', 'device_nameplate', 'gateways', 'schemas'],
                           ARRAY['operational', 'configuration', 'lifecycle']),
      ('PROPOSAL_EXPIRED', ARRAY['change_proposals'], ARRAY['operational', 'configuration', 'lifecycle']),
      ('EXPORTED', ARRAY['devices'], ARRAY['read']),
      -- Readings exported from History (0279): one row an export, in the one lane for readings.
      ('TELEMETRY_EXPORTED', ARRAY['telemetry'], ARRAY['read']),
      ('FLOW_DEPLOYED', ARRAY['gateways'], ARRAY['operational', 'configuration', 'lifecycle']),
      ('CREDENTIAL_ISSUED', ARRAY['gateways'], ARRAY['operational', 'configuration', 'lifecycle']),
      ('CREDENTIAL_SHOWN', ARRAY['gateways'], ARRAY['read']),
      -- Capture and playback.
      ('CAPTURE_STARTED', ARRAY['capture_jobs'], ARRAY['created']),
      ('CAPTURE_STOPPED', ARRAY['capture_jobs'], ARRAY['operational']),
      ('CAPTURE_RECORDED', ARRAY['captures'], ARRAY['created']),
      ('CAPTURE_UPLOADED', ARRAY['captures'], ARRAY['created']),
      ('CAPTURE_DOWNLOAD_ISSUED', ARRAY['captures'], ARRAY['read']),
      ('CAPTURE_DELETED', ARRAY['captures'], ARRAY['lifecycle']),
      ('PLAYBACK_STARTED', ARRAY['playback_jobs'], ARRAY['created']),
      ('PLAYBACK_STOPPED', ARRAY['playback_jobs'], ARRAY['operational']),
      -- People and access, in the person's lane.
      ('PERSON_ADDED', ARRAY['user_roles'], ARRAY['configuration']),
      ('ROLE_GRANTED', ARRAY['user_roles'], ARRAY['configuration']),
      ('ROLE_REVOKED', ARRAY['user_roles'], ARRAY['configuration']),
      ('ACCESS_REMOVED', ARRAY['user_roles'], ARRAY['configuration']),
      ('ACCESS_RESTORED', ARRAY['user_roles'], ARRAY['configuration']),
      ('PASSWORD_SET', ARRAY['user_roles'], ARRAY['configuration']),
      ('DISPLAY_NAME_CHANGED', ARRAY['user_roles'], ARRAY['configuration']),
      ('EMAIL_CHANGED', ARRAY['user_roles'], ARRAY['configuration']),
      ('SESSIONS_ENDED', ARRAY['user_roles'], ARRAY['configuration']),
      ('MFA_RESET', ARRAY['user_roles'], ARRAY['configuration']),
      ('APP_APPROVED', ARRAY['user_roles'], ARRAY['configuration']),
      ('APP_APPROVAL_REVOKED', ARRAY['user_roles'], ARRAY['configuration']),
      -- Apps, in the app's lane.
      ('APP_REGISTERED', ARRAY['oauth_clients'], ARRAY['configuration']),
      ('APP_REMOVED', ARRAY['oauth_clients'], ARRAY['configuration']),
      ('APP_RESTORED', ARRAY['oauth_clients'], ARRAY['configuration']),
      -- Machine identities and credentials.
      ('PRINCIPAL_REVOKED', ARRAY['service_principals'], ARRAY['configuration']),
      ('PRINCIPAL_REINSTATED', ARRAY['service_principals'], ARRAY['configuration']),
      ('PRINCIPAL_DESCRIBED', ARRAY['service_principals'], ARRAY['configuration']),
      ('TOKEN_MINTED', ARRAY['service_principals'], ARRAY['configuration']),
      ('TOKEN_REVOKED', ARRAY['service_principals'], ARRAY['configuration']),
      -- Backups: the request, then the backup it took.
      ('BACKUP_REQUESTED', ARRAY['backup_jobs'], ARRAY['configuration']),
      ('BACKUP_CANCELLED', ARRAY['backup_jobs'], ARRAY['configuration']),
      ('BACKUP_FAILED', ARRAY['backup_jobs'], ARRAY['configuration']),
      ('BACKUP_TAKEN', ARRAY['backups'], ARRAY['configuration']),
      ('BACKUP_RELEASED', ARRAY['backups'], ARRAY['configuration']),
      ('BACKUP_PRUNED', ARRAY['backups'], ARRAY['configuration']),
      -- The System page.
      ('SERVICE_LOGS_READ', ARRAY['service_logs'], ARRAY['read']),
      -- Alerts, in the alert's lane, or a machine identity's alert in the identity's.
      ('ALERT_ACKNOWLEDGED', ARRAY['platform_alerts', 'service_principals'], ARRAY['operational']),
      ('ALERT_ACKNOWLEDGEMENT_WITHDRAWN', ARRAY['platform_alerts', 'service_principals'], ARRAY['operational']),
      -- A suppression window's acts, in its subject's lane. Named acts on an asset row, so the
      -- snapshots decide the class.
      ('SUPPRESSION_WINDOW_SCHEDULED', ARRAY['devices', 'gateways', 'cells'], ARRAY['operational', 'configuration', 'lifecycle']),
      ('SUPPRESSION_WINDOW_CHANGED', ARRAY['devices', 'gateways', 'cells'], ARRAY['operational', 'configuration', 'lifecycle']),
      ('SUPPRESSION_WINDOW_ENDED', ARRAY['devices', 'gateways', 'cells'], ARRAY['operational', 'configuration', 'lifecycle']),
      ('SUPPRESSION_WINDOW_CANCELLED', ARRAY['devices', 'gateways', 'cells'], ARRAY['operational', 'configuration', 'lifecycle']),
      -- An automation's acts, in its own lane (0232 files the lane and the classes). Each is one row
      -- per automation, naming who did it.
      ('AUTOMATION_CREATED', ARRAY['automations'], ARRAY['created']),
      ('AUTOMATION_CHANGED', ARRAY['automations'], ARRAY['configuration']),
      ('AUTOMATION_ENABLED', ARRAY['automations'], ARRAY['operational']),
      ('AUTOMATION_DISABLED', ARRAY['automations'], ARRAY['operational']),
      ('AUTOMATION_DELETED', ARRAY['automations'], ARRAY['lifecycle']),
      -- The webhook's signing key, issued or rotated, in the webhook's lane.
      ('SIGNING_KEY_ISSUED', ARRAY['notification_channels'], ARRAY['configuration']),
      -- A site's imported vocabulary, in its own lane (0306): imported, removed, and shared or not.
      ('SITE_VOCABULARY_IMPORTED', ARRAY['site_vocabularies'], ARRAY['created']),
      ('SITE_VOCABULARY_REMOVED', ARRAY['site_vocabularies'], ARRAY['lifecycle']),
      ('SITE_VOCABULARY_SHARING_CHANGED', ARRAY['site_vocabularies'], ARRAY['configuration'])
    ) AS m(action, kinds, classes)
   CROSS JOIN LATERAL unnest(m.kinds) AS k(kind)
$$;

ALTER FUNCTION public.audit_trail_action_kinds() OWNER TO postgres;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_tbl  text;
  v_fn   text;
  v_def  text;
  v_role text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['public.site_vocabularies', 'public.site_vocabulary_concepts'] LOOP
    IF to_regclass(v_tbl) IS NULL THEN
      RAISE EXCEPTION '0306: % is missing', v_tbl;
    END IF;
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = v_tbl::regclass) THEN
      RAISE EXCEPTION '0306: % has no row security', v_tbl;
    END IF;
    IF has_table_privilege('anon', v_tbl, 'SELECT')
       OR has_table_privilege('authenticated', v_tbl, 'INSERT')
       OR has_table_privilege('authenticated', v_tbl, 'UPDATE')
       OR has_table_privilege('authenticated', v_tbl, 'DELETE')
       OR has_table_privilege('authenticated', v_tbl, 'TRUNCATE') THEN
      RAISE EXCEPTION '0306: % is readable by anon or writable by authenticated', v_tbl;
    END IF;
    IF NOT has_table_privilege('authenticated', v_tbl, 'SELECT') THEN
      RAISE EXCEPTION '0306: authenticated cannot read %', v_tbl;
    END IF;
  END LOOP;
  FOREACH v_def IN ARRAY ARRAY['site_vocabularies_select_authenticated', 'site_vocabulary_concepts_select_authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polname = v_def) THEN
      RAISE EXCEPTION '0306: the policy % is missing', v_def;
    END IF;
  END LOOP;
  -- Removing a file removes its concepts, and clears a metric's link without removing the metric.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'site_vocabulary_concepts_vocabulary_id_fkey' AND confdeltype = 'c') THEN
    RAISE EXCEPTION '0306: site_vocabulary_concepts does not cascade from its file';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_site_vocabulary_id_fkey' AND confdeltype = 'n') THEN
    RAISE EXCEPTION '0306: metric_catalog.site_vocabulary_id does not clear when its file is removed';
  END IF;
  -- The format's CHECK is judged by its name alone: a later file widens it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_vocabularies_source_format_valid') THEN
    RAISE EXCEPTION '0306: site_vocabularies has no CHECK on its source format';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY['public.import_site_vocabulary(jsonb, jsonb)', 'public.remove_site_vocabulary(uuid)',
                              'public.set_site_vocabulary_sharing(uuid, boolean)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                    AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0306: % is not SECURITY DEFINER with its search_path pinned', v_fn;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '0306: % may execute %', v_role, v_fn;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0306: authenticated may not execute %; the dashboard calls it', v_fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'public.site_vocabulary_holders(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION '0306: authenticated may not execute site_vocabulary_holders(); the Import dialog calls it';
  END IF;
  IF has_function_privilege('authenticated', 'public.semantic_id_shape(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0306: authenticated may execute semantic_id_shape(); it is the import functions'' own';
  END IF;

  -- The new acts, in the asset lane and their classes, and each map row once.
  IF public.audit_domain_for('site_vocabularies', 'SITE_VOCABULARY_IMPORTED') <> 'asset' THEN
    RAISE EXCEPTION '0306: audit_domain_for() files site_vocabularies in the % lane; it must be asset',
      public.audit_domain_for('site_vocabularies', 'SITE_VOCABULARY_IMPORTED');
  END IF;
  IF public.audit_event_class('SITE_VOCABULARY_IMPORTED', 'site_vocabularies', 'asset', NULL, '{"name": "x"}') <> 'created'
     OR public.audit_event_class('SITE_VOCABULARY_REMOVED', 'site_vocabularies', 'asset', '{"name": "x"}', NULL) <> 'lifecycle'
     OR public.audit_event_class('SITE_VOCABULARY_SHARING_CHANGED', 'site_vocabularies', 'asset', '{"name": "x"}', '{"name": "x"}') <> 'configuration' THEN
    RAISE EXCEPTION '0306: audit_event_class() does not class an import as created, a removal as lifecycle and a change of sharing as configuration';
  END IF;
  FOREACH v_def IN ARRAY ARRAY['SITE_VOCABULARY_IMPORTED', 'SITE_VOCABULARY_REMOVED', 'SITE_VOCABULARY_SHARING_CHANGED'] LOOP
    IF (SELECT count(*) FROM public.audit_trail_action_kinds() m
         WHERE m.action = v_def AND m.entity_type = 'site_vocabularies') <> 1 THEN
      RAISE EXCEPTION '0306: audit_trail_action_kinds() does not list % on site_vocabularies once', v_def;
    END IF;
  END LOOP;
  -- The arms of the files before are carried over.
  IF public.audit_domain_for('metric_semantic_ids', 'INSERT') <> 'asset'
     OR public.audit_domain_for('metric_catalog', 'UPDATE') <> 'asset'
     OR public.audit_domain_for('automations', 'AUTOMATION_CREATED') <> 'asset'
     OR public.audit_domain_for('telemetry', 'TELEMETRY_EXPORTED') <> 'asset'
     OR public.audit_domain_for('user_roles', 'ROLE_GRANTED') <> 'security'
     OR public.audit_domain_for('notification_channels', 'SIGNING_KEY_ISSUED') <> 'security' THEN
    RAISE EXCEPTION '0306: audit_domain_for() files a kind of an earlier file in another lane';
  END IF;
  FOR v_def IN SELECT unnest(ARRAY['SIGNING_KEY_ISSUED', 'AUTOMATION_DELETED', 'TELEMETRY_EXPORTED',
                                   'SUPPRESSION_WINDOW_CANCELLED', 'ALERT_ACKNOWLEDGEMENT_WITHDRAWN',
                                   'CAPTURE_DELETED', 'SERVICE_LOGS_READ', 'BACKUP_PRUNED', 'PROPOSAL_EXPIRED']) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.audit_trail_action_kinds() m WHERE m.action = v_def) THEN
      RAISE EXCEPTION '0306: audit_trail_action_kinds() lost %', v_def;
    END IF;
  END LOOP;
  IF public.audit_event_class('TELEMETRY_EXPORTED', 'telemetry', 'asset', NULL, '{"name": "Readings"}') <> 'read'
     OR public.audit_event_class('AUTOMATION_DELETED', 'automations', 'asset', '{"alias": "x"}', NULL) <> 'lifecycle'
     OR public.audit_event_class('ALERT_ACKNOWLEDGED', 'service_principals', 'security', NULL, NULL) <> 'operational' THEN
    RAISE EXCEPTION '0306: audit_event_class() lost a rule of an earlier file';
  END IF;

  -- The site arm of concept_definitions, which is the one thing this file adds to it: a concept of a
  -- vocabulary whose definitions are shared is defined by the file's text, under no standard, and one
  -- whose definitions are not shared is not there. Tried on rows a subtransaction takes back.
  BEGIN
    INSERT INTO public.site_vocabularies (id, name, source_format, kind, sha256, definitions_shareable)
    VALUES ('00000000-0000-4000-8000-000000000306', '0306 self-check', 'aas-json', 'site_own', repeat('0', 64), true);
    INSERT INTO public.site_vocabulary_concepts (vocabulary_id, semantic_id, semantic_id_type, preferred_name, definition)
    VALUES ('00000000-0000-4000-8000-000000000306', 'https://aber.local/semantics/self-check/0306/Shared', 'IRI',
            'Shared concept', 'The text the file shares.');
    IF NOT EXISTS (SELECT 1 FROM public.concept_definitions c
                    WHERE c.semantic_id = 'https://aber.local/semantics/self-check/0306/Shared'
                      AND c.standard IS NULL AND c.name = 'Shared concept' AND c.definition = 'The text the file shares.') THEN
      RAISE EXCEPTION '0306: concept_definitions does not define a shared site concept by the file''s text';
    END IF;
    UPDATE public.site_vocabularies SET definitions_shareable = false
     WHERE id = '00000000-0000-4000-8000-000000000306';
    IF EXISTS (SELECT 1 FROM public.concept_definitions c
                WHERE c.semantic_id = 'https://aber.local/semantics/self-check/0306/Shared') THEN
      RAISE EXCEPTION '0306: concept_definitions defines a concept of a vocabulary whose definitions are not shared';
    END IF;
    RAISE EXCEPTION 'the self-check rolls back' USING ERRCODE = 'AB306';
  EXCEPTION WHEN SQLSTATE 'AB306' THEN
    NULL;
  END;

  -- A request with no person behind it is refused before anything is read.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.import_site_vocabulary('{}'::jsonb, '[]'::jsonb);
    RAISE EXCEPTION '0306: import_site_vocabulary() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$check$;

NOTIFY pgrst, 'reload schema';
