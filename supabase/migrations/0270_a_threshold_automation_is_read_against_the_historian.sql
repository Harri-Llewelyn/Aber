-- 0270: A threshold automation is read against the historian, and what was read is kept.
--
-- An automation's `threshold` trigger names a device and a metric and a number. This file holds the
-- two things 0271's evaluator is built from: the read that finds which of them are breaching, and the
-- table that remembers what each run found.
--
--   * machine_condition_readings(): one row for each live threshold pair (an enabled automation's
--     unarchived trigger on an unarchived device) that has a latest value, breached or not. It reads
--     the historian's telemetry_latest over postgres_fdw, one remote query for each metric, carrying
--     only the devices that metric is watched on, so the historian is asked for exactly the pairs.
--     A pair with no latest value has no row: no reading is not a breach.
--   * machine_condition_rows(): the breaching ones, in the shape platform_health_rows() answers
--     (condition, sparkplug_id, subject, value, detail) with the ids a caller joins by. It is a
--     function of its own and no arm of platform_health_rows(): postgres_fdw raises on connect, so a
--     historian outage would take the platform's own conditions down with it.
--   * automation_trigger_states: one row for each (trigger, device, metric), holding when it began to
--     breach, when it began to fire, when it was last read, and the value it read. Every role reads
--     it. Nobody writes it directly: 0271's evaluator does, as the owner.
--
-- Neither function is granted to an API role. They run as the historian's admin mapping, which is
-- the mapping a pg_cron job has, and a browser has no reason to start a read of the historian.
--
-- Reasoning: supabase/README.md, "A threshold automation is read against the historian (0270)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. What each run found
-- -------------------------------------------------------------------------------------------------
-- The key carries the device and the metric as well as the trigger: a trigger that is given another
-- device or metric is another pair, and the row of the old one is no longer live, so it can never
-- fire. The comparison and the threshold are what the row was last judged against; a changed one
-- starts the hold again. fillfactor leaves room for the update every run makes of each row.
CREATE TABLE IF NOT EXISTS public.automation_trigger_states (
    trigger_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    metric_name text NOT NULL,
    pending_since timestamp with time zone,
    firing_since timestamp with time zone,
    last_evaluated_at timestamp with time zone NOT NULL,
    last_value double precision,
    last_observed_at timestamp with time zone,
    comparison text NOT NULL,
    threshold double precision NOT NULL,
    CONSTRAINT automation_trigger_states_pkey PRIMARY KEY (trigger_id, entity_id, metric_name),
    CONSTRAINT automation_trigger_states_trigger_id_fkey FOREIGN KEY (trigger_id)
        REFERENCES public.automation_triggers(id) ON DELETE CASCADE,
    CONSTRAINT automation_trigger_states_comparison_valid CHECK ((comparison = ANY (ARRAY['above'::text, 'below'::text]))),
    CONSTRAINT automation_trigger_states_one_phase CHECK (((pending_since IS NULL) OR (firing_since IS NULL)))
)
WITH (fillfactor = 70);

ALTER TABLE public.automation_trigger_states OWNER TO postgres;
ALTER TABLE public.automation_trigger_states ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.automation_trigger_states IS
  'What the evaluator found for each live (trigger, device, metric): since when it has been breaching '
  'and not yet firing (pending_since), since when it has been firing (firing_since), when its value '
  'was last read (last_evaluated_at) and the value (last_value, which arrived at last_observed_at). '
  'Neither time is set while it is not breaching. Read by every signed-in role; written by '
  'evaluate_automations() only, which deletes a row once its trigger is no longer live (0270).';
COMMENT ON COLUMN public.automation_trigger_states.pending_since IS
  'When the latest value began to breach, while the hold has not yet been served. NULL when it is not '
  'breaching, and once it fires. A run that reads no value for it leaves this as it was (0270).';
COMMENT ON COLUMN public.automation_trigger_states.firing_since IS
  'When the alert for it began to fire: the starts_at of its open platform_alerts occurrence. NULL '
  'while it is not firing. A run that reads no value for it leaves this as it was (0270).';
COMMENT ON COLUMN public.automation_trigger_states.last_evaluated_at IS
  'The run that last read a value for it. A pair with no latest value in the historian is not '
  'evaluated, and this stays at the last run that had one (0270).';
COMMENT ON COLUMN public.automation_trigger_states.last_value IS
  'The latest value that run read, whenever it arrived: a silent device is compared by the last '
  'thing it said (0270).';
COMMENT ON COLUMN public.automation_trigger_states.last_observed_at IS
  'When the value in last_value arrived at the historian (0270).';
COMMENT ON COLUMN public.automation_trigger_states.comparison IS
  'The trigger''s comparison, above or below, as that run judged it. A change of it, or of the '
  'threshold, starts the hold again (0270).';
COMMENT ON COLUMN public.automation_trigger_states.threshold IS
  'The trigger''s threshold as that run judged it (0270).';

-- Every role reads every state, as every role reads every automation (0255). anon is revoked by
-- name, and no role holds INSERT, UPDATE or DELETE: the evaluator runs as the owner.
REVOKE ALL ON TABLE public.automation_trigger_states FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.automation_trigger_states TO authenticated, service_role;

