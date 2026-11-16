-- 0295: A document of device schemas is checked and applied in one call.
--
-- A device schema could be built in the schema builder and downloaded as JSON, and nothing read a
-- file back: moving one to another site meant building it again by hand, and two versions could not
-- be compared. The Schemas page now exports and uploads schemas as YAML, as the Automations page
-- does for automations. The browser parses a person's YAML into JSON and hands it to one function,
-- and the database is the authority: it checks every field, resolves every metric against the
-- catalogue and checks the caller's right. The browser's JSON Schema is a convenience that a guard
-- test holds to it.
--
--   * apply_device_schemas(p_doc, p_dry_run) answers one result per schema: its name, its status
--     (new, changed, unchanged or refused) and, for a refusal, reasons that each carry a JSON path
--     the editor maps back to a line, such as $[0].metrics[1].minimum. All or nothing: with any
--     refusal, or with p_dry_run true, it writes nothing, so the upload preview is the same call.
--     It never deletes: a schema the document leaves out is left alone.
--   * A schema is found by its name, across sites: the lineage whose names, with a trailing _v2,
--     _v3 and so on taken off, are this one, as fork_schema() names a version. Its version in force
--     is what the document is compared with. A schema no lineage has is made as version 1, in force,
--     as the builder makes one. A changed one becomes a new DRAFT version, named, numbered and
--     linked to its parent as fork_schema() does, carrying the document's metrics, ranges, semantic
--     id and change description. Publishing stays a step of its own, and a published version is
--     never edited. An unchanged schema writes nothing.
--   * What a document says about a schema is its name, description, semantic id and type, and each
--     metric by catalogue name with its minimum and maximum. The definition is built from the
--     catalogue exactly as the builders build it (schema_property_entry(), held to the builders'
--     contract fixture by the suite), and a changed schema keeps whatever of its stored definition
--     a document cannot say, as a draft's Save Draft does.
--   * A metric the catalogue lacks is refused by name, and so is a derived one: nothing publishes a
--     derived metric, so a schema cannot model it. A deprecated metric is refused unless the schema
--     already models it. A metric's semantic id in the file must be the catalogue's.
--   * device_schemas_document() renders the schemas in force back to the document's shape.
--     apply_device_schemas() of that document reports every schema unchanged.
--   * One writer, with fork_schema()'s gate: the schema:manage permission, which only the
--     Administrator holds, and the second factor (require_mfa()). A machine identity is refused as
--     the table's insert policy refuses one. The Audit Trail row of a schema written is the
--     schemas table's own trigger's: one INSERT row for each schema made, naming the person.
--
-- Reasoning: supabase/README.md, "A document of device schemas is checked and applied in one call
-- (0295)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. A metric's entry in a schema, as the builders write it
-- -------------------------------------------------------------------------------------------------
-- The JSON type a Sparkplug datatype travels as: frontend/src/utils/sparkplugDatatype.js's
-- datatypeToJsonSchemaType().
CREATE OR REPLACE FUNCTION public.schema_property_type(p_datatype integer) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE WHEN p_datatype = 11 THEN 'boolean'
              WHEN p_datatype IN (12, 14, 15) THEN 'string'
              ELSE 'number' END;
$$;

