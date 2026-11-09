-- 0263: An email goes to the people who hold the roles it names, and the log says how many.
--
-- 0262 made email a channel with a route. This file answers who it goes to, how a test is asked
-- for, and what the delivery log keeps of a send.
--
--   * notification_email_address() is how an address is found: auth.users.email, for a person who
--     can sign in. A machine identity, an account whose access was removed or that GoTrue bans, and
--     a person with no address are told nothing.
--   * notification_email_recipients() resolves a message's people when it is sent, as the dispatcher
--     asks: the people in user_roles whose role the email route names, or the person who asked for a
--     test. A machine identity's alert goes to Administrators only. The dispatcher runs as the
--     service role, past RLS, so the database applies each alert's visibility itself.
--   * The log keeps how many people a message went to and how many the relay refused, never their
--     addresses: every role reads the log (0247), and an address is not theirs to read.
--   * queue_test_email_notification() queues a test for the Administrator who asks, to their own
--     address, as queue_test_notification() does for the webhook.
--
-- Reasoning: supabase/README.md, "An email goes to the people who hold the roles it names (0263)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. What the log keeps of a send
-- -------------------------------------------------------------------------------------------------
ALTER TABLE public.notification_deliveries
    ADD COLUMN IF NOT EXISTS recipients integer
        CONSTRAINT notification_deliveries_recipients_valid CHECK ((recipients >= 0)),
    ADD COLUMN IF NOT EXISTS refused integer
        CONSTRAINT notification_deliveries_refused_valid CHECK ((refused >= 0));

COMMENT ON COLUMN public.notification_deliveries.recipients IS
  'For an email, how many people the relay took the message for; NULL for the webhook and until it '
  'is sent. A count, never the addresses: every role reads this table (0263).';
COMMENT ON COLUMN public.notification_deliveries.refused IS
  'For an email, how many addresses the relay refused while taking the others; NULL otherwise (0263).';

-- -------------------------------------------------------------------------------------------------
-- 2. Finding the people
-- -------------------------------------------------------------------------------------------------
-- The address GoTrue holds for a person, lower-cased, or NULL when the person is to be told nothing:
-- no account, no address, a machine identity (no way to sign in), or access removed or banned.
CREATE OR REPLACE FUNCTION public.notification_email_address(p_user_id uuid) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
  SELECT lower(btrim(u.email::text))
    FROM auth.users u
   WHERE u.id = p_user_id
     AND nullif(btrim(coalesce(u.email::text, '')), '') IS NOT NULL
     AND NOT public.is_machine_principal(u.id)
     AND NOT public.person_access_is_removed(u.id);
$$;

