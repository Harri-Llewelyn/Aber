-- 0262: An alert reaches the roles its email route names.
--
-- 0247's queue carries one channel today, the webhook. This file makes email the second, and states
-- what makes it a channel: a route, a closed list of roles to tell, and the rule for which alerts it
-- may carry. Who the people are, and what is sent them, is 0263.
--
--   * notification_deliveries.channel admits 'email'.
--   * Two Notifications settings, read by every role and changed only by an Administrator:
--     notifications.email_min_severity (the lowest severity emailed, warning) and
--     notifications.email_roles (the roles told, none until an Administrator names some). A route
--     matches on severity alone, as the webhook's does; each is checked by notification_setting_guard().
--   * notification_channel_reaches() is the one place that says whether a channel may carry an alert
--     about a kind of subject. The webhook never carries a machine identity's alert. Email does only
--     when Administrators are among the roles told, since an Administrator alone may read it.
--   * The queue trigger, the reminders and the send decision ask it, and the trigger queues an email
--     for an alert that email carries, beside the webhook's. Acknowledgement, suppression and the
--     writer's confirmation window need no email arm: the decision applies them to any channel.
--
-- Reasoning: supabase/README.md, "An alert reaches the roles its email route names (0262)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The channel
-- -------------------------------------------------------------------------------------------------
-- 0247 declares the table and its first CHECK; a table that exists keeps the CHECK it has, so the
-- constraint is replaced here, and a replay replaces it with itself.
ALTER TABLE public.notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_channel_valid;
ALTER TABLE public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_channel_valid
    CHECK ((channel = ANY (ARRAY['webhook'::text, 'email'::text])));

COMMENT ON COLUMN public.notification_deliveries.channel IS
  'Where it goes: webhook, the generic outbound webhook (0248), or email, to the people whose roles '
  'notifications.email_roles names (0262).';

-- -------------------------------------------------------------------------------------------------
-- 2. The email route
-- -------------------------------------------------------------------------------------------------
SELECT public.seed_setting(
    'notifications.email_min_severity',
    to_jsonb('warning'::text),
    'string',
    'Notifications',
    'Lowest severity emailed',
    'An alert at this severity or above is emailed when it starts firing, as a reminder while it '
    'fires unacknowledged, and when it resolves: info, warning or critical. It goes to the roles '
    'named below, and only to a person who has an email address on file.',
    'warning, in notification_severity_carried()'
);

SELECT public.seed_setting(
    'notifications.email_roles',
    '[]'::jsonb,
    'json',
    'Notifications',
    'Roles emailed',
    'The roles whose people are emailed about an alert, as a list such as ["Administrator", '
    '"Shopfloor_Manager"]. Empty emails nobody, which is how email starts. An alert about a machine '
    'identity''s token goes only to Administrators, and only when Administrator is listed.',
    NULL
);

-- What is wrong with a value for notifications.email_roles, or NULL: a list of role names that the
-- roles table holds, each once. The roles are read live, so a role added later is accepted.
CREATE OR REPLACE FUNCTION public.notification_email_roles_problem(p_value jsonb) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_role jsonb;
  v_text text;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'array' THEN
    RETURN 'must be a list of roles';
  END IF;
  FOR v_role IN SELECT r FROM jsonb_array_elements(p_value) AS e(r) LOOP
    IF jsonb_typeof(v_role) <> 'string' THEN
      RETURN 'must be a list of roles';
    END IF;
    v_text := v_role #>> '{}';
    IF NOT EXISTS (SELECT 1 FROM public.roles WHERE name = v_text) THEN
      RETURN format('names %s, which is not a role', quote_literal(v_text));
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT r) FROM jsonb_array_elements_text(p_value) AS e(r)) <> jsonb_array_length(p_value) THEN
    RETURN 'names a role twice';
  END IF;
  RETURN NULL;
END
$$;

ALTER FUNCTION public.notification_email_roles_problem(jsonb) OWNER TO postgres;

COMMENT ON FUNCTION public.notification_email_roles_problem(jsonb) IS
  'What is wrong with a value for notifications.email_roles, or NULL: a list of role names the roles '
  'table holds, each named once (0262).';

-- The roles told, as the setting holds them. A value that is not a list of strings is no roles.
CREATE OR REPLACE FUNCTION public.notification_email_roles() RETURNS text[]
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(
    (SELECT array_agg(r.role)
       FROM public.system_settings s
      CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]'::jsonb END) AS r(role)
      WHERE s.key = 'notifications.email_roles'),
    ARRAY[]::text[]);