SELECT public.replay_policy('public.automation_trigger_states', 'automation_trigger_states_select_authenticated', $ddl$
CREATE POLICY automation_trigger_states_select_authenticated ON public.automation_trigger_states FOR SELECT TO authenticated USING (true);
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 2. The read
-- -------------------------------------------------------------------------------------------------
-- One remote query for each metric. A query naming both arrays at once, every device and every
-- metric, asks the historian for their cross product (300 devices of 10 metrics asks for 3,000
-- series to find 300) and is 8 times slower; one for each metric asks for exactly the pairs. The
-- filter on asset and metric is shipped to the historian, which pushes it below the view's DISTINCT
-- ON, so the work is one index probe for each matching series for each chunk.
--
-- The newest value is compared whenever it arrived: the filter has no time bound, and none comes from
-- now(), which postgres_fdw would evaluate here and ship nothing for. The comparison runs here, on
-- the rows that cross. NULL is not a reading (the value is a flag or a text), and NaN is not a
-- reading either: Postgres sorts it above every number, so it would breach every `above`.
--
-- A historian that cannot be reached raises from the first remote query. That is the caller's to
-- handle: this function states no outage and writes nothing.
CREATE OR REPLACE FUNCTION public.machine_condition_readings()
RETURNS TABLE (trigger_id uuid, entity_id uuid, metric_name text, comparison text, threshold double precision,
               value double precision, observed_at timestamp with time zone, breached boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_metric record;
BEGIN
  FOR v_metric IN
    SELECT t.metric_name AS name, array_agg(DISTINCT d.sparkplug_id) AS assets
      FROM public.automation_triggers t
      JOIN public.automations a ON a.id = t.automation_id AND a.enabled
      JOIN public.devices d ON d.id = t.entity_id AND NOT coalesce(d.is_archived, false)
     WHERE t.kind = 'threshold' AND NOT t.is_archived AND d.sparkplug_id IS NOT NULL
     GROUP BY t.metric_name
     ORDER BY t.metric_name
  LOOP
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
  END LOOP;
END
$$;

ALTER FUNCTION public.machine_condition_readings() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.machine_condition_readings() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.machine_condition_readings() IS
  'One row for each live threshold pair that has a latest numeric value in the historian, with that '
  'value, when it arrived, the trigger''s comparison and threshold, and whether the value breaches: '
  'one remote query for each metric, carrying that metric''s devices. A pair with no value has no row. '
  'Raises when the historian cannot be read. Run by evaluate_automations() as the owner, and granted '
  'to no API role (0270).';

-- The breaching ones, as platform_health_rows() answers its conditions: a name, the device's wire
-- id, a subject, a value and a sentence, with the ids of the trigger and the device beside them.
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
         format('%s is %s, %s %s', r.metric_name, r.value, r.comparison, r.threshold),
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
  'One row for each live threshold pair whose latest value breaches now, in the shape of '
  'platform_health_rows(): condition (threshold), sparkplug_id, subject (the device''s name), value and '
  'detail, with trigger_id, entity_id and metric_name. Not an arm of platform_health_rows(): a historian '
  'outage must not take the platform conditions down with it. Granted to no API role (0270).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn  text;
  v_src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.automation_trigger_states'::regclass AND c.relrowsecurity) THEN
    RAISE EXCEPTION '0270: row security is off on automation_trigger_states';
  END IF;
  IF has_table_privilege('anon', 'public.automation_trigger_states', 'SELECT')
     OR has_table_privilege('anon', 'public.automation_trigger_states', 'INSERT') THEN
    RAISE EXCEPTION '0270: anon holds a privilege on automation_trigger_states';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.automation_trigger_states', 'SELECT') THEN
    RAISE EXCEPTION '0270: authenticated cannot read automation_trigger_states';
  END IF;
  IF has_table_privilege('authenticated', 'public.automation_trigger_states', 'INSERT')
     OR has_table_privilege('authenticated', 'public.automation_trigger_states', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.automation_trigger_states', 'DELETE')
     OR has_table_privilege('service_role', 'public.automation_trigger_states', 'INSERT')
     OR has_table_privilege('service_role', 'public.automation_trigger_states', 'UPDATE')
     OR has_table_privilege('service_role', 'public.automation_trigger_states', 'DELETE') THEN
    RAISE EXCEPTION '0270: a role may write automation_trigger_states directly';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'automation_trigger_states_trigger_id_fkey' AND c.confdeltype = 'c') THEN
    RAISE EXCEPTION '0270: automation_trigger_states does not cascade from automation_triggers';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY['public.machine_condition_readings()', 'public.machine_condition_rows()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0270: an API role may execute %', v_fn;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn::regprocedure AND p.prosecdef
                      AND p.proconfig @> ARRAY['search_path=public']) THEN
      RAISE EXCEPTION '0270: % is not SECURITY DEFINER with its search_path pinned', v_fn;
    END IF;
  END LOOP;

  -- The read stays one remote query for each metric, each carrying its own devices.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.machine_condition_readings()'::regprocedure;
  IF position('FOR v_metric IN' IN v_src) = 0 OR position('= ANY (v_metric.assets)' IN v_src) = 0
     OR position('= v_metric.name' IN v_src) = 0 OR position('timescale.telemetry_latest' IN v_src) = 0 THEN
    RAISE EXCEPTION '0270: machine_condition_readings() no longer reads the historian one metric at a time';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