ALTER FUNCTION public.schema_property_type(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.schema_property_type(integer) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.schema_property_type(integer) IS
  'The JSON Schema type a Sparkplug datatype travels as in a schema''s properties: boolean for 11, '
  'string for 12, 14 and 15, number for any other (0295).';

-- A metric's permitted values (text, as the column keeps them) as an `enum` of the property's own
-- type, or NULL where there is no closed set to write: schemaProperty.js's enumFor(). A value the
-- type cannot carry is left out, repeats are removed, and the first of each stays first.
CREATE OR REPLACE FUNCTION public.schema_property_enum(p_values text[], p_type text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_agg(t.v ORDER BY t.first_at)
    FROM (
      SELECT typed.v, min(typed.at) AS first_at
        FROM (
          SELECT u.at,
                 CASE
                   WHEN p_type = 'string' THEN to_jsonb(u.raw)
                   WHEN p_type = 'boolean' AND lower(btrim(u.raw)) IN ('true', 'false')
                     THEN to_jsonb(lower(btrim(u.raw)) = 'true')
                   -- A nested CASE, so the cast is only reached by text that is a number.
                   WHEN p_type IN ('number', 'integer')
                        AND btrim(u.raw) ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$'
                     THEN CASE WHEN abs(btrim(u.raw)::numeric) <= 1.7976931348623157e308::numeric
                                    AND (p_type = 'number' OR btrim(u.raw)::numeric = trunc(btrim(u.raw)::numeric))
                               THEN to_jsonb(trim_scale(btrim(u.raw)::numeric)) END
                 END AS v
            FROM unnest(p_values) WITH ORDINALITY AS u(raw, at)) typed
       WHERE typed.v IS NOT NULL
       GROUP BY typed.v) t;
$$;

ALTER FUNCTION public.schema_property_enum(text[], text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.schema_property_enum(text[], text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.schema_property_enum(text[], text) IS
  'A metric''s permitted values as the `enum` its schema property carries, typed as the property is: '
  'strings as they are, true and false as booleans, whole numbers (or any number, for a number) as '
  'numbers. NULL when no value fits. The same rule as schemaProperty.js''s enumFor() (0295).';

-- Whether a value is a JSON number a double can hold, so a bound is one a reading can be compared with.
CREATE OR REPLACE FUNCTION public.schema_bound_is_number(p_value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(jsonb_typeof(p_value) = 'number'
                  AND abs((p_value #>> '{}')::numeric) <= 1.7976931348623157e308::numeric, false);
$$;

ALTER FUNCTION public.schema_bound_is_number(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.schema_bound_is_number(jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.schema_bound_is_number(jsonb) IS
  'True for a JSON number within the range of a double, the only kind of value a schema''s minimum '
  'or maximum may be (0295).';

-- One metric's `properties` entry, from its catalogue row: schemaProperty.js's catalogPropertyEntry().
-- `p_stored` is the entry a saved definition holds, or NULL for a metric being added. The type, the
-- description and the permitted values are always the catalogue's as they are now, absent when it has
-- none; every other stored key stays. A numeric property takes the range given, a missing bound
-- removing the stored one.
CREATE OR REPLACE FUNCTION public.schema_property_entry(p_stored jsonb, p_datatype integer, p_description text,
                                                        p_permitted text[], p_minimum jsonb, p_maximum jsonb)
RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_entry jsonb := CASE WHEN jsonb_typeof(p_stored) = 'object' THEN p_stored
                        ELSE jsonb_build_object('type', public.schema_property_type(p_datatype)) END;
  v_type  text := CASE WHEN jsonb_typeof(v_entry -> 'type') = 'string' THEN v_entry ->> 'type'
                       ELSE public.schema_property_type(p_datatype) END;
  v_desc  text := nullif(regexp_replace(coalesce(p_description, ''), '^\s+|\s+$', '', 'g'), '');
  v_enum  jsonb := public.schema_property_enum(p_permitted, v_type);
BEGIN
  v_entry := CASE WHEN v_desc IS NULL THEN v_entry - 'description'
                  ELSE v_entry || jsonb_build_object('description', v_desc) END;
  v_entry := CASE WHEN v_enum IS NULL THEN v_entry - 'enum'
                  ELSE v_entry || jsonb_build_object('enum', v_enum) END;
  IF v_type IN ('number', 'integer') THEN
    v_entry := CASE WHEN p_minimum IS NULL OR jsonb_typeof(p_minimum) = 'null' THEN v_entry - 'minimum'
                    ELSE v_entry || jsonb_build_object('minimum', p_minimum) END;
    v_entry := CASE WHEN p_maximum IS NULL OR jsonb_typeof(p_maximum) = 'null' THEN v_entry - 'maximum'
                    ELSE v_entry || jsonb_build_object('maximum', p_maximum) END;
  END IF;
  RETURN v_entry;
END
$$;

ALTER FUNCTION public.schema_property_entry(jsonb, integer, text, text[], jsonb, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.schema_property_entry(jsonb, integer, text, text[], jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.schema_property_entry(jsonb, integer, text, text[], jsonb, jsonb) IS
  'A metric''s entry in a schema''s properties from its catalogue row, as both schema builders write '
  'it: the type, the catalogue''s description and permitted values as `enum`, and for a number the '
  'minimum and maximum given. Every other key of a stored entry stays. The suite holds it to '
  'test-harness/fixtures/schema-builder-output.json, which the dashboard''s builders are held to '
  '(0295).';

-- -------------------------------------------------------------------------------------------------
-- 2. A schema in the document's shape
-- -------------------------------------------------------------------------------------------------
-- One renderer for the stored schema and for a document that has been checked, so "unchanged" is a
-- comparison of two renderings of one shape. Empty or absent values are left out, and the metrics are
-- in name order: a schema's `properties` is a jsonb object, which keeps no order. A metric's semantic
-- id is the catalogue's, so it is the same on both sides.
CREATE OR REPLACE FUNCTION public.device_schema_document_of(p_name text, p_description text, p_semantic_id text,
                                                           p_semantic_id_type text, p_metrics jsonb)
RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'name', p_name,
    'description', nullif(regexp_replace(coalesce(p_description, ''), '^\s+|\s+$', '', 'g'), ''),
    'semantic_id', nullif(p_semantic_id, ''),
    'semantic_id_type', CASE WHEN nullif(p_semantic_id, '') IS NULL THEN NULL ELSE p_semantic_id_type END,
    'metrics', coalesce((
      SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'name', m ->> 'name',
               'minimum', CASE WHEN jsonb_typeof(m -> 'minimum') = 'number' THEN m -> 'minimum' END,
               'maximum', CASE WHEN jsonb_typeof(m -> 'maximum') = 'number' THEN m -> 'maximum' END,
               'semantic_id', nullif(m ->> 'semantic_id', '')))
             ORDER BY (m ->> 'name') COLLATE "C")
        FROM jsonb_array_elements(coalesce(p_metrics, '[]'::jsonb)) m), '[]'::jsonb)));
$$;

ALTER FUNCTION public.device_schema_document_of(text, text, text, text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.device_schema_document_of(text, text, text, text, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.device_schema_document_of(text, text, text, text, jsonb) TO authenticated;

COMMENT ON FUNCTION public.device_schema_document_of(text, text, text, text, jsonb) IS
  'A schema in the document''s shape: name, description, semantic_id, semantic_id_type and metrics, '
  'each metric its name, minimum, maximum and the catalogue''s semantic_id, in name order, with empty '
  'values left out. p_metrics is a list of {name, minimum, maximum, semantic_id}. Used for a stored '
  'schema and for a checked document alike, so "unchanged" compares two renderings of one shape (0295).';

-- A stored schema in the document's shape: its lineage's name, and its definition's properties
-- (a metric whose entry is not an object has no range). SECURITY INVOKER: the tables' own policies
-- decide what the caller reads.
CREATE OR REPLACE FUNCTION public.device_schema_stored_document(p_schema_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT public.device_schema_document_of(
    public.schema_version_base_name(s.schema_name), s.description, s.semantic_id, s.semantic_id_type,
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
  'The stored schema in the document''s shape, named by its lineage (the name without a trailing _v2, '
  '_v3 and so on). SECURITY INVOKER: the tables'' own policies decide what the caller sees (0295).';

-- -------------------------------------------------------------------------------------------------
-- 3. Checking a document
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
      IF v_seen ? v_stem THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.name', format(
          '`%s` is already the name of the schema at %s. Give each schema its own name.', v_stem, v_seen ->> v_stem));
      ELSE
        v_seen := v_seen || jsonb_build_object(v_stem, v_path);
      END IF;

      -- Found by its name across the lineage's versions: the one in force is what this is compared with.
      SELECT count(*)::integer INTO v_heads FROM public.schemas s
       WHERE s.status = 'active' AND public.schema_version_base_name(s.schema_name) = v_stem;
      SELECT EXISTS (SELECT 1 FROM public.schemas s WHERE public.schema_version_base_name(s.schema_name) = v_stem)
        INTO v_known;
      IF v_heads > 1 THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.name', format(
          'More than one schema here is called `%s`, so Aber cannot tell which the file means.', v_stem));
      ELSIF v_heads = 1 THEN
        SELECT s.schema_definition INTO v_head_def FROM public.schemas s
         WHERE s.status = 'active' AND public.schema_version_base_name(s.schema_name) = v_stem;
      ELSIF v_known THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.name', format(
          '`%s` has no version in force. Publish its draft on the Schemas page first.', v_stem));
      ELSIF v_name <> v_stem THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.name', format(
          '`%s` ends in a version, which Aber adds itself when it versions a schema. Name the schema `%s`.', v_name, v_stem));
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
                 jsonb_build_object('name', v_name, 'stem', v_stem, 'description', v_desc,
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
  'and null when there is any reason to refuse it. Every reason is collected, each with a JSON path. '
  'Refuses a key it does not know, a metric the catalogue lacks, a derived metric, a deprecated one '
  'the schema does not already model, a range on a metric that is not a number and a metric semantic '
  'id the catalogue does not give. Called by apply_device_schemas() (0295).';

-- -------------------------------------------------------------------------------------------------
-- 4. Applying a document
-- -------------------------------------------------------------------------------------------------
-- A person who holds schema:manage, as fork_schema() asks, and the second factor. A machine identity
-- may not: the table's insert policy admits a person in a role, and this writes as the owner. Every
-- field is checked before anything is written, and one refusal anywhere writes nothing. A schema is
-- found by its name; the version in force is compared with what the document would make of it, and
-- an unchanged one is left untouched. A changed one is a new draft, named, numbered and linked as
-- fork_schema() does, and a published version is never edited. Each INSERT is one row of the
-- schemas table's audit trigger, so the Audit Trail has one row for each schema written, naming the
-- person.
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
      v_new_doc := public.device_schema_document_of(
        v_canon ->> 'stem', v_canon ->> 'description', v_canon ->> 'semantic_id', v_canon ->> 'semantic_id_type',
        v_canon -> 'metrics');
      SELECT * INTO v_head FROM public.schemas s
       WHERE s.status = 'active' AND public.schema_version_base_name(s.schema_name) = v_canon ->> 'stem';
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
            '`%s` has a draft already. Publish or discard it on the Schemas page, then upload again.', v_canon ->> 'stem')));
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
  'schema is found by its name, without a trailing _v2. One INSERT is one Audit Trail row, by the '
  'schemas table''s own trigger (0295).';

-- -------------------------------------------------------------------------------------------------
-- 5. Reading them back
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
    SELECT DISTINCT public.schema_version_base_name(s.schema_name) AS stem
      FROM public.schemas s
     WHERE p_ids IS NULL OR s.id = ANY (p_ids)
  ), docs AS (
    SELECT public.device_schema_stored_document(s.id) AS doc
      FROM public.schemas s
      JOIN picked p ON p.stem = public.schema_version_base_name(s.schema_name)
     WHERE s.status = 'active'
  )
  SELECT coalesce(jsonb_agg(doc ORDER BY (doc ->> 'name') COLLATE "C"), '[]'::jsonb) FROM docs;