$$;

ALTER FUNCTION public.notification_email_roles() OWNER TO postgres;

COMMENT ON FUNCTION public.notification_email_roles() IS
  'The roles notifications.email_roles names: none when the setting is empty or not a list (0262).';

-- 0248's guard, whole, with an arm for each email setting: the same severities as the webhook's, and
-- the roles' own rule. 0248 replays first on every boot, and the last declaration stands.
--
-- SECURITY DEFINER, which 0248's was not: Postgres checks EXECUTE on every function an expression
-- names when it first evaluates the expression in a transaction, whichever arm is taken, and no API
-- role may run the two problem functions. Run as the caller, the guard refused an Administrator's
-- first change of any Notifications setting in a transaction. It uses nothing of the caller's.
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
    WHEN 'notifications.reminder_hours' THEN
      CASE WHEN jsonb_typeof(NEW.value) <> 'number'
                OR (NEW.value #>> '{}')::numeric <> trunc((NEW.value #>> '{}')::numeric)
           THEN 'must be a whole number of hours' END
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
  'critical, an allowed-hosts list that is not one of host names, a list of roles that names one '
  'that does not exist, and a part hour (0248, 0262).';

-- -------------------------------------------------------------------------------------------------
-- 3. Which alerts a channel may carry, and whether it can send at all
-- -------------------------------------------------------------------------------------------------
-- The one rule, so the trigger, the reminders and the decision cannot disagree. A machine identity's
-- alert is an Administrator's to read (0204). The webhook carries only what every role may read.
-- Email applies the same visibility to the people: it carries the alert when Administrators are
-- told, and 0263 resolves only Administrators for it.
CREATE OR REPLACE FUNCTION public.notification_channel_reaches(p_channel text, p_entity_type text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE p_channel
    WHEN 'webhook' THEN p_entity_type IS DISTINCT FROM 'service_identity'
    WHEN 'email' THEN p_entity_type IS DISTINCT FROM 'service_identity'
                      OR 'Administrator' = ANY (public.notification_email_roles())
    ELSE true
  END;
$$;

ALTER FUNCTION public.notification_channel_reaches(text, text) OWNER TO postgres;

COMMENT ON FUNCTION public.notification_channel_reaches(text, text) IS
  'Whether p_channel may carry an alert about a subject of p_entity_type: the webhook never one about '
  'a machine identity (service_identity), email only when Administrators are among the roles told, '
  'and any other alert always. For the queue trigger, the reminders and the send decision (0262).';

-- 0247's, whole, with the email arm: email can send once a role is named. Whether the site has a
-- mail relay is the dispatcher's to know, and the Settings page asks it.
CREATE OR REPLACE FUNCTION public.notification_channel_is_configured(p_channel text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT CASE p_channel
    WHEN 'webhook' THEN EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'notification_webhook_url')
                    AND EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'notification_webhook_signing_key')
    WHEN 'email' THEN cardinality(public.notification_email_roles()) > 0
    ELSE false
  END;
$$;

ALTER FUNCTION public.notification_channel_is_configured(text) OWNER TO postgres;

COMMENT ON FUNCTION public.notification_channel_is_configured(text) IS
  'Whether p_channel has what it needs to send: for webhook, its address and its signing key in the '
  'vault; for email, at least one role to tell. Nothing is queued for a channel that is not '
  '(0247, 0262).';

-- -------------------------------------------------------------------------------------------------
-- 4. Queueing
-- -------------------------------------------------------------------------------------------------
-- 0247's trigger function, whole, with the email arm beside the webhook's. A resolve follows each
-- channel's own firing message, so it needed no change.
CREATE OR REPLACE FUNCTION public.queue_platform_alert_notifications() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_event text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event := CASE WHEN NEW.status = 'firing' THEN 'firing' END;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    v_event := NEW.status;
  END IF;

  IF v_event = 'firing' THEN
    IF public.notification_channel_reaches('webhook', NEW.entity_type)
       AND public.notification_severity_carried(NEW.severity, 'webhook')
       AND public.notification_channel_is_configured('webhook') THEN
      INSERT INTO public.notification_deliveries (alert_id, event, channel)
      VALUES (NEW.id, 'firing', 'webhook')
      ON CONFLICT DO NOTHING;
    END IF;
    IF public.notification_channel_reaches('email', NEW.entity_type)
       AND public.notification_severity_carried(NEW.severity, 'email')
       AND public.notification_channel_is_configured('email') THEN
      INSERT INTO public.notification_deliveries (alert_id, event, channel)
      VALUES (NEW.id, 'firing', 'email')
      ON CONFLICT DO NOTHING;
    END IF;
  ELSIF v_event = 'resolved' THEN
    INSERT INTO public.notification_deliveries (alert_id, event, channel)
    SELECT NEW.id, 'resolved', d.channel
      FROM public.notification_deliveries d
     WHERE d.alert_id = NEW.id AND d.event = 'firing'
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;

ALTER FUNCTION public.queue_platform_alert_notifications() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queue_platform_alert_notifications() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.queue_platform_alert_notifications() IS
  'AFTER INSERT OR UPDATE OF status on platform_alerts: queues a firing message for each channel '
  'that carries the alert when an occurrence starts firing, and a resolve for each channel that '
  'was queued its firing message when it resolves. A repeat or a stamp queues nothing (0247, 0262).';

-- 0247's, whole, with one condition changed: a reminder is queued only on a channel that still
-- carries the alert, so email is not reminded about a machine identity once Administrators are not told.
CREATE OR REPLACE FUNCTION public.queue_platform_alert_reminders() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_hours numeric := coalesce((SELECT (s.value #>> '{}')::numeric FROM public.system_settings s
                                WHERE s.key = 'notifications.reminder_hours'
                                  AND jsonb_typeof(s.value) = 'number'), 12);
  v_count integer;
BEGIN
  INSERT INTO public.notification_deliveries (alert_id, event, channel)
  SELECT a.id, 'reminder', f.channel
    FROM public.notification_deliveries f
    JOIN public.platform_alerts a ON a.id = f.alert_id
   WHERE f.event = 'firing' AND f.state = 'sent'
     AND a.status = 'firing'
     AND a.acknowledged_at IS NULL
     AND public.notification_channel_reaches(f.channel, a.entity_type)
     AND public.platform_alert_is_confirmed(a)
     AND public.notification_severity_carried(a.severity, f.channel)
     AND public.notification_channel_is_configured(f.channel)
     AND NOT EXISTS (SELECT 1 FROM public.platform_alerts n
                      WHERE n.fingerprint = a.fingerprint AND n.starts_at > a.starts_at)
     AND NOT EXISTS (SELECT 1 FROM public.notification_deliveries p
                      WHERE p.alert_id = a.id AND p.channel = f.channel AND p.event = 'reminder'
                        AND p.state = 'pending')
     AND greatest(f.finished_at,
                  (SELECT max(r.created_at) FROM public.notification_deliveries r
                    WHERE r.alert_id = a.id AND r.channel = f.channel AND r.event = 'reminder'))
         <= now() - make_interval(secs => (v_hours * 3600)::double precision);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

ALTER FUNCTION public.queue_platform_alert_reminders() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queue_platform_alert_reminders() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.queue_platform_alert_reminders() IS
  'Queue a reminder for each alert still firing, unacknowledged and confirmed by its writer, on each '
  'channel that still carries it, notifications.reminder_hours after its firing message was sent or '
  'its last reminder queued. Returns how many. Called every minute by sweep_notifications() '
  '(0247, 0262).';

-- -------------------------------------------------------------------------------------------------
-- 5. The send decision
-- -------------------------------------------------------------------------------------------------
-- 0250's, whole, with the webhook-only drop made the channel's own rule. The arms are 0247's table
-- and 0250's hold, and email takes each of them as the webhook does.
CREATE OR REPLACE FUNCTION public.platform_alert_send_decision(p_alert_id uuid, p_event text, p_channel text)
RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_alert  public.platform_alerts;
  v_firing text;
BEGIN
  IF p_event IS NULL OR NOT p_event = ANY (ARRAY['firing', 'resolved', 'reminder']) THEN
    RAISE EXCEPTION 'An alert''s event is firing, resolved or reminder, not %.', coalesce(quote_literal(p_event), 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_alert FROM public.platform_alerts WHERE id = p_alert_id;
  IF NOT FOUND THEN
    RETURN 'drop';
  END IF;
  -- The dispatcher runs as the service role, past RLS, so it applies the select policy's own
  -- predicate: a channel carries only what the people it tells may read.
  IF NOT public.notification_channel_reaches(p_channel, v_alert.entity_type) THEN
    RETURN 'drop';
  END IF;

  IF p_event = 'resolved' THEN
    SELECT d.state INTO v_firing
      FROM public.notification_deliveries d
     WHERE d.alert_id = p_alert_id AND d.channel = p_channel AND d.event = 'firing';
    RETURN CASE v_firing WHEN 'sent' THEN 'send' WHEN 'pending' THEN 'hold' ELSE 'drop' END;
  END IF;

  IF v_alert.status <> 'firing'
     OR EXISTS (SELECT 1 FROM public.platform_alerts n
                 WHERE n.fingerprint = v_alert.fingerprint AND n.starts_at > v_alert.starts_at) THEN
    RETURN 'drop';
  END IF;
  IF v_alert.acknowledged_at IS NOT NULL THEN
    RETURN 'drop';
  END IF;
  IF p_event = 'reminder' AND NOT public.platform_alert_is_confirmed(v_alert) THEN
    RETURN 'drop';
  END IF;
  -- SUPPRESSION ARM: the predicate the dashboard reads, asked now, not the occurrence's stamp. After
  -- the drops, so an alert that resolved or was acknowledged in its window is never sent.
  IF public.platform_alert_suppressing_window(v_alert.entity_type, v_alert.entity_id, now()) IS NOT NULL THEN
    RETURN 'hold';
  END IF;
  RETURN 'send';
END
$$;

ALTER FUNCTION public.platform_alert_send_decision(uuid, text, text) OWNER TO postgres;

COMMENT ON FUNCTION public.platform_alert_send_decision(uuid, text, text) IS
  'send, hold or drop for one queued message about an alert, decided as it is about to be sent: a '
  'firing message or a reminder is dropped once the occurrence has resolved, been replaced or been '
  'acknowledged, and a reminder once its writer stops confirming it; either is held while a '
  'suppression window covers the alert (0250); a resolve is sent only if its firing message was, '
  'and held while that one is still pending. A channel that may not carry the alert drops it: the '
  'webhook a machine identity''s alert, email one too unless Administrators are told (0247, 0262).';

-- CREATE OR REPLACE keeps the grants the earlier files gave; restated, so this file stands on its own.
REVOKE ALL ON FUNCTION public.platform_alert_send_decision(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_alert_send_decision(uuid, text, text) TO service_role;

-- -------------------------------------------------------------------------------------------------
-- 6. Who may call what
-- -------------------------------------------------------------------------------------------------
DO $grants$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
      'public.notification_email_roles_problem(jsonb)', 'public.notification_email_roles()',
      'public.notification_channel_reaches(text, text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_fn);
  END LOOP;
END
$grants$;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn  text;
  v_src text;
BEGIN
  -- The channel list: email is admitted, and nothing else is.
  IF position('''email''' IN public.live_constraint_definition('public.notification_deliveries'::regclass,
                                                                'notification_deliveries_channel_valid')) = 0
     OR position('''webhook''' IN public.live_constraint_definition('public.notification_deliveries'::regclass,
                                                                    'notification_deliveries_channel_valid')) = 0 THEN
    RAISE EXCEPTION '0262: notification_deliveries_channel_valid does not admit both webhook and email';
  END IF;
  BEGIN
    INSERT INTO public.notification_deliveries (event, channel) VALUES ('test', 'sms');
    RAISE EXCEPTION '0262: notification_deliveries admits a channel that is neither webhook nor email';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Both settings are declared, with the types the guard and the page rely on.
  IF NOT EXISTS (SELECT 1 FROM public.system_settings
                  WHERE key = 'notifications.email_min_severity' AND value_type = 'string'
                    AND category = 'Notifications' AND NOT sensitive)
     OR NOT EXISTS (SELECT 1 FROM public.system_settings
                     WHERE key = 'notifications.email_roles' AND value_type = 'json'
                       AND category = 'Notifications' AND NOT sensitive) THEN
    RAISE EXCEPTION '0262: the email route''s two settings are not declared as a string and a json list, readable by every role';
  END IF;

  -- The roles' rule, and the severity's, as the guard applies them.
  IF public.notification_email_roles_problem('["Administrator", "Shopfloor_Manager"]') IS NOT NULL
     OR public.notification_email_roles_problem('[]') IS NOT NULL
     OR public.notification_email_roles_problem('["Plumber"]') IS NULL
     OR public.notification_email_roles_problem('["Administrator", "Administrator"]') IS NULL
     OR public.notification_email_roles_problem('"Administrator"') IS NULL
     OR public.notification_email_roles_problem('[1]') IS NULL THEN
    RAISE EXCEPTION '0262: notification_email_roles_problem() admits what it must refuse, or the reverse';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.notification_setting_guard()'::regprocedure;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.notification_setting_guard()'::regprocedure) THEN
    RAISE EXCEPTION '0262: notification_setting_guard() is not SECURITY DEFINER, so a caller who may not run its helpers is refused';
  END IF;
  IF position('notifications.email_min_severity' IN v_src) = 0 OR position('notifications.email_roles' IN v_src) = 0
     OR position('notifications.webhook_allowed_hosts' IN v_src) = 0 OR position('notifications.reminder_hours' IN v_src) = 0 THEN
    RAISE EXCEPTION '0262: notification_setting_guard() lost an arm of 0248, or lacks one of the email settings';
  END IF;

  -- Which alerts a channel carries. Email about a machine identity depends on a setting, so only the
  -- arms that do not are asserted.
  IF public.notification_channel_reaches('webhook', 'service_identity')
     OR NOT public.notification_channel_reaches('webhook', 'device')
     OR NOT public.notification_channel_reaches('email', 'device')
     OR NOT public.notification_channel_reaches('email', 'platform')
     OR NOT public.notification_channel_reaches('sms', 'service_identity') THEN
    RAISE EXCEPTION '0262: notification_channel_reaches() answers other than 0247''s for the webhook, or refuses an alert email may carry';
  END IF;

  -- The three that read it ask it, and the trigger names both channels.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.queue_platform_alert_notifications()'::regprocedure;
  IF position('notification_channel_reaches(''email'', NEW.entity_type)' IN v_src) = 0
     OR position('notification_channel_reaches(''webhook'', NEW.entity_type)' IN v_src) = 0 THEN
    RAISE EXCEPTION '0262: queue_platform_alert_notifications() does not ask which channels reach the alert';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.queue_platform_alert_reminders()'::regprocedure;
  IF position('notification_channel_reaches(f.channel, a.entity_type)' IN v_src) = 0 THEN
    RAISE EXCEPTION '0262: queue_platform_alert_reminders() does not ask which channels reach the alert';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.platform_alert_send_decision(uuid, text, text)'::regprocedure;
  IF position('notification_channel_reaches(p_channel, v_alert.entity_type)' IN v_src) = 0 THEN
    RAISE EXCEPTION '0262: platform_alert_send_decision() does not ask which channels reach the alert';
  END IF;
  -- 0250's arms are all still there, in 0250's order: the drops, then the hold.
  IF position('platform_alert_suppressing_window(v_alert.entity_type, v_alert.entity_id, now())' IN v_src) = 0
     OR position('acknowledged_at IS NOT NULL' IN v_src) > position('SUPPRESSION ARM' IN v_src) THEN
    RAISE EXCEPTION '0262: platform_alert_send_decision() lost 0250''s suppression arm, or holds before it drops an acknowledged alert';
  END IF;
  v_fn := 'public.platform_alert_send_decision(uuid, text, text)';
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0262: platform_alert_send_decision() is not the service role''s alone to run';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                  AND prosecdef AND provolatile = 's' AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0262: % is not STABLE SECURITY DEFINER with its search_path pinned', v_fn;
  END IF;
  IF public.platform_alert_send_decision('00000000-0000-4000-8000-000000000000', 'firing', 'email') <> 'drop' THEN
    RAISE EXCEPTION '0262: platform_alert_send_decision() does not drop an email about an occurrence that is gone';
  END IF;

  -- No browser role may run the new helpers, and the redeclared writers stay the owner's.
  FOREACH v_fn IN ARRAY ARRAY[
      'public.notification_email_roles_problem(jsonb)', 'public.notification_email_roles()',
      'public.notification_channel_reaches(text, text)', 'public.queue_platform_alert_notifications()',
      'public.queue_platform_alert_reminders()', 'public.notification_setting_guard()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0262: an API role may execute %', v_fn;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.notification_channel_is_configured(text)'::regprocedure
                  AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0262: notification_channel_is_configured() is not SECURITY DEFINER with its search_path pinned';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
