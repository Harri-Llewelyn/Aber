-- 0283: A threshold automation reads a derived metric.
--
-- 0270 reads each threshold pair's latest value from the historian's telemetry_latest. A derived
-- metric (0267) is published by no device and has no row there, so an automation on one was accepted
-- and never fired. This file declares the two reads again, after the function they call (0282):
--
--   * machine_condition_readings() gives a pair on a derived metric its current value from
--     derived_current() (0282): a counter rate and a time in state over the last hour, a sum at the
--     last whole minute. observed_at is the minute that window ends at. Its `for` and its hold work as
--     for any metric, since evaluate_automations() reads only the columns this returns, and they are
--     the same. A measured metric is read as it was: one remote query for each metric, carrying that
--     metric's devices. A derived metric's devices go to derived_current() in chunks of 500.
--   * machine_condition_rows() words the window in its detail: "Controller/PARTS_PER_HOUR is 4.2 over
--     the last hour, below 5". A derived value is rounded to three decimals there, where a measured
--     one is printed as it was read.
--
-- Neither function is granted to an API role, as in 0270.
--
-- Reasoning: supabase/README.md, "A threshold automation reads a derived metric (0283)", and the
-- section for 0270. Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The read
-- -------------------------------------------------------------------------------------------------
-- The output columns are 0270's, so 0270 can run again on the next boot (CREATE OR REPLACE cannot
-- change them) and this file declares the function again after it. A metric is derived by its
-- catalogue row, which is fixed once saved. The catalogue is joined on the name: a trigger names a
-- metric that is in the catalogue, but a row deleted since reads as measured and finds no value in
-- telemetry_latest, which is no reading.
CREATE OR REPLACE FUNCTION public.machine_condition_readings()
RETURNS TABLE (trigger_id uuid, entity_id uuid, metric_name text, comparison text, threshold double precision,
               value double precision, observed_at timestamp with time zone, breached boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  -- Devices one call of derived_current() carries: a call is bounded by its own cap, and a metric on
  -- more devices than that is read in parts.
  c_chunk CONSTANT integer := 500;
  v_metric record;
  v_part text[];
BEGIN
  FOR v_metric IN
    SELECT t.metric_name AS name, coalesce(bool_or(m.derivation IS NOT NULL), false) AS derived,
           array_agg(DISTINCT d.sparkplug_id) AS assets
      FROM public.automation_triggers t
      JOIN public.automations a ON a.id = t.automation_id AND a.enabled
      JOIN public.devices d ON d.id = t.entity_id AND NOT coalesce(d.is_archived, false)
      LEFT JOIN public.metric_catalog m ON m.name = t.metric_name
     WHERE t.kind = 'threshold' AND NOT t.is_archived AND d.sparkplug_id IS NOT NULL
     GROUP BY t.metric_name
     ORDER BY t.metric_name
  LOOP
    IF v_metric.derived THEN
      FOR v_at IN 1..cardinality(v_metric.assets) BY c_chunk LOOP
        v_part := v_metric.assets[v_at : v_at + c_chunk - 1];
        RETURN QUERY
        SELECT t.id, t.entity_id, t.metric_name, t.comparison, t.threshold, c.value, c.observed_at,
               CASE t.comparison WHEN 'above' THEN c.value > t.threshold ELSE c.value < t.threshold END
          FROM public.automation_triggers t
          JOIN public.automations a ON a.id = t.automation_id AND a.enabled
          JOIN public.devices d ON d.id = t.entity_id AND NOT coalesce(d.is_archived, false)
          JOIN public.derived_current(v_part, ARRAY[v_metric.name]) c
            ON c.asset_id = d.sparkplug_id AND c.metric_name = t.metric_name
         WHERE t.kind = 'threshold' AND NOT t.is_archived AND t.metric_name = v_metric.name
           AND d.sparkplug_id = ANY (v_part)
           AND c.value IS NOT NULL AND c.value <> 'NaN'::double precision;
      END LOOP;
    ELSE
      RETURN QUERY
      SELECT t.id, t.entity_id, t.metric_name, t.comparison, t.threshold, l.val_double, l."time",
             CASE t.comparison WHEN 'above' THEN l.val_double > t.threshold ELSE l.val_double < t.threshold END
        FROM public.automation_triggers t
        JOIN public.automations a ON a.id = t.automation_id AND a.enabled
        JOIN public.devices d ON d.id = t.entity_id AND NOT coalesce(d.is_archived, false)
        JOIN timescale.telemetry_latest l ON l.asset_id = d.sparkplug_id AND l.metric_name = t.metric_name
       WHERE t.kind = 'threshold' AND NOT t.is_archived AND t.metric_name = v_metric.name
         AND l.asset_id = ANY (v_metric.assets) AND l.metric_name = v_metric.name
         AND l.val_double IS NOT NULL AND l.val_double <> 'NaN'::double precision;
    END IF;
  END LOOP;
END
$$;

ALTER FUNCTION public.machine_condition_readings() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.machine_condition_readings() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.machine_condition_readings() IS
  'One row for each live threshold pair that has a value, with that value, when it arrived, the '
  'trigger''s comparison and threshold, and whether the value breaches. A measured metric''s value is '
  'its latest in the historian, one remote query for each metric carrying that metric''s devices. A '
  'derived metric''s is its current value from derived_current(): over the last hour for a counter rate '
  'and a time in state, at the last whole minute for a sum, observed_at being the minute that ends at. '
  'A pair with no value has no row. Raises when the historian cannot be read. Run by '
  'evaluate_automations() as the owner, and granted to no API role (0270, 0283).';

-- -------------------------------------------------------------------------------------------------
-- 2. The breaching ones, with the window in their words
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.machine_condition_rows()
RETURNS TABLE (condition text, sparkplug_id text, subject text, value numeric, detail text,
               trigger_id uuid, entity_id uuid, metric_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT 'threshold'::text,
         d.sparkplug_id,
         d.name,
         r.value::numeric,
         format('%s is %s%s, %s %s',
                r.metric_name,
                CASE WHEN m.derivation IS NULL THEN r.value::text ELSE trim_scale(round(r.value::numeric, 3))::text END,
                CASE public.derived_window_minutes(m.derivation) WHEN 60 THEN ' over the last hour' ELSE '' END,
                r.comparison, r.threshold),
         r.trigger_id,
         r.entity_id,
         r.metric_name
    FROM public.machine_condition_readings() r
    JOIN public.devices d ON d.id = r.entity_id
    LEFT JOIN public.metric_catalog m ON m.name = r.metric_name
   WHERE r.breached;
$$;

ALTER FUNCTION public.machine_condition_rows() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.machine_condition_rows() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.machine_condition_rows() IS
  'One row for each live threshold pair whose value breaches now, in the shape of '
  'platform_health_rows(): condition (threshold), sparkplug_id, subject (the device''s name), value and '
  'detail, with trigger_id, entity_id and metric_name. The detail of a derived metric says its window: '
  '"is 4.2 over the last hour, below 5". Not an arm of platform_health_rows(): a historian outage '
  'must not take the platform conditions down with it. Granted to no API role (0270, 0283).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn  text;
  v_src text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.machine_condition_readings()', 'public.machine_condition_rows()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0283: an API role may execute %', v_fn;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn::regprocedure AND p.prosecdef
                      AND p.proconfig @> ARRAY['search_path=public']) THEN
      RAISE EXCEPTION '0283: % is not SECURITY DEFINER with its search_path pinned', v_fn;
    END IF;
  END LOOP;

  -- A measured metric is still one remote query each carrying its devices, and a derived one reads
  -- through derived_current() and not telemetry_latest, which holds nothing under its name.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.machine_condition_readings()'::regprocedure;
  IF position('FOR v_metric IN' IN v_src) = 0 OR position('= ANY (v_metric.assets)' IN v_src) = 0
     OR position('= v_metric.name' IN v_src) = 0 OR position('timescale.telemetry_latest' IN v_src) = 0
     OR position('public.derived_current(' IN v_src) = 0 THEN
    RAISE EXCEPTION '0283: machine_condition_readings() no longer reads a measured metric from the historian one metric at a time, or a derived one through derived_current()';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.machine_condition_rows()'::regprocedure;
  IF position('public.derived_window_minutes(' IN v_src) = 0 THEN
    RAISE EXCEPTION '0283: machine_condition_rows() no longer words a derived metric''s window from derived_window_minutes()';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
