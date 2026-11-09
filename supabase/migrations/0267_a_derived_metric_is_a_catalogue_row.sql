-- 0267: A derived metric is a catalogue row.
--
-- A derived metric is a `metric_catalog` row with its definition on the row, so the schema builder,
-- the AAS exporter and the telemetry export still read one table. Nothing computes it yet, and
-- nothing is stored for it: the definition is what a later read fills a query template from.
--
--   * `derivation` is NULL for a measured metric, as every row is today. A derived one holds one of
--     three kinds as jsonb, which derivation_shape_problem() checks (the CHECK below):
--         {"kind": "counter_rate",  "input": "<name>"}
--         {"kind": "time_in_state", "input": "<name>", "states": ["<state>", ...]}
--         {"kind": "sum",           "inputs": [{"metric": "<name>", "sign": 1 | -1}, ...]}
--   * enforce_derived_metric() runs BEFORE INSERT OR UPDATE and refuses, with a reason the dialog
--     shows: an input that is missing, derived, or of the wrong datatype; the inputs of a sum
--     disagreeing on a unit; a state its input cannot report; a name any device has declared; a
--     semantic id, standard or permitted values; a measured metric made derived; and a derived
--     metric's definition or unit changed. The unit is the trigger's to set, from the inputs.
--   * The writers are the table's own policies, Administrator only behind require_mfa(), as for any
--     catalogue row. The audit trigger files the change as it files any catalogue change.
--
-- Reasoning: supabase/README.md, "A derived metric is a catalogue row (0267)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The column
-- -------------------------------------------------------------------------------------------------
ALTER TABLE public.metric_catalog ADD COLUMN IF NOT EXISTS derivation jsonb;

COMMENT ON COLUMN public.metric_catalog.derivation IS 'NULL for a measured metric. For a derived one, its definition: {"kind": "counter_rate", "input": name}, {"kind": "time_in_state", "input": name, "states": [...]} or {"kind": "sum", "inputs": [{"metric": name, "sign": 1 or -1}, ...]}. Fixed once the row exists, and never an input of another derived metric (0267).';

-- -------------------------------------------------------------------------------------------------
-- 2. The shape of a definition
-- -------------------------------------------------------------------------------------------------
-- The first thing wrong with a definition's shape, or NULL. The facts about other rows (an input
-- exists, is measured, shares a unit) are the trigger's. A sum has two to eight inputs: a limit
-- that can be raised later, where one added later could not be applied to a row already saved.
CREATE OR REPLACE FUNCTION public.derivation_shape_problem(p_derivation jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  c_name       CONSTANT text    := '^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$';
  c_max_inputs CONSTANT integer := 8;
  v_kind   text;
  v_keys   text[];
  v_item   jsonb;
  v_names  text[] := ARRAY[]::text[];
  v_name   text;
BEGIN
  IF jsonb_typeof(p_derivation) IS DISTINCT FROM 'object' THEN
    RETURN 'a definition is a JSON object';
  END IF;
  IF jsonb_typeof(p_derivation -> 'kind') IS DISTINCT FROM 'string'
     OR (p_derivation ->> 'kind') NOT IN ('counter_rate', 'time_in_state', 'sum') THEN
    RETURN 'its kind is counter_rate, time_in_state or sum';
  END IF;
  v_kind := p_derivation ->> 'kind';
  SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(p_derivation) AS k;

  IF v_kind IN ('counter_rate', 'time_in_state') THEN
    IF v_keys IS DISTINCT FROM (CASE v_kind WHEN 'counter_rate' THEN ARRAY['input', 'kind']
                                            ELSE ARRAY['input', 'kind', 'states'] END) THEN
      RETURN 'a ' || v_kind || ' has '
             || (CASE v_kind WHEN 'counter_rate' THEN 'a kind and an input' ELSE 'a kind, an input and states' END)
             || ', and nothing else';
    END IF;
    IF jsonb_typeof(p_derivation -> 'input') IS DISTINCT FROM 'string' OR (p_derivation ->> 'input') !~ c_name THEN
      RETURN 'its input is a metric name';
    END IF;
    IF v_kind = 'time_in_state' THEN
      IF jsonb_typeof(p_derivation -> 'states') IS DISTINCT FROM 'array'
         OR jsonb_array_length(p_derivation -> 'states') = 0 THEN
        RETURN 'its states are a list of at least one';
      END IF;
      FOR v_item IN SELECT * FROM jsonb_array_elements(p_derivation -> 'states') LOOP
        IF jsonb_typeof(v_item) IS DISTINCT FROM 'string' OR (v_item #>> '{}') = '' THEN
          RETURN 'each state is a non-empty string';
        END IF;
        v_name := v_item #>> '{}';
        IF v_name = ANY (v_names) THEN
          RETURN 'each state is named once';
        END IF;
        v_names := v_names || v_name;
      END LOOP;
    END IF;
    RETURN NULL;
  END IF;

  IF v_keys IS DISTINCT FROM ARRAY['inputs', 'kind'] THEN
    RETURN 'a sum has a kind and inputs, and nothing else';
  END IF;
  IF jsonb_typeof(p_derivation -> 'inputs') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_derivation -> 'inputs') NOT BETWEEN 2 AND c_max_inputs THEN
    RETURN 'a sum has two to ' || c_max_inputs::text || ' inputs';
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_derivation -> 'inputs') LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_item) AS k) IS DISTINCT FROM ARRAY['metric', 'sign'] THEN
      RETURN 'each input of a sum is a metric and a sign';
    END IF;
    IF jsonb_typeof(v_item -> 'metric') IS DISTINCT FROM 'string' OR (v_item ->> 'metric') !~ c_name THEN
      RETURN 'each input is a metric name';
    END IF;
    IF jsonb_typeof(v_item -> 'sign') IS DISTINCT FROM 'number' OR (v_item ->> 'sign')::numeric NOT IN (1, -1) THEN
      RETURN 'each sign is 1 or -1';
    END IF;
    v_name := v_item ->> 'metric';
    IF v_name = ANY (v_names) THEN
      RETURN 'each input appears once';
    END IF;
    v_names := v_names || v_name;
  END LOOP;
  RETURN NULL;