$$;

ALTER FUNCTION public.device_schemas_document(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.device_schemas_document(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.device_schemas_document(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.device_schemas_document(uuid[]) IS
  'The schemas in force in the document''s shape, a list ordered by name: every one, or those of the '
  'lineages the schema ids given belong to, whichever of their versions an id is. A draft is not '
  'exported. apply_device_schemas() of the list reports every schema unchanged (0295).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn  text;
  v_src text;
  v_out jsonb;
BEGIN
  -- The writer is SECURITY DEFINER with a pinned path, asks for the permission fork_schema() asks for
  -- and then for the second factor, and is for signed-in roles alone.
  v_fn := 'public.apply_device_schemas(jsonb, boolean)';
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = v_fn::regprocedure AND p.prosecdef AND p.proconfig = ARRAY['search_path=public'];
  IF v_src IS NULL THEN
    RAISE EXCEPTION '0295: % is not SECURITY DEFINER with search_path pinned to public', v_fn;
  END IF;
  IF position('has_authority(ARRAY[''schema:manage''])' IN v_src) = 0 THEN
    RAISE EXCEPTION '0295: % does not ask for schema:manage', v_fn;
  END IF;
  IF position('PERFORM public.require_mfa();' IN v_src) = 0 THEN
    RAISE EXCEPTION '0295: % does not ask for the second factor', v_fn;
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.apply_device_schemas(jsonb, boolean)', 'public.device_schemas_document(uuid[])'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0295: % is not for signed-in roles alone', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.device_schemas_parse(jsonb)', 'public.schema_property_entry(jsonb, integer, text, text[], jsonb, jsonb)',
                              'public.schema_property_enum(text[], text)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0295: a browser-facing role may execute %', v_fn;
    END IF;
  END LOOP;

  -- The checker answers a refusal with a path, and an empty list with nothing to refuse.
  v_out := public.device_schemas_parse('{}'::jsonb);
  IF v_out -> 0 -> 'reasons' -> 0 ->> 'path' <> '$' THEN
    RAISE EXCEPTION '0295: device_schemas_parse() does not refuse a document that is not a list';
  END IF;
  v_out := public.device_schemas_parse('[{"mode": "single"}]'::jsonb);
  IF v_out -> 0 -> 'reasons' -> 0 ->> 'path' <> '$[0].mode' OR v_out -> 0 -> 'canon' <> 'null'::jsonb THEN
    RAISE EXCEPTION '0295: device_schemas_parse() does not refuse a key it does not know';
  END IF;
  IF public.device_schemas_parse('[]'::jsonb) <> '[]'::jsonb THEN
    RAISE EXCEPTION '0295: device_schemas_parse() finds something in an empty list';
  END IF;

  -- The entry a metric gets is what the builders write: the type, the catalogue's words, and a number's range.
  IF public.schema_property_entry(NULL, 10, ' Spindle load ', ARRAY['1', '1.0', 'x'], '0'::jsonb, '150'::jsonb)
       <> '{"type": "number", "description": "Spindle load", "enum": [1], "minimum": 0, "maximum": 150}'::jsonb
     OR public.schema_property_entry(NULL, 12, NULL, ARRAY['READY', 'ACTIVE'], '0'::jsonb, NULL)
       <> '{"type": "string", "enum": ["READY", "ACTIVE"]}'::jsonb
     OR public.schema_property_entry(NULL, 11, '', ARRAY['true', 'maybe'], NULL, NULL)
       <> '{"type": "boolean", "enum": [true]}'::jsonb
     OR public.schema_property_entry('{"type": "number", "pattern": "x", "minimum": 5}'::jsonb, 10, NULL, NULL, NULL, '9'::jsonb)
       <> '{"type": "number", "pattern": "x", "maximum": 9}'::jsonb THEN
    RAISE EXCEPTION '0295: schema_property_entry() does not write the entry the builders write';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
