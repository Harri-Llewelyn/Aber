-- 0247: An alert is queued for each channel that carries it, and a dispatcher sends it.
--
-- Until now an alert reached the dashboard and nowhere else. The platform database is the system of
-- record for alerts and their acknowledgements, so it is the database that decides what is sent.
--
--   * notification_deliveries is the queue and the delivery log: one row per message to one
--     channel. A row is pending until it is sent, dropped or dead. The webhook (0248) is the one
--     channel today; email later adds a second without changing a row of the webhook's.
--   * trg_platform_alerts_queue_notifications, AFTER INSERT OR UPDATE OF status on platform_alerts,
--     queues a firing message when an occurrence starts firing and a resolve when it resolves.
--     Nothing else queues: grafana-alert-webhook upserts the same row on every repeat, and its
--     last_confirmed_at stamp is not a status change.
--   * platform_alert_send_decision() answers send, hold or drop for one message, just before the
--     dispatcher sends it. An acknowledgement made after a message was queued stops it.
--   * Reminders: every notifications.reminder_hours while an alert fires unacknowledged and its
--     writer still confirms it (platform_alert_confirmation_window()).
--   * The notification-dispatch edge function drains the queue. A queued row asks for it through
--     pg_net, and pg_cron sweeps every minute as the backstop: sweep_forge()'s shape, with its
--     one-pass lease. It is told apart from any other caller by a secret this file generates.
--
-- 0001 states platform_alerts.last_confirmed_at. 0248 adds the webhook, its settings and its key.
--
-- Reasoning: supabase/README.md, "An alert is queued for each channel that carries it (0247)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The last-confirmed stamp, which 0001 states
-- -------------------------------------------------------------------------------------------------
COMMENT ON COLUMN public.platform_alerts.last_confirmed_at IS
  'When the row''s writer last said it still holds: grafana-alert-webhook stamps it on every post '
  'of the occurrence, Grafana''s repeats included. Not a status change, so it queues no '
  'notification. A firing row confirmed longer ago than platform_alert_confirmation_window() is '
  'sent no reminder. NULL: never confirmed (0247).';

-- -------------------------------------------------------------------------------------------------
-- 2. The queue, which is also the delivery log
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alert_id uuid,
    event text NOT NULL,
    channel text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_attempt_at timestamp with time zone,
    finished_at timestamp with time zone,
    response_status integer,
    last_error text,
    requested_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id),
    CONSTRAINT notification_deliveries_alert_id_fkey FOREIGN KEY (alert_id)
        REFERENCES public.platform_alerts(id) ON DELETE CASCADE,
    CONSTRAINT notification_deliveries_event_valid
        CHECK ((event = ANY (ARRAY['firing'::text, 'resolved'::text, 'reminder'::text, 'test'::text]))),
    CONSTRAINT notification_deliveries_channel_valid CHECK ((channel = ANY (ARRAY['webhook'::text]))),
    CONSTRAINT notification_deliveries_state_valid
        CHECK ((state = ANY (ARRAY['pending'::text, 'sent'::text, 'dropped'::text, 'dead'::text]))),
    CONSTRAINT notification_deliveries_alert_unless_test CHECK (((alert_id IS NULL) = (event = 'test'::text))),
    CONSTRAINT notification_deliveries_finished_unless_pending CHECK (((state = 'pending'::text) = (finished_at IS NULL))),
    CONSTRAINT notification_deliveries_attempts_valid CHECK ((attempts >= 0)),
    CONSTRAINT notification_deliveries_error_length CHECK ((char_length(last_error) <= 500))
);

ALTER TABLE public.notification_deliveries OWNER TO postgres;
ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.notification_deliveries IS
  'One message to one channel: an alert occurrence starting to fire, resolving or reminding, or an '
  'Administrator''s test. The queue the notification-dispatch function drains, and the delivery log '
  'the Notifications settings show. Written only by the functions of 0247 and 0248 (0247).';
COMMENT ON COLUMN public.notification_deliveries.alert_id IS
  'The occurrence (platform_alerts.id) the message is about; NULL for a test. Deleted with it.';
COMMENT ON COLUMN public.notification_deliveries.event IS
  'firing, resolved, reminder or test: the CloudEvents type aber.alert.<event>, or aber.test.';
COMMENT ON COLUMN public.notification_deliveries.channel IS
  'Where it goes. webhook, the generic outbound webhook (0248).';
COMMENT ON COLUMN public.notification_deliveries.state IS
  'pending until it leaves the queue: sent (the receiver answered 2xx), dropped (the send decision '
  'said it no longer applies) or dead (every attempt failed).';
COMMENT ON COLUMN public.notification_deliveries.attempts IS
  'How many times it was posted. A hold is not an attempt.';
