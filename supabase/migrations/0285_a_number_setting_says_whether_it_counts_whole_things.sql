-- 0285: A number setting says whether it counts whole things, and the database holds it to that.
--
-- system_settings held a value and its bounds and nothing more, so each reader decided what 1.5 meant
-- for a count of days or hours: a retention window took a part day, the reminder interval alone
-- refused one (0248), and the cap on open proposals and the cold-archive threshold are read as
-- integers, so a part value stopped every proposal or every platform_health alert query. The
-- Settings page offered every number as the same plain field.
--
--   * system_settings.whole_number: true where the setting counts whole things. Set beside the
--     bounds, by an UPDATE guarded on the value it sets, because seed_setting() takes neither and
--     cannot take the flag: a second seed_setting() with one more defaulted argument makes every
--     seven-argument call ambiguous, and 0001 declares the seven-argument form again on every boot.
--   * system_settings_whole_number_guard(), BEFORE INSERT OR UPDATE: a whole setting refuses a part
--     value ("must be a whole number", with "of hours", "of days" or "of seconds" where the key
--     ends so). It replaces 0248's arm for notifications.reminder_hours, which this file takes out
--     of notification_setting_guard(), keeping every other arm. It looks at a row when its value or
--     its flag changes, so the label and the description are still refreshed by seed_setting() on a
--     row it would refuse.
--   * Nine settings are whole. site_map.min_pin_spacing is not: it is a fraction of an area plan's
--     shorter side. supabase/README.md lists each with the reader that decided it.
--   * A part value already stored in one of the nine is rounded down, with a NOTICE naming the key,
--     the old value and the new one. The UPDATE goes through the table's audit trigger, so the
--     Audit Trail records each. Refusing would have stopped the site's upgrade.
--   * The two readers that took a part day as it was, check_alert_suppression_window_length() and
--     telemetry_export_max_days(), take a stored part value as its whole days, and the suppression
--     refusal says whole days.
--
-- Reasoning: supabase/README.md, "A number setting says whether it counts whole things (0285)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The flag
-- -------------------------------------------------------------------------------------------------
-- A constant default, so adding the column to a table with rows rewrites none of them.
ALTER TABLE public.system_settings ADD COLUMN IF NOT EXISTS whole_number boolean DEFAULT false NOT NULL;
ALTER TABLE public.system_settings ALTER COLUMN whole_number SET DEFAULT false;

COMMENT ON COLUMN public.system_settings.whole_number IS
  'A number setting that counts whole things (days, hours, seconds, proposals): a part value is '
  'refused by system_settings_whole_number_guard(), and the Settings page takes whole numbers only. '
  'False for every other type, and for a number that is a fraction, such as a share of a plan. Set '
  'beside min_value and max_value by an UPDATE, as seed_setting() takes neither (0285).';

-- Only a number can be whole.
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'system_settings_whole_number_is_a_number'
                AND conrelid = 'public.system_settings'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK (((NOT whole_number) OR (value_type = ''number''::text)))') THEN
    ALTER TABLE public.system_settings DROP CONSTRAINT system_settings_whole_number_is_a_number;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'system_settings_whole_number_is_a_number'
                    AND conrelid = 'public.system_settings'::regclass) THEN
    ALTER TABLE public.system_settings
        ADD CONSTRAINT system_settings_whole_number_is_a_number CHECK (((NOT whole_number) OR (value_type = 'number'::text)));
  END IF;
END $c$;

