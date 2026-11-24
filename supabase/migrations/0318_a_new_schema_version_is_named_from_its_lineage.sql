-- 0318: A new schema version is named from its lineage.
--
-- fork_schema() named a version from its parent's name with one trailing _v<n> taken off
-- (schema_version_base_name()), and apply_device_schemas() named a draft the same way. A name that was
-- taken is numbered further, X_v2_2, and does not end in _v<n>, so the version after it was X_v2_2_v3
-- and every later one kept the tail. Every version carries its lineage's name since 0298
-- (lineage_name, the first version's name), and a new version is now named from it: <lineage_name>_v<n>,
-- numbered further only while that name is taken. After X_v2_2 comes X_v3. No row is renamed, and the
-- number is the one both functions computed before.
--
--   * fork_schema() names the draft from the parent's lineage_name.
--   * apply_device_schemas() names it from the lineage's name the checked schema carries.
--   * device_schemas_parse() finds a name no lineage has, as in a file written before 0316, through the
--     lineage of the version that has it. It looked for a version in force with that name, which
--     the version after X_v2_2 no longer has. The checked schema no longer carries the stem a new
--     version was named from, which nothing reads.
--
-- Each body is its latest (0165, 0316) with only these changes and the comments beside them. Grants,
-- SECURITY mode, search_path, require_mfa() and every other arm are as they were. The writer comes
-- before the parser, so a call between the two statements never reads a stem the parser no longer gives.
--
-- Reasoning: supabase/README.md, "A new schema version is named from its lineage (0318)".
-- Idempotent.
--
-- Redefines public.fork_schema: 0318 names the draft from its lineage_name; 0165 named it from the
--   parent's name with one trailing _v<n> taken off, which keeps an X_v2_2's tail
-- Redefines public.apply_device_schemas: 0318 names a draft from its lineage's name, as fork_schema()
--   does; 0316 named it from the stem of the version in force
-- Redefines public.device_schemas_parse: 0318 finds a name no lineage has through the lineage of the
--   version that has it, since the version in force need not share it, and gives no stem, which no
--   version is named from any more

-- -------------------------------------------------------------------------------------------------
-- 1. Versioning a schema
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fork_schema(parent_schema_id uuid, change_description text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  -- Copied out of the parameters immediately: both are named after columns of `schemas`, and
  -- plpgsql would raise "column reference is ambiguous" on the first `WHERE id = parent_schema_id`.
  v_parent_id  UUID := parent_schema_id;
  v_change     TEXT := NULLIF(btrim(COALESCE(change_description, '')), '');
  parent       public.schemas%ROWTYPE;
  child        public.schemas%ROWTYPE;
  v_base       TEXT;
  v_next       INTEGER;
  v_name       TEXT;
  v_suffix     INTEGER := 1;
BEGIN
  -- Fail closed, before anything else observable happens. `has_authority` rather than a role name,
  -- so the gate is the permission 0069 withdrew.
  IF NOT public.has_authority(ARRAY['schema:manage']) THEN
    RAISE EXCEPTION 'insufficient privileges to version a schema'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.require_mfa();

  IF v_parent_id IS NULL THEN
    RAISE EXCEPTION 'parent_schema_id is required' USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- FOR UPDATE, not a bare SELECT: two operators forking the same schema at the same moment would
  -- otherwise both read version N and both insert N+1. The partial unique index catches the
  -- collision either way, but the lock turns a confusing constraint violation into a wait.
  SELECT * INTO parent FROM public.schemas WHERE id = v_parent_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('schema %s not found', v_parent_id));
  END IF;

  -- Only the head of a lineage may be forked. Forking an archived version would produce a second
  -- claimant to the same version number, and forking a draft would branch something that has never
  -- been in force -- edit the draft instead, which is what a draft is for.
  IF parent.status <> 'active' THEN
    RAISE EXCEPTION 'only an active schema can be versioned; "%" is %', parent.schema_name, parent.status
      USING ERRCODE = 'check_violation',
            HINT = 'Fork the active version of this lineage.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.schemas s
              WHERE s.parent_schema_id = v_parent_id AND s.status = 'draft') THEN
    RAISE EXCEPTION 'a draft version of "%" already exists; publish or delete it first', parent.schema_name
      USING ERRCODE = 'unique_violation';
  END IF;

  v_next := parent.version + 1;
  -- The lineage's name, the same from every version: the parent's own may be numbered further, X_v2_2.
  v_base := parent.lineage_name;
  v_name := v_base || '_v' || v_next;

  -- Another schema can already have the obvious name. Suffixing beats failing: the operator asked
  -- for a version, not for a naming negotiation.
  WHILE EXISTS (SELECT 1 FROM public.schemas s WHERE s.schema_name = v_name) LOOP
    v_suffix := v_suffix + 1;
    v_name := v_base || '_v' || v_next || '_' || v_suffix;
  END LOOP;

  -- The metric links are the definition: a schema's membership of the catalog lives in
  -- `schema_definition.properties` / `.required`, which deviceTags.js and validate.py both read.
  INSERT INTO public.schemas (
    schema_name, description, schema_definition,
    semantic_id, semantic_id_type,
    version, parent_schema_id, status, change_description
  ) VALUES (
    v_name, parent.description, parent.schema_definition,
    parent.semantic_id, parent.semantic_id_type,
    v_next, parent.id, 'draft', v_change
  )
  RETURNING * INTO child;

  RETURN to_jsonb(child);