COMMENT ON COLUMN public.notification_deliveries.next_attempt_at IS
  'When it is next due: now on queueing, then pushed out by the backoff after a failure, or by a hold.';
COMMENT ON COLUMN public.notification_deliveries.last_error IS
  'Why the last attempt failed, in the dispatcher''s words: never the address, which is a credential.';
COMMENT ON COLUMN public.notification_deliveries.requested_by IS
  'For a test, the Administrator who asked for it. NULL otherwise.';

-- One firing and one resolve per occurrence and channel: a replayed status change queues nothing new.
CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_once_per_occurrence
    ON public.notification_deliveries USING btree (alert_id, channel, event)
    WHERE (event = ANY (ARRAY['firing'::text, 'resolved'::text]));
-- What the decision and the reminders look up, and what the cascade from platform_alerts uses.
CREATE INDEX IF NOT EXISTS notification_deliveries_by_alert
    ON public.notification_deliveries USING btree (alert_id, channel, event, created_at);
CREATE INDEX IF NOT EXISTS notification_deliveries_pending_due
    ON public.notification_deliveries USING btree (next_attempt_at) WHERE (state = 'pending'::text);
CREATE INDEX IF NOT EXISTS notification_deliveries_newest
    ON public.notification_deliveries USING btree (created_at DESC);

-- Every signed-in role reads the log, as the Settings page shows it to every role. A row about an
-- alert is read through platform_alerts' own policy, so an alert a role may not read is not
-- listed either. No role writes it; the functions below do, as its owner.
REVOKE ALL ON TABLE public.notification_deliveries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.notification_deliveries TO authenticated;