-- -------------------------------------------------------------------------------------------------
-- 2. The guard
-- -------------------------------------------------------------------------------------------------
-- check_violation, as the Notifications guard raises it: PostgREST answers 400 with the sentence.
-- The unit words come from the key's last word, which is how every day, hour and second setting is
-- named, so the sentence is the one 0248 gave for the reminder interval.
CREATE OR REPLACE FUNCTION public.system_settings_whole_number_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_value numeric;
BEGIN
  IF NOT NEW.whole_number OR jsonb_typeof(NEW.value) IS DISTINCT FROM 'number' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.value IS NOT DISTINCT FROM OLD.value AND NEW.whole_number = OLD.whole_number THEN
      RETURN NEW;
    END IF;
  END IF;

  v_value := (NEW.value #>> '{}')::numeric;
  IF v_value <> trunc(v_value) THEN
    RAISE EXCEPTION '% must be a whole number%', NEW.key,
      CASE WHEN NEW.key ~ '_hours$' THEN ' of hours'
           WHEN NEW.key ~ '_days$' THEN ' of days'
           WHEN NEW.key ~ '_seconds$' THEN ' of seconds'
           ELSE '' END
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.system_settings_whole_number_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.system_settings_whole_number_guard() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.system_settings_whole_number_guard() IS
  'Refuses a part value in a number setting whose whole_number flag is set, when its value or its '
  'flag changes: "<key> must be a whole number", with of hours, of days or of seconds where the key '
  'ends so. Replaces the reminder interval''s arm of notification_setting_guard() (0248, 0285).';

SELECT public.replay_trigger('public.system_settings', 'system_settings_whole_number_trg', $ddl$
CREATE TRIGGER system_settings_whole_number_trg BEFORE INSERT OR UPDATE ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.system_settings_whole_number_guard();
$ddl$);

-- 0262's guard, whole, without the arm for notifications.reminder_hours: the guard above holds it
-- now, with the same sentence. 0248 and 0262 replay first on every boot, and the last declaration
-- stands. SECURITY DEFINER, as 0262 made it.
CREATE OR REPLACE FUNCTION public.notification_setting_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_rule text;
BEGIN
  IF NOT starts_with(NEW.key, 'notifications.') OR NEW.value IS NOT DISTINCT FROM OLD.value THEN
    RETURN NEW;
  END IF;

  v_rule := CASE NEW.key
    WHEN 'notifications.webhook_min_severity' THEN
      CASE WHEN jsonb_typeof(NEW.value) <> 'string'
                OR NOT (NEW.value #>> '{}') = ANY (ARRAY['info', 'warning', 'critical'])
           THEN 'must be info, warning or critical' END
    WHEN 'notifications.email_min_severity' THEN
      CASE WHEN jsonb_typeof(NEW.value) <> 'string'
                OR NOT (NEW.value #>> '{}') = ANY (ARRAY['info', 'warning', 'critical'])
           THEN 'must be info, warning or critical' END
    WHEN 'notifications.webhook_allowed_hosts' THEN
      public.notification_allowed_hosts_problem(NEW.value)
    WHEN 'notifications.email_roles' THEN
      public.notification_email_roles_problem(NEW.value)
  END;

  IF v_rule IS NOT NULL THEN
    RAISE EXCEPTION '% %', NEW.key, v_rule USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.notification_setting_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notification_setting_guard() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.notification_setting_guard() IS
  'Refuses a value a Notifications setting cannot hold: a severity outside info, warning and '
  'critical, an allowed-hosts list that is not one of host names, and a list of roles that names one '
  'that does not exist. A part hour is system_settings_whole_number_guard()''s (0248, 0262, 0285).';

-- -------------------------------------------------------------------------------------------------
-- 3. Which settings are whole, and what was stored before
-- -------------------------------------------------------------------------------------------------
-- A part value in one of these is rounded down before its flag is set, with a NOTICE, and through
-- the table's audit trigger, so the Audit Trail records the old value and the new one. A value is
-- never rounded below its floor. A replay finds nothing to round, because the guard holds from
-- the first boot, and writes nothing.
DO $whole$
DECLARE
  v_whole text[] := ARRAY['alerts.retention_days', 'alerts.suppression_max_days', 'archive.tier_after_days',
                          'history.export_max_days', 'notifications.reminder_hours',
                          'proposals.max_open_per_person', 'proposals.open_expiry_days',
                          'proposals.retention_days', 'ui.audit_trail_poll_seconds'];
  v_row record;
  v_new numeric;
BEGIN
  FOR v_row IN
    SELECT s.key, (s.value #>> '{}')::numeric AS old_value, s.min_value
      FROM public.system_settings s
     WHERE s.key = ANY (v_whole) AND s.value_type = 'number' AND jsonb_typeof(s.value) = 'number'
       AND (s.value #>> '{}')::numeric <> trunc((s.value #>> '{}')::numeric)
     ORDER BY s.key
  LOOP
    v_new := greatest(floor(v_row.old_value), ceil(coalesce(v_row.min_value, floor(v_row.old_value))));
    UPDATE public.system_settings SET value = to_jsonb(v_new) WHERE key = v_row.key;
    RAISE NOTICE '0285: % held % and now holds %; it counts whole things, so a part value is rounded down',
      v_row.key, trim_scale(v_row.old_value), trim_scale(v_new);
  END LOOP;

  UPDATE public.system_settings SET whole_number = true
   WHERE key = ANY (v_whole) AND value_type = 'number' AND NOT whole_number;
END
$whole$;

-- -------------------------------------------------------------------------------------------------
-- 4. The two readers that took a part day as it was
-- -------------------------------------------------------------------------------------------------
-- 0240's check, whole, with a stored part value taken as its whole days (as the cap on open
-- proposals does, 0286) and the sentence saying whole days. The fallback's shape and the tab the
-- sentence names are what mirror checks 62 and 63 read.
CREATE OR REPLACE FUNCTION public.check_alert_suppression_window_length(p_starts_at timestamp with time zone,
                                                                        p_ends_at timestamp with time zone)
RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_days numeric;
BEGIN
  SELECT (value #>> '{}')::numeric INTO v_days
    FROM public.system_settings
   WHERE key = 'alerts.suppression_max_days';
  IF v_days IS NULL OR v_days < 1 OR v_days > 90 THEN
    v_days := 7;
  END IF;
  v_days := floor(v_days);
  IF p_ends_at > p_starts_at + make_interval(secs => v_days::double precision * 86400.0) THEN
    RAISE EXCEPTION 'A window can last at most % %, set on Settings › Retention.',
      v_days::bigint, CASE WHEN v_days = 1 THEN 'day' ELSE 'days' END
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
END
$$;

ALTER FUNCTION public.check_alert_suppression_window_length(timestamp with time zone, timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_alert_suppression_window_length(timestamp with time zone, timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.check_alert_suppression_window_length(timestamp with time zone, timestamp with time zone) IS
  'Refuses a window that ends more than alerts.suppression_max_days after its start (22023), with '
  'a sentence naming the limit in whole days and Settings › Retention. A missing setting, or one '
  'outside 1 to 90, is 7 days; a stored part day is its whole days. Called by '
  'schedule_alert_suppression_window() and change_alert_suppression_window() (0240, 0285).';

-- 0278's reader, whole, with a stored part value taken as its whole days. The fallback's shape is
-- what mirror check 91 reads.
CREATE OR REPLACE FUNCTION public.telemetry_export_max_days() RETURNS numeric
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_days numeric;
BEGIN
  SELECT (value #>> '{}')::numeric INTO v_days
    FROM public.system_settings
   WHERE key = 'history.export_max_days';
  IF v_days IS NULL OR v_days < 1 OR v_days > 366 THEN
    v_days := 14;
  END IF;
  RETURN floor(v_days);
END
$$;

ALTER FUNCTION public.telemetry_export_max_days() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.telemetry_export_max_days() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.telemetry_export_max_days() IS
  'The most days one export of readings may span: history.export_max_days, or 14 where the row is '
  'missing or outside 1 to 366; a stored part day is its whole days. Read by export_telemetry(), and '
  'by nothing else: the setting itself is readable by every role (0278, 0285).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_whole text[] := ARRAY['alerts.retention_days', 'alerts.suppression_max_days', 'archive.tier_after_days',
                          'history.export_max_days', 'notifications.reminder_hours',
                          'proposals.max_open_per_person', 'proposals.open_expiry_days',
                          'proposals.retention_days', 'ui.audit_trail_poll_seconds'];
  v_key text;
BEGIN
  -- Each of the nine is flagged and holds a whole value; the fraction is not.
  FOR v_key IN SELECT s.key FROM public.system_settings s
                WHERE s.key = ANY (v_whole)
                  AND (NOT s.whole_number
                       OR (jsonb_typeof(s.value) = 'number'
                           AND (s.value #>> '{}')::numeric <> trunc((s.value #>> '{}')::numeric))) LOOP
    RAISE EXCEPTION '0285: % is not flagged whole_number, or still holds a part value', v_key;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'site_map.min_pin_spacing' AND whole_number) THEN
    RAISE EXCEPTION '0285: site_map.min_pin_spacing is a fraction of a plan, and is not whole_number';
  END IF;
  IF EXISTS (SELECT 1 FROM public.system_settings s
              WHERE s.whole_number AND jsonb_typeof(s.value) = 'number'
                AND (s.value #>> '{}')::numeric <> trunc((s.value #>> '{}')::numeric)) THEN
    RAISE EXCEPTION '0285: a whole_number setting holds a part value';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.system_settings'::regclass
                    AND t.tgname = 'system_settings_whole_number_trg' AND NOT t.tgisinternal
                    AND t.tgenabled = 'O' AND t.tgtype = 23) THEN
    RAISE EXCEPTION '0285: system_settings_whole_number_trg is not BEFORE INSERT OR UPDATE FOR EACH ROW on system_settings';
  END IF;
  IF has_function_privilege('authenticated', 'public.system_settings_whole_number_guard()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.system_settings_whole_number_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION '0285: a browser role may execute system_settings_whole_number_guard(), which only the trigger runs';
  END IF;
  IF pg_get_functiondef('public.notification_setting_guard()'::regprocedure) ~ 'reminder_hours' THEN
    RAISE EXCEPTION '0285: notification_setting_guard() still has an arm for notifications.reminder_hours';
  END IF;
  IF pg_get_functiondef('public.check_alert_suppression_window_length(timestamptz, timestamptz)'::regprocedure) ~ 'trim_scale' THEN
    RAISE EXCEPTION '0285: the suppression window refusal still words a part day';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
