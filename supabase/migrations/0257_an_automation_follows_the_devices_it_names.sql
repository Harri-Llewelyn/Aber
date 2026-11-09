-- 0257: An automation follows the devices it names, and its alerts end with what raised them.
--
-- An automation is bound to its devices, so what happens to a device happens to the triggers that
-- name it, and what stops an automation from watching ends the alerts it raised.
--
--   * Archiving a device archives the trigger rows that name it, and restoring it brings them back:
--     the rows are kept, and nothing evaluates them meanwhile. Deleting a device removes them.
--   * An automation left with no live trigger is disabled, and the Audit Trail records why: one
--     AUTOMATION_DISABLED row, naming the person who archived or deleted the device. An automation
--     that keeps another trigger is recorded as AUTOMATION_CHANGED, with the same reason. A restore
--     does not enable anything: a person turns the automation back on.
--   * The open alerts of a trigger are resolved when the trigger goes: deleted, archived, or given
--     another device or metric, which is another fingerprint. Turning an automation off resolves
--     the alerts of every trigger it has, and deleting one deletes its triggers, which resolves
--     theirs. platform_alerts' prune keeps the newest occurrence of a fingerprint for ever, so a
--     firing row nothing resolved would stay in the counter. The fingerprint is
--     automation_alert_fingerprint()'s (0255), and a resolve is the same UPDATE that ends an
--     occurrence, so a notification already sent is followed by its "resolved".
--   * The rules are triggers on the tables, not steps of the writers, so a row changed any other
--     way keeps them.
--
-- Reasoning: supabase/README.md, "An automation follows the devices it names (0257)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Resolving the alerts of triggers
-- -------------------------------------------------------------------------------------------------
-- Resolved by the prefix every fingerprint of the trigger starts with, so a trigger that watches
-- every device is resolved as a whole. A firing occurrence ends now, as a writer's resolve does.
CREATE OR REPLACE FUNCTION public.resolve_automation_alerts(p_trigger_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_resolved integer;
BEGIN
  UPDATE public.platform_alerts a
     SET status = 'resolved', ends_at = greatest(now(), a.starts_at)
   WHERE a.status = 'firing'
     AND a.fingerprint LIKE 'condition:%'
     AND EXISTS (SELECT 1 FROM unnest(p_trigger_ids) t(id)
                  WHERE starts_with(a.fingerprint, public.automation_alert_fingerprint(t.id, NULL, NULL)));
  GET DIAGNOSTICS v_resolved = ROW_COUNT;
  RETURN v_resolved;
END
$$;

ALTER FUNCTION public.resolve_automation_alerts(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_automation_alerts(uuid[]) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.resolve_automation_alerts(uuid[]) IS
  'Resolves the firing platform_alerts rows of these triggers, by the prefix automation_alert_fingerprint() '
  'gives each, ending them now, and returns how many. Called by the triggers below, so an alert never '
  'outlives the trigger that raised it (0257).';

CREATE OR REPLACE FUNCTION public.automation_trigger_resolves_its_alerts() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.resolve_automation_alerts(ARRAY[OLD.id]);
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
  'BEFORE DELETE, and BEFORE UPDATE OF entity_id, metric_name, is_archived, on automation_triggers: '
  'resolves the open alerts of a trigger that is deleted, archived, or given another device or '
  'metric. Writes no audit row: the act that caused it has one (0257).';

SELECT public.replay_trigger('public.automation_triggers', 'trg_automation_triggers_resolve_on_delete', $ddl$
CREATE TRIGGER trg_automation_triggers_resolve_on_delete BEFORE DELETE ON public.automation_triggers FOR EACH ROW EXECUTE FUNCTION public.automation_trigger_resolves_its_alerts();
$ddl$);
SELECT public.replay_trigger('public.automation_triggers', 'trg_automation_triggers_resolve_on_change', $ddl$
CREATE TRIGGER trg_automation_triggers_resolve_on_change BEFORE UPDATE OF entity_id, metric_name, is_archived ON public.automation_triggers FOR EACH ROW EXECUTE FUNCTION public.automation_trigger_resolves_its_alerts();
$ddl$);

CREATE OR REPLACE FUNCTION public.automation_disable_resolves_its_alerts() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM public.resolve_automation_alerts(
    ARRAY(SELECT t.id FROM public.automation_triggers t WHERE t.automation_id = NEW.id));
  RETURN NEW;
END
$$;

ALTER FUNCTION public.automation_disable_resolves_its_alerts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_disable_resolves_its_alerts() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automation_disable_resolves_its_alerts() IS
  'AFTER UPDATE OF enabled on automations, when it goes from enabled to disabled: resolves the open '
  'alerts of every trigger the automation has. Writes no audit row: the act that disabled it has one (0257).';

SELECT public.replay_trigger('public.automations', 'trg_automations_resolve_on_disable', $ddl$
CREATE TRIGGER trg_automations_resolve_on_disable AFTER UPDATE OF enabled ON public.automations FOR EACH ROW WHEN ((old.enabled AND (NOT new.enabled))) EXECUTE FUNCTION public.automation_disable_resolves_its_alerts();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 2. A device archived, restored or deleted
-- -------------------------------------------------------------------------------------------------
-- Runs in the transaction of the person who archived or deleted the device, so the Audit Trail rows
-- it files name them. A purge by the timer has no person, and the rows say so as every such row does.
-- Each automation is locked first, so a document applied at the same moment waits and then sees
-- what this did.
CREATE OR REPLACE FUNCTION public.automations_follow_a_device() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_event   text;
  v_device  uuid;
  v_name    text;
  v_auto    uuid;
  v_before  jsonb;
  v_after   jsonb;
  v_enabled boolean;
  v_why     text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_event := 'deleted';
    v_device := OLD.id;
    v_name := OLD.name;
  ELSIF NEW.is_archived IS TRUE AND OLD.is_archived IS DISTINCT FROM TRUE THEN
    v_event := 'archived';
    v_device := NEW.id;
    v_name := NEW.name;
  ELSIF NEW.is_archived IS NOT TRUE AND OLD.is_archived IS TRUE THEN
    v_event := 'restored';
    v_device := NEW.id;
    v_name := NEW.name;
  ELSE
    RETURN NEW;
  END IF;

  FOR v_auto IN
    SELECT DISTINCT t.automation_id
      FROM public.automation_triggers t
     WHERE t.entity_id = v_device
       AND CASE v_event WHEN 'restored' THEN t.is_archived WHEN 'archived' THEN NOT t.is_archived ELSE true END
     ORDER BY t.automation_id
  LOOP
    SELECT a.enabled INTO v_enabled FROM public.automations a WHERE a.id = v_auto FOR UPDATE;
    v_before := public.automation_stored_document(v_auto);
    IF v_event = 'archived' THEN
      UPDATE public.automation_triggers
         SET is_archived = true, archived_at = now()
       WHERE automation_id = v_auto AND entity_id = v_device AND NOT is_archived;
    ELSIF v_event = 'restored' THEN
      UPDATE public.automation_triggers
         SET is_archived = false, archived_at = NULL
       WHERE automation_id = v_auto AND entity_id = v_device AND is_archived;
    ELSE
      DELETE FROM public.automation_triggers WHERE automation_id = v_auto AND entity_id = v_device;
    END IF;
    v_after := public.automation_stored_document(v_auto);

    IF v_event <> 'restored' AND v_enabled
       AND NOT EXISTS (SELECT 1 FROM public.automation_triggers t WHERE t.automation_id = v_auto AND NOT t.is_archived) THEN
      UPDATE public.automations SET enabled = false, updated_at = now() WHERE id = v_auto;
      v_after := public.automation_stored_document(v_auto);
      v_why := format('Disabled: its last trigger watched the device %s, which was %s.', v_name, v_event);
      PERFORM public.file_automation_act('disabled', v_auto,
        public.automation_audit_identity(v_auto, v_before, NULL),
        public.automation_audit_identity(v_auto, v_after, v_why));
    ELSE
      UPDATE public.automations SET updated_at = now() WHERE id = v_auto;
      v_why := CASE v_event
        WHEN 'restored' THEN format('The device %s was restored, so its triggers are back. The automation stays as it was.', v_name)
        ELSE format('The device %s was %s, so its triggers are %s.', v_name, v_event,
                    CASE v_event WHEN 'archived' THEN 'archived' ELSE 'removed' END)
      END;
      PERFORM public.file_automation_act('changed', v_auto,
        public.automation_audit_identity(v_auto, v_before, NULL),
        public.automation_audit_identity(v_auto, v_after, v_why));
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.automations_follow_a_device() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automations_follow_a_device() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automations_follow_a_device() IS
  'BEFORE DELETE and AFTER UPDATE OF is_archived on devices. Archiving a device archives the trigger '
  'rows that name it and restoring brings them back; deleting removes them. An automation left with '
  'no live trigger is disabled (AUTOMATION_DISABLED, with the reason), one that keeps another is '
  'recorded as AUTOMATION_CHANGED. A restore enables nothing. The open alerts of a trigger are '
  'resolved by its own trigger (0257).';

SELECT public.replay_trigger('public.devices', 'trg_devices_automations_follow_delete', $ddl$
CREATE TRIGGER trg_devices_automations_follow_delete BEFORE DELETE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.automations_follow_a_device();
$ddl$);
SELECT public.replay_trigger('public.devices', 'trg_devices_automations_follow_archive', $ddl$
CREATE TRIGGER trg_devices_automations_follow_archive AFTER UPDATE OF is_archived ON public.devices FOR EACH ROW EXECUTE FUNCTION public.automations_follow_a_device();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn   text;
  v_name text;
  v_def  text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.resolve_automation_alerts(uuid[])', 'public.automation_trigger_resolves_its_alerts()',
                              'public.automation_disable_resolves_its_alerts()', 'public.automations_follow_a_device()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0257: a browser-facing role may execute %', v_fn;
    END IF;
  END LOOP;
  FOR v_name, v_def IN VALUES
      ('trg_automation_triggers_resolve_on_delete', 'BEFORE DELETE ON public.automation_triggers'),
      ('trg_automation_triggers_resolve_on_change', 'BEFORE UPDATE OF entity_id, metric_name, is_archived ON public.automation_triggers'),
      ('trg_automations_resolve_on_disable', 'AFTER UPDATE OF enabled ON public.automations'),
      ('trg_devices_automations_follow_delete', 'BEFORE DELETE ON public.devices'),
      ('trg_devices_automations_follow_archive', 'AFTER UPDATE OF is_archived ON public.devices') LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgname = v_name AND NOT t.tgisinternal AND t.tgenabled = 'O'
                      AND position(v_def IN pg_get_triggerdef(t.oid)) > 0) THEN
      RAISE EXCEPTION '0257: trigger % is missing, disabled, or not % ', v_name, v_def;
    END IF;
  END LOOP;
  -- The foreign keys keep a device's rows from outliving it, as a second line behind the trigger.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'automation_triggers_entity_id_fkey' AND c.confdeltype = 'c') THEN
    RAISE EXCEPTION '0257: automation_triggers_entity_id_fkey does not cascade from devices';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