-- SECURITY INVOKER, so the lookup runs under the reader's own policy on platform_alerts.
CREATE OR REPLACE FUNCTION public.notification_delivery_is_readable(p_alert_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT p_alert_id IS NULL OR EXISTS (SELECT 1 FROM public.platform_alerts a WHERE a.id = p_alert_id);
$$;

ALTER FUNCTION public.notification_delivery_is_readable(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notification_delivery_is_readable(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.notification_delivery_is_readable(uuid) TO authenticated;

COMMENT ON FUNCTION public.notification_delivery_is_readable(uuid) IS
  'Whether the caller may read a delivery log row about p_alert_id: a test always, an alert when '
  'platform_alerts'' own policy lets them read it. The log''s select policy (0247).';

SELECT public.replay_policy('public.notification_deliveries', 'notification_deliveries_select_authenticated', $ddl$
CREATE POLICY notification_deliveries_select_authenticated ON public.notification_deliveries FOR SELECT TO authenticated USING (public.notification_delivery_is_readable(alert_id));
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 3. The dispatcher's lease: one pass at a time, as the forge sweep's (0156)
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_dispatch_lease (
    id boolean DEFAULT true NOT NULL,
    holder uuid,
    held_until timestamp with time zone DEFAULT '-infinity'::timestamp with time zone NOT NULL,
    requested boolean DEFAULT false NOT NULL,
    CONSTRAINT notification_dispatch_lease_pkey PRIMARY KEY (id),
    CONSTRAINT notification_dispatch_lease_one_row CHECK (id)
);

ALTER TABLE public.notification_dispatch_lease OWNER TO postgres;
ALTER TABLE public.notification_dispatch_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_dispatch_lease FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.notification_dispatch_lease IS
  'The one notification-dispatch pass allowed to run. One row by CHECK (id). Moved only by '
  'claim_notification_dispatch(), renew_notification_dispatch() and '
  'release_notification_dispatch(); RLS on with no policy, and nothing granted (0247).';

INSERT INTO public.notification_dispatch_lease (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- The forge sweep's three, as 0001 states them, on this lease.
CREATE OR REPLACE FUNCTION public.claim_notification_dispatch(p_seconds integer) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_holder uuid;
BEGIN
    IF p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 3600 THEN
        RAISE EXCEPTION 'claim_notification_dispatch: a lease lasts 1 to 3600 seconds, not %', p_seconds
            USING ERRCODE = '22023';
    END IF;

    -- Two claims at once serialise on the row lock, and the second re-reads held_until after the
    -- first commits, so exactly one wins. A new pass sees every row queued before it.
    UPDATE public.notification_dispatch_lease
       SET holder = gen_random_uuid(),
           held_until = clock_timestamp() + make_interval(secs => p_seconds),
           requested = false
     WHERE id AND held_until <= clock_timestamp()
    RETURNING holder INTO v_holder;

    IF v_holder IS NULL THEN
        UPDATE public.notification_dispatch_lease SET requested = true WHERE id;
    END IF;
    RETURN v_holder;
END;
$$;

ALTER FUNCTION public.claim_notification_dispatch(integer) OWNER TO postgres;

COMMENT ON FUNCTION public.claim_notification_dispatch(integer) IS
  'Claim the notification-dispatch lease for p_seconds (1 to 3600). Returns the holder id, or null '
  'when another pass holds it, in which case `requested` is set so that pass''s release asks for one '
  'more. A lease past its held_until is taken over (0247).';

CREATE OR REPLACE FUNCTION public.renew_notification_dispatch(p_holder uuid, p_seconds integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    IF p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 3600 THEN
        RAISE EXCEPTION 'renew_notification_dispatch: a lease lasts 1 to 3600 seconds, not %', p_seconds
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.notification_dispatch_lease
       SET held_until = clock_timestamp() + make_interval(secs => p_seconds)
     WHERE id AND holder = p_holder AND held_until > clock_timestamp();
    RETURN FOUND;
END;
$$;

ALTER FUNCTION public.renew_notification_dispatch(uuid, integer) OWNER TO postgres;

COMMENT ON FUNCTION public.renew_notification_dispatch(uuid, integer) IS
  'Extend the lease p_holder holds by p_seconds from now, before each send. False when p_holder no '
  'longer holds a live lease: the pass then stops, so two passes never send one row (0247).';

-- Before release, the request it may make: a call made on commit, which is when pg_net sends.
CREATE OR REPLACE FUNCTION public.request_notification_dispatch() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_url    text;
  v_key    text;
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'supabase_functions_url';
  SELECT decrypted_secret INTO v_key    FROM vault.decrypted_secrets WHERE name = 'supabase_publishable_key';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'notification_dispatch_secret';

  -- Nothing configured does nothing, rather than sending a bare "Bearer ": the call would answer
  -- 401 or 503 either way, and not making it keeps "not configured" legible as such.
  IF coalesce(v_url, '') = '' OR coalesce(v_key, '') = '' OR coalesce(v_secret, '') = '' THEN
    RETURN false;
  END IF;

  -- A minute, the edge runtime's own limit on a worker: a pass posts each due message in turn.
  PERFORM net.http_post(
    url     := rtrim(v_url, '/') || '/notification-dispatch',
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'apikey',            v_key,
                 'Authorization',     'Bearer ' || v_key,
                 'x-dispatch-secret', v_secret),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );

  RETURN true;
END $$;

ALTER FUNCTION public.request_notification_dispatch() OWNER TO postgres;

COMMENT ON FUNCTION public.request_notification_dispatch() IS
  'Ask the notification-dispatch edge function for one pass over the queue, as sweep_forge() asks '
  'forge-sweep. Returns false when the stack holds no functions address, publishable key or '
  'dispatch secret. ASYNCHRONOUS: net.http_post queues the request, sent on commit, so true means '
  '"asked", not "sent" (0247).';

-- Once a transaction: a status change that queues several rows, or the sweep after it, asks once.
CREATE OR REPLACE FUNCTION public.request_notification_dispatch_once() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF coalesce(current_setting('aber.notification_dispatch_requested', true), '') = 'on' THEN
    RETURN true;
  END IF;
  PERFORM set_config('aber.notification_dispatch_requested', 'on', true);
  RETURN public.request_notification_dispatch();
END $$;

ALTER FUNCTION public.request_notification_dispatch_once() OWNER TO postgres;

COMMENT ON FUNCTION public.request_notification_dispatch_once() IS
  'request_notification_dispatch(), at most once a transaction: one pass drains every row the '
  'transaction queued. Called by the queue''s own trigger and by sweep_notifications() (0247).';

CREATE OR REPLACE FUNCTION public.release_notification_dispatch(p_holder uuid, p_again boolean DEFAULT false)
RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_requested boolean;
BEGIN
    SELECT requested INTO v_requested
      FROM public.notification_dispatch_lease
     WHERE id AND holder = p_holder
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    UPDATE public.notification_dispatch_lease
       SET holder = NULL, held_until = '-infinity', requested = false
     WHERE id;

    -- A claim refused during the pass may have come after the pass read the queue; p_again is a
    -- pass that stopped at its time limit with rows still due. Either asks for one more.
    IF v_requested OR coalesce(p_again, false) THEN
        PERFORM public.request_notification_dispatch();
    END IF;
    RETURN true;
END;
$$;

ALTER FUNCTION public.release_notification_dispatch(uuid, boolean) OWNER TO postgres;

COMMENT ON FUNCTION public.release_notification_dispatch(uuid, boolean) IS
  'Release the notification-dispatch lease if p_holder holds it, and ask for one more pass when a '
  'claim was refused while it was held, or when p_again says rows are still due. False, and nothing '
  'released, for any other id (0247).';

-- -------------------------------------------------------------------------------------------------
-- 4. The dispatch secret: what tells the database's call apart from any other caller
-- -------------------------------------------------------------------------------------------------
-- Generated here, once, and kept in the vault: the chart passes no value for it, and nothing but
-- request_notification_dispatch() and the check below reads it. A value the vault can no longer
-- decrypt, after the root key changed, is replaced.
DO $secret$
DECLARE
  v_id    uuid;
  v_value text;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'notification_dispatch_secret';
  IF v_id IS NOT NULL THEN
    BEGIN
      SELECT decrypted_secret INTO v_value FROM vault.decrypted_secrets WHERE id = v_id;
    EXCEPTION WHEN OTHERS THEN
      v_value := NULL;
    END;
    IF coalesce(v_value, '') <> '' THEN
      RETURN;
    END IF;
    DELETE FROM vault.secrets WHERE id = v_id;
  END IF;
  PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'notification_dispatch_secret',
    'What notification-dispatch checks a call against, so only the database asks for a pass (0247). '
    'Generated by the database; the chart holds no copy.');
END
$secret$;

-- The comparison is of digests, so its time says nothing about how much of the secret matched.
CREATE OR REPLACE FUNCTION public.notification_dispatch_secret_matches(p_secret text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(p_secret, '') <> ''
     AND EXISTS (SELECT 1 FROM vault.decrypted_secrets s
                  WHERE s.name = 'notification_dispatch_secret'
                    AND extensions.digest(s.decrypted_secret, 'sha256') = extensions.digest(p_secret, 'sha256'));
$$;

ALTER FUNCTION public.notification_dispatch_secret_matches(text) OWNER TO postgres;

COMMENT ON FUNCTION public.notification_dispatch_secret_matches(text) IS
  'Whether p_secret is the dispatch secret request_notification_dispatch() sends. For '
  'notification-dispatch alone, which refuses any other caller (0247).';

-- -------------------------------------------------------------------------------------------------
-- 5. What a channel carries
-- -------------------------------------------------------------------------------------------------
-- A severity's rank against the channel's route, notifications.<channel>_min_severity. A missing
-- or unreadable route falls back to warning, the seeded value.
CREATE OR REPLACE FUNCTION public.notification_severity_carried(p_severity text, p_channel text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(array_position(ARRAY['info', 'warning', 'critical'], p_severity), 0)
      >= coalesce(array_position(ARRAY['info', 'warning', 'critical'],
                                 (SELECT s.value #>> '{}' FROM public.system_settings s
                                   WHERE s.key = 'notifications.' || p_channel || '_min_severity')), 2);
$$;

ALTER FUNCTION public.notification_severity_carried(text, text) OWNER TO postgres;

COMMENT ON FUNCTION public.notification_severity_carried(text, text) IS
  'Whether an alert of p_severity is carried by p_channel: at or above the lowest severity its route '
  '(notifications.<channel>_min_severity) names, warning when it names none (0247).';

-- Whether a channel can send at all. The webhook needs its address and its signing key (0248).
CREATE OR REPLACE FUNCTION public.notification_channel_is_configured(p_channel text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT CASE p_channel
    WHEN 'webhook' THEN EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'notification_webhook_url')
                    AND EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'notification_webhook_signing_key')
    ELSE false
  END;
$$;

ALTER FUNCTION public.notification_channel_is_configured(text) OWNER TO postgres;

COMMENT ON FUNCTION public.notification_channel_is_configured(text) IS
  'Whether p_channel has what it needs to send: for webhook, its address and its signing key in '
  'the vault. Nothing is queued for a channel that is not (0247).';

-- -------------------------------------------------------------------------------------------------
-- 6. How long a writer's confirmation holds
-- -------------------------------------------------------------------------------------------------
-- By the writer, which the fingerprint names. Grafana repeats a firing alert every repeat_interval
-- (12h in grafana/provisioning/alerting/policies.yaml; mirror check 57 holds the two together), and
-- the webhook stamps each repeat. The margin, one hour, covers a repeat that waits for its group's
-- next flush or for the webhook to answer again.
CREATE OR REPLACE FUNCTION public.platform_alert_confirmation_window(p_fingerprint text) RETURNS interval
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
    -- Aber's own evaluator stamps on every run and names its fingerprints condition:<...>. Its run
    -- interval plus the margin goes here when it is built; until then such a row is not reminded.
    WHEN starts_with(p_fingerprint, 'condition:') THEN NULL::interval
    -- Grafana's repeat_interval, then the margin.
    ELSE interval '12 hours' + interval '1 hour'
  END;
$$;

ALTER FUNCTION public.platform_alert_confirmation_window(text) OWNER TO postgres;

COMMENT ON FUNCTION public.platform_alert_confirmation_window(text) IS
  'How long a writer''s last_confirmed_at stamp holds for a fingerprint: Grafana''s repeat_interval '
  '(12 hours) plus a one-hour margin; NULL, no reminder, for a condition: fingerprint until its '
  'evaluator states its interval (0247).';

CREATE OR REPLACE FUNCTION public.platform_alert_is_confirmed(p_alert public.platform_alerts) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(p_alert.last_confirmed_at
                    >= now() - public.platform_alert_confirmation_window(p_alert.fingerprint), false);
$$;

ALTER FUNCTION public.platform_alert_is_confirmed(public.platform_alerts) OWNER TO postgres;

COMMENT ON FUNCTION public.platform_alert_is_confirmed(public.platform_alerts) IS
  'Whether the occurrence''s writer has confirmed it within its window. A resolve that never '
  'arrived stops being confirmed, so it stops reminding (0247).';

-- -------------------------------------------------------------------------------------------------
-- 7. Queueing: an occurrence starting to fire, or resolving
-- -------------------------------------------------------------------------------------------------
-- UPDATE OF status fires whenever the webhook's upsert names the column, which is every repeat, so
-- the change itself is the test. A row that arrives resolved was never announced and queues
-- nothing. A resolve follows each channel's own firing message, whatever the route says now, so a
-- route raised in between does not leave a receiver holding an alert that never ends. SECURITY
-- DEFINER: the queue and the vault are its owner's.
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
    -- The webhook carries only what every signed-in role may read: never a machine identity's alert.
    IF NEW.entity_type <> 'service_identity'
       AND public.notification_severity_carried(NEW.severity, 'webhook')
       AND public.notification_channel_is_configured('webhook') THEN
      INSERT INTO public.notification_deliveries (alert_id, event, channel)
      VALUES (NEW.id, 'firing', 'webhook')
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
  'was queued its firing message when it resolves. A repeat or a stamp queues nothing (0247).';

SELECT public.replay_trigger('public.platform_alerts', 'trg_platform_alerts_queue_notifications', $ddl$
CREATE TRIGGER trg_platform_alerts_queue_notifications AFTER INSERT OR UPDATE OF status ON public.platform_alerts FOR EACH ROW EXECUTE FUNCTION public.queue_platform_alert_notifications();
$ddl$);

-- A queued row asks for a pass. Per row, so an insert that queued nothing asks nothing; once a
-- transaction, so several rows ask once.
CREATE OR REPLACE FUNCTION public.notification_deliveries_request_dispatch() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM public.request_notification_dispatch_once();
  RETURN NULL;
END
$$;

ALTER FUNCTION public.notification_deliveries_request_dispatch() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notification_deliveries_request_dispatch() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.notification_deliveries_request_dispatch() IS
  'AFTER INSERT on notification_deliveries: asks notification-dispatch for a pass, once a '
  'transaction, sent on commit (0247).';

SELECT public.replay_trigger('public.notification_deliveries', 'trg_notification_deliveries_request_dispatch', $ddl$
CREATE TRIGGER trg_notification_deliveries_request_dispatch AFTER INSERT ON public.notification_deliveries FOR EACH ROW EXECUTE FUNCTION public.notification_deliveries_request_dispatch();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 8. The send decision
-- -------------------------------------------------------------------------------------------------
-- One function, asked just before each send, so whatever changed since the row was queued counts.
-- The decision table is in supabase/README.md, and each arm returns where it is decided:
--
--   any event   the occurrence is gone (pruned)                                  drop
--   any event   the webhook, and a machine identity's alert                      drop
--   resolved    its channel's firing message was sent                            send
--   resolved    that message is still pending                                    hold
--   resolved    that message was dropped or died, or there is none               drop
--   firing,     the occurrence resolved, or a newer one replaced it              drop
--   reminder    acknowledged                                                     drop
--   reminder    its writer has not confirmed it within its window                drop
--   firing,     otherwise                                                        send
--   reminder
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
  -- predicate: the webhook carries only what every signed-in role may read.
  IF p_channel = 'webhook' AND v_alert.entity_type = 'service_identity' THEN
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
  -- SUPPRESSION ARM: 'hold' while a suppression window covers the alert goes here, so a firing
  -- message or a reminder waits and is sent when the window ends, as if the alert had just fired.
  RETURN 'send';
END
$$;

ALTER FUNCTION public.platform_alert_send_decision(uuid, text, text) OWNER TO postgres;

COMMENT ON FUNCTION public.platform_alert_send_decision(uuid, text, text) IS
  'send, hold or drop for one queued message about an alert, decided as it is about to be sent: a '
  'firing message or a reminder is dropped once the occurrence has resolved, been replaced or been '
  'acknowledged, and a reminder once its writer stops confirming it; a resolve is sent only if its '
  'firing message was, and held while that one is still pending. A machine identity''s alert is '
  'never sent to the webhook (0247).';

-- -------------------------------------------------------------------------------------------------
-- 9. Reminders
-- -------------------------------------------------------------------------------------------------
-- Due notifications.reminder_hours after the firing message was sent or the last reminder was
-- queued, whatever became of it, so a reminder that died is not queued again every minute. Only
-- for the newest occurrence, firing, unacknowledged, still confirmed, still carried by its
-- channel's route, and with no reminder already waiting.
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
     AND NOT (f.channel = 'webhook' AND a.entity_type = 'service_identity')
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

COMMENT ON FUNCTION public.queue_platform_alert_reminders() IS
  'Queue a reminder for each alert still firing, unacknowledged and confirmed by its writer, '
  'notifications.reminder_hours after its firing message was sent or its last reminder queued. '
  'Returns how many. Called every minute by sweep_notifications() (0247).';

-- -------------------------------------------------------------------------------------------------
-- 10. The sweep, every minute
-- -------------------------------------------------------------------------------------------------
-- The backstop: a request pg_net lost, a backoff that has come due, a hold to look at again. It
-- asks for a pass only when a row is due, so a quiet queue costs one query a minute.
CREATE OR REPLACE FUNCTION public.sweep_notifications() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM public.queue_platform_alert_reminders();
  IF EXISTS (SELECT 1 FROM public.notification_deliveries
              WHERE state = 'pending' AND next_attempt_at <= now()) THEN
    RETURN public.request_notification_dispatch_once();
  END IF;
  RETURN false;
END
$$;

ALTER FUNCTION public.sweep_notifications() OWNER TO postgres;

COMMENT ON FUNCTION public.sweep_notifications() IS
  'Queue the reminders that are due, then ask notification-dispatch for a pass if any row is due. '
  'True means asked. Scheduled every minute by pg_cron (0247).';

-- -------------------------------------------------------------------------------------------------
-- 11. What the dispatcher reads and writes
-- -------------------------------------------------------------------------------------------------
-- Only the pass that holds a live lease, so a pass that outlived its lease writes nothing. now() is
-- the call's own start: each of the dispatcher's calls is a transaction of its own.
CREATE OR REPLACE FUNCTION public.require_notification_dispatch_holder(p_holder uuid) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_holder IS NULL OR NOT EXISTS (SELECT 1 FROM public.notification_dispatch_lease
                                      WHERE id AND holder = p_holder AND held_until > now()) THEN
    RAISE EXCEPTION 'This pass does not hold the notification-dispatch lease.'
      USING ERRCODE = 'lock_not_available';
  END IF;
END
$$;

ALTER FUNCTION public.require_notification_dispatch_holder(uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.require_notification_dispatch_holder(uuid) IS
  'Raises 55P03 unless p_holder holds a live notification-dispatch lease (0247).';

-- Oldest first, so an occurrence's firing message is decided before its resolve. The webhook's
-- rows about a machine identity's alert are never selected: none is queued, and the decision drops
-- one if it were.
CREATE OR REPLACE FUNCTION public.notification_deliveries_due(p_holder uuid, p_limit integer DEFAULT 20)
RETURNS TABLE (id uuid, event text, channel text, attempts integer, created_at timestamp with time zone,
               alert jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM public.require_notification_dispatch_holder(p_holder);
  RETURN QUERY
  SELECT d.id, d.event, d.channel, d.attempts, d.created_at,
         CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', a.id,
           'name', a.alert_name,
           'severity', a.severity,
           'status', a.status,
           'subject', jsonb_build_object(
             'type', a.entity_type,
             'id', a.entity_id,
             'sparkplug_id', a.sparkplug_id,
             'name', public.alert_audit_identity(a) ->> 'subject_name'),
           'starts_at', a.starts_at,
           'ends_at', a.ends_at,
           'summary', a.summary,
           'labels', a.labels,
           'values', a."values") END
    FROM public.notification_deliveries d
    LEFT JOIN public.platform_alerts a ON a.id = d.alert_id
   WHERE d.state = 'pending'
     AND d.next_attempt_at <= now()
     AND NOT (d.channel = 'webhook' AND a.entity_type IS NOT DISTINCT FROM 'service_identity')
   ORDER BY d.created_at, d.id
   LIMIT least(greatest(coalesce(p_limit, 20), 1), 100);
END
$$;

ALTER FUNCTION public.notification_deliveries_due(uuid, integer) OWNER TO postgres;

COMMENT ON FUNCTION public.notification_deliveries_due(uuid, integer) IS
  'The pending rows that are due, oldest first, at most p_limit (1 to 100), each with the alert it is '
  'about: its name, severity, status, subject (type, id, Sparkplug id and name), start, end, summary, '
  'labels and values. For the pass holding the lease (0247).';

-- The outcome of one row. Only a pending row changes, so a row finished by another path stays as it is.
CREATE OR REPLACE FUNCTION public.record_notification_delivery(p_holder uuid, p_id uuid, p_outcome text,
                                                               p_retry_seconds integer DEFAULT NULL,
                                                               p_status integer DEFAULT NULL,
                                                               p_error text DEFAULT NULL)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 500);
  v_state text;
BEGIN
  PERFORM public.require_notification_dispatch_holder(p_holder);
  IF p_outcome IS NULL OR NOT p_outcome = ANY (ARRAY['sent', 'dropped', 'held', 'failed', 'dead']) THEN
    RAISE EXCEPTION 'An outcome is sent, dropped, held, failed or dead, not %.', coalesce(quote_literal(p_outcome), 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_outcome IN ('held', 'failed') AND (p_retry_seconds IS NULL OR p_retry_seconds NOT BETWEEN 1 AND 86400) THEN
    RAISE EXCEPTION 'A held or failed row is retried in 1 to 86400 seconds, not %.', p_retry_seconds
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.notification_deliveries d
     SET state = CASE p_outcome WHEN 'sent' THEN 'sent' WHEN 'dropped' THEN 'dropped'
                                WHEN 'dead' THEN 'dead' ELSE 'pending' END,
         attempts = d.attempts + CASE WHEN p_outcome IN ('sent', 'failed', 'dead') THEN 1 ELSE 0 END,
         next_attempt_at = CASE WHEN p_outcome IN ('held', 'failed')
                                THEN now() + make_interval(secs => p_retry_seconds)
                                ELSE d.next_attempt_at END,
         last_attempt_at = CASE WHEN p_outcome IN ('sent', 'failed', 'dead') THEN now() ELSE d.last_attempt_at END,
         finished_at = CASE WHEN p_outcome IN ('sent', 'dropped', 'dead') THEN now() END,
         response_status = CASE WHEN p_outcome IN ('sent', 'failed', 'dead') THEN p_status ELSE d.response_status END,
         last_error = CASE WHEN p_outcome IN ('failed', 'dead') THEN v_error
                           WHEN p_outcome = 'sent' THEN NULL ELSE d.last_error END
   WHERE d.id = p_id AND d.state = 'pending'
  RETURNING d.state INTO v_state;
  RETURN v_state;
END
$$;

ALTER FUNCTION public.record_notification_delivery(uuid, uuid, text, integer, integer, text) OWNER TO postgres;

COMMENT ON FUNCTION public.record_notification_delivery(uuid, uuid, text, integer, integer, text) IS
  'Record one row''s outcome for the pass holding the lease: sent, dropped, held (pushed out '
  'p_retry_seconds, not an attempt), failed (an attempt, retried in p_retry_seconds) or dead (the '
  'last attempt failed). Returns the new state, or NULL when the row was not pending (0247).';

-- -------------------------------------------------------------------------------------------------
-- 12. Who may call what
-- -------------------------------------------------------------------------------------------------
-- The dispatcher is the service role; the queue's writers are their owner's alone.
DO $grants$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
      'public.claim_notification_dispatch(integer)', 'public.renew_notification_dispatch(uuid, integer)',
      'public.release_notification_dispatch(uuid, boolean)', 'public.notification_dispatch_secret_matches(text)',
      'public.platform_alert_send_decision(uuid, text, text)', 'public.notification_deliveries_due(uuid, integer)',
      'public.record_notification_delivery(uuid, uuid, text, integer, integer, text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY[
      'public.request_notification_dispatch()', 'public.request_notification_dispatch_once()',
      'public.notification_severity_carried(text, text)', 'public.notification_channel_is_configured(text)',
      'public.platform_alert_confirmation_window(text)', 'public.platform_alert_is_confirmed(public.platform_alerts)',
      'public.queue_platform_alert_reminders()', 'public.sweep_notifications()',
      'public.require_notification_dispatch_holder(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_fn);
  END LOOP;
END
$grants$;

-- After the functions, so the first run finds them. ensure_cron_job() unschedules first, so a
-- replay keeps one job.
SELECT public.ensure_cron_job(
  'sweep_notifications',
  '* * * * *',
  $job$SELECT public.sweep_notifications()$job$
);

-- -------------------------------------------------------------------------------------------------
-- What this file and 0001 did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn   text;
  v_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'platform_alerts'
                    AND column_name = 'last_confirmed_at' AND data_type = 'timestamp with time zone'
                    AND is_nullable = 'YES' AND column_default IS NULL) THEN
    RAISE EXCEPTION '0247: platform_alerts.last_confirmed_at is missing, not a nullable timestamptz, or defaulted';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'platform_alerts_active'
                AND column_name = 'last_confirmed_at') THEN
    RAISE EXCEPTION '0247: platform_alerts_active returns last_confirmed_at, which it must not';
  END IF;
  IF has_column_privilege('authenticated', 'public.platform_alerts', 'last_confirmed_at', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.platform_alerts', 'last_confirmed_at', 'INSERT') THEN
    RAISE EXCEPTION '0247: authenticated may write platform_alerts.last_confirmed_at';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.notification_deliveries'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.notification_dispatch_lease'::regclass) THEN
    RAISE EXCEPTION '0247: notification_deliveries or notification_dispatch_lease has RLS off';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.notification_deliveries', 'SELECT') THEN
    RAISE EXCEPTION '0247: authenticated cannot read notification_deliveries; the Settings page shows it';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('authenticated', 'public.notification_deliveries', v_name)
       OR has_table_privilege('service_role', 'public.notification_deliveries', v_name)
       OR has_table_privilege('service_role', 'public.notification_dispatch_lease', v_name) THEN
      RAISE EXCEPTION '0247: an API role may % the queue or the lease directly', v_name;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.notification_deliveries', 'SELECT')
     OR has_table_privilege('authenticated', 'public.notification_dispatch_lease', 'SELECT') THEN
    RAISE EXCEPTION '0247: anon reads the queue, or authenticated the lease';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.notification_dispatch_lease WHERE id) THEN
    RAISE EXCEPTION '0247: the notification-dispatch lease has no row';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.platform_alerts'::regclass
                    AND t.tgname = 'trg_platform_alerts_queue_notifications'
                    AND NOT t.tgisinternal AND t.tgenabled = 'O'
                    AND t.tgfoid = 'public.queue_platform_alert_notifications()'::regprocedure
                    -- ROW (1), INSERT (4) and UPDATE (16), AFTER, and UPDATE OF status alone.
                    AND t.tgtype = 21
                    -- int2vector's text is its column numbers, space-separated: one, status's.
                    AND t.tgattr::text = (SELECT attnum::text FROM pg_attribute
                                           WHERE attrelid = 'public.platform_alerts'::regclass
                                             AND attname = 'status')) THEN
    RAISE EXCEPTION '0247: trg_platform_alerts_queue_notifications is not AFTER INSERT OR UPDATE OF status FOR EACH ROW';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.notification_deliveries'::regclass
                    AND t.tgname = 'trg_notification_deliveries_request_dispatch'
                    AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = 5) THEN
    RAISE EXCEPTION '0247: trg_notification_deliveries_request_dispatch is not AFTER INSERT FOR EACH ROW';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
      'public.claim_notification_dispatch(integer)', 'public.renew_notification_dispatch(uuid, integer)',
      'public.release_notification_dispatch(uuid, boolean)', 'public.notification_dispatch_secret_matches(text)',
      'public.platform_alert_send_decision(uuid, text, text)', 'public.notification_deliveries_due(uuid, integer)',
      'public.record_notification_delivery(uuid, uuid, text, integer, integer, text)'] LOOP
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0247: service_role may not execute %; notification-dispatch calls it', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0247: anon or authenticated may execute %', v_fn;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                    AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0247: % is not SECURITY DEFINER with its search_path pinned', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.request_notification_dispatch()', 'public.sweep_notifications()',
                              'public.queue_platform_alert_reminders()'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0247: an API role may execute %', v_fn;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'notification_dispatch_secret') THEN
    RAISE EXCEPTION '0247: the vault holds no notification_dispatch_secret';
  END IF;
  IF public.notification_dispatch_secret_matches('') OR public.notification_dispatch_secret_matches(NULL)
     OR public.notification_dispatch_secret_matches('not-the-secret') THEN
    RAISE EXCEPTION '0247: notification_dispatch_secret_matches() admits a value that is not the secret';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sweep_notifications' AND schedule = '* * * * *') THEN
    RAISE EXCEPTION '0247: the sweep_notifications job is not scheduled every minute';
  END IF;

  -- The windows, and a decision about an occurrence that is not there.
  IF public.platform_alert_confirmation_window('grafana-fingerprint') <> interval '13 hours'
     OR public.platform_alert_confirmation_window('condition:x') IS NOT NULL THEN
    RAISE EXCEPTION '0247: platform_alert_confirmation_window() answers other than 13 hours for Grafana and none for a condition';
  END IF;
  IF public.platform_alert_send_decision('00000000-0000-4000-8000-000000000000', 'firing', 'webhook') <> 'drop' THEN
    RAISE EXCEPTION '0247: platform_alert_send_decision() does not drop a message about an occurrence that is gone';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
