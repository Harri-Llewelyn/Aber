-- 0250: A suppressed alert's messages are held until its window ends.
--
-- 0247's platform_alert_send_decision() has a marked place for suppression (0240). This file fills
-- it: a firing message or a reminder about an alert a suppression window covers now is held, not
-- sent and not dropped. It is decided again when it comes due, so once the window ends, or is ended
-- early, an alert still firing is sent as if it had just fired. A resolve is unchanged: it goes only
-- if its firing message went, so an occurrence that resolved inside its window sends nothing.
--
-- The decision is redeclared whole from 0247, unchanged but for the arm: 0247 replays first on every
-- boot, and the last declaration stands.
--
-- Reasoning: supabase/README.md, "A suppressed alert is held until its window ends (0250)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The send decision, with the suppression arm
-- -------------------------------------------------------------------------------------------------
-- 0247's table, with one row before the last:
--
--   firing,     a suppression window covers the alert now                        hold
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
  'and held while that one is still pending. A machine identity''s alert is never sent to the '
  'webhook (0247).';

-- CREATE OR REPLACE keeps 0247's grants; restated, so this file stands on its own.
REVOKE ALL ON FUNCTION public.platform_alert_send_decision(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_alert_send_decision(uuid, text, text) TO service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn  text := 'public.platform_alert_send_decision(uuid, text, text)';
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn::regprocedure;
  IF position('platform_alert_suppressing_window(v_alert.entity_type, v_alert.entity_id, now())' IN v_src) = 0 THEN
    RAISE EXCEPTION '0250: platform_alert_send_decision() does not ask platform_alert_suppressing_window()';
  END IF;
  IF position('acknowledged_at IS NOT NULL' IN v_src) > position('SUPPRESSION ARM' IN v_src) THEN
    RAISE EXCEPTION '0250: platform_alert_send_decision() holds before it drops an acknowledged alert';
  END IF;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0250: service_role may not execute %; notification-dispatch calls it', v_fn;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0250: anon or authenticated may execute %', v_fn;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                  AND prosecdef AND provolatile = 's' AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0250: % is not STABLE SECURITY DEFINER with its search_path pinned', v_fn;
  END IF;
  IF public.platform_alert_send_decision('00000000-0000-4000-8000-000000000000', 'firing', 'webhook') <> 'drop' THEN
    RAISE EXCEPTION '0250: platform_alert_send_decision() does not drop a message about an occurrence that is gone';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
