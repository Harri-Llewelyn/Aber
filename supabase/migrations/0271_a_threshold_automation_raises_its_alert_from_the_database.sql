-- 0271: A threshold automation raises its alert from the database.
--
-- evaluate_automations() is what pg_cron runs every minute. It reads the historian through 0270's
-- machine_condition_readings(), keeps what it found in automation_trigger_states, and writes
-- platform_alerts as grafana-alert-webhook does, so acknowledgement, suppression and delivery read an
-- automation's alert as they read any other, and never ask which writer made a row.
--
--   * A breach that has held for the trigger's `for` fires: one occurrence row, status firing, under
--     automation_alert_fingerprint()'s name (0255), the alias as its name, the alert action's
--     severity, the device as its subject, labels naming the severity, the entity type, the metric,
--     the automation's key and the trigger's id, values holding the reading and the threshold, and
--     no rule_uid. A firing one that stops breaching resolves, with its ends_at. A hold is judged at
--     each run, so one shorter than the interval fires at the first run that finds the breach old
--     enough.
--   * Each run stamps last_confirmed_at on every row it holds firing, so a reminder never outlives the
--     automation (0247). platform_alert_confirmation_window() allows a run interval and a margin.
--   * No reading is not a breach. A pair the historian returns no value for is left as it was: a
--     breach under report-by-exception is compared by the last value, and a pending one is neither
--     started nor cleared by silence.
--   * A run that cannot read the historian writes nothing. It neither fires nor resolves, and it
--     raises one platform alert, Automations Not Evaluated, which the next run that reads resolves.
--     The read and the writes of what it found are one subtransaction, so a run that fails midway
--     writes nothing either.
--   * What is no longer live is forgotten. A disabled automation, an archived trigger or device, and a
--     trigger given another device or metric leave a state row behind, which the next run deletes and
--     which cannot fire meanwhile, since only a live pair is read. The alerts of such a trigger are
--     resolved by 0257's triggers, not here.
--
-- The evaluator is the platform's, not a person's: it asks for no role and no second factor, and it
-- is granted to no API role. A caller may pass the instant to judge at, which only the owner can.
--
-- Reasoning: supabase/README.md, "A threshold automation raises its alert from the database (0271)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The evaluator
-- -------------------------------------------------------------------------------------------------
-- The only statement that reaches the historian is the first INSERT, inside its own block, so what a
-- failure leaves is what the block rolled back. A foreign-key failure there is a trigger deleted
-- while the run was reading, and a deadlock or a serialization failure is a person's act meeting
-- the run: the next run reads what is left, and nothing is raised. Whether a pair breaches is the
-- one expression the three statements below repeat.
--
-- Firing is what platform_alerts says. A state that claims to fire with no open occurrence (its
-- alert resolved by the lifecycle, or the automation turned off and on within a minute) starts its
-- hold again; an open occurrence its state does not know is adopted, so there is never a second open
-- row for one fingerprint.
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
         format('%s: %s is %s, %s %s%s', dev.name, d.metric_name, d.last_value, d.comparison, d.threshold,
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
  'stamping last_confirmed_at on every row it holds firing. A pair with no value is left as it was. A '
  'run that cannot read the historian writes nothing but one platform alert, Automations Not '
  'Evaluated, which the next run that reads resolves. Returns how many pairs it read. p_at is the '
  'instant to judge at, now() for the job. Granted to no API role (0271).';

-- -------------------------------------------------------------------------------------------------
-- 2. Every minute
-- -------------------------------------------------------------------------------------------------
-- After the function, so the first run finds it. ensure_cron_job() unschedules first, so a replay
-- leaves one job. A run is 0.3 s at 300 triggers and about a second at 10,000, so a minute is under
-- 2% of the historian's time. platform_alert_confirmation_window() (0247) allows this interval and a
-- margin; mirror check 82 holds the two together.
SELECT public.ensure_cron_job(
  'evaluate_automations',
  '* * * * *',
  $job$SELECT public.evaluate_automations()$job$
);

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_src text;
BEGIN
  IF has_function_privilege('anon', 'public.evaluate_automations(timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.evaluate_automations(timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.evaluate_automations(timestamp with time zone)', 'EXECUTE') THEN
    RAISE EXCEPTION '0271: an API role may execute evaluate_automations()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.evaluate_automations(timestamp with time zone)'::regprocedure
                    AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']) THEN
    RAISE EXCEPTION '0271: evaluate_automations() is not SECURITY DEFINER with its search_path pinned';
  END IF;
  -- The fingerprint is composed in one place, and the evaluator reads the historian only through the
  -- one function that asks it for exactly the pairs.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.evaluate_automations(timestamp with time zone)'::regprocedure;
  IF position('public.automation_alert_fingerprint(' IN v_src) = 0
     OR position('public.machine_condition_readings()' IN v_src) = 0
     OR position('''condition:'' ||' IN v_src) <> 0 THEN
    RAISE EXCEPTION '0271: evaluate_automations() does not compose its fingerprints with automation_alert_fingerprint(), or does not read through machine_condition_readings()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'evaluate_automations' AND schedule = '* * * * *'
                    AND command = 'SELECT public.evaluate_automations()') THEN
    RAISE EXCEPTION '0271: pg_cron does not run evaluate_automations() every minute';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
