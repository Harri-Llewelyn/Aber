-- 0248: The webhook is signed, and kept to the hosts an Administrator allows.
--
-- The one channel 0247's dispatcher sends to today: a generic outbound webhook, any URL whose host
-- an Administrator has allowed. No product is named; a chat channel is reached by pointing the
-- webhook at it, or at a receiver on the site's own network.
--
--   * The address is a foreign credential: a webhook URL is a bearer secret another system issued.
--     set_notification_webhook_url() writes it through set_foreign_credential(), and
--     notification_webhook_url_is_set() probes it through foreign_credential_is_set() (0178).
--     clear_notification_webhook_url() removes it, and what was waiting for it is dropped.
--   * The routes and the allow-list are closed system_settings keys in the Notifications category,
--     each checked by notification_setting_guard(): notifications.webhook_min_severity,
--     notifications.webhook_allowed_hosts (an Administrator's alone to read, as a destination is)
--     and notifications.reminder_hours. 0002 seeds them.
--   * The signing key is Aber's: issue_notification_signing_key() generates one, keeps it in the
--     vault, shows it once and writes a SIGNING_KEY_ISSUED row (0249 files it). Issuing again
--     rotates it.
--   * notification_webhook_destination() is what notification-dispatch reads: the address, the
--     key and the allowed hosts, for the service role alone.
--   * queue_test_notification() queues an aber.test message, and the delivery log shows how it went.
--
-- Reasoning: supabase/README.md, "The webhook is signed and kept to its allowed hosts (0248)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Each Notifications setting's own rule
-- -------------------------------------------------------------------------------------------------
-- The allowed hosts: lower-case DNS names or IPv4 addresses, or an IPv6 address in brackets, each
-- once, at most 20. A host, not a URL: the port and the path are the address's, which is secret.
CREATE OR REPLACE FUNCTION public.notification_allowed_hosts_problem(p_value jsonb) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_host jsonb;
  v_text text;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'array' THEN
    RETURN 'must be a list of host names';
  END IF;
  IF jsonb_array_length(p_value) > 20 THEN
    RETURN 'holds at most 20 hosts';
  END IF;
  FOR v_host IN SELECT h FROM jsonb_array_elements(p_value) AS e(h) LOOP
    IF jsonb_typeof(v_host) <> 'string' THEN
      RETURN 'must be a list of host names';
    END IF;
    v_text := v_host #>> '{}';
    IF char_length(v_text) > 253
       OR (v_text !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
           AND v_text !~ '^\[[0-9a-f:.]+\]$') THEN
      RETURN format('names %s, which is not a lower-case host name: no scheme, port or path', quote_literal(v_text));
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT h) FROM jsonb_array_elements_text(p_value) AS e(h)) <> jsonb_array_length(p_value) THEN
    RETURN 'names a host twice';
  END IF;
  RETURN NULL;
END
$$;

ALTER FUNCTION public.notification_allowed_hosts_problem(jsonb) OWNER TO postgres;

COMMENT ON FUNCTION public.notification_allowed_hosts_problem(jsonb) IS
  'What is wrong with a value for notifications.webhook_allowed_hosts, or NULL: a list of at most 20 '
  'distinct lower-case host names, IPv4 addresses or bracketed IPv6 addresses (0248).';

-- BEFORE UPDATE, beside backup_offsite_setting_guard(): the table's CHECKs hold the type and the
-- bounds, and this the rest. 22023 would read as the caller's fault; check_violation, as theirs, is
-- what PostgREST answers 400 with the sentence.
CREATE OR REPLACE FUNCTION public.notification_setting_guard() RETURNS trigger
    LANGUAGE plpgsql
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
    WHEN 'notifications.webhook_allowed_hosts' THEN
      public.notification_allowed_hosts_problem(NEW.value)
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
  'critical, an allowed-hosts list that is not one of host names, and a part hour (0248).';