ALTER FUNCTION public.notification_email_address(uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.notification_email_address(uuid) IS
  'The address GoTrue holds for a person who can sign in (auth.users.email), lower-cased; NULL for no '
  'account, no address, a machine identity, or access removed or banned (0263).';

-- The addresses one email goes to, as a JSON list of strings. A pass that does not hold the dispatch
-- lease is refused, as for every other read of the queue.
CREATE OR REPLACE FUNCTION public.notification_email_recipients(p_holder uuid, p_delivery_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_row       public.notification_deliveries;
  v_alert     public.platform_alerts;
  v_roles     text[];
  v_addresses text[];
BEGIN
  PERFORM public.require_notification_dispatch_holder(p_holder);

  SELECT * INTO v_row FROM public.notification_deliveries WHERE id = p_delivery_id AND channel = 'email';
  IF NOT FOUND THEN
    RETURN '[]'::jsonb;
  END IF;

  -- A test goes to the one person who asked for it.
  IF v_row.event = 'test' THEN
    SELECT array_agg(a) INTO v_addresses FROM (SELECT public.notification_email_address(v_row.requested_by) AS a) t
     WHERE a IS NOT NULL;
    RETURN to_jsonb(coalesce(v_addresses, ARRAY[]::text[]));
  END IF;

  SELECT * INTO v_alert FROM public.platform_alerts WHERE id = v_row.alert_id;
  IF NOT FOUND THEN
    RETURN '[]'::jsonb;
  END IF;

  -- The roles the route names now. A machine identity's alert is an Administrator's to read (0204),
  -- so of those roles only Administrator is told it.
  v_roles := public.notification_email_roles();
  IF v_alert.entity_type = 'service_identity' THEN
    v_roles := ARRAY(SELECT r FROM unnest(v_roles) AS t(r) WHERE r = 'Administrator');
  END IF;

  SELECT array_agg(DISTINCT p.address ORDER BY p.address) INTO v_addresses
    FROM (SELECT public.notification_email_address(ur.user_id) AS address
            FROM public.user_roles ur
            JOIN public.roles r ON r.id = ur.role_id
           WHERE r.name = ANY (v_roles)) p
   WHERE p.address IS NOT NULL;
  RETURN to_jsonb(coalesce(v_addresses, ARRAY[]::text[]));
END
$$;

ALTER FUNCTION public.notification_email_recipients(uuid, uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.notification_email_recipients(uuid, uuid) IS
  'The addresses email message p_delivery_id goes to, as a JSON list, for the pass holding the '
  'dispatch lease: the person who asked for a test, or the people in user_roles whose role '
  'notifications.email_roles names and who have an address (auth.users.email) and access. A machine '
  'identity''s alert goes to Administrators only. An empty list is nobody to tell (0263).';

-- -------------------------------------------------------------------------------------------------
-- 3. What the dispatcher records of an email
-- -------------------------------------------------------------------------------------------------
-- record_notification_delivery()'s outcome, then the counts, and for a send the relay's note on an
-- address it refused. One name beside it rather than a new argument on it: a change of signature
-- would leave 0247's behind on every database that has run it.
CREATE OR REPLACE FUNCTION public.record_notification_email_delivery(
    p_holder uuid, p_id uuid, p_outcome text, p_retry_seconds integer DEFAULT NULL,
    p_status integer DEFAULT NULL, p_error text DEFAULT NULL,
    p_recipients integer DEFAULT NULL, p_refused integer DEFAULT NULL)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_state text;
BEGIN
  v_state := public.record_notification_delivery(p_holder, p_id, p_outcome, p_retry_seconds, p_status, p_error);
  IF v_state IS NOT NULL THEN
    UPDATE public.notification_deliveries d
       SET recipients = p_recipients,
           refused = p_refused,
           -- A send carries a note only when the relay refused some addresses.
           last_error = CASE WHEN p_outcome = 'sent' THEN left(nullif(btrim(coalesce(p_error, '')), ''), 500)
                             ELSE d.last_error END
     WHERE d.id = p_id AND d.channel = 'email';
  END IF;
  RETURN v_state;
END
$$;

ALTER FUNCTION public.record_notification_email_delivery(uuid, uuid, text, integer, integer, text, integer, integer) OWNER TO postgres;

COMMENT ON FUNCTION public.record_notification_email_delivery(uuid, uuid, text, integer, integer, text, integer, integer) IS
  'record_notification_delivery(), and then for an email row how many people the relay took the '
  'message for and how many addresses it refused, with the relay''s words on a refusal as a note on '
  'a send. Returns the new state, or NULL when the row was not pending (0263).';

-- -------------------------------------------------------------------------------------------------
-- 4. A test
-- -------------------------------------------------------------------------------------------------
-- Through the queue, as every message, to the Administrator who asked, so a test shows the whole
-- path: the relay, the sender and the message. The newest 20 finished email tests are kept.
CREATE OR REPLACE FUNCTION public.queue_test_email_notification() RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id  uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'only an Administrator may send a test email'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.require_mfa();
  IF public.notification_email_address(v_uid) IS NULL THEN
    RAISE EXCEPTION 'Your account has no email address, so a test cannot be sent to you.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  DELETE FROM public.notification_deliveries d
   WHERE d.event = 'test' AND d.channel = 'email' AND d.state <> 'pending'
     AND d.id NOT IN (SELECT t.id FROM public.notification_deliveries t
                       WHERE t.event = 'test' AND t.channel = 'email' AND t.state <> 'pending'
                       ORDER BY t.created_at DESC LIMIT 20);
  INSERT INTO public.notification_deliveries (event, channel, requested_by)
  VALUES ('test', 'email', v_uid)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

ALTER FUNCTION public.queue_test_email_notification() OWNER TO postgres;

COMMENT ON FUNCTION public.queue_test_email_notification() IS
  'Queue a test email to the caller''s own address and return its id; the delivery log row with that '
  'id says how it went. Administrator only (42501); 55000 when the account has no address. Keeps the '
  'newest 20 finished email tests (0263).';

-- -------------------------------------------------------------------------------------------------
-- 5. Who may call what
-- -------------------------------------------------------------------------------------------------
DO $grants$
DECLARE
  v_fn text;
BEGIN
  -- The dispatcher's two.
  FOREACH v_fn IN ARRAY ARRAY[
      'public.notification_email_recipients(uuid, uuid)',
      'public.record_notification_email_delivery(uuid, uuid, text, integer, integer, text, integer, integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
  -- An Administrator's, who calls it from the Settings page; it checks the role itself.
  REVOKE ALL ON FUNCTION public.queue_test_email_notification() FROM PUBLIC, anon, service_role;
  GRANT EXECUTE ON FUNCTION public.queue_test_email_notification() TO authenticated;
  -- The lookup is for the two above and for nobody's call.
  REVOKE ALL ON FUNCTION public.notification_email_address(uuid) FROM PUBLIC, anon, authenticated, service_role;
END
$grants$;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'notification_deliveries'
                    AND column_name = 'recipients' AND data_type = 'integer' AND is_nullable = 'YES')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'notification_deliveries'
                       AND column_name = 'refused' AND data_type = 'integer' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION '0263: notification_deliveries.recipients and .refused are missing or not nullable integers';
  END IF;
  -- The log is every role's to read, so it holds no address: no column of it is text that could.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'notification_deliveries'
                AND column_name ~* '(address|email|recipient)' AND data_type <> 'integer') THEN
    RAISE EXCEPTION '0263: notification_deliveries has a column that could hold an address';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
      'public.notification_email_recipients(uuid, uuid)',
      'public.record_notification_email_delivery(uuid, uuid, text, integer, integer, text, integer, integer)'] LOOP
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0263: service_role may not execute %; notification-dispatch calls it', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0263: anon or authenticated may execute %', v_fn;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure AND prosecdef
                    AND proconfig && ARRAY['search_path=public', 'search_path=public, pg_catalog']) THEN
      RAISE EXCEPTION '0263: % is not SECURITY DEFINER with its search_path pinned', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.queue_test_email_notification()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.queue_test_email_notification()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.queue_test_email_notification()', 'EXECUTE') THEN
    RAISE EXCEPTION '0263: queue_test_email_notification() is not a signed-in person''s to call';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.queue_test_email_notification()'::regprocedure AND prosecdef
                  AND 'search_path=public, pg_catalog' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0263: queue_test_email_notification() is not SECURITY DEFINER with its search_path pinned';
  END IF;
  IF has_function_privilege('anon', 'public.notification_email_address(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.notification_email_address(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.notification_email_address(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0263: an API role may execute notification_email_address()';
  END IF;

  -- No person behind the request: refused before anything is read or written. And the lookup finds
  -- nobody for an id that is no account.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.queue_test_email_notification();
    RAISE EXCEPTION '0263: queue_test_email_notification() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF public.notification_email_address('00000000-0000-4000-8000-000000000000') IS NOT NULL THEN
    RAISE EXCEPTION '0263: notification_email_address() found an address for an id that is no account';
  END IF;
  BEGIN
    PERFORM public.notification_email_recipients('00000000-0000-4000-8000-000000000000',
                                                  '00000000-0000-4000-8000-000000000000');
    RAISE EXCEPTION '0263: notification_email_recipients() answered a pass that holds no lease';
  EXCEPTION WHEN lock_not_available THEN NULL;
  END;
END
$check$;

NOTIFY pgrst, 'reload schema';
