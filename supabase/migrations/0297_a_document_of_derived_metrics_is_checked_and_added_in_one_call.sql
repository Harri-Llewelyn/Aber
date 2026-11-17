-- 0297: A document of derived metrics is checked and added in one call.
--
-- A derived metric (0267) was added one at a time in Add Derived Metric, so a site's derived metrics
-- could not be read as one list, reviewed, or taken to another site, and its description could not be
-- changed at all. The Metrics page's Derived tab now exports them as YAML and takes an upload, through
-- the editor and the preview the Automations and Schemas pages use. The browser parses a person's YAML into JSON and hands it to one function.
-- The database is the authority: it checks every field, resolves every input against the catalogue,
-- and saves each row through the table's own checks. The browser's JSON Schema is a convenience that a
-- guard test holds to it.
--
--   * apply_derived_metrics(p_doc, p_dry_run) answers one result per derived metric: its name, its
--     status (new, changed, unchanged or refused), what it changes (the document keys that differ, as
--     apply_automations() gives them, with their values before and after) and, for a refusal, reasons
--     that each carry a JSON path the editor maps back to a line, such as $[0].inputs[1].metric. All or
--     nothing: with any refusal, or with p_dry_run true, it writes nothing, so the upload preview is
--     the same call. It never deletes.
--   * A definition is fixed once saved (0267), so a description is the one thing an upload changes. A
--     name the catalogue lacks is a new derived metric. A name it has with the same definition and
--     description is unchanged, whatever the order of the states or the inputs of a sum. A name it has
--     with the same definition and another description is changed: the file says what is saved, so a
--     file that leaves the description out clears it, and the preview shows the description before and
--     after. A name it has with another definition is refused and says what to do. So is a name a
--     measured metric holds, and a deprecated derived metric's.
--   * What a file says is the name, the description and the definition: kind, input, states, or the
--     inputs of a sum. It never says the unit or the datatype: the table's trigger works out the
--     unit from the inputs and a derived metric is a Double.
--   * An input the catalogue lacks is refused by name, and so is a derived one, every one of them in
--     the one pass. A deprecated input is accepted, as the table accepts it. Every other refusal is
--     enforce_derived_metric()'s own: each row is saved in a subtransaction that is undone, so the
--     preview and the apply run the very checks Add Derived Metric's insert runs, and the unit a row
--     would get is the trigger's.
--   * derived_metrics_document() renders the derived metrics back to the document's shape, in name
--     order, leaving out the deprecated. apply_derived_metrics() of that document reports every
--     metric unchanged.
--   * One writer, with the catalogue's own gate: an Administrator, and the second factor
--     (require_mfa()), as metric_catalog_insert_privileged and metric_catalog_update_privileged ask. A
--     machine identity holds no role. The Audit Trail row of a metric added or changed is the
--     catalogue's own trigger's: one INSERT or one UPDATE for each, naming the person. No audit action,
--     class or domain is added.
--
-- Reasoning: supabase/README.md, "A document of derived metrics is checked and added in one call
-- (0297)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. What two definitions or two descriptions say, compared
-- -------------------------------------------------------------------------------------------------
-- A definition with its states and the inputs of a sum in name order, so two that differ only in
-- the order a person listed them compare equal: the value is the same.
CREATE OR REPLACE FUNCTION public.derivation_canonical(p_derivation jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE p_derivation ->> 'kind'
    WHEN 'time_in_state' THEN jsonb_set(p_derivation, '{states}', coalesce((
      SELECT jsonb_agg(s ORDER BY s #>> '{}' COLLATE "C")
        FROM jsonb_array_elements(p_derivation -> 'states') s), '[]'::jsonb))
    WHEN 'sum' THEN jsonb_set(p_derivation, '{inputs}', coalesce((
      SELECT jsonb_agg(i ORDER BY i ->> 'metric' COLLATE "C")
        FROM jsonb_array_elements(p_derivation -> 'inputs') i), '[]'::jsonb))
    ELSE p_derivation
  END;
$$;

ALTER FUNCTION public.derivation_canonical(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.derivation_canonical(jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.derivation_canonical(jsonb) IS
  'A derived metric''s definition with its states, or the inputs of a sum, in name order: two '
  'definitions that differ only in the order a person listed them are the same one (0297).';

-- A description as a file says it: no space at either end, and nothing where it is empty.
CREATE OR REPLACE FUNCTION public.derived_metric_description(p_description text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT nullif(regexp_replace(coalesce(p_description, ''), '^\s+|\s+$', '', 'g'), '');
$$;

ALTER FUNCTION public.derived_metric_description(text) OWNER TO postgres;
-- Called by derived_metric_document_of(), which derived_metrics_document() runs as the signed-in caller.
REVOKE ALL ON FUNCTION public.derived_metric_description(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.derived_metric_description(text) TO authenticated;

COMMENT ON FUNCTION public.derived_metric_description(text) IS
  'A derived metric''s description as a document says it: trimmed, and NULL where empty (0297).';

-- One derived metric in the document's shape: the definition's keys sit beside the name and the
-- description, which is left out where empty. The stored row and a checked document both go through
-- this, so "unchanged" and an export agree on the shape.
CREATE OR REPLACE FUNCTION public.derived_metric_document_of(p_name text, p_description text, p_derivation jsonb)
RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'name', p_name,
    'description', public.derived_metric_description(p_description),
    'kind', p_derivation -> 'kind',
    'input', p_derivation -> 'input',
    'states', p_derivation -> 'states',
    'inputs', p_derivation -> 'inputs'));
$$;

ALTER FUNCTION public.derived_metric_document_of(text, text, jsonb) OWNER TO postgres;
-- Called by derived_metrics_document(), which runs as the signed-in caller.
REVOKE ALL ON FUNCTION public.derived_metric_document_of(text, text, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.derived_metric_document_of(text, text, jsonb) TO authenticated;

COMMENT ON FUNCTION public.derived_metric_document_of(text, text, jsonb) IS
  'A derived metric in the document''s shape: name, description (left out where empty), kind and the '
  'definition''s own keys: input, states or inputs (0297).';

-- -------------------------------------------------------------------------------------------------
-- 2. Checking a document
-- -------------------------------------------------------------------------------------------------
-- Reads the catalogue and writes nothing. A file is bounded: 1,000 derived metrics. For each, in
-- order: {index, key, verdict, reasons, id, units, changes, before, after, canon}. The verdict is new,
-- changed, unchanged or refused. A changed metric has the same definition and another description:
-- `changes` names the keys that differ and `before` and `after` their values, empty for the rest.
-- `canon` is the metric as it would be saved (name, description, definition), and null with a
-- refusal. It is checked field by field and every reason is collected, so a person fixes a file in
-- one pass. The reasons are the shape automations_parse() gives (automation_reason() and
-- automation_path() are the shared helpers). What only the table's own checks know (an input of the
-- wrong datatype, a state it cannot report, units that differ, a name a device declares) is
-- apply_derived_metrics()'s, which runs them.
CREATE OR REPLACE FUNCTION public.derived_metrics_parse(p_doc jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  c_max_metrics CONSTANT integer := 1000;
  c_max_inputs  CONSTANT integer := 8;
  c_name        CONSTANT text    := '^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$';
  v_out        jsonb := '[]'::jsonb;
  v_seen       jsonb := '{}'::jsonb;
  v_file_names text[];
  v_item       jsonb;
  v_path       text;
  v_reasons    jsonb;
  v_key        text;
  v_val        jsonb;
  v_list       jsonb;
  v_entry      jsonb;
  v_part       jsonb;
  v_epath      text;
  v_name       text;
  v_desc       text;
  v_desc_ok    boolean;
  v_kind       text;
  v_def        jsonb;
  v_states     jsonb;
  v_inputs     jsonb;
  v_before     integer;
  v_in_names   text[];
  v_in_paths   text[];
  v_problem    text;
  v_found      boolean;
  v_changed    boolean;
  v_verdict    text;
  v_have       public.metric_catalog;
  v_cat        public.metric_catalog;
BEGIN
  IF jsonb_typeof(p_doc) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_array(jsonb_build_object('index', NULL, 'key', NULL, 'verdict', 'refused', 'canon', NULL,
      'reasons', jsonb_build_array(public.automation_reason('$',
        'A file holds a list of derived metrics. Start each one with `- name:`.'))));
  END IF;
  IF jsonb_array_length(p_doc) > c_max_metrics THEN
    RETURN jsonb_build_array(jsonb_build_object('index', NULL, 'key', NULL, 'verdict', 'refused', 'canon', NULL,
      'reasons', jsonb_build_array(public.automation_reason('$',
        format('A file holds at most %s derived metrics. Split it.', c_max_metrics)))));
  END IF;

  -- The names the file itself gives, so an input that is another metric of the file says so.
  v_file_names := ARRAY(SELECT x ->> 'name' FROM jsonb_array_elements(p_doc) x WHERE jsonb_typeof(x) = 'object');

  FOR i IN 0 .. jsonb_array_length(p_doc) - 1 LOOP
    v_item := p_doc -> i;
    v_path := format('$[%s]', i);
    v_reasons := '[]'::jsonb;
    v_name := NULL;
    v_desc := NULL;
    v_desc_ok := true;
    v_kind := NULL;
    v_def := NULL;
    v_in_names := ARRAY[]::text[];
    v_in_paths := ARRAY[]::text[];

    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      v_out := v_out || jsonb_build_object('index', i, 'key', NULL, 'verdict', 'refused', 'canon', NULL,
        'reasons', jsonb_build_array(public.automation_reason(v_path,
          'A derived metric is a set of keys: name and kind at least.')));
      CONTINUE;
    END IF;

    -- A key nothing here means is refused, never ignored.
    FOR v_key IN SELECT jsonb_object_keys(v_item) LOOP
      IF NOT v_key = ANY (ARRAY['name', 'description', 'kind', 'input', 'states', 'inputs']) THEN
        v_reasons := v_reasons || public.automation_reason(public.automation_path(v_path, v_key),
          CASE WHEN v_key IN ('unit', 'units', 'datatype')
            THEN format('`%s` is worked out from the inputs, so a file does not give it. Remove it.', v_key)
            ELSE format('`%s` is not a key a derived metric takes. Remove it. The keys are name, description, kind, input, states and inputs.', v_key)
          END);
      END IF;
    END LOOP;

    -- name: the catalogue's, which is fixed once saved
    v_val := v_item -> 'name';
    IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') !~ c_name THEN
      v_reasons := v_reasons || public.automation_reason(v_path || '.name',
        '`name` is the derived metric''s name, such as Controller/PARTS_PER_HOUR: letters, digits and underscores, with `/` between the parts.');
    ELSE
      v_name := v_val #>> '{}';
      IF v_seen ? v_name THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.name', format(
          '`%s` is already the name of the derived metric at %s. Give each its own name.', v_name, v_seen ->> v_name));
      ELSE
        v_seen := v_seen || jsonb_build_object(v_name, v_path);
      END IF;
    END IF;

    -- description
    IF v_item ? 'description' THEN
      v_val := v_item -> 'description';
      IF jsonb_typeof(v_val) <> 'string' OR char_length(v_val #>> '{}') > 4000 THEN
        v_desc_ok := false;
        v_reasons := v_reasons || public.automation_reason(v_path || '.description',
          '`description` is text of at most 4,000 characters.');
      ELSE
        v_desc := public.derived_metric_description(v_val #>> '{}');
      END IF;
    END IF;

    -- kind, and the keys that kind takes
    v_val := v_item -> 'kind';
    IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string'
       OR NOT (v_val #>> '{}') = ANY (ARRAY['counter_rate', 'time_in_state', 'sum']) THEN
      v_reasons := v_reasons || public.automation_reason(v_path || '.kind',
        '`kind` is counter_rate, time_in_state or sum.');
    ELSE
      v_kind := v_val #>> '{}';
      v_before := jsonb_array_length(v_reasons);

      FOREACH v_key IN ARRAY ARRAY['input', 'states', 'inputs'] LOOP
        IF v_item ? v_key AND NOT v_key = ANY (CASE v_kind
             WHEN 'counter_rate' THEN ARRAY['input']
             WHEN 'time_in_state' THEN ARRAY['input', 'states']
             ELSE ARRAY['inputs'] END) THEN
          v_reasons := v_reasons || public.automation_reason(public.automation_path(v_path, v_key),
            format('`%s` is not a key of a %s. Remove it.', v_key, v_kind));
        END IF;
      END LOOP;

      IF v_kind IN ('counter_rate', 'time_in_state') THEN
        v_val := v_item -> 'input';
        IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') !~ c_name THEN
          v_reasons := v_reasons || public.automation_reason(v_path || '.input',
            '`input` is the catalogue name of the metric the value is computed from, such as Controller/PART_COUNT.');
        ELSE
          v_in_names := v_in_names || (v_val #>> '{}');
          v_in_paths := v_in_paths || (v_path || '.input');
        END IF;

        IF v_kind = 'time_in_state' THEN
          v_list := v_item -> 'states';
          IF v_list IS NULL OR jsonb_typeof(v_list) <> 'array' OR jsonb_array_length(v_list) = 0 THEN
            v_reasons := v_reasons || public.automation_reason(v_path || '.states',
              '`states` is the list of values that count as being in the state: at least one, such as [ACTIVE].');
          ELSE
            v_states := '[]'::jsonb;
            FOR j IN 0 .. jsonb_array_length(v_list) - 1 LOOP
              v_entry := v_list -> j;
              v_epath := format('%s.states[%s]', v_path, j);
              IF jsonb_typeof(v_entry) <> 'string' OR (v_entry #>> '{}') = '' THEN
                v_reasons := v_reasons || public.automation_reason(v_epath,
                  'A state is text and not empty. Put a value such as "true" in quotes.');
              ELSIF v_states @> jsonb_build_array(v_entry) THEN
                v_reasons := v_reasons || public.automation_reason(v_epath, 'This state is listed twice.');
              ELSE
                v_states := v_states || v_entry;
              END IF;
            END LOOP;
          END IF;
        END IF;
      ELSE
        v_list := v_item -> 'inputs';
        IF v_list IS NULL OR jsonb_typeof(v_list) <> 'array'
           OR jsonb_array_length(v_list) NOT BETWEEN 2 AND c_max_inputs THEN
          v_reasons := v_reasons || public.automation_reason(v_path || '.inputs', format(
            '`inputs` is the metrics a sum adds or takes away: two to %s, each with a `metric` and a `sign` of 1 or -1.', c_max_inputs));
        ELSE
          v_inputs := '[]'::jsonb;
          FOR j IN 0 .. jsonb_array_length(v_list) - 1 LOOP
            v_entry := v_list -> j;
            v_epath := format('%s.inputs[%s]', v_path, j);
            IF jsonb_typeof(v_entry) <> 'object' THEN
              v_reasons := v_reasons || public.automation_reason(v_epath,
                'An input is a set of keys: metric and sign.');
              CONTINUE;
            END IF;
            FOR v_key IN SELECT jsonb_object_keys(v_entry) LOOP
              IF NOT v_key = ANY (ARRAY['metric', 'sign']) THEN
                v_reasons := v_reasons || public.automation_reason(public.automation_path(v_epath, v_key), format(
                  '`%s` is not a key an input takes. Remove it. The keys are metric and sign.', v_key));
              END IF;
            END LOOP;
            v_part := v_entry -> 'metric';
            IF v_part IS NULL OR jsonb_typeof(v_part) <> 'string' OR (v_part #>> '{}') !~ c_name THEN
              v_reasons := v_reasons || public.automation_reason(v_epath || '.metric',
                '`metric` is the catalogue name of an input, such as Power/PHASE_A.');
            ELSIF (v_part #>> '{}') = ANY (v_in_names) THEN
              v_reasons := v_reasons || public.automation_reason(v_epath || '.metric', 'This metric is an input twice.');
            ELSE
              v_in_names := v_in_names || (v_part #>> '{}');
              v_in_paths := v_in_paths || (v_epath || '.metric');
            END IF;
            v_val := v_entry -> 'sign';
            IF v_val IS NULL OR jsonb_typeof(v_val) <> 'number' OR (v_val #>> '{}')::numeric NOT IN (1, -1) THEN
              v_reasons := v_reasons || public.automation_reason(v_epath || '.sign',
                '`sign` is 1 to add the input and -1 to take it away.');
            ELSE
              v_inputs := v_inputs || jsonb_build_object('metric', v_part #>> '{}', 'sign', (v_val #>> '{}')::numeric::integer);
            END IF;
          END LOOP;
        END IF;
      END IF;

      -- The definition as it would be saved, once every key of it reads.
      IF jsonb_array_length(v_reasons) = v_before THEN
        v_def := CASE v_kind
          WHEN 'counter_rate' THEN jsonb_build_object('kind', v_kind, 'input', v_item -> 'input')
          WHEN 'time_in_state' THEN jsonb_build_object('kind', v_kind, 'input', v_item -> 'input', 'states', v_states)
          ELSE jsonb_build_object('kind', v_kind, 'inputs', v_inputs)
        END;
        v_problem := public.derivation_shape_problem(v_def);
        IF v_problem IS NOT NULL THEN
          v_reasons := v_reasons || public.automation_reason(v_path,
            format('The definition is malformed: %s.', v_problem));
          v_def := NULL;
        END IF;
      END IF;
    END IF;

    -- The name against the catalogue: a name it has keeps its definition, so it is unchanged, changed
    -- in its description, or refused.
    v_found := false;
    v_changed := false;
    v_have := NULL;
    IF v_name IS NOT NULL THEN
      SELECT * INTO v_have FROM public.metric_catalog m WHERE m.name = v_name;
      v_found := FOUND;
    END IF;
    IF v_found THEN
      IF v_have.derivation IS NULL THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.name', format(
          '`%s` is a measured metric, and a derived metric cannot take its name: its history would mix two sources. Choose another name.', v_name));
      ELSIF v_have.deprecated THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.name', format(
          '`%s` is deprecated here. Restore it on the Metrics page, or give this one a new name.', v_name));
      ELSIF v_def IS NOT NULL
            AND public.derivation_canonical(v_have.derivation) IS DISTINCT FROM public.derivation_canonical(v_def) THEN
        v_reasons := v_reasons || public.automation_reason(v_path || '.name', format(
          '`%s` already exists with another definition, and a definition is fixed once saved. Add this one under a new name, then deprecate `%s`, choosing the new one as Superseded By.', v_name, v_name));
      ELSIF v_def IS NOT NULL AND v_desc_ok
            AND public.derived_metric_description(v_have.description) IS DISTINCT FROM v_desc THEN
        -- The definition is the same, so the description is all there is to change.
        v_changed := true;
      END IF;
    ELSIF v_def IS NOT NULL THEN
      -- A new metric: every input is a measured metric the catalogue holds.
      FOR k IN 1 .. coalesce(cardinality(v_in_names), 0) LOOP
        SELECT * INTO v_cat FROM public.metric_catalog m WHERE m.name = v_in_names[k];
        IF NOT FOUND THEN
          v_reasons := v_reasons || public.automation_reason(v_in_paths[k], CASE WHEN v_in_names[k] = ANY (v_file_names)
            THEN format('%s is itself a derived metric. A derived metric cannot be built on another.', v_in_names[k])
            ELSE format('%s is not in the catalogue. Add it before building a derived metric on it.', v_in_names[k]) END);
        ELSIF v_cat.derivation IS NOT NULL THEN
          v_reasons := v_reasons || public.automation_reason(v_in_paths[k],
            format('%s is itself a derived metric. A derived metric cannot be built on another.', v_in_names[k]));
        END IF;
      END LOOP;
    END IF;

    v_verdict := CASE WHEN jsonb_array_length(v_reasons) > 0 THEN 'refused'
                      WHEN v_changed THEN 'changed'
                      WHEN v_found THEN 'unchanged' ELSE 'new' END;
    v_out := v_out || jsonb_build_object(
      'index', i, 'key', v_name, 'verdict', v_verdict, 'reasons', v_reasons,
      'id', CASE WHEN v_verdict IN ('unchanged', 'changed') THEN v_have.id END,
      'units', CASE WHEN v_verdict IN ('unchanged', 'changed') THEN v_have.units END,
      'changes', CASE WHEN v_verdict = 'changed' THEN '["description"]'::jsonb ELSE '[]'::jsonb END,
      'before', CASE WHEN v_verdict = 'changed'
                     THEN jsonb_build_object('description', public.derived_metric_description(v_have.description))
                     ELSE '{}'::jsonb END,
      'after', CASE WHEN v_verdict = 'changed' THEN jsonb_build_object('description', v_desc) ELSE '{}'::jsonb END,
      'canon', CASE WHEN v_verdict = 'refused' THEN NULL
                    ELSE jsonb_build_object('name', v_name, 'description', v_desc, 'derivation', v_def) END);
  END LOOP;
  RETURN v_out;
END
$$;

ALTER FUNCTION public.derived_metrics_parse(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.derived_metrics_parse(jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.derived_metrics_parse(jsonb) IS
  'Checks a document of derived metrics and writes nothing: for each, {index, key, verdict, reasons, '
  'id, units, changes, before, after, canon}. The verdict is new, unchanged (the name exists with this '
  'definition and description, in any order of states or inputs), changed (the same definition and '
  'another description: changes is [''description''], before and after hold the two) or refused. canon '
  'is the metric as it would be saved, null with a refusal. Every reason is collected, each with a '
  'JSON path. Refuses a key it does not know, a name a measured or a deprecated metric holds, another '
  'definition under a name that exists, and an input the catalogue lacks or that is derived. What the '
  'table''s own checks decide is apply_derived_metrics()''s. Called by it (0297).';

-- Where in the file an enforce_derived_metric() refusal belongs, from the words it gave: the input it
-- names (an input of a sum by its position), the states, the units of a sum, the name, or the metric
-- as a whole. Only a place to put the mark: the words are the trigger's own.
CREATE OR REPLACE FUNCTION public.derived_metric_refusal_path(p_path text, p_canon jsonb, p_message text, p_state text)
RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_def  jsonb := p_canon -> 'derivation';
  v_name text  := p_canon ->> 'name';
BEGIN
  IF p_state = 'P0001' OR left(p_message, length(v_name) + 11) = v_name || ' is a name ' THEN
    RETURN p_path || '.name';
  END IF;
  IF p_message LIKE 'The inputs of a sum must share one unit%' THEN
    RETURN p_path || '.inputs';
  END IF;
  IF v_def ->> 'kind' = 'sum' THEN
    FOR k IN 0 .. jsonb_array_length(v_def -> 'inputs') - 1 LOOP
      IF left(p_message, length(v_def -> 'inputs' -> k ->> 'metric') + 1) IN (
           (v_def -> 'inputs' -> k ->> 'metric') || ' ', (v_def -> 'inputs' -> k ->> 'metric') || ':') THEN
        RETURN format('%s.inputs[%s].metric', p_path, k);
      END IF;
    END LOOP;
  ELSIF v_def ? 'input' AND left(p_message, length(v_def ->> 'input') + 1) IN (
          (v_def ->> 'input') || ' ', (v_def ->> 'input') || ':') THEN
    IF p_message LIKE '%reports true or false%' THEN
      RETURN p_path || '.states';
    END IF;
    RETURN p_path || '.input';
  END IF;
  IF left(p_message, 1) = '"' THEN
    RETURN p_path || '.states';
  END IF;
  RETURN p_path;
END
$$;

ALTER FUNCTION public.derived_metric_refusal_path(text, jsonb, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.derived_metric_refusal_path(text, jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.derived_metric_refusal_path(text, jsonb, text, text) IS
  'The JSON path a refusal of enforce_derived_metric() or of the catalogue''s group spelling belongs at, '
  'from its words and SQLSTATE: the input it names, the states, the inputs of a sum, the name, or the '
  'metric as a whole (0297).';

-- -------------------------------------------------------------------------------------------------
-- 3. Applying a document
-- -------------------------------------------------------------------------------------------------
-- An Administrator behind the second factor, as the catalogue's insert policy asks; a machine identity
-- holds no role. Every field is checked before anything is written, and one refusal anywhere writes
-- nothing. A new metric is first saved in a subtransaction that is undone, which runs the very checks
-- of the table's triggers and constraints, as Add Derived Metric's insert does, and reads the unit the
-- trigger gives it. Then, with no refusal and p_dry_run false, each new one is saved and each changed
-- one has its description set: nothing else of an existing metric is touched, and the table's trigger
-- refuses any other change. Each INSERT or UPDATE is one row of the catalogue's audit trigger, naming
-- the person.
CREATE OR REPLACE FUNCTION public.apply_derived_metrics(p_doc jsonb, p_dry_run boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  c_datatype CONSTANT integer := 10;
  v_uid     uuid := auth.uid();
  v_item    jsonb;
  v_canon   jsonb;
  v_status  text;
  v_reasons jsonb;
  v_id      uuid;
  v_units   text;
  v_message text;
  v_state   text;
  v_work    jsonb := '[]'::jsonb;
  v_refused boolean := false;
  v_at      integer[] := ARRAY[]::integer[];
  v_ids     uuid[]    := ARRAY[]::uuid[];
  v_us      text[]    := ARRAY[]::text[];
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'Only an Administrator may apply derived metrics.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.require_mfa();
  IF p_dry_run IS NULL THEN
    RAISE EXCEPTION 'p_dry_run is true to preview and false to apply.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_item IN SELECT x FROM jsonb_array_elements(public.derived_metrics_parse(p_doc)) x LOOP
    v_status := v_item ->> 'verdict';
    v_reasons := v_item -> 'reasons';
    v_canon := v_item -> 'canon';
    v_id := (v_item ->> 'id')::uuid;
    v_units := v_item ->> 'units';

    IF v_status = 'new' THEN
      BEGIN
        INSERT INTO public.metric_catalog (name, datatype, description, derivation)
        VALUES (v_canon ->> 'name', c_datatype, v_canon ->> 'description', v_canon -> 'derivation')
        RETURNING units INTO v_units;
        RAISE EXCEPTION 'undo' USING ERRCODE = 'DM001';
      EXCEPTION
        WHEN SQLSTATE 'DM001' THEN
          NULL;
        WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
          v_status := 'refused';
          v_units := NULL;
          v_reasons := jsonb_build_array(public.automation_reason(
            public.derived_metric_refusal_path(format('$[%s]', v_item -> 'index'), v_canon, v_message, v_state),
            v_message));
      END;
    END IF;
    IF v_status = 'refused' THEN
      v_refused := true;
    END IF;

    v_work := v_work || jsonb_build_object(
      'index', v_item -> 'index', 'name', v_item -> 'key', 'status', v_status, 'id', v_id,
      'units', v_units, 'derivation', v_canon -> 'derivation', 'changes', v_item -> 'changes',
      'before', v_item -> 'before', 'after', v_item -> 'after', 'reasons', v_reasons, 'canon', v_canon);
  END LOOP;

  IF NOT p_dry_run AND NOT v_refused THEN
    FOR v_item IN SELECT x FROM jsonb_array_elements(v_work) x LOOP
      v_canon := v_item -> 'canon';
      IF v_item ->> 'status' = 'changed' THEN
        UPDATE public.metric_catalog SET description = v_canon ->> 'description'
         WHERE id = (v_item ->> 'id')::uuid;
      ELSIF v_item ->> 'status' = 'new' THEN
        INSERT INTO public.metric_catalog (name, datatype, description, derivation)
        VALUES (v_canon ->> 'name', c_datatype, v_canon ->> 'description', v_canon -> 'derivation')
        RETURNING id, units INTO v_id, v_units;
        -- What was made, by its place in the file, for the result.
        v_at := array_append(v_at, (v_item ->> 'index')::integer);
        v_ids := array_append(v_ids, v_id);
        v_us := array_append(v_us, v_units);
      END IF;
    END LOOP;
  END IF;

  RETURN coalesce((SELECT jsonb_agg(CASE WHEN m.at IS NULL THEN e.w - 'canon'
                                         ELSE (e.w - 'canon') || jsonb_build_object('id', m.id, 'units', m.units) END ORDER BY e.ord)
                     FROM jsonb_array_elements(v_work) WITH ORDINALITY AS e(w, ord)
                     LEFT JOIN unnest(v_at, v_ids, v_us) AS m(at, id, units) ON m.at = (e.w ->> 'index')::integer),
                  '[]'::jsonb);
END
$$;

ALTER FUNCTION public.apply_derived_metrics(jsonb, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_derived_metrics(jsonb, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.apply_derived_metrics(jsonb, boolean) TO authenticated;

COMMENT ON FUNCTION public.apply_derived_metrics(jsonb, boolean) IS
  'Checks a document of derived metrics and applies it: an Administrator behind the second factor '
  '(42501 otherwise). Answers one result per metric, {index, name, status, id, units, derivation, '
  'changes, before, after, reasons}: status new, changed, unchanged or refused. A changed metric has '
  'the same definition and another description, which a file that leaves it out clears: changes is '
  '[''description''] and before and after hold the two. For a refusal, reasons, each {path, message} '
  'with a JSON path such as $[0].inputs[1].metric. All or nothing: with any refusal, or with '
  'p_dry_run true, nothing is written, so a preview and an apply are one call. Adds what is new, sets '
  'the description of what changed and never deletes: a name that exists with another definition is '
  'refused. A new metric is saved in a subtransaction that is undone, so every refusal of the '
  'table''s own checks is given in its words. One INSERT or UPDATE is one Audit Trail row, by the '
  'catalogue''s trigger (0297).';

-- -------------------------------------------------------------------------------------------------
-- 4. Reading them back
-- -------------------------------------------------------------------------------------------------
-- The derived metrics in the document's shape, a list: every one, or those the ids given belong to,
-- ordered by name. A deprecated one is not exported: a document says what is in use. SECURITY
-- INVOKER: every signed-in role reads the catalogue.
CREATE OR REPLACE FUNCTION public.derived_metrics_document(p_ids uuid[] DEFAULT NULL::uuid[]) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(jsonb_agg(public.derived_metric_document_of(m.name, m.description, m.derivation)
                            ORDER BY m.name COLLATE "C"), '[]'::jsonb)
    FROM public.metric_catalog m
   WHERE m.derivation IS NOT NULL AND NOT m.deprecated AND (p_ids IS NULL OR m.id = ANY (p_ids));
$$;

ALTER FUNCTION public.derived_metrics_document(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.derived_metrics_document(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.derived_metrics_document(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.derived_metrics_document(uuid[]) IS
  'The derived metrics in the document''s shape, a list ordered by name: every one, or those of the '
  'metric ids given. A deprecated one is not exported. apply_derived_metrics() of the list reports '
  'every metric unchanged (0297).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn  text;
  v_src text;
  v_out jsonb;
BEGIN
  -- The writer is SECURITY DEFINER with a pinned path, asks for the role the catalogue's insert policy
  -- asks for and then for the second factor, and is for signed-in roles alone.
  v_fn := 'public.apply_derived_metrics(jsonb, boolean)';
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = v_fn::regprocedure AND p.prosecdef AND p.proconfig = ARRAY['search_path=public'];
  IF v_src IS NULL THEN
    RAISE EXCEPTION '0297: % is not SECURITY DEFINER with search_path pinned to public', v_fn;
  END IF;
  IF position('has_role(ARRAY[''Administrator''])' IN v_src) = 0 THEN
    RAISE EXCEPTION '0297: % does not ask for the Administrator role', v_fn;
  END IF;
  IF position('PERFORM public.require_mfa();' IN v_src) = 0 THEN
    RAISE EXCEPTION '0297: % does not ask for the second factor', v_fn;
  END IF;
  -- It changes a description and nothing else of a metric that exists: one UPDATE, of that column, and
  -- no DELETE.
  IF position('UPDATE public.metric_catalog SET description = ' IN v_src) = 0
     OR length(v_src) - length(replace(v_src, 'UPDATE public.', '')) <> length('UPDATE public.') THEN
    RAISE EXCEPTION '0297: % does not make the one UPDATE of a description', v_fn;
  END IF;
  IF position('DELETE FROM' IN v_src) > 0 THEN
    RAISE EXCEPTION '0297: % deletes', v_fn;
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.apply_derived_metrics(jsonb, boolean)', 'public.derived_metrics_document(uuid[])',
                              'public.derived_metric_document_of(text, text, jsonb)', 'public.derived_metric_description(text)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0297: % is not for signed-in roles alone', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.derived_metrics_parse(jsonb)', 'public.derived_metric_refusal_path(text, jsonb, text, text)',
                              'public.derivation_canonical(jsonb)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0297: a browser-facing role may execute %', v_fn;
    END IF;
  END LOOP;

  -- The checker answers a refusal with a path, and an empty list with nothing to refuse.
  v_out := public.derived_metrics_parse('{}'::jsonb);
  IF v_out -> 0 -> 'reasons' -> 0 ->> 'path' <> '$' THEN
    RAISE EXCEPTION '0297: derived_metrics_parse() does not refuse a document that is not a list';
  END IF;
  v_out := public.derived_metrics_parse('[{"name": "A/B", "kind": "counter_rate", "input": "A/C", "unit": "x"}]'::jsonb);
  IF v_out -> 0 -> 'reasons' -> 0 ->> 'path' <> '$[0].unit' OR v_out -> 0 -> 'canon' <> 'null'::jsonb THEN
    RAISE EXCEPTION '0297: derived_metrics_parse() does not refuse a key it does not know';
  END IF;
  IF public.derived_metrics_parse('[]'::jsonb) <> '[]'::jsonb THEN
    RAISE EXCEPTION '0297: derived_metrics_parse() finds something in an empty list';
  END IF;

  -- A definition in another order is the same one, and the document's shape holds the definition's keys.
  IF public.derivation_canonical('{"kind": "time_in_state", "input": "A/X", "states": ["B", "A"]}')
       <> public.derivation_canonical('{"kind": "time_in_state", "input": "A/X", "states": ["A", "B"]}')
     OR public.derivation_canonical('{"kind": "sum", "inputs": [{"metric": "A/Y", "sign": -1}, {"metric": "A/X", "sign": 1}]}')
       <> public.derivation_canonical('{"kind": "sum", "inputs": [{"metric": "A/X", "sign": 1}, {"metric": "A/Y", "sign": -1}]}')
     OR public.derivation_canonical('{"kind": "counter_rate", "input": "A/X"}') <> '{"kind": "counter_rate", "input": "A/X"}' THEN
    RAISE EXCEPTION '0297: derivation_canonical() does not put a definition in one order';
  END IF;
  IF public.derived_metric_document_of('A/B', ' ', '{"kind": "counter_rate", "input": "A/X"}')
       <> '{"name": "A/B", "kind": "counter_rate", "input": "A/X"}'::jsonb
     OR public.derived_metric_document_of('A/B', ' Rate ', '{"kind": "time_in_state", "input": "A/X", "states": ["ON"]}')
       <> '{"name": "A/B", "description": "Rate", "kind": "time_in_state", "input": "A/X", "states": ["ON"]}'::jsonb THEN
    RAISE EXCEPTION '0297: derived_metric_document_of() does not write the document''s shape';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
