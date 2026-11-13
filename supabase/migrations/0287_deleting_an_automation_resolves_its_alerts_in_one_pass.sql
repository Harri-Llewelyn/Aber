-- 0287: Deleting an automation resolves its alerts in one pass.
--
-- The alerts of the triggers an automation loses were resolved by comparing every firing alert's
-- fingerprint with every trigger's prefix, so the time grew as triggers times firing alerts, and
-- twice over:
--
--   * 0257's row trigger called the resolve once for each trigger deleted, so deleting an
--     automation with 3,000 triggers made 3,000 calls;
--   * and a call with many ids was no better, since starts_with() compared each alert with each
--     id. One call for 3,000 triggers was 3,000 comparisons for each firing alert.
--
-- Now a delete resolves once, and a call resolves in one pass however many ids it is given:
--
--   * automation_alert_trigger_id() reads the trigger's id out of a fingerprint, beside
--     automation_alert_fingerprint() (0255), which composes it. resolve_automation_alerts() matches
--     that id with an equality, which Postgres hashes: one pass over the firing alerts.
--   * Deleting triggers resolves their alerts in one call per statement, an AFTER DELETE statement
--     trigger that reads the rows the statement deleted. A delete of an automation cascades to its
--     triggers as one statement, so it is one call.
--   * 0257's BEFORE DELETE row trigger is still stated by 0257 and a replay puts it back, so its
--     function no longer resolves on a delete. Its UPDATE arm is as it was: a trigger archived or
--     given another device or metric is a few rows, and a statement trigger with a transition table
--     cannot name the columns it listens to, so it would run for every update of a threshold.
--
-- Reasoning: supabase/README.md, "Deleting an automation resolves its alerts in one pass (0287)".
-- Idempotent.
--
-- Redefines public.automation_trigger_resolves_its_alerts: 0287 returns at once for a delete, since
--   a statement trigger resolves the alerts of the triggers a statement deleted in one call; the
--   update arm is 0257's, word for word. 0257 resolved once for each row deleted
-- Redefines public.resolve_automation_alerts: 0287 matches a firing alert by the trigger id
--   automation_alert_trigger_id() reads out of its fingerprint, an equality that is hashed, and not
--   by starts_with() against each id's prefix, which compared every alert with every id: one call
--   for 3,000 triggers took 5 s. It returns 0 at once for no ids; 0257 scanned for them

