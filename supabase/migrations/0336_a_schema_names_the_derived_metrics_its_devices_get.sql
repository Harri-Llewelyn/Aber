-- 0336: A schema names the derived metrics its devices get.
--
-- A derived metric (0267) applied to every device that reported all its inputs. That suits a counter
-- rate and not a time in state: two robots report one program name and run different programs, and a
-- share of time in a program one of them never runs was drawn for it, at 0%. A schema says what a kind
-- of device is, so a schema version now names the derived metrics its devices get, and a device has
-- the ones its schemas name.
--
--   * schemas.derived_metrics is the list, beside schema_definition and apart from it: the definition is
--     what a payload is judged against, and nothing publishes a derived metric. It is a column of the
--     version, so prevent_active_schema_mutation() freezes it, a change of it is the schema's own row
--     in the Audit Trail, and the version's policies are its policies.
--   * trg_schemas_derived_metrics checks it where it is saved: each name is a derived metric of the
--     catalogue, a deprecated one only where the version names it already, each input is a metric the
--     same schema models, and each state of a time in state is one the schema's copy of the input
--     permits. A version inserted without a list takes its parent's, so fork_schema() carries it and is
--     not declared again.
--   * trg_metric_catalog_derived_is_named refuses to delete or rename a derived metric a version names.
--   * device_derived_metrics() is the rule, once: the union of what the schemas bound to a device name, a
--     replay lane's being its original's. automations_parse() refuses a threshold on a derived metric the
--     device does not have. One the automation already watches stays.
--   * The versions there are: every version a device is bound to, and every draft, takes the derived
--     metrics whose inputs it models, once, on the boot that adds the column. The fill writes a
--     published version under a lock and leaves no Audit Trail row, as 0298's did. Two NOTICEs name
--     what it cannot carry: a device with no schema, and a device none of whose schemas models every
--     input.
--
-- Nothing is computed or stored here: a value is made when it is read (0282).
--
-- Reasoning: supabase/README.md, "A schema names the derived metrics its devices get (0336)".
-- Idempotent.
--
-- Redefines public.automations_parse: 0336 refuses a threshold on a derived metric that none of the
--   device's schemas names, and names those schemas, unless the automation watches it already

-- -------------------------------------------------------------------------------------------------
-- 1. What a definition needs and what a schema models
-- -------------------------------------------------------------------------------------------------
-- The inputs of a derived metric's definition, in the order it holds them: derivationInputs() in
-- utils/derivedMetric.js.
CREATE OR REPLACE FUNCTION public.derivation_input_names(p_derivation jsonb) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
    WHEN p_derivation ->> 'kind' = 'sum' THEN
      ARRAY(SELECT e.i ->> 'metric'
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_derivation -> 'inputs') = 'array'
                                             THEN p_derivation -> 'inputs' ELSE '[]'::jsonb END)
                   WITH ORDINALITY AS e(i, ord)
             ORDER BY e.ord)
    WHEN p_derivation ->> 'input' IS NOT NULL THEN ARRAY[p_derivation ->> 'input']
    ELSE ARRAY[]::text[]
  END;
$$;

ALTER FUNCTION public.derivation_input_names(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.derivation_input_names(jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.derivation_input_names(jsonb) IS
  'The names of the metrics a derived metric is computed from, in the order its definition holds them, '
  'and an empty list for a measured metric (0336).';

-- The metrics a schema's definition models: the keys of `properties` and the names in `required`, as
-- modelledMetrics() in utils/deviceTags.js reads them.
CREATE OR REPLACE FUNCTION public.schema_modelled_metrics(p_definition jsonb) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT ARRAY(
    SELECT k.name
      FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p_definition -> 'properties') = 'object'
                                  THEN p_definition -> 'properties' ELSE '{}'::jsonb END) AS k(name)
    UNION
    SELECT r.name
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_definition -> 'required') = 'array'
                                          THEN p_definition -> 'required' ELSE '[]'::jsonb END) AS r(name)
     WHERE r.name IS NOT NULL);
$$;