END
$$;

ALTER FUNCTION public.derivation_shape_problem(jsonb) OWNER TO postgres;
-- The CHECK below runs as the writer, so the writing role needs EXECUTE; anon writes nothing.
REVOKE ALL ON FUNCTION public.derivation_shape_problem(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.derivation_shape_problem(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.derivation_shape_problem(jsonb) IS 'The first thing wrong with the shape of a derived metric''s definition (metric_catalog.derivation), or NULL: one of three kinds, each with only its own keys, names in the metric name format, a sum of two to eight inputs each signed 1 or -1. Facts about other rows are enforce_derived_metric()''s (0267).';

-- Guarded, never dropped and re-added: the column is new, so the first scan reads no value.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_derivation_shape'
                    AND conrelid = 'public.metric_catalog'::regclass) THEN
    ALTER TABLE public.metric_catalog
      ADD CONSTRAINT metric_catalog_derivation_shape
      CHECK (derivation IS NULL OR public.derivation_shape_problem(derivation) IS NULL);
  END IF;
END
$$;

-- -------------------------------------------------------------------------------------------------
-- 3. What may be saved
-- -------------------------------------------------------------------------------------------------
-- SECURITY DEFINER so the checks read every device and every catalogue row whatever the writer's
-- policies show; it writes nothing but the row's unit. BEFORE, so a refusal names its reason before
-- the CHECK's own words, and the unit is set by the INSERT that saves the row.
CREATE OR REPLACE FUNCTION public.enforce_derived_metric() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  c_hour_suffix CONSTANT text := '/HOUR';
  v_problem text;
  v_kind    text;
  v_names   text[];
  v_in      record;
  v_unit    text;
  v_first_name  text;
  v_first_units text;
  v_have_first  boolean := false;
  v_state   text;
  v_devices bigint;
  v_device  text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.derivation IS NULL AND NEW.derivation IS NOT NULL THEN
      RAISE EXCEPTION 'A measured metric cannot become a derived one: devices may already publish it, and its history would mix two sources under one name. Add a derived metric under a new name.'
            USING ERRCODE = '23514';
    END IF;
    IF OLD.derivation IS NOT NULL AND NEW.derivation IS DISTINCT FROM OLD.derivation THEN
      RAISE EXCEPTION 'A derived metric''s definition cannot be changed, because nothing is stored and a change would alter every past value. Add a new derived metric, and deprecate this one with the new one as its replacement.'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.derivation IS NOT NULL AND NEW.units IS DISTINCT FROM OLD.units THEN
      RAISE EXCEPTION 'A derived metric''s unit follows its inputs and cannot be changed.'
            USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.derivation IS NULL THEN
    RETURN NEW;
  END IF;

  v_problem := public.derivation_shape_problem(NEW.derivation);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'The definition of a derived metric is malformed: %.', v_problem USING ERRCODE = '23514';
  END IF;
  v_kind := NEW.derivation ->> 'kind';

  -- A local extension, computed: nothing a standard names, nothing a device reports.
  IF NEW.datatype <> 10 THEN
    RAISE EXCEPTION 'A derived metric is a Double: its value is computed as a number.' USING ERRCODE = '23514';
  END IF;
  IF NEW.semantic_id IS NOT NULL OR NEW.semantic_id_type IS NOT NULL THEN
    RAISE EXCEPTION 'A derived metric carries no semantic id: it is a local extension, and its definition says where its value comes from.'
          USING ERRCODE = '23514';
  END IF;
  IF NEW.standard IS NOT NULL THEN
    RAISE EXCEPTION 'A derived metric is a local extension, so it names no standard.' USING ERRCODE = '23514';
  END IF;
  IF NEW.permitted_values IS NOT NULL THEN
    RAISE EXCEPTION 'A derived metric has no permitted values: its value is computed.' USING ERRCODE = '23514';
  END IF;

  -- An UPDATE reaching here changed nothing about the definition, so only an INSERT checks the rest.
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;

  -- A name a device has declared is one it may publish: two sources under one series.
  SELECT count(*), min(d.name) INTO v_devices, v_device
    FROM public.devices d
   WHERE NEW.name = ANY (d.last_birth_metrics);
  IF v_devices > 0 THEN
    RAISE EXCEPTION '% is a name % declares, so a derived metric cannot take it: both would put readings in one series. Choose a name no device publishes.',
          NEW.name,
          CASE WHEN v_devices = 1 THEN format('the device %s', v_device)
               ELSE format('the device %s and %s more', v_device, v_devices - 1) END
          USING ERRCODE = '23514';
  END IF;

  v_names := CASE v_kind
    WHEN 'sum' THEN ARRAY(SELECT i ->> 'metric' FROM jsonb_array_elements(NEW.derivation -> 'inputs') AS i)
    ELSE ARRAY[NEW.derivation ->> 'input']
  END;

  -- Every input is a measured metric of the right kind of value.
  FOR v_in IN
    SELECT n.name, n.ord, c.id, c.datatype, c.units, c.derivation, c.permitted_values
      FROM unnest(v_names) WITH ORDINALITY AS n(name, ord)
      LEFT JOIN public.metric_catalog c ON c.name = n.name
     ORDER BY n.ord
  LOOP
    IF v_in.id IS NULL THEN
      RAISE EXCEPTION '% is not in the catalogue. Add it before building a derived metric on it.', v_in.name
            USING ERRCODE = '23514';
    END IF;
    IF v_in.derivation IS NOT NULL THEN
      RAISE EXCEPTION '% is itself a derived metric. A derived metric cannot be built on another.', v_in.name
            USING ERRCODE = '23514';
    END IF;
    IF v_kind = 'time_in_state' THEN
      IF v_in.datatype NOT IN (11, 12, 14) THEN
        RAISE EXCEPTION '%: a time in state needs a string or a boolean metric, and this one is a number.', v_in.name
              USING ERRCODE = '23514';
      END IF;
    ELSIF v_in.datatype NOT BETWEEN 1 AND 10 THEN
      RAISE EXCEPTION '%: a % needs a numeric metric, and this one is %.', v_in.name,
            CASE v_kind WHEN 'sum' THEN 'sum' ELSE 'counter rate' END,
            CASE WHEN v_in.datatype = 11 THEN 'a boolean' WHEN v_in.datatype IN (12, 14, 15) THEN 'a string' ELSE 'not a number' END
            USING ERRCODE = '23514';
    END IF;

    IF v_kind = 'time_in_state' THEN
      FOR v_state IN SELECT s #>> '{}' FROM jsonb_array_elements(NEW.derivation -> 'states') AS s LOOP
        IF v_in.datatype = 11 AND v_state NOT IN ('true', 'false') THEN
          RAISE EXCEPTION '%: a boolean reports true or false, and "%" is neither.', v_in.name, v_state
                USING ERRCODE = '23514';
        ELSIF v_in.permitted_values IS NOT NULL AND NOT v_state = ANY (v_in.permitted_values) THEN
          RAISE EXCEPTION '"%" is not a value % may report (%).', v_state, v_in.name, array_to_string(v_in.permitted_values, ', ')
                USING ERRCODE = '23514';
        END IF;
      END LOOP;
    END IF;

    -- The inputs of a sum share one unit, none included.
    IF v_kind = 'sum' THEN
      IF NOT v_have_first THEN
        v_have_first := true; v_first_name := v_in.name; v_first_units := v_in.units;
      ELSIF v_in.units IS DISTINCT FROM v_first_units THEN
        RAISE EXCEPTION 'The inputs of a sum must share one unit: % is in % and % is in %.',
              v_first_name, coalesce(v_first_units, 'no unit'), v_in.name, coalesce(v_in.units, 'no unit')
              USING ERRCODE = '23514';
      END IF;
    END IF;
    v_unit := v_in.units;
  END LOOP;

  -- The unit follows the inputs: a rate is the input's unit per hour (a counter with none counts
  -- occurrences), a ratio has none, and a sum takes the one its inputs share.
  v_unit := CASE v_kind
    WHEN 'counter_rate' THEN coalesce(v_unit, 'COUNT') || c_hour_suffix
    WHEN 'time_in_state' THEN NULL
    ELSE v_unit
  END;
  IF NEW.units IS NOT NULL AND NEW.units IS DISTINCT FROM v_unit THEN
    RAISE EXCEPTION 'A derived metric takes its unit from its inputs (%). Leave Units empty.',
          coalesce(v_unit, 'none') USING ERRCODE = '23514';
  END IF;
  NEW.units := v_unit;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.enforce_derived_metric() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_derived_metric() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_derived_metric() IS 'Trigger function on metric_catalog: refuses a derived metric whose input is missing, derived or of the wrong datatype, whose sum mixes units, whose state its input cannot report, whose name a device has declared, or that carries a semantic id, standard or permitted values; sets its unit from its inputs; and refuses to make a measured metric derived or to change a derived metric''s definition or unit (0267).';