-- -------------------------------------------------------------------------------------------------
-- 1. The trigger an alert's fingerprint names
-- -------------------------------------------------------------------------------------------------
-- The inverse of automation_alert_fingerprint(): condition:<trigger id>:<device id>:<metric> gives
-- the trigger id, and so does the prefix condition:<trigger id>:. Any other fingerprint, such as
-- condition:not-evaluated, a rule's or a platform alert's, gives NULL.
CREATE OR REPLACE FUNCTION public.automation_alert_trigger_id(p_fingerprint text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE WHEN p_fingerprint LIKE 'condition:%:%' THEN split_part(p_fingerprint, ':', 2) END;
$$;

ALTER FUNCTION public.automation_alert_trigger_id(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_alert_trigger_id(text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automation_alert_trigger_id(text) IS
  'The id of the trigger a fingerprint that automation_alert_fingerprint() composed belongs to, as text, '
  'and NULL for any other fingerprint. It reads what that function writes, so the two change together (0287).';

-- -------------------------------------------------------------------------------------------------
-- 2. Resolving the alerts of triggers, in one pass
-- -------------------------------------------------------------------------------------------------
-- 0257's, with the match as an equality on the trigger's id, so that it is hashed against the ids
-- given, and one pass over the firing alerts however many there are. A firing occurrence ends now,
-- as a writer's resolve does.
CREATE OR REPLACE FUNCTION public.resolve_automation_alerts(p_trigger_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_resolved integer;
BEGIN
  IF coalesce(cardinality(p_trigger_ids), 0) = 0 THEN
    RETURN 0;
  END IF;
  UPDATE public.platform_alerts a
     SET status = 'resolved', ends_at = greatest(now(), a.starts_at)
   WHERE a.status = 'firing'
     AND public.automation_alert_trigger_id(a.fingerprint) IN (SELECT t.id::text FROM unnest(p_trigger_ids) t(id));
  GET DIAGNOSTICS v_resolved = ROW_COUNT;
  RETURN v_resolved;
END
$$;

ALTER FUNCTION public.resolve_automation_alerts(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_automation_alerts(uuid[]) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.resolve_automation_alerts(uuid[]) IS
  'Resolves the firing platform_alerts rows of these triggers, by the trigger id automation_alert_trigger_id() '
  'reads out of each fingerprint, ending them now, and returns how many. One pass over the firing alerts '
  'however many ids it is given. Called by the triggers on automation_triggers and automations, so an alert '
  'never outlives the trigger that raised it (0257, 0287).';

-- -------------------------------------------------------------------------------------------------
-- 3. Triggers deleted: one call for the statement
-- -------------------------------------------------------------------------------------------------
-- Runs after the rows are gone, so the alerts are taken after the trigger rows, the order the
-- evaluator takes them in. Nothing reads a deleted row but its id.
CREATE OR REPLACE FUNCTION public.automation_triggers_gone_resolve_their_alerts() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM public.resolve_automation_alerts(ARRAY(SELECT g.id FROM gone g));
  RETURN NULL;
END
$$;

ALTER FUNCTION public.automation_triggers_gone_resolve_their_alerts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_triggers_gone_resolve_their_alerts() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automation_triggers_gone_resolve_their_alerts() IS
  'AFTER DELETE, once for the statement, on automation_triggers: resolves the open alerts of every trigger the '
  'statement deleted, in one call. Writes no audit row: the act that caused it has one (0287).';

SELECT public.replay_trigger('public.automation_triggers', 'trg_automation_triggers_gone_resolve_alerts', $ddl$
CREATE TRIGGER trg_automation_triggers_gone_resolve_alerts AFTER DELETE ON public.automation_triggers REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION public.automation_triggers_gone_resolve_their_alerts();
$ddl$);

-- 0257's row function, with the delete arm left to the statement trigger above. The update arm is
-- 0257's, word for word.
CREATE OR REPLACE FUNCTION public.automation_trigger_resolves_its_alerts() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  -- Archived, or watching another device or metric: the fingerprint it had is no longer its own.
  IF (NEW.is_archived AND NOT OLD.is_archived)
     OR (NEW.entity_id, NEW.metric_name) IS DISTINCT FROM (OLD.entity_id, OLD.metric_name) THEN
    PERFORM public.resolve_automation_alerts(ARRAY[OLD.id]);
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.automation_trigger_resolves_its_alerts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_trigger_resolves_its_alerts() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automation_trigger_resolves_its_alerts() IS
  'BEFORE UPDATE OF entity_id, metric_name, is_archived, on automation_triggers: resolves the open alerts '
  'of a trigger that is archived or given another device or metric. A delete returns at once, since '
  'automation_triggers_gone_resolve_their_alerts() resolves it in one call for the statement (0257, 0287). '
  'Writes no audit row: the act that caused it has one.';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn      text;
  v_trigger uuid := '11111111-1111-4111-8111-111111111111';
  v_entity  uuid := '22222222-2222-4222-8222-222222222222';
  v_src     text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.automation_alert_trigger_id(text)', 'public.resolve_automation_alerts(uuid[])',
                              'public.automation_triggers_gone_resolve_their_alerts()',
                              'public.automation_trigger_resolves_its_alerts()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0287: a browser-facing role may execute %', v_fn;
    END IF;
  END LOOP;
  -- The reader and the composer agree: every fingerprint of a trigger gives its id, and nothing
  -- that is not one does.
  IF public.automation_alert_trigger_id(public.automation_alert_fingerprint(v_trigger, v_entity, 'Spindle/LOAD')) IS DISTINCT FROM v_trigger::text
     OR public.automation_alert_trigger_id(public.automation_alert_fingerprint(v_trigger, NULL, NULL)) IS DISTINCT FROM v_trigger::text
     OR public.automation_alert_trigger_id('condition:not-evaluated') IS NOT NULL
     OR public.automation_alert_trigger_id('condition:' || v_trigger::text) IS NOT NULL
     OR public.automation_alert_trigger_id('rule:' || v_trigger::text || ':x') IS NOT NULL THEN
    RAISE EXCEPTION '0287: automation_alert_trigger_id() does not read what automation_alert_fingerprint() composes';
  END IF;
  -- The resolve matches by that id, which is what lets it hash the ids it is given.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.resolve_automation_alerts(uuid[])'::regprocedure;
  IF position('public.automation_alert_trigger_id(' IN v_src) = 0 OR position('starts_with' IN v_src) > 0 THEN
    RAISE EXCEPTION '0287: resolve_automation_alerts() does not match a fingerprint by its trigger id';
  END IF;
  -- The statement trigger is in place, once for the statement, over the rows it deleted.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgname = 'trg_automation_triggers_gone_resolve_alerts' AND NOT t.tgisinternal AND t.tgenabled = 'O'
                    AND position('AFTER DELETE ON public.automation_triggers REFERENCING OLD TABLE AS gone FOR EACH STATEMENT'
                                 IN pg_get_triggerdef(t.oid)) > 0) THEN
    RAISE EXCEPTION '0287: trg_automation_triggers_gone_resolve_alerts is missing, disabled, or not a statement trigger over the deleted rows';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