ALTER FUNCTION public.schema_modelled_metrics(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.schema_modelled_metrics(jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.schema_modelled_metrics(jsonb) IS
  'The names of the metrics a schema''s definition models: the keys of its properties and the names in '
  'its required list, each once (0336).';

-- -------------------------------------------------------------------------------------------------
-- 2. What a version may name
-- -------------------------------------------------------------------------------------------------
-- Every reason a version of this definition may not name a derived metric, one row for each, in the
-- order of the names and in words a person reads. `p_kept` is what the version names already: a
-- deprecated derived metric may stay and may not be added, as a deprecated metric may. The dashboard's
-- editor says the same of what it can know (derivedProblems() in utils/derivedMetric.js).
CREATE OR REPLACE FUNCTION public.schema_derived_metric_problems(p_definition jsonb, p_names text[], p_kept text[])
RETURNS TABLE (metric_name text, problem text)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_modelled text[] := public.schema_modelled_metrics(p_definition);
  v_row   record;
  v_input text;
  v_state text;
  v_enum  jsonb;
BEGIN
  FOR v_row IN
    SELECT n.name, c.id, c.derivation, coalesce(c.deprecated, false) AS deprecated
      FROM unnest(p_names) WITH ORDINALITY AS n(name, ord)
      LEFT JOIN public.metric_catalog c ON c.name = n.name
     ORDER BY n.ord
  LOOP
    metric_name := v_row.name;
    IF v_row.id IS NULL THEN
      problem := format('%s is not in the metric catalogue. Add it on the Metrics page first.', v_row.name);
      RETURN NEXT;
      CONTINUE;
    ELSIF v_row.derivation IS NULL THEN
      problem := format('%s is a measured metric, so it goes among the metrics the schema models. A schema''s derived metrics are the ones Aber computes.', v_row.name);
      RETURN NEXT;
      CONTINUE;
    ELSIF v_row.deprecated AND NOT coalesce(v_row.name = ANY (p_kept), false) THEN
      problem := format('%s is deprecated. A schema may keep it but not add it.', v_row.name);
      RETURN NEXT;
      CONTINUE;
    END IF;

    FOREACH v_input IN ARRAY public.derivation_input_names(v_row.derivation) LOOP
      IF NOT v_input = ANY (v_modelled) THEN
        problem := format('%s is computed from %s, which this schema does not model. Add %s to its metrics, or leave %s out.',
                          v_row.name, v_input, v_input, v_row.name);
        RETURN NEXT;
      END IF;
    END LOOP;

    -- A state is text in a definition, and a permitted value is text, true or false, or a number.
    IF v_row.derivation ->> 'kind' = 'time_in_state' THEN
      v_enum := p_definition -> 'properties' -> (v_row.derivation ->> 'input') -> 'enum';
      IF jsonb_typeof(v_enum) = 'array' THEN
        FOR v_state IN SELECT s.state FROM jsonb_array_elements_text(v_row.derivation -> 'states') AS s(state) LOOP
          IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_enum) AS e(value) WHERE e.value = v_state) THEN
            problem := format('%s counts the state "%s", which this schema does not permit %s to report (%s). Leave %s out, or add the state to the metric''s permitted values.',
                              v_row.name, v_state, v_row.derivation ->> 'input',
                              (SELECT string_agg(e.value, ', ' ORDER BY e.ord)
                                 FROM jsonb_array_elements_text(v_enum) WITH ORDINALITY AS e(value, ord)),
                              v_row.name);
            RETURN NEXT;
          END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;
END
$$;

