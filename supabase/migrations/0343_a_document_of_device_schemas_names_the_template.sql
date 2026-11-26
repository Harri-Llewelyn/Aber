-- 0343: A document of device schemas names the template a schema is built from.
--
-- A version built from a template (0342) says which template, and the template is part of the version:
-- frozen with it, and carried by Create Version. A file of device schemas says what a version is, so it
-- says that too, as `template`, the template's id. Which element each metric fills is not written: it
-- follows from the template and the catalogue of the site the file is applied on, as it does in the
-- editor.
--
--   * device_schema_template_part() renders the key, as device_schema_derived_part() renders
--     `derived_metrics`, so a stored version and a checked document are one shape.
--   * device_schemas_parse() takes `template`: the id of a template Aber holds. A schema with one carries
--     the template's id as its semantic id, so `semantic_id` is left out or is that id. Every element the
--     template requires is filled by a metric the file lists.
--   * apply_device_schemas() compares and writes it. A file says what is saved, so a file without the key
--     builds no template, and a version built from one that it changes loses it. A file written before
--     1.10 is read as it was.
--
-- Reasoning: supabase/README.md, "A document of device schemas names the template (0343)".
-- Idempotent.
--
-- Redefines public.device_schema_stored_document: 0343 adds the template the version is built from
-- Redefines public.device_schemas_parse: 0343 takes and checks `template`
-- Redefines public.apply_device_schemas: 0343 compares and writes the template, and builds no template
--   for a changed schema whose file names none

