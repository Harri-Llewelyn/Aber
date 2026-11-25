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
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
-- Structure, and what the two readers of a definition say of a few literals. Nothing is planted.
DO $check$
DECLARE
  v_fn text;
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
                              'public.refuse_losing_a_named_derived_metric()'] LOOP
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
END
$check$;

NOTIFY pgrst, 'reload schema';