ALTER FUNCTION public.schema_derived_metric_problems(jsonb, text[], text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.schema_derived_metric_problems(jsonb, text[], text[])
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.schema_derived_metric_problems(jsonb, text[], text[]) IS
  'Every reason a schema version of this definition may not name a derived metric: {metric_name, '
  'problem}, problem in words. One the catalogue lacks, a measured one, a deprecated one not in p_kept, '
  'one an input of which the definition does not model, and a time in state that counts a state the '
  'definition''s enum for the input leaves out. No row means every name may be saved (0336).';

-- -------------------------------------------------------------------------------------------------
-- 3. The column, its trigger, and what a version names stays in the catalogue
-- -------------------------------------------------------------------------------------------------
-- Added nullable and filled below, in 0298's order: the column, the trigger, then the fill behind a
-- lock, so a row the previous release's dashboard inserts meanwhile is never refused.
ALTER TABLE public.schemas ADD COLUMN IF NOT EXISTS derived_metrics text[];

-- SECURITY DEFINER: the parent's row and the catalogue's, and the lock on it, must not depend on the
-- caller. The catalogue's rows are locked as a foreign key locks the row it names, so one cannot be
-- deleted between this check and its commit.
CREATE OR REPLACE FUNCTION public.schemas_check_their_derived_metrics() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_parent   public.schemas;
  v_kept     text[] := ARRAY[]::text[];
  v_problems text;
BEGIN
  IF NEW.parent_schema_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM public.schemas p WHERE p.id = NEW.parent_schema_id;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.derived_metrics IS NULL THEN
    -- Not given: the parent's, which is NULL until the fill below has run, and none for a first version.
    NEW.derived_metrics := CASE WHEN NEW.parent_schema_id IS NULL THEN ARRAY[]::text[] ELSE v_parent.derived_metrics END;
  ELSE
    NEW.derived_metrics := ARRAY(SELECT DISTINCT n.name COLLATE "C"
                                   FROM unnest(NEW.derived_metrics) AS n(name)
                                  WHERE n.name IS NOT NULL
                                  ORDER BY 1);
  END IF;
  IF coalesce(cardinality(NEW.derived_metrics), 0) = 0 THEN
    RETURN NEW;
  END IF;

  -- A copy of its parent is as whole as its parent, and an edit that changes neither column is not one
  -- of what is checked here. Create Version must not be refused by what a published version says, since
  -- nobody can edit that.
  IF TG_OP = 'INSERT' THEN
    IF NEW.schema_definition = v_parent.schema_definition AND NEW.derived_metrics = v_parent.derived_metrics THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.schema_definition = OLD.schema_definition AND NEW.derived_metrics = OLD.derived_metrics THEN
      RETURN NEW;
    END IF;
    v_kept := coalesce(OLD.derived_metrics, ARRAY[]::text[]);
  END IF;
  v_kept := v_kept || coalesce(v_parent.derived_metrics, ARRAY[]::text[]);

  PERFORM 1 FROM public.metric_catalog c WHERE c.name = ANY (NEW.derived_metrics) ORDER BY c.name FOR KEY SHARE;
  SELECT string_agg(p.problem, ' ' ORDER BY p.ord) INTO v_problems
    FROM public.schema_derived_metric_problems(NEW.schema_definition, NEW.derived_metrics, v_kept)
         WITH ORDINALITY AS p(metric_name, problem, ord);
  IF v_problems IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problems USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.schemas_check_their_derived_metrics() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.schemas_check_their_derived_metrics() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.schemas_check_their_derived_metrics() IS
  'BEFORE INSERT, and BEFORE UPDATE of schema_definition or derived_metrics, on schemas: puts '
  'derived_metrics in name order, each name once, and refuses the row with every reason '
  'schema_derived_metric_problems() gives. A version inserted without a list takes its parent''s. A copy '
  'of its parent, and an edit that changes neither column, is not checked again (0336).';

SELECT public.replay_trigger('public.schemas', 'trg_schemas_derived_metrics', $ddl$
CREATE TRIGGER trg_schemas_derived_metrics BEFORE INSERT OR UPDATE OF schema_definition, derived_metrics ON public.schemas FOR EACH ROW EXECUTE FUNCTION public.schemas_check_their_derived_metrics();
$ddl$);

-- What a foreign key would do, for a list of names: a derived metric that a version names is neither
-- deleted nor renamed. A name is fixed already (enforce_metric_catalog_immutability()), and this holds if
-- that ever changes.
CREATE OR REPLACE FUNCTION public.refuse_losing_a_named_derived_metric() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_versions bigint;
  v_first    text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.name IS NOT DISTINCT FROM OLD.name THEN
    RETURN NEW;
  END IF;
  SELECT count(*), min(s.lineage_name || ' v' || s.version) INTO v_versions, v_first
    FROM public.schemas s
   WHERE OLD.name = ANY (s.derived_metrics);
  IF v_versions > 0 THEN
    RAISE EXCEPTION '% cannot be %: the schema version % names it%. Deprecate it instead.',
          OLD.name, CASE TG_OP WHEN 'DELETE' THEN 'deleted' ELSE 'renamed' END, v_first,
          CASE WHEN v_versions = 1 THEN '' ELSE format(', and %s more', v_versions - 1) END
          USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.refuse_losing_a_named_derived_metric() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_losing_a_named_derived_metric() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.refuse_losing_a_named_derived_metric() IS
  'BEFORE DELETE, and BEFORE UPDATE of name, on metric_catalog, for a derived metric: refuses with 23503 '
  'while a schema version names it, as a foreign key would (0336).';

SELECT public.replay_trigger('public.metric_catalog', 'trg_metric_catalog_derived_is_named', $ddl$
CREATE TRIGGER trg_metric_catalog_derived_is_named BEFORE DELETE OR UPDATE OF name ON public.metric_catalog FOR EACH ROW WHEN ((old.derivation IS NOT NULL)) EXECUTE FUNCTION public.refuse_losing_a_named_derived_metric();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 4. The versions there are, once
-- -------------------------------------------------------------------------------------------------
-- A version a device is bound to, and a draft, takes the derived metrics whose inputs it models, so
-- nothing a person sees goes: those are the ones its devices had by the rule before. Any other version
-- names none. The lock is taken only where the column is still nullable, so a replay does nothing.
-- Neither the audit trigger nor the checking trigger runs for the fill: it records no choice anybody
-- made, and it names a deprecated derived metric too, since its values are still shown. Both are
-- enabled again before the transaction ends, and the self-check reads them.
DO $fill$
DECLARE
  -- How many devices one NOTICE names, so a site with thousands still reads it.
  c_named  CONSTANT integer := 100;
  v_filled integer;
  v_case   record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.schemas'::regclass AND attname = 'derived_metrics'
                AND NOT attnotnull AND NOT attisdropped) THEN
    LOCK TABLE public.schemas IN SHARE ROW EXCLUSIVE MODE;

    ALTER TABLE public.schemas DISABLE TRIGGER trg_schemas_audit_trail;
    ALTER TABLE public.schemas DISABLE TRIGGER trg_schemas_derived_metrics;
    WITH inputs AS (
      SELECT c.name AS derived, i.name AS input, cardinality(public.derivation_input_names(c.derivation)) AS needed
        FROM public.metric_catalog c
       CROSS JOIN LATERAL unnest(public.derivation_input_names(c.derivation)) AS i(name)
       WHERE c.derivation IS NOT NULL
    ), covered AS (
      SELECT s.id, i.derived
        FROM public.schemas s
       CROSS JOIN LATERAL unnest(public.schema_modelled_metrics(s.schema_definition)) AS m(name)
        JOIN inputs i ON i.input = m.name
       WHERE s.derived_metrics IS NULL
         AND (s.status = 'draft' OR EXISTS (SELECT 1 FROM public.device_submodels ds WHERE ds.schema_id = s.id))
       GROUP BY s.id, i.derived, i.needed
      HAVING count(*) = i.needed
    ), named AS (
      SELECT c.id, array_agg(c.derived ORDER BY c.derived COLLATE "C") AS names FROM covered c GROUP BY c.id
    ), done AS (
      UPDATE public.schemas s
         SET derived_metrics = coalesce(n.names, ARRAY[]::text[])
        FROM public.schemas v LEFT JOIN named n ON n.id = v.id
       WHERE v.id = s.id AND s.derived_metrics IS NULL
      RETURNING cardinality(s.derived_metrics) > 0 AS any_named
    )
    SELECT count(*) FILTER (WHERE d.any_named) INTO v_filled FROM done d;
    ALTER TABLE public.schemas ENABLE TRIGGER trg_schemas_derived_metrics;
    ALTER TABLE public.schemas ENABLE TRIGGER trg_schemas_audit_trail;
    ALTER TABLE public.schemas ALTER COLUMN derived_metrics SET NOT NULL;
    RAISE NOTICE '0336: % schema version(s) now name the derived metrics whose inputs they model', v_filled;

    -- What a device had by the rule before (its birth's metrics and all its schemas' together covered
    -- every input) and no schema of it names. A quarantined device showed none, and a replay lane has
    -- its original's.
    FOR v_case IN
      WITH inputs AS MATERIALIZED (
        SELECT c.name AS derived, i.name AS input, cardinality(public.derivation_input_names(c.derivation)) AS needed
          FROM public.metric_catalog c
         CROSS JOIN LATERAL unnest(public.derivation_input_names(c.derivation)) AS i(name)
         WHERE c.derivation IS NOT NULL
      ), modelled AS MATERIALIZED (
        SELECT s.id, m.name
          FROM public.schemas s
         CROSS JOIN LATERAL unnest(public.schema_modelled_metrics(s.schema_definition)) AS m(name)
         WHERE m.name IN (SELECT i.input FROM inputs i)
      ), shown AS MATERIALIZED (
        SELECT d.id, d.name, d.last_birth_metrics,
               EXISTS (SELECT 1 FROM public.device_submodels ds WHERE ds.device_id = d.id) AS has_schema
          FROM public.devices d
         WHERE NOT coalesce(d.is_quarantined, false) AND d.shadow_of IS NULL
      ), reported AS (
        SELECT d.id, b.name
          FROM shown d CROSS JOIN LATERAL unnest(d.last_birth_metrics) AS b(name)
         WHERE b.name IN (SELECT i.input FROM inputs i)
        UNION
        SELECT d.id, m.name
          FROM shown d
          JOIN public.device_submodels ds ON ds.device_id = d.id
          JOIN modelled m ON m.id = ds.schema_id
      ), lost AS (
        SELECT r.id, i.derived
          FROM reported r JOIN inputs i ON i.input = r.name
         GROUP BY r.id, i.derived, i.needed
        HAVING count(*) = i.needed
        EXCEPT
        SELECT ds.device_id, n.name
          FROM public.device_submodels ds
          JOIN public.schemas s ON s.id = ds.schema_id
         CROSS JOIN LATERAL unnest(s.derived_metrics) AS n(name)
      ), worded AS (
        SELECT d.has_schema, d.name || ' (' || string_agg(l.derived, ', ' ORDER BY l.derived COLLATE "C") || ')' AS words,
               row_number() OVER (PARTITION BY d.has_schema ORDER BY d.name, d.id) AS place
          FROM lost l JOIN shown d ON d.id = l.id
         GROUP BY d.id, d.name, d.has_schema
      )
      SELECT w.has_schema, count(*) AS devices,
             string_agg(w.words, '; ' ORDER BY w.place) FILTER (WHERE w.place <= c_named)
               || CASE WHEN count(*) > c_named THEN format('; and %s more', count(*) - c_named) ELSE '' END AS words
        FROM worded w
       GROUP BY w.has_schema
       ORDER BY w.has_schema
    LOOP
      IF v_case.has_schema THEN
        RAISE NOTICE '0336: % device(s) no longer have a derived metric, because none of their schemas models every input of it: %',
              v_case.devices, v_case.words;
      ELSE
        RAISE NOTICE '0336: % device(s) have no schema, so no derived metric applies to them any more: %',
              v_case.devices, v_case.words;
      END IF;
    END LOOP;
  END IF;
END $fill$;

COMMENT ON COLUMN public.schemas.derived_metrics IS 'The derived metrics a device bound to this version gets, by catalogue name, in name order. Never a metric the version models: nothing publishes a derived metric. Part of the version: fixed once it is published, and a version made without a list takes its parent''s (0336).';

-- -------------------------------------------------------------------------------------------------
-- 5. The derived metrics a device has
-- -------------------------------------------------------------------------------------------------
-- The rule, once: the derived metrics the schemas bound to a device name, several schemas' together. A
-- replay lane has its original's, whatever its own bindings say by now. derivedMetricsOfDevice() in
-- utils/derivedMetric.js and derivedMetricsFor() in the AAS exporter are the same rule, and
-- test-harness/fixtures/device-derived-metrics.json holds the three together.
CREATE OR REPLACE FUNCTION public.device_derived_metrics(p_device_ids uuid[] DEFAULT NULL::uuid[])
RETURNS TABLE (device_id uuid, metric_name text)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT DISTINCT d.id, c.name
    FROM public.devices d
    JOIN public.device_submodels ds ON ds.device_id = coalesce(d.shadow_of, d.id)
    JOIN public.schemas s ON s.id = ds.schema_id
   CROSS JOIN LATERAL unnest(s.derived_metrics) AS n(name)
    JOIN public.metric_catalog c ON c.name = n.name AND c.derivation IS NOT NULL
   WHERE p_device_ids IS NULL OR d.id = ANY (p_device_ids);
$$;

ALTER FUNCTION public.device_derived_metrics(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.device_derived_metrics(uuid[]) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.device_derived_metrics(uuid[]) IS
  'The derived metrics a device has, one row for each: the ones named by the schemas bound to it, or, for '
  'a replay lane, to its original. Every device, or the ones given (0336).';

-- Why a device does not have a derived metric, as a sentence for a refusal: its schemas by name, or that
-- it has none.
CREATE OR REPLACE FUNCTION public.device_lacks_derived_metric_words(p_device_id uuid, p_metric text) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE WHEN x.schemas IS NULL
              THEN format('%s has no schema, so it has no derived metric. Give it one that names `%s`.', d.name, p_metric)
              ELSE format('%s does not have `%s`: none of its schemas names it (%s). Name it in one of them on the Schemas page.',
                          d.name, p_metric, x.schemas)
         END
    FROM public.devices d
   CROSS JOIN LATERAL (
     SELECT string_agg(s.lineage_name || ' v' || s.version, ', ' ORDER BY s.lineage_name, s.version) AS schemas
       FROM public.device_submodels ds JOIN public.schemas s ON s.id = ds.schema_id
      WHERE ds.device_id = coalesce(d.shadow_of, d.id)) x
   WHERE d.id = p_device_id;
$$;

ALTER FUNCTION public.device_lacks_derived_metric_words(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.device_lacks_derived_metric_words(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.device_lacks_derived_metric_words(uuid, text) IS
  'Why a device does not have a derived metric, in one sentence that names the schemas bound to it, or '
  'says that it has none (0336).';

-- -------------------------------------------------------------------------------------------------
-- 6. A threshold on a derived metric
-- -------------------------------------------------------------------------------------------------
-- Reads the catalogue and the devices and writes nothing. A file is bounded: 500 automations, 100
-- triggers each, 500 devices a trigger and 10,000 devices in all. For each automation, in
-- order: {index, key, reasons, canon}. `canon` is the automation as it would be stored, with every
-- value typed and every default made explicit, and null when there is any reason to refuse it. It
-- is checked field by field and every reason is collected, so a person fixes a file in one pass.
-- A threshold on a derived metric is for a device that has it. One the automation watches already is
-- kept, as a schema keeps a deprecated metric: a schema may stop naming a derived metric at any time,
-- and the file an export writes must still apply.
CREATE OR REPLACE FUNCTION public.automations_parse(p_doc jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  c_id      CONSTANT text := '^[a-z0-9][a-z0-9_-]{0,63}$';
  c_uuid    CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_for     CONSTANT text := '^(0|[1-9][0-9]{0,2})[smh]$';
  c_max_automations CONSTANT integer := 500;
  c_max_triggers    CONSTANT integer := 100;
  c_max_devices     CONSTANT integer := 500;
  c_max_rows        CONSTANT integer := 10000;
  v_out      jsonb := '[]'::jsonb;
  v_seen     jsonb := '{}'::jsonb;
  v_auto     jsonb;
  v_apath    text;
  v_reasons  jsonb;
  v_rows     jsonb;
  v_actions  jsonb;
  v_key      text;
  v_id       text;
  v_alias    text;
  v_desc     text := '';
  v_enabled  boolean := true;
  v_list     jsonb;
  v_trig     jsonb;
  v_tpath    text;
  v_dpath    text;
  v_devs     jsonb;
  v_dev      jsonb;
  v_dev_id   text;
  v_dev_ids  text[];
  v_dev_count integer;
  v_visited  integer := 0;
  v_metric   text;
  v_metric_ok boolean;
  v_derived  boolean;
  v_cmp      text;
  v_val      jsonb;
  v_num      numeric;
  v_threshold double precision;
  v_hold     integer;
  v_for      text;
  v_act      jsonb;
  v_ok       boolean;
BEGIN
  IF jsonb_typeof(p_doc) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_array(jsonb_build_object('index', NULL, 'key', NULL, 'reasons', jsonb_build_array(
      public.automation_reason('$', 'A file holds a list of automations. Start each one with `- id:`.')), 'canon', NULL));
  END IF;
  IF jsonb_array_length(p_doc) > c_max_automations THEN
    RETURN jsonb_build_array(jsonb_build_object('index', NULL, 'key', NULL, 'reasons', jsonb_build_array(
      public.automation_reason('$', format('A file holds at most %s automations. Split it.', c_max_automations))),
      'canon', NULL));
  END IF;

  FOR i IN 0 .. jsonb_array_length(p_doc) - 1 LOOP
    v_auto := p_doc -> i;
    v_apath := format('$[%s]', i);
    v_reasons := '[]'::jsonb;
    v_rows := '[]'::jsonb;
    v_actions := '[]'::jsonb;
    v_id := NULL;
    v_alias := NULL;
    v_desc := '';
    v_enabled := true;

    IF jsonb_typeof(v_auto) IS DISTINCT FROM 'object' THEN
      v_out := v_out || jsonb_build_object('index', i, 'key', NULL, 'canon', NULL, 'reasons', jsonb_build_array(
        public.automation_reason(v_apath, 'An automation is a set of keys: id, alias, triggers and actions at least.')));
      CONTINUE;
    END IF;

    -- A key nothing here means is refused, never ignored.
    FOR v_key IN SELECT jsonb_object_keys(v_auto) LOOP
      IF NOT v_key = ANY (ARRAY['id', 'alias', 'description', 'enabled', 'triggers', 'conditions', 'actions']) THEN
        v_reasons := v_reasons || public.automation_reason(public.automation_path(v_apath, v_key), format(
          '`%s` is not a key an automation takes. Remove it. The keys are id, alias, description, enabled, triggers, conditions and actions.', v_key));
      END IF;
    END LOOP;

    -- id
    v_val := v_auto -> 'id';
    IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') !~ c_id THEN
      v_reasons := v_reasons || public.automation_reason(v_apath || '.id',
        '`id` is the automation''s fixed name: 1 to 64 lowercase letters, digits, hyphens or underscores, starting with a letter or a digit.');
    ELSE
      v_id := v_val #>> '{}';
      IF v_seen ? v_id THEN
        v_reasons := v_reasons || public.automation_reason(v_apath || '.id', format(
          '`%s` is already the id of the automation at %s. Give each automation its own id.', v_id, v_seen ->> v_id));
      ELSE
        v_seen := v_seen || jsonb_build_object(v_id, v_apath);
      END IF;
    END IF;

    -- alias
    v_val := v_auto -> 'alias';
    IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string'
       OR char_length(v_val #>> '{}') NOT BETWEEN 1 AND 120
       OR (v_val #>> '{}') !~ '^\S' OR (v_val #>> '{}') !~ '\S$' OR (v_val #>> '{}') ~ '[[:cntrl:]]' THEN
      v_reasons := v_reasons || public.automation_reason(v_apath || '.alias',
        '`alias` is the name the list shows: 1 to 120 characters, with no space or control character at either end.');
    ELSE
      v_alias := v_val #>> '{}';
    END IF;

    -- description
    IF v_auto ? 'description' THEN
      v_val := v_auto -> 'description';
      IF jsonb_typeof(v_val) <> 'string' OR char_length(v_val #>> '{}') > 1000 THEN
        v_reasons := v_reasons || public.automation_reason(v_apath || '.description',
          '`description` is text of at most 1,000 characters.');
      ELSE
        v_desc := v_val #>> '{}';
      END IF;
    END IF;

    -- enabled
    IF v_auto ? 'enabled' THEN
      v_val := v_auto -> 'enabled';
      IF jsonb_typeof(v_val) <> 'boolean' THEN
        v_reasons := v_reasons || public.automation_reason(v_apath || '.enabled', '`enabled` is true or false.');
      ELSE
        v_enabled := (v_val #>> '{}')::boolean;
      END IF;
    END IF;

    -- conditions: none exist yet, so only an absent or empty list is accepted.
    IF v_auto ? 'conditions' THEN
      v_val := v_auto -> 'conditions';
      v_ok := CASE WHEN jsonb_typeof(v_val) = 'array' THEN jsonb_array_length(v_val) > 0 ELSE true END;
      IF v_ok THEN
        v_reasons := v_reasons || public.automation_reason(v_apath || '.conditions',
          'This release has no condition types. Remove `conditions`, or leave it empty.');
      END IF;
    END IF;

    -- triggers
    v_list := v_auto -> 'triggers';
    IF v_list IS NULL OR jsonb_typeof(v_list) <> 'array' THEN
      v_reasons := v_reasons || public.automation_reason(v_apath || '.triggers',
        '`triggers` is the list of what starts the automation. Give a list, with at least one trigger unless `enabled` is false.');
    ELSIF jsonb_array_length(v_list) > c_max_triggers THEN
      v_reasons := v_reasons || public.automation_reason(v_apath || '.triggers',
        format('An automation takes at most %s triggers.', c_max_triggers));
    ELSE
      IF jsonb_array_length(v_list) = 0 AND v_enabled THEN
        v_reasons := v_reasons || public.automation_reason(v_apath || '.triggers',
          'An enabled automation needs a trigger. Add one, or set `enabled: false`.');
      END IF;
      FOR j IN 0 .. jsonb_array_length(v_list) - 1 LOOP
        v_trig := v_list -> j;
        v_tpath := format('%s.triggers[%s]', v_apath, j);
        IF jsonb_typeof(v_trig) <> 'object' THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath,
            'A trigger is a set of keys: trigger, device, metric and above or below.');
          CONTINUE;
        END IF;

        FOR v_key IN SELECT jsonb_object_keys(v_trig) LOOP
          IF NOT v_key = ANY (ARRAY['trigger', 'device', 'metric', 'above', 'below', 'for']) THEN
            v_reasons := v_reasons || public.automation_reason(public.automation_path(v_tpath, v_key), format(
              '`%s` is not a key a threshold trigger takes. Remove it. The keys are trigger, device, metric, above, below and for.', v_key));
          END IF;
        END LOOP;

        -- trigger: the type
        v_val := v_trig -> 'trigger';
        IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') <> 'threshold' THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath || '.trigger',
            '`trigger` names the type. This release has `threshold`.');
        END IF;

        -- metric: one in the catalogue, and a number
        v_metric := NULL;
        v_derived := false;
        v_val := v_trig -> 'metric';
        IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string' THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath || '.metric',
            '`metric` is the catalogue name of the reading, such as Spindle/LOAD.');
        ELSE
          v_metric := v_val #>> '{}';
          -- A derived metric is accepted: every one is a Double, and the evaluator reads its current value.
          -- Whether a device has it is asked with the device, below.
          SELECT m.datatype BETWEEN 1 AND 10, m.derivation IS NOT NULL INTO v_metric_ok, v_derived
            FROM public.metric_catalog m WHERE m.name = v_metric;
          IF v_metric_ok IS NULL THEN
            v_reasons := v_reasons || public.automation_reason(v_tpath || '.metric', format(
              '`%s` is not in the metric catalogue. Register it on the Metrics page first.', v_metric));
            v_metric := NULL;
          ELSIF NOT v_metric_ok THEN
            v_reasons := v_reasons || public.automation_reason(v_tpath || '.metric', format(
              '`%s` is not a number, so it has no threshold to compare with. Use a numeric metric.', v_metric));
            v_metric := NULL;
          END IF;
        END IF;

        -- above or below: exactly one, a number
        v_cmp := NULL;
        v_threshold := NULL;
        IF (v_trig ? 'above') AND (v_trig ? 'below') THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath, 'Give `above` or `below`, not both.');
        ELSIF NOT (v_trig ? 'above') AND NOT (v_trig ? 'below') THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath, 'A threshold trigger needs `above` or `below`.');
        ELSE
          v_cmp := CASE WHEN v_trig ? 'above' THEN 'above' ELSE 'below' END;
          v_val := v_trig -> v_cmp;
          v_ok := false;
          IF jsonb_typeof(v_val) = 'number' THEN
            v_num := (v_val #>> '{}')::numeric;
            IF abs(v_num) <= 1.7976931348623157e308::numeric THEN
              BEGIN
                v_threshold := v_num::double precision;
                v_ok := true;
              EXCEPTION WHEN numeric_value_out_of_range THEN
                v_ok := false;
              END;
            END IF;
          END IF;
          IF NOT v_ok THEN
            v_reasons := v_reasons || public.automation_reason(v_tpath || '.' || v_cmp,
              format('`%s` is a number, with no unit: the value is in the metric''s catalogue unit.', v_cmp));
            v_cmp := NULL;
          END IF;
        END IF;

        -- for: how long it must hold, 30s, 5m or 1h
        v_hold := 0;
        IF v_trig ? 'for' THEN
          v_val := v_trig -> 'for';
          IF jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') !~ c_for THEN
            v_reasons := v_reasons || public.automation_reason(v_tpath || '.for',
              '`for` is how long it must hold before it fires: a whole number and s, m or h, such as 30s, 5m or 1h, up to 999 of one unit.');
            v_hold := NULL;
          ELSE
            v_for := v_val #>> '{}';
            v_hold := substring(v_for FROM '^[0-9]+')::integer
                      * CASE right(v_for, 1) WHEN 's' THEN 1 WHEN 'm' THEN 60 ELSE 3600 END;
          END IF;
        END IF;

        -- device: one id or a list, each a device that exists and is not archived
        v_devs := NULL;
        v_val := v_trig -> 'device';
        v_dpath := v_tpath || '.device';
        v_dev_count := CASE WHEN jsonb_typeof(v_val) = 'array' THEN jsonb_array_length(v_val) ELSE 0 END;
        IF v_val IS NULL THEN
          v_reasons := v_reasons || public.automation_reason(v_dpath,
            '`device` is the id of the device to watch, or a list of ids. Copy them from the Devices page.');
        ELSIF jsonb_typeof(v_val) = 'string' THEN
          v_devs := jsonb_build_array(v_val);
        ELSIF jsonb_typeof(v_val) = 'array' AND v_dev_count BETWEEN 1 AND c_max_devices THEN
          v_devs := v_val;
        ELSE
          v_reasons := v_reasons || public.automation_reason(v_dpath, format(
            '`device` is a device id, or a list of 1 to %s of them.', c_max_devices));
        END IF;
        IF v_devs IS NOT NULL THEN
          v_dev_ids := ARRAY[]::text[];
          FOR k IN 0 .. jsonb_array_length(v_devs) - 1 LOOP
            -- Every device of every trigger is a row to check, so the whole file is bounded.
            v_visited := v_visited + 1;
            IF v_visited > c_max_rows THEN
              RETURN jsonb_build_array(jsonb_build_object('index', NULL, 'key', NULL, 'reasons', jsonb_build_array(
                public.automation_reason('$', format('A file holds at most %s devices across its triggers. Split it.', c_max_rows))),
                'canon', NULL));
            END IF;
            v_dev := v_devs -> k;
            IF jsonb_typeof(v_val) = 'array' THEN v_dpath := format('%s.device[%s]', v_tpath, k); END IF;
            v_dev_id := NULL;
            IF jsonb_typeof(v_dev) <> 'string' OR (v_dev #>> '{}') !~ c_uuid THEN
              v_reasons := v_reasons || public.automation_reason(v_dpath,
                'A device is named by its id: a lowercase uuid, as the Devices page shows it.');
            ELSIF (v_dev #>> '{}') = ANY (v_dev_ids) THEN
              v_reasons := v_reasons || public.automation_reason(v_dpath, 'This device is listed twice.');
            ELSE
              v_dev_id := v_dev #>> '{}';
              v_dev_ids := v_dev_ids || v_dev_id;
              SELECT NOT coalesce(d.is_archived, false) INTO v_ok FROM public.devices d WHERE d.id = v_dev_id::uuid;
              IF v_ok IS NULL THEN
                v_reasons := v_reasons || public.automation_reason(v_dpath, format(
                  'No device has the id %s. Copy an id from the Devices page.', v_dev_id));
                v_dev_id := NULL;
              ELSIF NOT v_ok THEN
                v_reasons := v_reasons || public.automation_reason(v_dpath, format(
                  'Device %s is archived. Restore it, or name another device.', v_dev_id));
                v_dev_id := NULL;
              END IF;
              IF v_dev_id IS NOT NULL AND v_metric IS NOT NULL AND v_derived
                 AND NOT EXISTS (SELECT 1 FROM public.device_derived_metrics(ARRAY[v_dev_id::uuid]) x WHERE x.metric_name = v_metric)
                 AND NOT EXISTS (SELECT 1 FROM public.automation_triggers t JOIN public.automations a ON a.id = t.automation_id
                                  WHERE a.key = v_id AND NOT t.is_archived
                                    AND t.entity_id = v_dev_id::uuid AND t.metric_name = v_metric) THEN
                v_reasons := v_reasons || public.automation_reason(
                  v_dpath, public.device_lacks_derived_metric_words(v_dev_id::uuid, v_metric));
                v_dev_id := NULL;
              END IF;
            END IF;
            IF v_dev_id IS NOT NULL AND v_metric IS NOT NULL AND v_cmp IS NOT NULL AND v_hold IS NOT NULL THEN
              v_rows := v_rows || jsonb_build_object(
                'position', j, 'device_position', k, 'kind', 'threshold', 'entity_id', v_dev_id,
                'metric_name', v_metric, 'comparison', v_cmp, 'threshold', to_jsonb(v_threshold),
                'hold_seconds', v_hold);
            END IF;
          END LOOP;
        END IF;
      END LOOP;
    END IF;

    -- actions: one `alert`
    v_list := v_auto -> 'actions';
    IF v_list IS NULL OR jsonb_typeof(v_list) <> 'array' THEN
      v_reasons := v_reasons || public.automation_reason(v_apath || '.actions',
        '`actions` is what the automation does. Give a list with one `alert`.');
    ELSIF jsonb_array_length(v_list) <> 1 THEN
      v_reasons := v_reasons || public.automation_reason(v_apath || '.actions',
        'An automation takes exactly one action in this release: an `alert`.');
    ELSE
      v_act := v_list -> 0;
      v_tpath := v_apath || '.actions[0]';
      IF jsonb_typeof(v_act) <> 'object' THEN
        v_reasons := v_reasons || public.automation_reason(v_tpath, 'An action is a set of keys: action and severity.');
      ELSE
        FOR v_key IN SELECT jsonb_object_keys(v_act) LOOP
          IF NOT v_key = ANY (ARRAY['action', 'severity']) THEN
            v_reasons := v_reasons || public.automation_reason(public.automation_path(v_tpath, v_key), format(
              '`%s` is not a key an alert action takes. Remove it. The keys are action and severity.', v_key));
          END IF;
        END LOOP;
        v_val := v_act -> 'action';
        IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') <> 'alert' THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath || '.action',
            '`action` names the type. This release has `alert`.');
        END IF;
        v_val := v_act -> 'severity';
        IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string'
           OR NOT (v_val #>> '{}') = ANY (ARRAY['critical', 'warning', 'info']) THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath || '.severity',
            '`severity` is critical, warning or info.');
        ELSE
          v_actions := jsonb_build_array(jsonb_build_object('position', 0, 'kind', 'alert', 'severity', v_val #>> '{}'));
        END IF;
      END IF;
    END IF;

    v_out := v_out || jsonb_build_object(
      'index', i, 'key', v_id, 'reasons', v_reasons,
      'canon', CASE WHEN jsonb_array_length(v_reasons) = 0 THEN
                 jsonb_build_object('key', v_id, 'alias', v_alias, 'description', v_desc, 'enabled', v_enabled,
                                    'rows', v_rows, 'actions', v_actions)
               END);
  END LOOP;
  RETURN v_out;
END
$$;

ALTER FUNCTION public.automations_parse(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automations_parse(jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automations_parse(jsonb) IS
  'Checks a document of automations and writes nothing: for each, {index, key, reasons, canon}. '
  'canon is the automation as it would be stored, typed and with its defaults explicit, and null '
  'when there is any reason to refuse it. Every reason is collected, each with a JSON path. '
  'Refuses a key it does not know, a metric that is not a number in the catalogue, a device that '
  'is not there or is archived, a derived metric the device does not have (unless the automation '
  'watches it already), and anything but one `threshold` trigger type and one `alert` action. Called by '
  'apply_automations() (0256, 0336).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
-- Structure, and what the two readers of a definition say of a few literals. Nothing is planted.
DO $check$
DECLARE
  v_fn  text;
  v_src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.schemas'::regclass AND attname = 'derived_metrics'
                    AND attnotnull AND NOT attisdropped AND atttypid = 'text[]'::regtype) THEN
    RAISE EXCEPTION '0336: schemas.derived_metrics is missing, admits NULL or is not text[]';
  END IF;
  -- The fill disables the audit trigger and the checking one for its own statement.
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.schemas'::regclass AND t.tgenabled <> 'D'
         AND t.tgname IN ('trg_schemas_derived_metrics', 'trg_schemas_audit_trail')) <> 2 THEN
    RAISE EXCEPTION '0336: trg_schemas_derived_metrics or trg_schemas_audit_trail is missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.metric_catalog'::regclass
                    AND t.tgname = 'trg_metric_catalog_derived_is_named' AND t.tgenabled <> 'D') THEN
    RAISE EXCEPTION '0336: trg_metric_catalog_derived_is_named is missing or disabled';
  END IF;
  -- The guard that freezes a published version reads every column but `status`, this one among them.
  IF position('(to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed)' IN
              (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.prevent_active_schema_mutation()'::regprocedure)) = 0
     OR position('allowed CONSTANT text[] := ARRAY[''status'']' IN
                 (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.prevent_active_schema_mutation()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0336: prevent_active_schema_mutation() no longer freezes every column but status';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY['public.derivation_input_names(jsonb)', 'public.schema_modelled_metrics(jsonb)',
                              'public.schema_derived_metric_problems(jsonb, text[], text[])',
                              'public.schemas_check_their_derived_metrics()',
                              'public.refuse_losing_a_named_derived_metric()',
                              'public.device_derived_metrics(uuid[])', 'public.device_lacks_derived_metric_words(uuid, text)',
                              'public.automations_parse(jsonb)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0336: a browser-facing role may execute %', v_fn;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = v_fn::regprocedure AND p.proconfig = ARRAY['search_path=public']) THEN
      RAISE EXCEPTION '0336: % does not pin its search_path', v_fn;
    END IF;
  END LOOP;

  IF public.derivation_input_names('{"kind": "sum", "inputs": [{"metric": "B/Y", "sign": 1}, {"metric": "A/X", "sign": -1}]}') <> ARRAY['B/Y', 'A/X']
     OR public.derivation_input_names('{"kind": "counter_rate", "input": "A/X"}') <> ARRAY['A/X']
     OR cardinality(public.derivation_input_names(NULL)) <> 0 THEN
    RAISE EXCEPTION '0336: derivation_input_names() does not name a definition''s inputs';
  END IF;
  IF (SELECT array_agg(n ORDER BY n) FROM unnest(public.schema_modelled_metrics(
        '{"properties": {"A/X": {}, "B/Y": {}}, "required": ["B/Y", "C/Z"]}')) n) IS DISTINCT FROM ARRAY['A/X', 'B/Y', 'C/Z']
     OR cardinality(public.schema_modelled_metrics('{"properties": ["A/X"]}')) <> 0 THEN
    RAISE EXCEPTION '0336: schema_modelled_metrics() does not name what a definition models';
  END IF;
  -- The document's check asks the rule, and the automation's own rows.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.automations_parse(jsonb)'::regprocedure;
  IF position('public.device_derived_metrics(ARRAY[v_dev_id::uuid])' IN v_src) = 0
     OR position('a.key = v_id AND NOT t.is_archived' IN v_src) = 0 THEN
    RAISE EXCEPTION '0336: automations_parse() does not ask whether the device has the derived metric, or whether the automation watches it already';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