SELECT public.replay_trigger('public.system_settings', 'notification_setting_guard_trg', $ddl$
CREATE TRIGGER notification_setting_guard_trg BEFORE UPDATE ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.notification_setting_guard();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 2. The address, a foreign credential
-- -------------------------------------------------------------------------------------------------
-- http or https, a host, and no user name or password in it: a credential belongs in the path or
-- the query, where the receiver issued it. The host is checked against the allow-list when it is
-- sent, not here, so the list can be changed in either order.
CREATE OR REPLACE FUNCTION public.set_notification_webhook_url(p_url text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_url text := btrim(coalesce(p_url, ''));
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'only an Administrator may set the webhook''s address'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF char_length(v_url) > 2048 OR v_url !~ '^https?://[^\s/?#@]+(/[^\s]*)?$' THEN
    RAISE EXCEPTION 'The webhook''s address is a URL starting http:// or https://, with no spaces and no user name in it.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM public.set_foreign_credential('notification_webhook_url', v_url, 'the webhook''s address',
    'Where notification-dispatch posts each alert (0248). A foreign credential: the receiver issued it.');
END
$$;

ALTER FUNCTION public.set_notification_webhook_url(text) OWNER TO postgres;

COMMENT ON FUNCTION public.set_notification_webhook_url(text) IS
  'Write the webhook''s address into the vault through set_foreign_credential(). Administrator only '
  '(42501); an address that is not an http or https URL, or that names a user, is 22023. '
  'WRITE-ONLY: nothing reads it back to a browser (0248).';

CREATE OR REPLACE FUNCTION public.notification_webhook_url_is_set() RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  RETURN public.foreign_credential_is_set('notification_webhook_url');
END
$$;

ALTER FUNCTION public.notification_webhook_url_is_set() OWNER TO postgres;

COMMENT ON FUNCTION public.notification_webhook_url_is_set() IS
  'True when the webhook''s address is in the vault and the caller is an Administrator; false for '
  'everyone else (0248).';

-- Removing the address switches the webhook off. A message still waiting can go nowhere, so it is
-- dropped; the delivery log keeps it.
CREATE OR REPLACE FUNCTION public.clear_notification_webhook_url() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_dropped integer;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'only an Administrator may remove the webhook'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM vault.secrets WHERE name = 'notification_webhook_url';
  UPDATE public.notification_deliveries
     SET state = 'dropped', finished_at = now()
   WHERE channel = 'webhook' AND state = 'pending';
  GET DIAGNOSTICS v_dropped = ROW_COUNT;
  RETURN v_dropped;
END
$$;

ALTER FUNCTION public.clear_notification_webhook_url() OWNER TO postgres;

COMMENT ON FUNCTION public.clear_notification_webhook_url() IS
  'Remove the webhook''s address from the vault, which stops the webhook, and drop what was still '
  'waiting for it. Administrator only (42501). Returns how many were dropped. The signing key is '
  'kept (0248).';

-- -------------------------------------------------------------------------------------------------
-- 3. The signing key, Aber's own
-- -------------------------------------------------------------------------------------------------
-- 32 random bytes as Standard Webhooks writes a key, whsec_<base64>, so a receiver's verifier
-- takes it as it is. Replaced, not updated, so the vault row's created_at is when it was issued.
-- Shown once: the caller gets it, and nothing reads it back to a browser.
CREATE OR REPLACE FUNCTION public.issue_notification_signing_key() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_key    text := 'whsec_' || encode(extensions.gen_random_bytes(32), 'base64');
  v_prior  timestamp with time zone;
  v_issued timestamp with time zone;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'only an Administrator may issue the webhook''s signing key'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT created_at INTO v_prior FROM vault.secrets WHERE name = 'notification_webhook_signing_key';
  DELETE FROM vault.secrets WHERE name = 'notification_webhook_signing_key';
  PERFORM vault.create_secret(v_key, 'notification_webhook_signing_key',
    'The key notification-dispatch signs each webhook message with (0248). Issued by an '
    'Administrator and shown to them once.');
  SELECT created_at INTO v_issued FROM vault.secrets WHERE name = 'notification_webhook_signing_key';

  -- In the webhook's own lane. The key itself is never in it.
  INSERT INTO public.audit_trail (
      entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
      causation_id, recorded_at
  ) VALUES (
      'notification_channels', md5('notification_channels:webhook')::uuid, 'SIGNING_KEY_ISSUED',
      CASE WHEN v_prior IS NULL THEN NULL
           ELSE jsonb_build_object('name', 'Webhook', 'channel', 'webhook',
                                   'issued_at', to_char(v_prior AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END,
      jsonb_build_object('name', 'Webhook', 'channel', 'webhook', 'replaced', v_prior IS NOT NULL,
                         'issued_at', to_char(v_issued AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      v_uid, public.audit_actor_source(), txid_current(), now()
  );
  RETURN v_key;
END
$$;

ALTER FUNCTION public.issue_notification_signing_key() OWNER TO postgres;

COMMENT ON FUNCTION public.issue_notification_signing_key() IS
  'Generate the webhook''s signing key (whsec_ and 32 random bytes in base64), keep it in the '
  'vault, and return it: the one time it is shown. Issuing again rotates it, and the old key stops '
  'signing at once. Administrator only (42501). Writes one SIGNING_KEY_ISSUED row, which never '
  'holds the key (0248).';

-- What the panel shows. Whether, never what, and to an Administrator alone, as the probes.
CREATE OR REPLACE FUNCTION public.notification_webhook_status() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RETURN jsonb_build_object('visible', false, 'url_set', NULL, 'signing_key_issued_at', NULL);
  END IF;
  RETURN jsonb_build_object(
    'visible', true,
    'url_set', public.foreign_credential_is_set('notification_webhook_url'),
    'signing_key_issued_at', (SELECT created_at FROM vault.secrets WHERE name = 'notification_webhook_signing_key'));
END
$$;

ALTER FUNCTION public.notification_webhook_status() OWNER TO postgres;

COMMENT ON FUNCTION public.notification_webhook_status() IS
  'For an Administrator: whether the webhook''s address is set, and when its signing key was issued '
  '(NULL when none has been). For everyone else, visible false and nothing else (0248).';

-- -------------------------------------------------------------------------------------------------
-- 4. What the dispatcher reads
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notification_webhook_destination() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
  SELECT jsonb_build_object(
    'url', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'notification_webhook_url'),
    'signing_key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'notification_webhook_signing_key'),
    'allowed_hosts', coalesce((SELECT CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value END
                                 FROM public.system_settings s WHERE s.key = 'notifications.webhook_allowed_hosts'),
                              '[]'::jsonb));
$$;

ALTER FUNCTION public.notification_webhook_destination() OWNER TO postgres;

COMMENT ON FUNCTION public.notification_webhook_destination() IS
  'The webhook''s address, its signing key and its allowed hosts, for notification-dispatch alone: '
  'no browser role may call it. A value not set is NULL (0248).';

-- -------------------------------------------------------------------------------------------------
-- 5. A test
-- -------------------------------------------------------------------------------------------------
-- Through the queue, as every other message: the function is not reachable from a browser, and the
-- delivery log is where the outcome is read. The newest 20 finished tests are kept.
CREATE OR REPLACE FUNCTION public.queue_test_notification() RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id  uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'only an Administrator may send a test'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'notification_webhook_url') THEN
    RAISE EXCEPTION 'Set the webhook''s address before sending a test.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'notification_webhook_signing_key') THEN
    RAISE EXCEPTION 'Issue a signing key before sending a test: every message is signed.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  DELETE FROM public.notification_deliveries d
   WHERE d.event = 'test' AND d.state <> 'pending'
     AND d.id NOT IN (SELECT t.id FROM public.notification_deliveries t
                       WHERE t.event = 'test' AND t.state <> 'pending'
                       ORDER BY t.created_at DESC LIMIT 20);
  INSERT INTO public.notification_deliveries (event, channel, requested_by)
  VALUES ('test', 'webhook', v_uid)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

ALTER FUNCTION public.queue_test_notification() OWNER TO postgres;

COMMENT ON FUNCTION public.queue_test_notification() IS
  'Queue an aber.test message to the webhook and return its id; the delivery log row with that id '
  'says how it went. Administrator only (42501); 55000 until the address is set and a signing key '
  'issued. Keeps the newest 20 finished tests (0248).';

-- -------------------------------------------------------------------------------------------------
-- 6. Who may call what
-- -------------------------------------------------------------------------------------------------
-- A signed-in person calls the panel's five; each checks the role itself. The destination is the
-- dispatcher's alone.
DO $grants$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
      'public.set_notification_webhook_url(text)', 'public.notification_webhook_url_is_set()',
      'public.clear_notification_webhook_url()', 'public.issue_notification_signing_key()',
      'public.notification_webhook_status()', 'public.queue_test_notification()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn);
  END LOOP;
  REVOKE ALL ON FUNCTION public.notification_webhook_destination() FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.notification_webhook_destination() TO service_role;
  REVOKE ALL ON FUNCTION public.notification_allowed_hosts_problem(jsonb) FROM PUBLIC, anon, authenticated, service_role;
END
$grants$;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
      'public.set_notification_webhook_url(text)', 'public.notification_webhook_url_is_set()',
      'public.clear_notification_webhook_url()', 'public.issue_notification_signing_key()',
      'public.notification_webhook_status()', 'public.queue_test_notification()',
      'public.notification_webhook_destination()'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure AND prosecdef
                    AND 'search_path=public, pg_catalog' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0248: % is not SECURITY DEFINER with its search_path pinned', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0248: anon may execute %', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.notification_webhook_destination()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.notification_webhook_destination()', 'EXECUTE') THEN
    RAISE EXCEPTION '0248: notification_webhook_destination() is not the service role''s alone';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.issue_notification_signing_key()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.issue_notification_signing_key()', 'EXECUTE') THEN
    RAISE EXCEPTION '0248: issue_notification_signing_key() is not a signed-in person''s to call';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.system_settings'::regclass
                    AND t.tgname = 'notification_setting_guard_trg' AND NOT t.tgisinternal
                    AND t.tgenabled = 'O' AND t.tgtype = 19) THEN
    RAISE EXCEPTION '0248: notification_setting_guard_trg is not BEFORE UPDATE FOR EACH ROW on system_settings';
  END IF;
  IF public.notification_allowed_hosts_problem('["hooks.example.net", "10.0.0.7", "[fd00::7]"]') IS NOT NULL
     OR public.notification_allowed_hosts_problem('["https://hooks.example.net"]') IS NULL
     OR public.notification_allowed_hosts_problem('["Hooks.Example.net"]') IS NULL
     OR public.notification_allowed_hosts_problem('["a", "a"]') IS NULL
     OR public.notification_allowed_hosts_problem('{"host": "a"}') IS NULL THEN
    RAISE EXCEPTION '0248: notification_allowed_hosts_problem() admits what it must refuse, or the reverse';
  END IF;

  -- A request with no person behind it is refused before anything is read or written.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.issue_notification_signing_key();
    RAISE EXCEPTION '0248: issue_notification_signing_key() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.queue_test_notification();
    RAISE EXCEPTION '0248: queue_test_notification() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (public.notification_webhook_status() ->> 'visible')::boolean THEN
    RAISE EXCEPTION '0248: notification_webhook_status() shows the webhook to a caller with no identity';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