-- -------------------------------------------------------------------------------------------------
-- 1. The key
-- -------------------------------------------------------------------------------------------------
-- The `template` key of a document, or no key for a schema built some other way: one renderer for a
-- stored version and for a checked document, as device_schema_derived_part() is.
CREATE OR REPLACE FUNCTION public.device_schema_template_part(p_template_id text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE WHEN nullif(p_template_id, '') IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('template', p_template_id) END;
$$;

ALTER FUNCTION public.device_schema_template_part(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.device_schema_template_part(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.device_schema_template_part(text) TO authenticated;

COMMENT ON FUNCTION public.device_schema_template_part(text) IS
  'The `template` key of a schema in the document''s shape: the template''s id, or no key for a schema '
  'built some other way (0343).';

-- -------------------------------------------------------------------------------------------------
-- 2. The functions that read and write a document
-- -------------------------------------------------------------------------------------------------
-- A stored schema in the document's shape: its lineage's name, which every version carries, its
-- definition's properties (a metric whose entry is not an object has no range), the derived metrics it
-- names and the template it is built from. SECURITY INVOKER: the tables' own policies decide what the
-- caller reads.
CREATE OR REPLACE FUNCTION public.device_schema_stored_document(p_schema_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT public.device_schema_document_of(
    s.lineage_name, s.description, s.semantic_id, s.semantic_id_type,
    (SELECT jsonb_agg(jsonb_build_object(
              'name', p.key, 'minimum', p.value -> 'minimum', 'maximum', p.value -> 'maximum',
              'semantic_id', mc.semantic_id))
       FROM jsonb_each(CASE WHEN jsonb_typeof(s.schema_definition -> 'properties') = 'object'
                            THEN s.schema_definition -> 'properties' ELSE '{}'::jsonb END) p
       LEFT JOIN public.metric_catalog mc ON mc.name = p.key))
    || public.device_schema_derived_part(s.derived_metrics)
    || public.device_schema_template_part(s.template_id)
    FROM public.schemas s
   WHERE s.id = p_schema_id;
$$;

ALTER FUNCTION public.device_schema_stored_document(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.device_schema_stored_document(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.device_schema_stored_document(uuid) TO authenticated;

COMMENT ON FUNCTION public.device_schema_stored_document(uuid) IS
  'The stored schema in the document''s shape, named by its lineage (lineage_name, the name of the '
  'lineage''s first version, which every version carries), with the derived metrics it names and the '
  'template it is built from. SECURITY INVOKER: the tables'' own policies decide what the caller sees '
  '(0295, 0316, 0336, 0343).';

-- Reads the catalogue and the schemas and writes nothing. A file is bounded: 200 schemas and 1,000
-- metrics each. For each schema, in order: {index, key, reasons, canon}. `canon` is the schema as it
-- would be stored, every value typed and every metric resolved to the catalogue's own semantic id,
-- and null when there is any reason to refuse it. It is checked field by field and every reason is
-- collected, so a person fixes a file in one pass. The reasons are the shape automations_parse()
-- gives (automation_reason() and automation_path() are the shared helpers).
CREATE OR REPLACE FUNCTION public.device_schemas_parse(p_doc jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  c_max_schemas CONSTANT integer := 200;
  c_max_metrics CONSTANT integer := 1000;
  v_out      jsonb := '[]'::jsonb;
  v_seen     jsonb := '{}'::jsonb;
  v_item     jsonb;
  v_path     text;
  v_reasons  jsonb;
  v_key      text;
  v_val      jsonb;
  v_name     text;
  v_stem     text;
  v_lineage  text;
  v_by_lineage boolean;
  v_roots    uuid[];
  v_head_id  uuid;
  v_desc     text;
  v_sid      text;
  v_stype    text;
  v_change   text;
  v_list     jsonb;
  v_rows     jsonb;
  v_metric   jsonb;
  v_mpath    text;
  v_mname    text;
  v_mnames   text[];
  v_cat      public.metric_catalog;
  v_found    boolean;
  v_heads    integer;
  v_head_def jsonb;
  v_known    boolean;
  v_kept     boolean;
  v_numeric  boolean;
  v_min      jsonb;
  v_max      jsonb;
  v_ok       boolean;
  v_listed   text[];
  v_dnames   text[];
  v_dname    text;
  v_dpath    text;
  v_kept_derived text[];
  v_problem  text;
  v_template text;
BEGIN
  IF jsonb_typeof(p_doc) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_array(jsonb_build_object('index', NULL, 'key', NULL, 'reasons', jsonb_build_array(
      public.automation_reason('$', 'A file holds a list of schemas. Start each one with `- name:`.')), 'canon', NULL));
  END IF;
  IF jsonb_array_length(p_doc) > c_max_schemas THEN
    RETURN jsonb_build_array(jsonb_build_object('index', NULL, 'key', NULL, 'reasons', jsonb_build_array(
      public.automation_reason('$', format('A file holds at most %s schemas. Split it.', c_max_schemas))), 'canon', NULL));
  END IF;

  FOR i IN 0 .. jsonb_array_length(p_doc) - 1 LOOP
    v_item := p_doc -> i;
    v_path := format('$[%s]', i);
    v_reasons := '[]'::jsonb;
    v_rows := '[]'::jsonb;
    v_name := NULL;
    v_stem := NULL;
    v_lineage := NULL;
    v_head_id := NULL;
    v_desc := '';
    v_sid := NULL;
    v_stype := NULL;
    v_change := NULL;
    v_head_def := NULL;
    v_listed := ARRAY[]::text[];
    v_dnames := ARRAY[]::text[];
    v_kept_derived := ARRAY[]::text[];
    v_template := NULL;

    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      v_out := v_out || jsonb_build_object('index', i, 'key', NULL, 'canon', NULL, 'reasons', jsonb_build_array(
        public.automation_reason(v_path, 'A schema is a set of keys: name and metrics at least.')));
      CONTINUE;
    END IF;

    -- A key nothing here means is refused, never ignored.
    FOR v_key IN SELECT jsonb_object_keys(v_item) LOOP
      IF NOT v_key = ANY (ARRAY['name', 'description', 'semantic_id', 'semantic_id_type', 'template', 'change_description', 'metrics', 'derived_metrics']) THEN
        v_reasons := v_reasons || public.automation_reason(public.automation_path(v_path, v_key), format(
          '`%s` is not a key a schema takes. Remove it. The keys are name, description, semantic_id, semantic_id_type, template, change_description, metrics and derived_metrics.', v_key));
      END IF;
    END LOOP;

    -- name: the schema's, which a version's _v2 is not part of
    v_val := v_item -> 'name';
    IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string'
       OR char_length(v_val #>> '{}') NOT BETWEEN 1 AND 120
       OR (v_val #>> '{}') !~ '^\S' OR (v_val #>> '{}') !~ '\S$' OR (v_val #>> '{}') ~ '[[:cntrl:]]'
       OR public.schema_version_base_name(v_val #>> '{}') = '' THEN
      v_reasons := v_reasons || public.automation_reason(v_path || '.name',
        '`name` is the schema''s name: 1 to 120 characters, with no space or control character at either end.');
    ELSE
      v_name := v_val #>> '{}';
      v_stem := public.schema_version_base_name(v_name);

      -- Found by its lineage's name, which every version carries; the one in force is what this is
      -- compared with. A name no lineage has is found as a file written before 0316 names one: a
      -- version's name with one trailing _v<n> taken off. That version names its lineage, whose
      -- version in force is named from the lineage and may not share the name.
      v_by_lineage := EXISTS (SELECT 1 FROM public.schemas s WHERE s.lineage_name = v_name);
      v_lineage := CASE WHEN v_by_lineage THEN v_name ELSE v_stem END;
      v_roots := ARRAY(SELECT s.lineage_root_id FROM public.schemas s
                        WHERE CASE WHEN v_by_lineage THEN s.lineage_name = v_name
                                   ELSE public.schema_version_base_name(s.schema_name) = v_stem END);
      v_known := cardinality(v_roots) > 0;
      SELECT count(*)::integer INTO v_heads
        FROM public.schemas s
       WHERE s.status = 'active' AND s.lineage_root_id = ANY (v_roots);
      IF v_heads > 1 THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.name', format(
          'More than one schema here is called `%s`, so Aber cannot tell which the file means.', v_lineage));
      ELSIF v_heads = 1 THEN
        SELECT s.id, s.lineage_name, s.schema_definition
          INTO v_head_id, v_lineage, v_head_def
          FROM public.schemas s
         WHERE s.status = 'active' AND s.lineage_root_id = ANY (v_roots);
        SELECT s.derived_metrics INTO v_kept_derived FROM public.schemas s WHERE s.id = v_head_id;
      ELSIF v_known THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.name', format(
          '`%s` has no version in force. Publish its draft on the Schemas page first.', v_lineage));
      ELSIF v_name <> v_stem THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.name', format(
          '`%s` ends in a version, which Aber adds itself when it versions a schema. Name the schema `%s`.', v_name, v_stem));
      END IF;

      -- Once a lineage: two names that find one lineage are one schema twice.
      IF v_seen ? v_lineage THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.name', format(
          '`%s` is already the name of the schema at %s. Give each schema its own name.', v_lineage, v_seen ->> v_lineage));
      ELSE
        v_seen := v_seen || jsonb_build_object(v_lineage, v_path);
      END IF;
    END IF;

    -- description
    IF v_item ? 'description' THEN
      v_val := v_item -> 'description';
      IF jsonb_typeof(v_val) <> 'string' OR char_length(v_val #>> '{}') > 4000 THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.description',
          '`description` is text of at most 4,000 characters.');
      ELSE
        v_desc := regexp_replace(v_val #>> '{}', '^\s+|\s+$', '', 'g');
      END IF;
    END IF;

    -- semantic_id and its type: the type only with an id
    IF v_item ? 'semantic_id' THEN
      v_val := v_item -> 'semantic_id';
      IF jsonb_typeof(v_val) <> 'string' OR char_length(v_val #>> '{}') NOT BETWEEN 1 AND 1000
         OR (v_val #>> '{}') !~ '^\S' OR (v_val #>> '{}') !~ '\S$' OR (v_val #>> '{}') ~ '[[:cntrl:]]' THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.semantic_id',
          '`semantic_id` is the id of the standard Submodel the schema matches: 1 to 1,000 characters, with no space or control character at either end.');
      ELSE
        v_sid := v_val #>> '{}';
      END IF;
    END IF;
    IF v_item ? 'semantic_id_type' THEN
      v_val := v_item -> 'semantic_id_type';
      IF jsonb_typeof(v_val) <> 'string' OR NOT (v_val #>> '{}') = ANY (ARRAY['IRI', 'IRDI', 'ExpandedNodeId']) THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.semantic_id_type',
          '`semantic_id_type` is IRI, IRDI or ExpandedNodeId.');
      ELSIF NOT (v_item ? 'semantic_id') THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.semantic_id_type',
          'Give `semantic_id` too, or remove `semantic_id_type`.');
      ELSE
        v_stype := v_val #>> '{}';
      END IF;
    END IF;

    -- template: the id of a template Aber holds. The schema carries it as its semantic id, so a
    -- semantic_id the file gives is that id.
    IF v_item ? 'template' THEN
      v_val := v_item -> 'template';
      IF jsonb_typeof(v_val) <> 'string' THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.template',
          '`template` is the id of an IDTA submodel template, as the Vocabulary page''s Templates tab lists it. Leave it out for a schema built from the catalogue alone.');
      ELSIF NOT EXISTS (SELECT 1 FROM public.idta_template_elements e WHERE e.template_id = v_val #>> '{}') THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.template', format(
          '`%s` is not a template Aber holds. The Vocabulary page''s Templates tab lists them.', v_val #>> '{}'));
      ELSE
        v_template := v_val #>> '{}';
        IF v_sid IS NOT NULL AND v_sid <> v_template THEN
          v_reasons := v_reasons || public.automation_reason(v_path || '.semantic_id', format(
            'A schema built from a template carries the template''s id as its semantic id. Leave `semantic_id` out, or make it `%s`.', v_template));
        ELSIF v_sid IS NULL AND NOT (v_item ? 'semantic_id') THEN
          v_sid := v_template;
          v_stype := 'IRI';
        END IF;
      END IF;
    END IF;

    -- change_description: why a new version exists. Used only when the file makes one.
    IF v_item ? 'change_description' THEN
      v_val := v_item -> 'change_description';
      IF jsonb_typeof(v_val) <> 'string' OR char_length(v_val #>> '{}') > 1000 THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.change_description',
          '`change_description` is text of at most 1,000 characters.');
      ELSE
        v_change := nullif(regexp_replace(v_val #>> '{}', '^\s+|\s+$', '', 'g'), '');
      END IF;
    END IF;

    -- metrics: catalogue names, each with an optional range
    v_list := v_item -> 'metrics';
    IF v_list IS NULL OR jsonb_typeof(v_list) <> 'array' OR jsonb_array_length(v_list) = 0 THEN
      v_reasons := v_reasons || public.automation_reason(v_path || '.metrics',
        '`metrics` is the list of catalogue metrics the schema models. A schema with none constrains nothing: give at least one.');
    ELSIF jsonb_array_length(v_list) > c_max_metrics THEN
      v_reasons := v_reasons || public.automation_reason(v_path || '.metrics',
        format('A schema takes at most %s metrics.', c_max_metrics));
    ELSE
      v_mnames := ARRAY[]::text[];
      FOR j IN 0 .. jsonb_array_length(v_list) - 1 LOOP
        v_metric := v_list -> j;
        v_mpath := format('%s.metrics[%s]', v_path, j);
        IF jsonb_typeof(v_metric) <> 'object' THEN
          v_reasons := v_reasons || public.automation_reason(v_mpath,
            'A metric is a set of keys: name, and for a number minimum and maximum.');
          CONTINUE;
        END IF;
        FOR v_key IN SELECT jsonb_object_keys(v_metric) LOOP
          IF NOT v_key = ANY (ARRAY['name', 'minimum', 'maximum', 'semantic_id']) THEN
            v_reasons := v_reasons || public.automation_reason(public.automation_path(v_mpath, v_key), format(
              '`%s` is not a key a metric takes. Remove it. The keys are name, minimum, maximum and semantic_id.', v_key));
          END IF;
        END LOOP;

        -- name: in the catalogue, measured, and not retired
        v_mname := NULL;
        v_val := v_metric -> 'name';
        IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string' THEN
          v_reasons := v_reasons || public.automation_reason(v_mpath || '.name',
            '`name` is the metric''s catalogue name, such as Spindle/LOAD.');
        ELSE
          v_mname := v_val #>> '{}';
          v_listed := v_listed || v_mname;
          SELECT * INTO v_cat FROM public.metric_catalog m WHERE m.name = v_mname;
          v_found := FOUND;
          v_kept := coalesce(jsonb_typeof(v_head_def -> 'properties') = 'object' AND (v_head_def -> 'properties') ? v_mname, false);
          IF NOT v_found THEN
            v_reasons := v_reasons || public.automation_reason(v_mpath || '.name', format(
              '`%s` is not in the metric catalogue. Register it on the Metrics page first.', v_mname));
            v_mname := NULL;
          ELSIF v_cat.derivation IS NOT NULL THEN
            v_reasons := v_reasons || public.automation_reason(v_mpath || '.name', format(
              '`%s` is a derived metric. Nothing publishes one, so a schema does not model it: name it under `derived_metrics`.', v_mname));
            v_mname := NULL;
          ELSIF v_cat.deprecated AND NOT v_kept THEN
            v_reasons := v_reasons || public.automation_reason(v_mpath || '.name', format(
              '`%s` is deprecated. A schema may keep it but not add it.', v_mname));
            v_mname := NULL;
          ELSIF v_mname = ANY (v_mnames) THEN
            v_reasons := v_reasons || public.automation_reason(v_mpath || '.name', 'This metric is listed twice.');
            v_mname := NULL;
          ELSE
            v_mnames := v_mnames || v_mname;
          END IF;
        END IF;

        -- minimum and maximum: numbers, for a number metric only
        v_min := NULL;
        v_max := NULL;
        v_numeric := v_mname IS NOT NULL AND (
          public.schema_property_type(v_cat.datatype) = 'number'
          OR coalesce(v_head_def -> 'properties' -> v_mname ->> 'type', '') IN ('number', 'integer'));
        FOREACH v_key IN ARRAY ARRAY['minimum', 'maximum'] LOOP
          IF NOT (v_metric ? v_key) THEN CONTINUE; END IF;
          v_val := v_metric -> v_key;
          IF NOT public.schema_bound_is_number(v_val) THEN
            v_reasons := v_reasons || public.automation_reason(v_mpath || '.' || v_key, format(
              '`%s` is a number, in the metric''s catalogue unit. Leave it out for no bound.', v_key));
          ELSIF v_mname IS NOT NULL AND NOT v_numeric THEN
            v_reasons := v_reasons || public.automation_reason(v_mpath || '.' || v_key, format(
              '`%s` is for a number, and `%s` is not one. Remove it.', v_key, v_mname));
          ELSIF v_key = 'minimum' THEN
            v_min := v_val;
          ELSE
            v_max := v_val;
          END IF;
        END LOOP;
        IF v_min IS NOT NULL AND v_max IS NOT NULL AND (v_min #>> '{}')::numeric > (v_max #>> '{}')::numeric THEN
          v_reasons := v_reasons || public.automation_reason(v_mpath || '.minimum', 'The minimum is above the maximum.');
        END IF;

        -- semantic_id: the catalogue's own, so the same name cannot mean another thing here
        IF v_metric ? 'semantic_id' THEN
          v_val := v_metric -> 'semantic_id';
          IF v_mname IS NULL THEN
            NULL;
          ELSIF jsonb_typeof(v_val) <> 'string' THEN
            v_reasons := v_reasons || public.automation_reason(v_mpath || '.semantic_id',
              '`semantic_id` is text: the id the catalogue gives the metric.');
          ELSIF (v_val #>> '{}') IS DISTINCT FROM v_cat.semantic_id THEN
            v_reasons := v_reasons || public.automation_reason(v_mpath || '.semantic_id', format(
              'The catalogue gives `%s` the semantic id %s. Remove this line, or correct the metric on the Metrics page.',
              v_mname, coalesce('`' || v_cat.semantic_id || '`', 'none')));
          END IF;
        END IF;

        IF v_mname IS NOT NULL THEN
          v_rows := v_rows || jsonb_build_object(
            'name', v_mname, 'minimum', v_min, 'maximum', v_max, 'semantic_id', v_cat.semantic_id);
        END IF;
      END LOOP;
    END IF;

    -- derived_metrics: the derived metrics the schema's devices get, by name. Absent names none. Each is
    -- held to the metrics the file lists, whatever else is wrong with those; a state is held to the
    -- permitted values of the definition to be written, which apply_device_schemas() makes.
    IF v_item ? 'derived_metrics' THEN
      v_list := v_item -> 'derived_metrics';
      IF jsonb_typeof(v_list) <> 'array' THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.derived_metrics',
          '`derived_metrics` is the list of derived metrics the schema''s devices get, by name. Leave it out for none.');
      ELSIF jsonb_array_length(v_list) > c_max_metrics THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.derived_metrics',
          format('A schema names at most %s derived metrics.', c_max_metrics));
      ELSE
        FOR j IN 0 .. jsonb_array_length(v_list) - 1 LOOP
          v_val := v_list -> j;
          v_dpath := format('%s.derived_metrics[%s]', v_path, j);
          IF jsonb_typeof(v_val) <> 'string' THEN
            v_reasons := v_reasons || public.automation_reason(v_dpath,
              'A derived metric is named by its catalogue name, such as Controller/PARTS_PER_HOUR.');
            CONTINUE;
          END IF;
          v_dname := v_val #>> '{}';
          IF v_dname = ANY (v_dnames) THEN
            v_reasons := v_reasons || public.automation_reason(v_dpath, 'This derived metric is listed twice.');
            CONTINUE;
          END IF;
          v_dnames := v_dnames || v_dname;
          FOR v_problem IN
            SELECT p.problem FROM public.schema_derived_metric_problems(
              jsonb_build_object('required', to_jsonb(v_listed)), ARRAY[v_dname], v_kept_derived) p
          LOOP
            v_reasons := v_reasons || public.automation_reason(v_dpath, v_problem);
          END LOOP;
        END LOOP;
      END IF;
    END IF;

    -- Every element the template requires is filled by a metric the file lists, as trg_schemas_template
    -- asks when the version is written.
    IF v_template IS NOT NULL THEN
      FOR v_problem IN
        SELECT p.problem FROM public.schema_template_problems(v_template, v_template,
          public.schema_template_elements(v_template, jsonb_build_object('required', to_jsonb(v_listed)))) p
      LOOP
        v_reasons := v_reasons || public.automation_reason(v_path || '.template', v_problem);
      END LOOP;
    END IF;

    v_ok := jsonb_array_length(v_reasons) = 0;
    v_out := v_out || jsonb_build_object(
      'index', i, 'key', v_name, 'reasons', v_reasons,
      'canon', CASE WHEN v_ok THEN
                 jsonb_build_object('name', v_name, 'lineage', v_lineage, 'head', v_head_id,
                                    'description', v_desc,
                                    'semantic_id', v_sid, 'semantic_id_type', v_stype,
                                    'change_description', v_change, 'metrics', v_rows,
                                    'derived_metrics', to_jsonb(v_dnames), 'template', v_template)
               END);
  END LOOP;
  RETURN v_out;
END
$$;

ALTER FUNCTION public.device_schemas_parse(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.device_schemas_parse(jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.device_schemas_parse(jsonb) IS
  'Checks a document of device schemas and writes nothing: for each, {index, key, reasons, canon}. '
  'canon is the schema as it would be stored, typed and with each metric resolved to the catalogue, '
  'and null when there is any reason to refuse it; it carries the version in force it is compared '
  'with (head) and its lineage''s name (lineage), which a new version is named from. A schema is found '
  'by its lineage_name, and a name no lineage has by the lineage of a version whose name without a '
  'trailing _v<n> is it, as a file written before 0316 names one. Every reason is collected, each with '
  'a JSON path. Refuses a key it does not know, a metric the catalogue lacks, a derived metric among '
  '`metrics`, a deprecated one the schema does not already model, a range on a metric that is not a '
  'number, a metric semantic id the catalogue does not give, two schemas that find one lineage, and in '
  '`derived_metrics` a metric the catalogue lacks, a measured one, a deprecated one the version in force '
  'does not name and one with an input the file does not list, a `template` Aber does not hold, a '
  '`semantic_id` that is not the template''s, and a template that requires an element no metric the '
  'file lists fills. Called by apply_device_schemas() (0295, 0316, 0318, 0336, 0343).';

-- A person who holds schema:manage, as fork_schema() asks, and the second factor. A machine identity
-- may not: the table's insert policy admits a person in a role, and this writes as the owner. Every
-- field is checked before anything is written, and one refusal anywhere writes nothing. A schema is
-- found by its lineage's name; the version in force device_schemas_parse() found is compared with
-- what the document would make of it, and an unchanged one is left untouched. A changed one is a new
-- draft, named from its lineage, numbered and linked as fork_schema() does, and a published version
-- is never edited. Each INSERT is one row of the schemas table's audit trigger, so the Audit Trail has
-- one row for each schema written, naming the person.
CREATE OR REPLACE FUNCTION public.apply_device_schemas(p_doc jsonb, p_dry_run boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_parsed    jsonb;
  v_item      jsonb;
  v_canon     jsonb;
  v_new_doc   jsonb;
  v_old_doc   jsonb;
  v_head      public.schemas;
  v_draft     public.schemas;
  v_work      jsonb := '[]'::jsonb;
  v_out       jsonb := '[]'::jsonb;
  v_status    text;
  v_changes   jsonb;
  v_metrics   jsonb;
  v_reasons   jsonb;
  v_id        uuid;
  v_version   integer;
  v_name      text;
  v_suffix    integer;
  v_refused   boolean := false;
  v_def       jsonb;
  v_props     jsonb;
  v_names     text[];
  v_derived   jsonb;
BEGIN
  IF v_uid IS NULL OR public.is_machine_principal(v_uid) OR NOT public.has_authority(ARRAY['schema:manage']) THEN
    RAISE EXCEPTION 'Only an Administrator may apply device schemas.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.require_mfa();
  IF p_dry_run IS NULL THEN
    RAISE EXCEPTION 'p_dry_run is true to preview and false to apply.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_parsed := public.device_schemas_parse(p_doc);

  -- What each would be, without writing.
  FOR v_item IN SELECT x FROM jsonb_array_elements(v_parsed) x LOOP
    v_canon := v_item -> 'canon';
    v_id := NULL;
    v_version := NULL;
    v_name := NULL;
    v_changes := '[]'::jsonb;
    v_metrics := NULL;
    v_derived := NULL;
    v_reasons := v_item -> 'reasons';
    IF v_canon IS NULL OR jsonb_typeof(v_canon) = 'null' THEN
      v_status := 'refused';
      v_refused := true;
    ELSE
      -- Under its lineage's name, as device_schema_stored_document() renders the version in force.
      v_names := ARRAY(SELECT jsonb_array_elements_text(v_canon -> 'derived_metrics'));
      v_new_doc := public.device_schema_document_of(
        v_canon ->> 'lineage', v_canon ->> 'description', v_canon ->> 'semantic_id', v_canon ->> 'semantic_id_type',
        v_canon -> 'metrics') || public.device_schema_derived_part(v_names)
        || public.device_schema_template_part(v_canon ->> 'template');
      SELECT * INTO v_head FROM public.schemas s
       WHERE s.status = 'active' AND s.id = (v_canon ->> 'head')::uuid;
      IF NOT FOUND THEN
        v_status := 'new';
        v_version := 1;
        v_name := v_canon ->> 'name';
      ELSE
        v_id := v_head.id;
        v_version := v_head.version;
        v_name := v_head.schema_name;
        v_old_doc := public.device_schema_stored_document(v_head.id);
        SELECT * INTO v_draft FROM public.schemas d WHERE d.parent_schema_id = v_head.id AND d.status = 'draft';
        IF v_old_doc = v_new_doc THEN
          v_status := 'unchanged';
        ELSIF FOUND AND public.device_schema_stored_document(v_draft.id) = v_new_doc THEN
          -- What the file says is the draft a last upload made, so there is nothing to make.
          v_status := 'unchanged';
          v_id := v_draft.id;
          v_version := v_draft.version;
          v_name := v_draft.schema_name;
        ELSIF FOUND THEN
          v_status := 'refused';
          v_refused := true;
          v_reasons := jsonb_build_array(public.automation_reason(format('$[%s]', v_item -> 'index'), format(
            '`%s` has a draft already. Publish or discard it on the Schemas page, then upload again.', v_canon ->> 'lineage')));
        ELSE
          v_status := 'changed';
          -- The draft's number and name, as fork_schema() gives them: the lineage's name and the number,
          -- numbered further while that name is taken.
          v_version := v_head.version + 1;
          v_name := (v_canon ->> 'lineage') || '_v' || v_version;
          v_suffix := 1;
          WHILE EXISTS (SELECT 1 FROM public.schemas s WHERE s.schema_name = v_name) LOOP
            v_suffix := v_suffix + 1;
            v_name := (v_canon ->> 'lineage') || '_v' || v_version || '_' || v_suffix;
          END LOOP;
          SELECT coalesce(jsonb_agg(k ORDER BY k), '[]'::jsonb) INTO v_changes
            FROM (SELECT key AS k FROM jsonb_each(v_old_doc || v_new_doc)
                   WHERE v_old_doc -> key IS DISTINCT FROM v_new_doc -> key) c;
          SELECT jsonb_build_object(
                   'added', coalesce(jsonb_agg(n ORDER BY n) FILTER (WHERE kind = 'added'), '[]'::jsonb),
                   'removed', coalesce(jsonb_agg(n ORDER BY n) FILTER (WHERE kind = 'removed'), '[]'::jsonb),
                   'changed', coalesce(jsonb_agg(n ORDER BY n) FILTER (WHERE kind = 'changed'), '[]'::jsonb))
            INTO v_metrics
            FROM (SELECT coalesce(a ->> 'name', b ->> 'name') AS n,
                         CASE WHEN b IS NULL THEN 'added' WHEN a IS NULL THEN 'removed' ELSE 'changed' END AS kind
                    FROM jsonb_array_elements(v_new_doc -> 'metrics') a
                    FULL JOIN jsonb_array_elements(v_old_doc -> 'metrics') b ON a ->> 'name' = b ->> 'name'
                   WHERE a IS DISTINCT FROM b) d;
          SELECT jsonb_build_object(
                   'added', coalesce(jsonb_agg(n ORDER BY n COLLATE "C") FILTER (WHERE kind = 'added'), '[]'::jsonb),
                   'removed', coalesce(jsonb_agg(n ORDER BY n COLLATE "C") FILTER (WHERE kind = 'removed'), '[]'::jsonb))
            INTO v_derived
            FROM (SELECT coalesce(a.n, b.n) AS n, CASE WHEN b.n IS NULL THEN 'added' ELSE 'removed' END AS kind
                    FROM unnest(v_names) AS a(n)
                    FULL JOIN unnest(v_head.derived_metrics) AS b(n) ON a.n = b.n
                   WHERE a.n IS NULL OR b.n IS NULL) d;
        END IF;
      END IF;

      -- A state of a derived metric is held to the permitted values that would be written, so the
      -- preview says what trg_schemas_derived_metrics would. The rest was checked with the file.
      IF v_status IN ('new', 'changed') AND cardinality(v_names) > 0 THEN
        SELECT coalesce(jsonb_agg(public.automation_reason(
                 format('$[%s].derived_metrics[%s]', v_item -> 'index',
                        (SELECT e.ord - 1 FROM jsonb_array_elements_text(p_doc -> (v_item ->> 'index')::integer -> 'derived_metrics')
                                WITH ORDINALITY AS e(name, ord) WHERE e.name = p.metric_name LIMIT 1)),
                 p.problem) ORDER BY p.ord), '[]'::jsonb)
          INTO v_reasons
          FROM public.schema_derived_metric_problems(
                 jsonb_build_object('properties', public.device_schema_properties(
                   CASE WHEN v_status = 'changed' THEN v_head.schema_definition END, v_canon -> 'metrics')),
                 v_names, CASE WHEN v_status = 'changed' THEN v_head.derived_metrics ELSE ARRAY[]::text[] END)
               WITH ORDINALITY AS p(metric_name, problem, ord);
        IF jsonb_array_length(v_reasons) > 0 THEN
          v_status := 'refused';
          v_refused := true;
        END IF;
      END IF;
    END IF;
    v_work := v_work || jsonb_build_object(
      'index', v_item -> 'index', 'name', v_item -> 'key', 'status', v_status, 'id', v_id,
      'version', v_version, 'schema_name', v_name, 'changes', v_changes, 'metrics', v_metrics,
      'derived_metrics', v_derived,
      'reasons', v_reasons, 'canon', v_canon);
  END LOOP;

  IF NOT p_dry_run AND NOT v_refused THEN
    FOR v_item IN SELECT x FROM jsonb_array_elements(v_work) x LOOP
      v_status := v_item ->> 'status';
      IF v_status NOT IN ('new', 'changed') THEN CONTINUE; END IF;
      v_canon := v_item -> 'canon';
      v_head := NULL;
      IF v_status = 'changed' THEN
        -- The head is locked, so two uploads cannot both make the next version of it.
        SELECT * INTO v_head FROM public.schemas WHERE id = (v_item ->> 'id')::uuid FOR UPDATE;
      END IF;

      -- The definition: the metrics the document names, each from its catalogue row; for a changed
      -- schema, the stored definition with its metric list and entries brought up to date and
      -- nothing else, so what the document cannot say (a metric's pattern, a `required` list) stays.
      v_props := public.device_schema_properties(
        CASE WHEN v_status = 'changed' THEN v_head.schema_definition END, v_canon -> 'metrics');
      v_names := ARRAY(SELECT jsonb_array_elements_text(v_canon -> 'derived_metrics'));
      v_def := CASE WHEN v_status = 'changed' AND jsonb_typeof(v_head.schema_definition) = 'object'
                    THEN v_head.schema_definition ELSE jsonb_build_object('type', 'object') END
               || jsonb_build_object('properties', v_props);
      IF jsonb_typeof(v_def -> 'required') = 'array' THEN
        v_def := v_def || jsonb_build_object('required', coalesce((
          SELECT jsonb_agg(r) FROM jsonb_array_elements(v_def -> 'required') r WHERE v_props ? (r #>> '{}')), '[]'::jsonb));
      END IF;

      IF v_status = 'new' THEN
        -- Version 1 and in force, as the builder makes one: the columns' defaults say so.
        INSERT INTO public.schemas (schema_name, description, schema_definition, semantic_id, semantic_id_type,
                                    change_description, derived_metrics, template_id)
        VALUES (v_canon ->> 'name', nullif(v_canon ->> 'description', ''), v_def, v_canon ->> 'semantic_id',
                v_canon ->> 'semantic_id_type', coalesce(v_canon ->> 'change_description', 'Initial release'), v_names,
                v_canon ->> 'template')
        RETURNING id INTO v_id;
      ELSE
        -- The file's template, and none where it names none: template_elements given without a template
        -- is how trg_schemas_template is told not to take the parent's.
        INSERT INTO public.schemas (schema_name, description, schema_definition, semantic_id, semantic_id_type,
                                    version, parent_schema_id, status, change_description, derived_metrics,
                                    template_id, template_elements)
        VALUES (v_item ->> 'schema_name', nullif(v_canon ->> 'description', ''), v_def, v_canon ->> 'semantic_id',
                v_canon ->> 'semantic_id_type', (v_item ->> 'version')::integer, v_head.id, 'draft',
                v_canon ->> 'change_description', v_names,
                v_canon ->> 'template', CASE WHEN v_canon ->> 'template' IS NULL THEN '{}'::jsonb END)
        RETURNING id INTO v_id;
      END IF;
      -- The id of what was made, for the result.
      v_work := (SELECT jsonb_agg(CASE WHEN w -> 'index' = v_item -> 'index'
                                       THEN w || jsonb_build_object('id', v_id) ELSE w END ORDER BY ord)
                   FROM jsonb_array_elements(v_work) WITH ORDINALITY AS e(w, ord));
    END LOOP;
  END IF;

  SELECT coalesce(jsonb_agg(w - 'canon' ORDER BY ord), '[]'::jsonb) INTO v_out
    FROM jsonb_array_elements(v_work) WITH ORDINALITY AS e(w, ord);
  RETURN v_out;
END
$$;

ALTER FUNCTION public.apply_device_schemas(jsonb, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_device_schemas(jsonb, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.apply_device_schemas(jsonb, boolean) TO authenticated;

COMMENT ON FUNCTION public.apply_device_schemas(jsonb, boolean) IS
  'Checks a document of device schemas and applies it: a person who holds schema:manage, the '
  'Administrator (42501 otherwise, a machine identity too). Answers one result per schema, {index, '
  'name, status, id, version, schema_name, changes, metrics, derived_metrics, reasons}: status new '
  '(version 1, in force), changed (a new DRAFT version, named from its lineage and linked as '
  'fork_schema() does, with the metrics added, removed and changed and the derived metrics added and '
  'removed), unchanged or refused, and for a refusal reasons, each '
  '{path, message} with a JSON path such as $[0].metrics[1].minimum. All or nothing: with any refusal, '
  'or with p_dry_run true, nothing is written, so a preview and an apply are one call. Never deletes, '
  'never edits a published version, and refuses a changed schema whose lineage has a draft already. A '
  'schema is found by its lineage''s name, or, for a name no lineage has, by a version''s name '
  'without a trailing _v2. A changed schema is built from the template its file names, or from none. One '
  'INSERT is one Audit Trail row, by the schemas table''s own trigger (0295, 0316, 0318, 0336, 0343).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
-- Structure, and what the renderer says of two literals. Nothing is planted.
DO $check$
DECLARE
  v_fn  text;
  v_src text;
BEGIN
  -- The writer is still SECURITY DEFINER with a pinned path, asks for schema:manage, refuses a machine
  -- identity and asks for the second factor, and is for signed-in roles alone, as 0336 left it.
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'public.apply_device_schemas(jsonb, boolean)'::regprocedure
     AND p.prosecdef AND p.proconfig = ARRAY['search_path=public'];
  IF v_src IS NULL
     OR position('has_authority(ARRAY[''schema:manage''])' IN v_src) = 0
     OR position('public.is_machine_principal(v_uid)' IN v_src) = 0
     OR position('PERFORM public.require_mfa();' IN v_src) = 0 THEN
    RAISE EXCEPTION '0343: apply_device_schemas() is not SECURITY DEFINER and pinned, or does not ask for schema:manage, a person and the second factor';
  END IF;
  IF position('public.device_schema_template_part(v_canon ->> ''template'')' IN v_src) = 0 THEN
    RAISE EXCEPTION '0343: apply_device_schemas() does not compare the template';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.apply_device_schemas(jsonb, boolean)', 'public.device_schema_stored_document(uuid)',
                              'public.device_schema_template_part(text)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0343: % is not for signed-in roles alone', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.device_schemas_parse(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.device_schemas_parse(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '0343: a browser-facing role may execute device_schemas_parse()';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('public.device_schema_stored_document(uuid)'::regprocedure, 'public.device_schemas_parse(jsonb)'::regprocedure,
                              'public.device_schema_template_part(text)'::regprocedure)
                AND (p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public'])) THEN
    RAISE EXCEPTION '0343: a reader of device schemas documents is SECURITY DEFINER or has no pinned search_path';
  END IF;
  IF position('public.device_schema_template_part(s.template_id)' IN
              (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.device_schema_stored_document(uuid)'::regprocedure)) = 0
     OR position('''template'', ''change_description''' IN
                 (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.device_schemas_parse(jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0343: the stored document or the parser does not know `template`';
  END IF;
  IF public.device_schema_template_part('https://example.com/T') <> '{"template": "https://example.com/T"}'::jsonb
     OR public.device_schema_template_part(NULL) <> '{}'::jsonb
     OR public.device_schema_template_part('') <> '{}'::jsonb THEN
    RAISE EXCEPTION '0343: device_schema_template_part() does not write the document''s key';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
