-- 0283: A threshold automation reads a derived metric.
--
-- 0270 reads each threshold pair's latest value from the historian's telemetry_latest. A derived
-- metric (0267) is published by no device and has no row there, so an automation on one was accepted
-- and never fired. This file declares the two reads again, after the function they call (0282), and
-- the evaluator that words what they found:
--
--   * machine_condition_readings() gives a pair on a derived metric its current value from
--     derived_current() (0282): a counter rate and a time in state over the last hour, a sum at the
--     last whole minute. observed_at is the minute that window ends at. Its `for` and its hold work as
--     for any metric, since evaluate_automations() reads only the columns this returns, and they are
--     the same. A measured metric is read as it was: one remote query for each metric, carrying that
--     metric's devices. A derived metric's devices go to derived_current() in chunks of 500.
--   * automation_value_words() is the one place a value becomes words: a derived metric's value
--     rounded to three decimals and followed by its window ("4.167 over the last hour", "7 at the
--     last whole minute"), a measured one's exactly as it was printed before.
--   * machine_condition_rows() words its detail with it: "Controller/PARTS_PER_HOUR is 4.167 over the
--     last hour, below 5".
--   * evaluate_automations() is declared again with one change, the summary of the alert it writes,
--     which words the value with it: "Press 1: Controller/PARTS_PER_HOUR is 4.167 over the last hour,
--     below 5 for 10m". What is compared, and the values.value the row keeps, stay unrounded.
--
-- No function here is granted to an API role, as in 0270 and 0271.
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
-- 2. A value in words
-- -------------------------------------------------------------------------------------------------
-- The one place the detail and the alert's summary say a value. A metric with no catalogue row, or a
-- measured one, is the value as it prints (p_value::text, which is what format('%s') prints too), so
-- a measured alert reads as it did. A derived one is trimmed to the three decimals a person can use
-- and followed by the window its current value is over, from derived_window_minutes() (0282).
CREATE OR REPLACE FUNCTION public.automation_value_words(p_metric text, p_value double precision) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
           WHEN m.derivation IS NULL THEN p_value::text
           ELSE trim_scale(round(p_value::numeric, 3))::text
                || CASE public.derived_window_minutes(m.derivation) WHEN 0 THEN ' at the last whole minute' ELSE ' over the last hour' END
         END
    FROM (SELECT 1) AS one
    LEFT JOIN public.metric_catalog m ON m.name = p_metric;
$$;

ALTER FUNCTION public.automation_value_words(text, double precision) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_value_words(text, double precision) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automation_value_words(text, double precision) IS
  'A threshold value in words, for an automation''s detail and its alert''s summary: a derived metric''s '
  'value rounded to three decimals and followed by its window ("4.167 over the last hour", "7 at the '
  'last whole minute"), any other value as it prints. Granted to no API role (0283).';

-- -------------------------------------------------------------------------------------------------
-- 3. The breaching ones, with the window in their words
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
         format('%s is %s, %s %s', r.metric_name, public.automation_value_words(r.metric_name, r.value), r.comparison, r.threshold),
         r.trigger_id,
         r.entity_id,
         r.metric_name
    FROM public.machine_condition_readings() r
    JOIN public.devices d ON d.id = r.entity_id
   WHERE r.breached;
$$;

ALTER FUNCTION public.machine_condition_rows() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.machine_condition_rows() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.machine_condition_rows() IS
  'One row for each live threshold pair whose value breaches now, in the shape of '
  'platform_health_rows(): condition (threshold), sparkplug_id, subject (the device''s name), value and '
  'detail, with trigger_id, entity_id and metric_name. The detail of a derived metric says its window: '
  '"is 4.167 over the last hour, below 5". Not an arm of platform_health_rows(): a historian outage '
  'must not take the platform conditions down with it. Granted to no API role (0270, 0283).';

-- -------------------------------------------------------------------------------------------------
-- 4. The evaluator, with the value in words
-- -------------------------------------------------------------------------------------------------
-- 0271's function with one change: the summary of an alert it raises says the value through
-- automation_value_words(), so a derived metric's alert reads "4.167 over the last hour" and not
-- 4.166666666666667. Everything else, what is compared and the values the row keeps included, is
-- 0271's, which runs first on every boot and which the job would run in between.
CREATE OR REPLACE FUNCTION public.evaluate_automations(p_at timestamp with time zone DEFAULT now()) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  c_not_evaluated CONSTANT text := 'condition:not-evaluated';
  v_read     integer;
  v_failed   boolean := false;
  v_sqlstate text;
  v_message  text;
BEGIN
  -- One run at a time: a run started by hand while pg_cron's is under way finds nothing to do.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('evaluate_automations', 0)) THEN
    RETURN 0;
  END IF;

  BEGIN
    INSERT INTO public.automation_trigger_states AS s
           (trigger_id, entity_id, metric_name, last_evaluated_at, last_value, last_observed_at, comparison, threshold)
    SELECT r.trigger_id, r.entity_id, r.metric_name, p_at, r.value, r.observed_at, r.comparison, r.threshold
      FROM public.machine_condition_readings() r
    ON CONFLICT (trigger_id, entity_id, metric_name) DO UPDATE
       SET last_evaluated_at = excluded.last_evaluated_at,
           last_value = excluded.last_value,
           last_observed_at = excluded.last_observed_at,
           pending_since = CASE WHEN (s.comparison, s.threshold) IS DISTINCT FROM (excluded.comparison, excluded.threshold)
                                THEN NULL ELSE s.pending_since END,
           comparison = excluded.comparison,
           threshold = excluded.threshold;
    GET DIAGNOSTICS v_read = ROW_COUNT;
  EXCEPTION
    WHEN foreign_key_violation OR deadlock_detected OR serialization_failure THEN
      RETURN 0;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
      v_failed := true;
  END;

  IF v_failed THEN
    RAISE WARNING 'evaluate_automations: the historian could not be read (%): %', v_sqlstate, v_message;
    INSERT INTO public.platform_alerts (fingerprint, entity_type, alert_name, severity, status, summary, starts_at,
                                        labels, last_confirmed_at)
    SELECT c_not_evaluated, 'platform', 'Automations Not Evaluated', 'warning', 'firing',
           format('The historian could not be read (SQLSTATE %s), so no automation was judged. Alerts that were firing stay as they are.',
                  v_sqlstate),
           p_at, jsonb_build_object('severity', 'warning', 'entity_type', 'platform'), p_at
     WHERE NOT EXISTS (SELECT 1 FROM public.platform_alerts p WHERE p.fingerprint = c_not_evaluated AND p.status = 'firing');
    UPDATE public.platform_alerts p
       SET last_confirmed_at = p_at
     WHERE p.fingerprint = c_not_evaluated AND p.status = 'firing' AND p.last_confirmed_at IS DISTINCT FROM p_at;
    RETURN 0;
  END IF;

  -- The run read, so it was evaluated: the alert that said it could not is over.
  UPDATE public.platform_alerts p
     SET status = 'resolved', ends_at = greatest(p_at, p.starts_at)
   WHERE p.fingerprint = c_not_evaluated AND p.status = 'firing';

  -- What is no longer live: the key names the device and the metric, so a trigger given another of
  -- either leaves its old row here.
  DELETE FROM public.automation_trigger_states s
   WHERE NOT EXISTS (SELECT 1
                       FROM public.automation_triggers t
                       JOIN public.automations a ON a.id = t.automation_id AND a.enabled
                       JOIN public.devices d ON d.id = t.entity_id AND NOT coalesce(d.is_archived, false)
                      WHERE t.id = s.trigger_id AND t.entity_id = s.entity_id AND t.metric_name = s.metric_name
                        AND t.kind = 'threshold' AND NOT t.is_archived);

  -- Firing is what platform_alerts says, for the pairs read this run.
  UPDATE public.automation_trigger_states s
     SET firing_since = o.since,
         pending_since = CASE WHEN o.since IS NULL THEN s.pending_since END
    FROM (SELECT x.trigger_id, x.entity_id, x.metric_name,
                 (SELECT p.starts_at
                    FROM public.platform_alerts p
                   WHERE p.fingerprint = public.automation_alert_fingerprint(x.trigger_id, x.entity_id, x.metric_name)
                     AND p.status = 'firing'
                   ORDER BY p.starts_at DESC
                   LIMIT 1) AS since
            FROM public.automation_trigger_states x
           WHERE x.last_evaluated_at = p_at) o
   WHERE s.trigger_id = o.trigger_id AND s.entity_id = o.entity_id AND s.metric_name = o.metric_name
     AND s.firing_since IS DISTINCT FROM o.since;

  -- What stopped breaching resolves, as a resolved notification from Grafana does.
  UPDATE public.platform_alerts p
     SET status = 'resolved', ends_at = greatest(p_at, p.starts_at)
   WHERE p.status = 'firing'
     AND p.fingerprint IN (SELECT public.automation_alert_fingerprint(s.trigger_id, s.entity_id, s.metric_name)
                             FROM public.automation_trigger_states s
                            WHERE s.last_evaluated_at = p_at
                              AND NOT (CASE s.comparison WHEN 'above' THEN s.last_value > s.threshold
                                                         ELSE s.last_value < s.threshold END));
  UPDATE public.automation_trigger_states s
     SET pending_since = NULL, firing_since = NULL
   WHERE s.last_evaluated_at = p_at
     AND (s.pending_since IS NOT NULL OR s.firing_since IS NOT NULL)
     AND NOT (CASE s.comparison WHEN 'above' THEN s.last_value > s.threshold ELSE s.last_value < s.threshold END);

  -- What breaches: it begins to be pending, stays pending, or has held its time and fires.
  WITH due AS (
    SELECT s.trigger_id, s.entity_id, s.metric_name, s.last_value, s.comparison, s.threshold,
           s.firing_since IS NULL
             AND p_at - coalesce(s.pending_since, p_at) >= make_interval(secs => t.hold_seconds) AS fires
      FROM public.automation_trigger_states s
      JOIN public.automation_triggers t ON t.id = s.trigger_id
     WHERE s.last_evaluated_at = p_at
       AND (CASE s.comparison WHEN 'above' THEN s.last_value > s.threshold ELSE s.last_value < s.threshold END)
  ), moved AS (
    UPDATE public.automation_trigger_states s
       SET pending_since = CASE WHEN d.fires OR s.firing_since IS NOT NULL THEN NULL
                                ELSE coalesce(s.pending_since, p_at) END,
           firing_since = CASE WHEN d.fires THEN p_at ELSE s.firing_since END
      FROM due d
     WHERE s.trigger_id = d.trigger_id AND s.entity_id = d.entity_id AND s.metric_name = d.metric_name
    RETURNING s.trigger_id
  )
  INSERT INTO public.platform_alerts (fingerprint, entity_type, entity_id, sparkplug_id, alert_name, severity, status,
                                      summary, starts_at, rule_uid, labels, "values", last_confirmed_at)
  SELECT public.automation_alert_fingerprint(d.trigger_id, d.entity_id, d.metric_name),
         'device', dev.id, dev.sparkplug_id, a.alias, act.severity, 'firing',
         format('%s: %s is %s, %s %s%s', dev.name, d.metric_name, public.automation_value_words(d.metric_name, d.last_value),
                d.comparison, d.threshold,
                CASE WHEN t.hold_seconds > 0 THEN ' for ' || public.automation_duration_text(t.hold_seconds) ELSE '' END),
         p_at, NULL,
         jsonb_build_object('severity', act.severity, 'entity_type', 'device', 'metric', d.metric_name,
                            'automation', a.key, 'trigger_id', d.trigger_id::text),
         jsonb_build_object('value', d.last_value, 'threshold', d.threshold),
         p_at
    FROM due d
    JOIN public.automation_triggers t ON t.id = d.trigger_id
    JOIN public.automations a ON a.id = t.automation_id
    JOIN public.devices dev ON dev.id = d.entity_id
   CROSS JOIN LATERAL (SELECT ac.severity
                         FROM public.automation_actions ac
                        WHERE ac.automation_id = a.id AND ac.kind = 'alert'
                        ORDER BY ac.position
                        LIMIT 1) act
   WHERE d.fires;

  -- Every firing row is confirmed by the run that holds it, a pair that returned no value included.
  -- It changes no status, so it queues nothing.
  UPDATE public.platform_alerts p
     SET last_confirmed_at = p_at
   WHERE p.status = 'firing' AND p.last_confirmed_at IS DISTINCT FROM p_at
     AND p.fingerprint IN (SELECT public.automation_alert_fingerprint(s.trigger_id, s.entity_id, s.metric_name)
                             FROM public.automation_trigger_states s
                            WHERE s.firing_since IS NOT NULL);

  RETURN v_read;
END
$$;

ALTER FUNCTION public.evaluate_automations(timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.evaluate_automations(timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.evaluate_automations(timestamp with time zone) IS
  'The evaluator pg_cron runs every minute. Reads the historian through machine_condition_readings(), '
  'keeps what it found in automation_trigger_states, fires a breach that has held for its `for` and '
  'resolves one that stopped, writing platform_alerts under automation_alert_fingerprint() and '
  'stamping last_confirmed_at on every row it holds firing. The summary words the value through '
  'automation_value_words(): a derived metric''s rounded, with its window. A pair with no value is left as '
  'it was. A run that cannot read the historian writes nothing but one platform alert, Automations Not '
  'Evaluated, which the next run that reads resolves. Returns how many pairs it read. p_at is the '
  'instant to judge at, now() for the job. Granted to no API role (0271, 0283).';

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
  IF position('public.automation_value_words(' IN v_src) = 0 THEN
    RAISE EXCEPTION '0283: machine_condition_rows() no longer words its value with automation_value_words()';
  END IF;
  -- The evaluator is still 0271's, composing fingerprints in one place and reading through the one
  -- function, and it says its value with the same words the detail does.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.evaluate_automations(timestamp with time zone)'::regprocedure;
  IF position('public.automation_value_words(' IN v_src) = 0
     OR position('public.automation_alert_fingerprint(' IN v_src) = 0
     OR position('public.machine_condition_readings()' IN v_src) = 0
     OR position('''condition:'' ||' IN v_src) <> 0 THEN
    RAISE EXCEPTION '0283: evaluate_automations() does not word its value with automation_value_words(), or has lost what 0271 holds of it';
  END IF;
  IF has_function_privilege('anon', 'public.evaluate_automations(timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.evaluate_automations(timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.evaluate_automations(timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.automation_value_words(text, double precision)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.automation_value_words(text, double precision)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.automation_value_words(text, double precision)', 'EXECUTE') THEN
    RAISE EXCEPTION '0283: an API role may execute evaluate_automations() or automation_value_words()';
  END IF;
  IF public.automation_value_words('not-in-the-catalogue', 80.12345678) IS DISTINCT FROM '80.12345678' THEN
    RAISE EXCEPTION '0283: a metric the catalogue does not hold is not worded as its value prints';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
