-- 0243: History lists the alerts that fired, each occurrence with when it ended and who acknowledged it.
--
-- alert_occurrences(p_from, p_to, p_sparkplug_ids, p_limit) returns the platform_alerts occurrences
-- that overlap the window [p_from, p_to), newest first: one that started before the window and
-- ended in it, or is still firing, is listed as well as one that started in it. It is History's
-- Alerts tab and the shading of firing periods on its charts.
--
--   * Each row is the whole occurrence, as platform_alerts holds it, so a column a later migration
--     adds reaches the dashboard with no change here. Beside it, ended_at and replaced.
--   * ended_at is ends_at, or for a firing occurrence a later one of the same fingerprint has
--     replaced, that one's start. Both writers open a new occurrence when an alert fires again
--     without a resolve in between, and nothing ever resolves the older row. platform_alerts_active
--     already reads it as superseded; this reads it as ended then. NULL is still firing.
--   * It runs as the caller, so platform_alerts' select policy decides the rows: a service_identity
--     alert reaches an Administrator alone (0204).
--   * p_sparkplug_ids keeps the occurrences about those devices and gateways; NULL keeps every one.
--     p_limit is 1 to 5,000, and bounds out of order are refused (22023).
--
-- PostgREST cannot ask for the next occurrence of a fingerprint, which is why this is a function
-- and not a read of the table.
--
-- Reasoning: supabase/README.md, "History lists the alerts that fired (0243)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The read
-- -------------------------------------------------------------------------------------------------
-- The next occurrence is looked up only for a firing row with no end: the condition is a one-time
-- filter inside the subquery, and the lookup is uq_platform_alerts_event's (fingerprint, starts_at).
CREATE OR REPLACE FUNCTION public.alert_occurrences(
    p_from timestamp with time zone,
    p_to timestamp with time zone,
    p_sparkplug_ids text[] DEFAULT NULL,
    p_limit integer DEFAULT 1000
) RETURNS TABLE (
    occurrence public.platform_alerts,
    ended_at timestamp with time zone,
    replaced boolean
)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
DECLARE
    -- The most one read returns. The dashboard asks for one more than it shows (api.js).
    c_max_rows CONSTANT integer := 5000;
BEGIN
    IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
        RAISE EXCEPTION 'alert_occurrences: p_to (%) must be after p_from (%)', p_to, p_from
              USING ERRCODE = '22023';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > c_max_rows THEN
        RAISE EXCEPTION 'alert_occurrences: p_limit must be 1 to %; got %', c_max_rows, p_limit
              USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT a, coalesce(a.ends_at, n.next_start), n.next_start IS NOT NULL
      FROM public.platform_alerts a
      LEFT JOIN LATERAL (
        SELECT min(x.starts_at) AS next_start
          FROM public.platform_alerts x
         WHERE a.status = 'firing' AND a.ends_at IS NULL
           AND x.fingerprint = a.fingerprint AND x.starts_at > a.starts_at
      ) n ON true
     WHERE a.starts_at < p_to
       AND coalesce(a.ends_at, n.next_start, 'infinity'::timestamptz) > p_from
       AND (p_sparkplug_ids IS NULL OR a.sparkplug_id = ANY (p_sparkplug_ids))
     ORDER BY a.starts_at DESC, a.recorded_at DESC, a.id
     LIMIT p_limit;
END;
$fn$;

ALTER FUNCTION public.alert_occurrences(timestamp with time zone, timestamp with time zone, text[], integer)
    OWNER TO postgres;

COMMENT ON FUNCTION public.alert_occurrences(timestamp with time zone, timestamp with time zone, text[], integer) IS
  'History''s Alerts tab: the platform_alerts occurrences that overlap [p_from, p_to), newest '
  'first, each whole, with ended_at (ends_at, or the start of the occurrence that replaced a firing '
  'one; NULL while firing) and replaced. p_sparkplug_ids keeps those devices and gateways. At most '
  'p_limit rows, 1 to 5,000. Runs as the caller, so the table''s select policy decides the rows '
  '(0243).';

-- -------------------------------------------------------------------------------------------------
-- 2. Who may call it: whoever may read platform_alerts
-- -------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.alert_occurrences(timestamp with time zone, timestamp with time zone, text[], integer)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alert_occurrences(timestamp with time zone, timestamp with time zone, text[], integer)
    TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn CONSTANT text := 'public.alert_occurrences(timestamp with time zone, timestamp with time zone, text[], integer)';
  v_forms integer;
  v_bad text;
BEGIN
  SELECT count(*) INTO v_forms
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'alert_occurrences';
  IF v_forms <> 1 THEN
    RAISE EXCEPTION '0243: alert_occurrences is declared % times, not once', v_forms;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                  AND NOT prosecdef AND provolatile = 's' AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0243: % is not a STABLE SECURITY INVOKER function with its search_path pinned', v_fn;
  END IF;
  IF pg_get_function_result(v_fn::regprocedure)
     <> 'TABLE(occurrence platform_alerts, ended_at timestamp with time zone, replaced boolean)' THEN
    RAISE EXCEPTION '0243: % returns %, not the whole occurrence with ended_at and replaced',
          v_fn, pg_get_function_result(v_fn::regprocedure);
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0243: anon may execute %', v_fn;
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0243: authenticated and service_role must execute %, as they read platform_alerts', v_fn;
  END IF;

  FOREACH v_bad IN ARRAY ARRAY['window', 'open', 'limit', 'size'] LOOP
    BEGIN
      CASE v_bad
        WHEN 'window' THEN PERFORM public.alert_occurrences(now(), now() - interval '1 hour');
        WHEN 'open' THEN PERFORM public.alert_occurrences(NULL, now());
        WHEN 'limit' THEN PERFORM public.alert_occurrences(now() - interval '1 hour', now(), NULL, 0);
        ELSE PERFORM public.alert_occurrences(now() - interval '1 hour', now(), NULL, 5001);
      END CASE;
      RAISE EXCEPTION '0243: alert_occurrences() accepted a bad %', v_bad USING ERRCODE = 'P0001';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
