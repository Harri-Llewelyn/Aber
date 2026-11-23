-- 0316: A document of device schemas names a schema by its lineage.
--
-- A document named a schema by the name of its version in force with one trailing _v<n> taken off
-- (schema_version_base_name()). That holds while a lineage's versions are X, X_v2, X_v3. A version
-- whose name was taken is numbered further, X_v2_2, and keeps its tail, so a lineage whose version in
-- force had that name exported under X_v2_2, and another site that has X did not find it. Every
-- version carries its lineage's name since 0298 (lineage_name, the first version's name), and the
-- document now names a schema by it.
--
--   * device_schema_stored_document() writes lineage_name.
--   * device_schemas_parse() finds a schema by lineage_name. A name no lineage has is found as before,
--     by a version's name with one trailing _v<n> taken off, so a file written before this one still
--     applies as it did. Where the two rules could find different lineages, lineage_name wins. Two
--     schemas of one file that find one lineage are one name used twice. The checked schema carries
--     the version in force it found, its lineage's name, and the stem a new version is named from.
--   * apply_device_schemas() compares and versions the version in force that device_schemas_parse()
--     found, and renders the file's schema under its lineage's name. A new draft is named from the
--     version in force as fork_schema() names one from its parent, as before.
--   * device_schemas_document() picks the lineages of the ids given by lineage_root_id, so the id of
--     any version exports its lineage's version in force, whatever the versions are named.
--
-- Each body is 0295's with only these changes. Grants, SECURITY mode, search_path, require_mfa() and
-- every other arm are 0295's.
--
-- Reasoning: supabase/README.md, "A document of device schemas names a schema by its lineage (0316)".
-- Idempotent.
--
-- Redefines public.device_schema_stored_document: 0316 names the schema by its lineage_name; 0295
--   named it by its version's name with one trailing _v<n> taken off, which keeps an X_v2_2's tail
-- Redefines public.device_schemas_parse: 0316 finds a schema by its lineage_name first, and by a
--   version's name without a trailing _v<n> only where no lineage has the name, as a file written
--   before 0316 names one; the checked schema carries the version in force it found
-- Redefines public.apply_device_schemas: 0316 compares and versions the version in force
--   device_schemas_parse() found and renders the file's schema under its lineage's name, so a
--   lineage whose version in force is named X_v2_2 is found by X
-- Redefines public.device_schemas_document: 0316 picks a lineage by lineage_root_id; 0295 picked it
--   by the stem of a version's name, which an X_v2_2 version does not share with its lineage

-- -------------------------------------------------------------------------------------------------
-- 1. A stored schema in the document's shape
-- -------------------------------------------------------------------------------------------------
-- A stored schema in the document's shape: its lineage's name, which every version carries, and its
-- definition's properties (a metric whose entry is not an object has no range). SECURITY INVOKER:
-- the tables' own policies decide what the caller reads.
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
    FROM public.schemas s
   WHERE s.id = p_schema_id;
$$;