SELECT public.replay_trigger('public.metric_catalog', 'trg_metric_catalog_derivation', $ddl$
CREATE TRIGGER trg_metric_catalog_derivation BEFORE INSERT OR UPDATE ON public.metric_catalog FOR EACH ROW EXECUTE FUNCTION public.enforce_derived_metric();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 4. Self-check
-- -------------------------------------------------------------------------------------------------
-- Of the shapes and of what the shape function says about a few definitions; no row is read, since
-- a row a writer saves while this runs is the trigger's to judge.
DO $check$
DECLARE
  v_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'metric_catalog'
                    AND column_name = 'derivation' AND data_type = 'jsonb') THEN
    RAISE EXCEPTION '0267: metric_catalog has no jsonb derivation column';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_derivation_shape' AND conrelid = 'public.metric_catalog'::regclass) THEN
    RAISE EXCEPTION '0267: metric_catalog_derivation_shape is missing';
  END IF;

  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.metric_catalog'::regclass AND t.tgname = 'trg_metric_catalog_derivation';
  IF v_def IS NULL OR position('BEFORE INSERT OR UPDATE' IN v_def) = 0 THEN
    RAISE EXCEPTION '0267: trg_metric_catalog_derivation is not BEFORE INSERT OR UPDATE (found %)', v_def;
  END IF;

  IF public.derivation_shape_problem('{"kind": "counter_rate", "input": "Controller/PART_COUNT"}') IS NOT NULL
     OR public.derivation_shape_problem('{"kind": "time_in_state", "input": "Controller/EXECUTION", "states": ["ACTIVE"]}') IS NOT NULL
     OR public.derivation_shape_problem('{"kind": "sum", "inputs": [{"metric": "A/X", "sign": 1}, {"metric": "A/Y", "sign": -1}]}') IS NOT NULL THEN
    RAISE EXCEPTION '0267: derivation_shape_problem() refuses a well-formed definition';
  END IF;
  IF public.derivation_shape_problem('{"kind": "average", "input": "A/X"}') IS NULL
     OR public.derivation_shape_problem('{"kind": "counter_rate", "input": "A/X", "states": ["ACTIVE"]}') IS NULL
     OR public.derivation_shape_problem('{"kind": "sum", "inputs": [{"metric": "A/X", "sign": 1}]}') IS NULL
     OR public.derivation_shape_problem('{"kind": "sum", "inputs": [{"metric": "A/X", "sign": 2}, {"metric": "A/Y", "sign": 1}]}') IS NULL
     OR public.derivation_shape_problem('[]') IS NULL THEN
    RAISE EXCEPTION '0267: derivation_shape_problem() accepts a malformed definition';
  END IF;

  IF has_function_privilege('anon', 'public.derivation_shape_problem(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.enforce_derived_metric()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_derived_metric()', 'EXECUTE') THEN
    RAISE EXCEPTION '0267: a browser-facing role may execute a function it should not';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.derivation_shape_problem(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '0267: authenticated may not execute derivation_shape_problem(), which the CHECK calls as the writer';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