END;
$$;

ALTER FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) FROM PUBLIC, anon;

COMMENT ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) IS
  'Derives the next draft version of an active schema, copying its definition. The version number is '
  'computed, never supplied. The draft is named from its lineage, <lineage_name>_v<version>, and '
  'numbered further (_2, _3) while that name is taken (0318).';

-- -------------------------------------------------------------------------------------------------
-- 2. Applying a document
-- -------------------------------------------------------------------------------------------------
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
  'force), changed (a new DRAFT version, named from its lineage and linked as fork_schema() does, with '
  'the metrics added, removed and changed), unchanged or refused, and for a refusal reasons, each '
  '{path, message} with a JSON path such as $[0].metrics[1].minimum. All or nothing: with any refusal, '
  'or with p_dry_run true, nothing is written, so a preview and an apply are one call. Never deletes, '
  'never edits a published version, and refuses a changed schema whose lineage has a draft already. A '
  'schema is found by its lineage''s name, or, for a name no lineage has, by a version''s name '
  'without a trailing _v2. One INSERT is one Audit Trail row, by the schemas table''s own trigger '
  '(0295, 0316, 0318).';

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
                 jsonb_build_object('name', v_name, 'lineage', v_lineage, 'head', v_head_id,
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
  'with (head) and its lineage''s name (lineage), which a new version is named from. A schema is found '
  'by its lineage_name, and a name no lineage has by the lineage of a version whose name without a '
  'trailing _v<n> is it, as a file written before 0316 names one. Every reason is collected, each with '
  'a JSON path. Refuses a key it does not know, a metric the catalogue lacks, a derived metric, a '
  'deprecated one the schema does not already model, a range on a metric that is not a number, a '
  'metric semantic id the catalogue does not give and two schemas that find one lineage. Called by '
  'apply_device_schemas() (0295, 0316, 0318).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  c_person CONSTANT uuid := '00000000-0000-4000-8000-000000031800';
  c_root   CONSTANT uuid := '00000000-0000-4000-8000-000000031801';
  c_head   CONSTANT uuid := '00000000-0000-4000-8000-000000031802';
  c_name   CONSTANT text := 'Aber_0318_Self_Check';
  v_fn     text;
  v_src    text;
  v_said   text;
  v_made   jsonb;
  v_out    jsonb;
BEGIN
  -- Both writers are still SECURITY DEFINER with a pinned path, ask for schema:manage and then for the
  -- second factor, and are closed to anon; only the document's refuses a machine identity.
  FOREACH v_fn IN ARRAY ARRAY['public.fork_schema(uuid, text)', 'public.apply_device_schemas(jsonb, boolean)'] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p
     WHERE p.oid = v_fn::regprocedure AND p.prosecdef AND p.proconfig = ARRAY['search_path=public'];
    IF v_src IS NULL THEN
      RAISE EXCEPTION '0318: % is not SECURITY DEFINER with search_path pinned to public', v_fn;
    END IF;
    IF position('has_authority(ARRAY[''schema:manage''])' IN v_src) = 0
       OR position('PERFORM public.require_mfa();' IN v_src) = 0 THEN
      RAISE EXCEPTION '0318: % does not ask for schema:manage and the second factor', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0318: % is open to anon, or closed to signed-in roles', v_fn;
    END IF;
  END LOOP;
  IF position('public.is_machine_principal(v_uid)' IN v_src) = 0
     OR has_function_privilege('service_role', 'public.apply_device_schemas(jsonb, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '0318: apply_device_schemas() admits a machine identity or the service role';
  END IF;
  IF has_function_privilege('anon', 'public.device_schemas_parse(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.device_schemas_parse(jsonb)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p
                 WHERE p.oid = 'public.device_schemas_parse(jsonb)'::regprocedure
                   AND (p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public'])) THEN
    RAISE EXCEPTION '0318: device_schemas_parse() is a browser-facing role''s, SECURITY DEFINER or not pinned';
  END IF;

  -- A lineage X whose version in force was numbered further, X_v2_2, on rows a subtransaction takes
  -- back, with the Administrator who versions it: a document and fork_schema() both name the next
  -- version X_v3, and with X_v3 in force a file that names X_v2_2 still finds the lineage.
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (c_person, 'aber-0318-self-check@example.invalid');
    INSERT INTO public.user_roles (user_id, role_id)
    SELECT c_person, r.id FROM public.roles r WHERE r.name = 'Administrator';
    INSERT INTO public.metric_catalog (name, datatype) VALUES ('Aber_0318/Self_Check', 10);
    INSERT INTO public.schemas (id, schema_name, schema_definition, status)
    VALUES (c_root, c_name, '{"type": "object", "properties": {}}'::jsonb, 'archived');
    INSERT INTO public.schemas (id, schema_name, schema_definition, status, version, parent_schema_id)
    VALUES (c_head, c_name || '_v2_2', '{"type": "object", "properties": {}}'::jsonb, 'active', 2, c_root);
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', c_person, 'role', 'authenticated', 'aal', 'aal2')::text, true);

    v_said := public.apply_device_schemas(jsonb_build_array(jsonb_build_object(
      'name', c_name, 'metrics', '[{"name": "Aber_0318/Self_Check"}]'::jsonb)), true) -> 0 ->> 'schema_name';
    v_made := public.fork_schema(c_head, 'self-check');
    IF v_said IS DISTINCT FROM c_name || '_v3' OR v_made ->> 'schema_name' IS DISTINCT FROM c_name || '_v3' THEN
      RAISE EXCEPTION '0318: the version after X_v2_2 is named % by a document and % by fork_schema(), not X_v3',
        v_said, v_made ->> 'schema_name';
    END IF;

    UPDATE public.schemas SET status = 'archived' WHERE id = c_head;
    UPDATE public.schemas SET status = 'active' WHERE id = (v_made ->> 'id')::uuid;
    v_out := public.device_schemas_parse(jsonb_build_array(jsonb_build_object('name', c_name || '_v2_2', 'metrics', '[]'::jsonb)));
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_out -> 0 -> 'reasons') r WHERE r ->> 'path' = '$[0].name') THEN
      RAISE EXCEPTION '0318: with X_v3 in force, a file written before 0316 no longer finds its lineage by the name X_v2_2';
    END IF;
    RAISE EXCEPTION 'the self-check rolls back' USING ERRCODE = 'AB318';
  EXCEPTION WHEN SQLSTATE 'AB318' THEN
    NULL;
  END;
END
$check$;

NOTIFY pgrst, 'reload schema';