ALTER FUNCTION public.device_schema_stored_document(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.device_schema_stored_document(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.device_schema_stored_document(uuid) TO authenticated;

COMMENT ON FUNCTION public.device_schema_stored_document(uuid) IS
  'The stored schema in the document''s shape, named by its lineage (lineage_name, the name of the '
  'lineage''s first version, which every version carries). SECURITY INVOKER: the tables'' own '
  'policies decide what the caller sees (0295, 0316).';

-- -------------------------------------------------------------------------------------------------
-- 2. Checking a document
-- -------------------------------------------------------------------------------------------------
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

    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      v_out := v_out || jsonb_build_object('index', i, 'key', NULL, 'canon', NULL, 'reasons', jsonb_build_array(
        public.automation_reason(v_path, 'A schema is a set of keys: name and metrics at least.')));
      CONTINUE;
    END IF;

    -- A key nothing here means is refused, never ignored.
    FOR v_key IN SELECT jsonb_object_keys(v_item) LOOP
      IF NOT v_key = ANY (ARRAY['name', 'description', 'semantic_id', 'semantic_id_type', 'change_description', 'metrics']) THEN
        v_reasons := v_reasons || public.automation_reason(public.automation_path(v_path, v_key), format(
          '`%s` is not a key a schema takes. Remove it. The keys are name, description, semantic_id, semantic_id_type, change_description and metrics.', v_key));
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
      -- version's name with one trailing _v<n> taken off.
      v_by_lineage := EXISTS (SELECT 1 FROM public.schemas s WHERE s.lineage_name = v_name);
      v_lineage := CASE WHEN v_by_lineage THEN v_name ELSE v_stem END;
      SELECT (count(*) FILTER (WHERE s.status = 'active'))::integer, count(*) > 0 INTO v_heads, v_known
        FROM public.schemas s
       WHERE CASE WHEN v_by_lineage THEN s.lineage_name = v_name
                  ELSE public.schema_version_base_name(s.schema_name) = public.schema_version_base_name(v_name) END;
      IF v_heads > 1 THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.name', format(
          'More than one schema here is called `%s`, so Aber cannot tell which the file means.', v_lineage));
      ELSIF v_heads = 1 THEN
        -- A new version is named from the stem of the one in force, as fork_schema() names one from its parent.
        SELECT s.id, s.lineage_name, public.schema_version_base_name(s.schema_name), s.schema_definition
          INTO v_head_id, v_lineage, v_stem, v_head_def
          FROM public.schemas s
         WHERE s.status = 'active'
           AND CASE WHEN v_by_lineage THEN s.lineage_name = v_name
                    ELSE public.schema_version_base_name(s.schema_name) = public.schema_version_base_name(v_name) END;
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
          SELECT * INTO v_cat FROM public.metric_catalog m WHERE m.name = v_mname;
          v_found := FOUND;
          v_kept := coalesce(jsonb_typeof(v_head_def -> 'properties') = 'object' AND (v_head_def -> 'properties') ? v_mname, false);
          IF NOT v_found THEN
            v_reasons := v_reasons || public.automation_reason(v_mpath || '.name', format(
              '`%s` is not in the metric catalogue. Register it on the Metrics page first.', v_mname));
            v_mname := NULL;
          ELSIF v_cat.derivation IS NOT NULL THEN
            v_reasons := v_reasons || public.automation_reason(v_mpath || '.name', format(
              '`%s` is a derived metric. Nothing publishes one, so a schema cannot model it.', v_mname));
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

    v_ok := jsonb_array_length(v_reasons) = 0;
    v_out := v_out || jsonb_build_object(
      'index', i, 'key', v_name, 'reasons', v_reasons,
      'canon', CASE WHEN v_ok THEN
                 jsonb_build_object('name', v_name, 'stem', v_stem, 'lineage', v_lineage, 'head', v_head_id,
                                    'description', v_desc,
                                    'semantic_id', v_sid, 'semantic_id_type', v_stype,
                                    'change_description', v_change, 'metrics', v_rows)
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
  'with (head), its lineage''s name (lineage) and the stem a new version is named from (stem). A '
  'schema is found by its lineage_name, and a name no lineage has by a version''s name without a '
  'trailing _v<n>, as a file written before 0316 names one. Every reason is collected, each with a '
  'JSON path. Refuses a key it does not know, a metric the catalogue lacks, a derived metric, a '
  'deprecated one the schema does not already model, a range on a metric that is not a number, a '
  'metric semantic id the catalogue does not give and two schemas that find one lineage. Called by '
  'apply_device_schemas() (0295, 0316).';

-- -------------------------------------------------------------------------------------------------
-- 3. Applying a document
-- -------------------------------------------------------------------------------------------------
-- A person who holds schema:manage, as fork_schema() asks, and the second factor. A machine identity
-- may not: the table's insert policy admits a person in a role, and this writes as the owner. Every
-- field is checked before anything is written, and one refusal anywhere writes nothing. A schema is
-- found by its lineage's name; the version in force device_schemas_parse() found is compared with
-- what the document would make of it, and an unchanged one is left untouched. A changed one is a new
-- draft, named, numbered and linked as fork_schema() does, and a published version is never edited.
-- Each INSERT is one row of the schemas table's audit trigger, so the Audit Trail has one row for
-- each schema written, naming the person.
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
    v_reasons := v_item -> 'reasons';
    IF v_canon IS NULL OR jsonb_typeof(v_canon) = 'null' THEN
      v_status := 'refused';
      v_refused := true;
    ELSE
      -- Under its lineage's name, as device_schema_stored_document() renders the version in force.
      v_new_doc := public.device_schema_document_of(
        v_canon ->> 'lineage', v_canon ->> 'description', v_canon ->> 'semantic_id', v_canon ->> 'semantic_id_type',
        v_canon -> 'metrics');
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
          -- The draft's number and name, as fork_schema() gives them: a discarded draft leaves its name behind.
          v_version := v_head.version + 1;
          v_name := (v_canon ->> 'stem') || '_v' || v_version;
          v_suffix := 1;
          WHILE EXISTS (SELECT 1 FROM public.schemas s WHERE s.schema_name = v_name) LOOP
            v_suffix := v_suffix + 1;
            v_name := (v_canon ->> 'stem') || '_v' || v_version || '_' || v_suffix;
          END LOOP;
          SELECT coalesce(jsonb_agg(k ORDER BY k), '[]'::jsonb) INTO v_changes
            FROM (SELECT key AS k FROM jsonb_each(v_new_doc)
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
        END IF;
      END IF;
    END IF;
    v_work := v_work || jsonb_build_object(
      'index', v_item -> 'index', 'name', v_item -> 'key', 'status', v_status, 'id', v_id,
      'version', v_version, 'schema_name', v_name, 'changes', v_changes, 'metrics', v_metrics,
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
      SELECT jsonb_object_agg(m ->> 'name', public.schema_property_entry(
               CASE WHEN v_status = 'changed' AND jsonb_typeof(v_head.schema_definition -> 'properties') = 'object'
                    THEN v_head.schema_definition -> 'properties' -> (m ->> 'name') END,
               c.datatype, c.description, c.permitted_values, m -> 'minimum', m -> 'maximum'))
        INTO v_props
        FROM jsonb_array_elements(v_canon -> 'metrics') m
        JOIN public.metric_catalog c ON c.name = m ->> 'name';
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
                                    change_description)
        VALUES (v_canon ->> 'name', nullif(v_canon ->> 'description', ''), v_def, v_canon ->> 'semantic_id',
                v_canon ->> 'semantic_id_type', coalesce(v_canon ->> 'change_description', 'Initial release'))
        RETURNING id INTO v_id;
      ELSE
        INSERT INTO public.schemas (schema_name, description, schema_definition, semantic_id, semantic_id_type,
                                    version, parent_schema_id, status, change_description)
        VALUES (v_item ->> 'schema_name', nullif(v_canon ->> 'description', ''), v_def, v_canon ->> 'semantic_id',
                v_canon ->> 'semantic_id_type', (v_item ->> 'version')::integer, v_head.id, 'draft',
                v_canon ->> 'change_description')
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
  'name, status, id, version, schema_name, changes, metrics, reasons}: status new (version 1, in '
  'force), changed (a new DRAFT version, named and linked as fork_schema() does, with the '
  'metrics added, removed and changed), unchanged or refused, and for a refusal reasons, each {path, '
  'message} with a JSON path such as $[0].metrics[1].minimum. All or nothing: with any refusal, or '
  'with p_dry_run true, nothing is written, so a preview and an apply are one call. Never deletes, '
  'never edits a published version, and refuses a changed schema whose lineage has a draft already. A '
  'schema is found by its lineage''s name, or, for a name no lineage has, by a version''s name '
  'without a trailing _v2. One INSERT is one Audit Trail row, by the schemas table''s own trigger '
  '(0295, 0316).';

-- -------------------------------------------------------------------------------------------------
-- 4. Reading them back
-- -------------------------------------------------------------------------------------------------
-- The schemas in force in the document's shape, a list: every one, or those of the lineages the ids
-- given belong to, whichever version each id is, ordered by name. A draft is not exported, and nor
-- is a version a newer one replaced: a document says a schema as it is in force. SECURITY INVOKER:
-- every signed-in role reads schemas and the catalogue.
CREATE OR REPLACE FUNCTION public.device_schemas_document(p_ids uuid[] DEFAULT NULL::uuid[]) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  WITH picked AS (
    SELECT DISTINCT s.lineage_root_id
      FROM public.schemas s
     WHERE p_ids IS NULL OR s.id = ANY (p_ids)
  ), docs AS (
    SELECT public.device_schema_stored_document(s.id) AS doc
      FROM public.schemas s
      JOIN picked p ON p.lineage_root_id = s.lineage_root_id
     WHERE s.status = 'active'
  )
  SELECT coalesce(jsonb_agg(doc ORDER BY (doc ->> 'name') COLLATE "C"), '[]'::jsonb) FROM docs;
$$;

ALTER FUNCTION public.device_schemas_document(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.device_schemas_document(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.device_schemas_document(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.device_schemas_document(uuid[]) IS
  'The schemas in force in the document''s shape, a list ordered by name: every one, or those of the '
  'lineages the schema ids given belong to (lineage_root_id), whichever of their versions an id is. '
  'Each is named by its lineage. A draft is not exported. apply_device_schemas() of the list reports '
  'every schema unchanged (0295, 0316).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  c_root  CONSTANT uuid := '00000000-0000-4000-8000-000000031601';
  c_head  CONSTANT uuid := '00000000-0000-4000-8000-000000031602';
  v_fn    text;
  v_src   text;
  v_out   jsonb;
BEGIN
  -- The writer is still SECURITY DEFINER with a pinned path, asks for the permission fork_schema()
  -- asks for and then for the second factor, and is for signed-in roles alone, as 0295 made it.
  v_fn := 'public.apply_device_schemas(jsonb, boolean)';
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = v_fn::regprocedure AND p.prosecdef AND p.proconfig = ARRAY['search_path=public'];
  IF v_src IS NULL THEN
    RAISE EXCEPTION '0316: % is not SECURITY DEFINER with search_path pinned to public', v_fn;
  END IF;
  IF position('has_authority(ARRAY[''schema:manage''])' IN v_src) = 0
     OR position('public.is_machine_principal(v_uid)' IN v_src) = 0 THEN
    RAISE EXCEPTION '0316: % does not ask for schema:manage, or admits a machine identity', v_fn;
  END IF;
  IF position('PERFORM public.require_mfa();' IN v_src) = 0 THEN
    RAISE EXCEPTION '0316: % does not ask for the second factor', v_fn;
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.apply_device_schemas(jsonb, boolean)', 'public.device_schemas_document(uuid[])',
                              'public.device_schema_stored_document(uuid)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0316: % is not for signed-in roles alone', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.device_schemas_parse(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.device_schemas_parse(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '0316: a browser-facing role may execute device_schemas_parse()';
  END IF;
  -- The three readers run as their caller, so the tables' own policies decide what each reads.
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('public.device_schemas_parse(jsonb)'::regprocedure,
                              'public.device_schemas_document(uuid[])'::regprocedure,
                              'public.device_schema_stored_document(uuid)'::regprocedure)
                AND (p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public'])) THEN
    RAISE EXCEPTION '0316: a reader of device schemas documents is SECURITY DEFINER or has no pinned search_path';
  END IF;

  -- A lineage whose version in force was numbered further, X_v2_2, on rows a subtransaction takes
  -- back: it is exported under X, found by X and by the name a file written before 0316 gave it, and
  -- the two are one schema.
  BEGIN
    INSERT INTO public.schemas (id, schema_name, schema_definition, status)
    VALUES (c_root, 'Aber_0316_Self_Check', '{"type": "object", "properties": {}}'::jsonb, 'archived');
    INSERT INTO public.schemas (id, schema_name, schema_definition, status, version, parent_schema_id)
    VALUES (c_head, 'Aber_0316_Self_Check_v2_2', '{"type": "object", "properties": {}}'::jsonb, 'active', 2, c_root);

    IF public.device_schema_stored_document(c_head) ->> 'name' IS DISTINCT FROM 'Aber_0316_Self_Check' THEN
      RAISE EXCEPTION '0316: device_schema_stored_document() does not name a version X_v2_2 by its lineage X';
    END IF;
    v_out := public.device_schemas_document(ARRAY[c_root]);
    IF jsonb_array_length(v_out) <> 1 OR v_out -> 0 ->> 'name' IS DISTINCT FROM 'Aber_0316_Self_Check' THEN
      RAISE EXCEPTION '0316: device_schemas_document() of an archived version does not export its lineage''s version in force';
    END IF;
    v_out := public.device_schemas_parse(
      '[{"name": "Aber_0316_Self_Check", "metrics": []}, {"name": "Aber_0316_Self_Check_v2_2", "metrics": []}]'::jsonb);
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_out -> 0 -> 'reasons') r WHERE r ->> 'path' = '$[0].name') THEN
      RAISE EXCEPTION '0316: device_schemas_parse() does not find a lineage whose version in force is X_v2_2 by X';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_out -> 1 -> 'reasons') r
                    WHERE r ->> 'path' = '$[1].name' AND r ->> 'message' LIKE '%already the name of the schema at $[0]%') THEN
      RAISE EXCEPTION '0316: device_schemas_parse() does not find X''s lineage by the name X_v2_2 a file written before 0316 gave it';
    END IF;
    RAISE EXCEPTION 'the self-check rolls back' USING ERRCODE = 'AB316';
  EXCEPTION WHEN SQLSTATE 'AB316' THEN
    NULL;
  END;
END
$check$;

NOTIFY pgrst, 'reload schema';
