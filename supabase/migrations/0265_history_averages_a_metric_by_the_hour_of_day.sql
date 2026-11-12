-- 0265: History averages one metric by the hour of the day, for the Cell tab's heatmap.
--
-- telemetry_hour_of_day(from_ts, to_ts, asset_ids, metric_name, tz) returns one row per device per
-- hour of the day, 0 to 23 in the time zone given: the mean of that hour across the window's days.
-- It reads telemetry_carried() at one hour, so a quiet hour carries the last value forward and
-- counts as that value (under report-by-exception it is what held), and every hour weighs the same
-- however many readings it held. So what reaches the browser is devices times 24, never one row
-- an hour.
--
--   * A device with no number in the window, or a text or a flag metric, has no row. A series with
--     nothing to carry has no row before its first value, as telemetry_carried() has none.
--   * `days` is how many local dates the mean spans, so a reader can say "the mean of 7 days".
--   * The hour is the one an hourly bucket starts in. In a zone offset by part of an hour, as India
--     is, a bucket runs from :30 to :30 and lies in the hour it starts in.
--   * It refuses a window of more than 50,000 hours times devices, as telemetry_carried() does, and
--     an unknown time zone, before anything is read.
--   * It runs as the caller, as the telemetry views do.
--
-- Reasoning: supabase/README.md, "History averages a metric by the hour of the day (0265)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The read
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.telemetry_hour_of_day(
    from_ts timestamp with time zone,
    to_ts timestamp with time zone,
    asset_ids text[],
    metric_name text,
    tz text
) RETURNS TABLE (
    asset_id text,
    hour_of_day integer,
    mean_value double precision,
    days integer
)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
DECLARE
    -- telemetry_carried()'s own bound, said here so the refusal names the window, not a bucket.
    c_max_rows CONSTANT bigint := 50000;
    v_from     timestamp with time zone;
    v_hours    bigint;
BEGIN
    IF from_ts IS NULL OR to_ts IS NULL OR to_ts <= from_ts THEN
        RAISE EXCEPTION 'telemetry_hour_of_day: to_ts (%) must be after from_ts (%)', to_ts, from_ts
              USING ERRCODE = '22023';
    END IF;
    IF asset_ids IS NULL OR metric_name IS NULL THEN
        RAISE EXCEPTION 'telemetry_hour_of_day: name the assets and the metric'
              USING ERRCODE = '22023';
    END IF;
    IF tz IS NULL OR btrim(tz) = '' THEN
        RAISE EXCEPTION 'telemetry_hour_of_day: name the time zone the hours are in'
              USING ERRCODE = '22023';
    END IF;
    BEGIN
        PERFORM now() AT TIME ZONE tz;
    EXCEPTION WHEN invalid_parameter_value THEN
        RAISE EXCEPTION 'telemetry_hour_of_day: % is not a time zone', tz USING ERRCODE = '22023';
    END;

    v_from := date_bin(interval '1 hour', from_ts, timestamptz 'epoch');
    v_hours := ceil(extract(epoch FROM to_ts - v_from) / 3600)::bigint;
    IF v_hours * cardinality(asset_ids) > c_max_rows THEN
        RAISE EXCEPTION 'telemetry_hour_of_day: % hours of % devices is more than % rows; choose a shorter window or fewer devices',
              v_hours, cardinality(asset_ids), c_max_rows USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT c.asset_id,
           extract(hour FROM c.bucket_ts AT TIME ZONE tz)::integer,
           avg(c.avg_double),
           count(DISTINCT (c.bucket_ts AT TIME ZONE tz)::date)::integer
      FROM public.telemetry_carried(from_ts, to_ts, interval '1 hour', asset_ids, ARRAY[metric_name]) c
     WHERE c.avg_double IS NOT NULL
     GROUP BY 1, 2
     ORDER BY 1, 2;
END;
$fn$;

ALTER FUNCTION public.telemetry_hour_of_day(timestamp with time zone, timestamp with time zone, text[], text, text)
    OWNER TO postgres;

COMMENT ON FUNCTION public.telemetry_hour_of_day(timestamp with time zone, timestamp with time zone, text[], text, text) IS
  'History''s hour-of-day read: for each device, the mean of one numeric metric at each hour of the '
  'day in the time zone given, across the window''s days, from telemetry_carried() at one hour. A '
  'quiet hour counts as the value carried into it. days is how many local dates the mean spans. '
  'Refuses an unknown time zone and more than 50,000 hours times devices. Runs as the caller (0265).';

-- -------------------------------------------------------------------------------------------------
-- 2. Who may call it: whoever may read the telemetry views
-- -------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.telemetry_hour_of_day(timestamp with time zone, timestamp with time zone, text[], text, text)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.telemetry_hour_of_day(timestamp with time zone, timestamp with time zone, text[], text, text)
    TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn CONSTANT text := 'public.telemetry_hour_of_day(timestamp with time zone, timestamp with time zone, text[], text, text)';
  v_forms integer;
  v_bad text;
BEGIN
  SELECT count(*) INTO v_forms
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'telemetry_hour_of_day';
  IF v_forms <> 1 THEN
    RAISE EXCEPTION '0265: telemetry_hour_of_day is declared % times, not once', v_forms;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                  AND NOT prosecdef AND provolatile = 's' AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0265: % is not a STABLE SECURITY INVOKER function with its search_path pinned', v_fn;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0265: anon may execute %', v_fn;
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0265: authenticated and service_role must execute %, as they read the telemetry views', v_fn;
  END IF;

  -- The refusals come before any read, so they hold on a stack with no historian.
  FOREACH v_bad IN ARRAY ARRAY['window', 'assets', 'zone', 'unknown zone', 'size'] LOOP
    BEGIN
      CASE v_bad
        WHEN 'window' THEN PERFORM public.telemetry_hour_of_day(now(), now() - interval '1 hour', '{a}', 'm', 'UTC');
        WHEN 'assets' THEN PERFORM public.telemetry_hour_of_day(now() - interval '1 day', now(), NULL, 'm', 'UTC');
        WHEN 'zone' THEN PERFORM public.telemetry_hour_of_day(now() - interval '1 day', now(), '{a}', 'm', ' ');
        WHEN 'unknown zone' THEN PERFORM public.telemetry_hour_of_day(now() - interval '1 day', now(), '{a}', 'm', 'Not/AZone');
        ELSE PERFORM public.telemetry_hour_of_day(now() - interval '7 years', now(), '{a}', 'm', 'UTC');
      END CASE;
      RAISE EXCEPTION '0265: telemetry_hour_of_day() accepted a bad %', v_bad USING ERRCODE = 'P0001';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
