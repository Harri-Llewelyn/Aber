-- 0282: History draws a derived metric from the minutes, and its current value has one rule.
--
-- derived_series(from_ts, to_ts, bucket, asset_ids, metric_names) computes derived metrics
-- (0267) at query time. It reads each metric's definition from metric_catalog and each input
-- through telemetry_carried() (0233) at one minute, then combines the minutes into the bucket:
--
--   * counter_rate: the increase per hour. A minute's increase is its carried last value less the
--     minute before's, and a fall is a reset whose new value counts as the increase. A bucket's rate
--     is its increases over the hours its minutes cover.
--   * time_in_state: the share of the bucket's minutes whose state, the minute's last value
--     carried, is one of the states.
--   * sum: the time-average of the per-minute signed sum, a minute counting only where EVERY input
--     has a value, so a partial sum never reads as a real one.
--
-- A device that lacks an input has no row. One row per device, metric and bucket that has a value,
-- in the columns telemetry_carried() uses where the meaning is the same: avg_double is the value, and
-- min_double, max_double and last_double are the lowest and highest minute and the last minute of a
-- sum, and the value itself for a rate and a share; n_rows counts the inputs' readings in the bucket
-- and is_carried says there were none.
--
--   * It reads in chunks of whole buckets and as many devices as fit telemetry_carried()'s 50,000
--     rows. Each chunk reads one minute before its start, so nothing is carried between chunks.
--   * It reads whole minutes only: nothing from the minute that holds now.
--   * It refuses before it reads anything: a metric that is not derived, bad bounds, a bucket that
--     is not whole minutes or is over 4 days, more than 5,000 devices times metrics times buckets
--     (the dashboard's row cap), and more than 250,000 minutes of input to read (22023).
--
-- derived_current(asset_ids, metric_names) is a derived metric's current value, by one rule that
-- derived_window_minutes() states: a rate and a time in state over the 60 minutes ending at the last
-- whole minute, a sum at the last whole minute. The evaluator (0283) and the Devices drawer both
-- read it, so a value in an alert and a value on the page are the same number.
--
-- Both run as the caller, SECURITY INVOKER, as telemetry_carried() does. grafana_reader is not
-- granted: it holds no privilege on the foreign rollups or on metric_catalog, and the wrapper that
-- gave it platform_health_rows() is SECURITY DEFINER.
--
-- Reasoning: supabase/README.md, "History draws a derived metric from the minutes (0282)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. How far back a current value looks
-- -------------------------------------------------------------------------------------------------
-- 60 for a counter rate and a time in state: a rate from one minute swings between 0 and sixty times
-- the count, and a minute's share is 0 or 1, so a person means an hour by "parts per hour" and
-- "uptime". 0 for a sum, which is its value at the last whole minute. NULL for anything else. The
-- browser's copy is derivedWindowMinutes() in utils/derivedMetric.js (mirror check 94).
CREATE OR REPLACE FUNCTION public.derived_window_minutes(p_derivation jsonb) RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE p_derivation ->> 'kind'
           WHEN 'counter_rate' THEN 60
           WHEN 'time_in_state' THEN 60
           WHEN 'sum' THEN 0
         END;
$$;

ALTER FUNCTION public.derived_window_minutes(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.derived_window_minutes(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.derived_window_minutes(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.derived_window_minutes(jsonb) IS
  'How many minutes before the last whole minute a derived metric''s current value looks: 60 for a '
  'counter rate and a time in state, 0 for a sum, which is its value at the last whole minute. NULL for '
  'a definition of another kind (0282).';

-- -------------------------------------------------------------------------------------------------
-- 2. The series
-- -------------------------------------------------------------------------------------------------
-- Every column is qualified: the result's own column names are variables in plpgsql. The rows come
-- in no promised order, a chunk at a time: a caller that wants one sorts by asset_id, metric_name
-- and bucket_ts.
CREATE OR REPLACE FUNCTION public.derived_series(
    from_ts timestamp with time zone,
    to_ts timestamp with time zone,
    bucket interval,
    asset_ids text[],
    metric_names text[]
) RETURNS TABLE (
    bucket_ts timestamp with time zone,
    asset_id text,
    metric_name text,
    avg_double double precision,
    min_double double precision,
    max_double double precision,
    last_double double precision,
    n_rows bigint,
    is_carried boolean
)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
DECLARE
    -- The dashboard's row cap, TELEMETRY_MAX_ROWS: what one call may return.
    c_max_rows    CONSTANT bigint := 5000;
    -- Minutes of input one call may read, a minute of one input of one device being one: about two
    -- seconds on the spike's historian.
    c_max_minutes CONSTANT bigint := 250000;
    -- telemetry_carried()'s bound: what each chunk reads, a minute before it included.
    c_read_rows   CONSTANT bigint := 50000;
    -- Four days: with the most inputs a definition has (8), one device's bucket fits one chunk.
    c_max_bucket  CONSTANT integer := 5760;
    v_secs     numeric;
    v_step     interval;
    v_from     timestamp with time zone;
    v_last     timestamp with time zone;
    v_end      timestamp with time zone;
    v_assets   text[];
    v_metrics  text[];
    v_missing  text;
    v_buckets  bigint;
    v_inputs   bigint;
    v_mpb      integer;
    v_def      record;
    v_kind     text;
    v_input    text;
    v_states   text[];
    v_names    text[];
    v_signs    integer[];
    v_n_in     integer;
    v_a_chunk  integer;
    v_k_chunk  integer;
    v_chunk    text[];
    v_cs       timestamp with time zone;
    v_ce       timestamp with time zone;
BEGIN
    IF from_ts IS NULL OR to_ts IS NULL OR to_ts <= from_ts THEN
        RAISE EXCEPTION 'derived_series: to_ts (%) must be after from_ts (%)', to_ts, from_ts
              USING ERRCODE = '22023';
    END IF;
    v_secs := extract(epoch FROM bucket);
    IF bucket IS NULL OR extract(year FROM bucket) <> 0 OR extract(month FROM bucket) <> 0
       OR v_secs < 60 OR v_secs % 60 <> 0 OR v_secs > c_max_bucket * 60 THEN
        RAISE EXCEPTION 'derived_series: bucket must be a whole number of minutes, at least one and at most 4 days, and no months; got %',
              bucket USING ERRCODE = '22023';
    END IF;
    IF asset_ids IS NULL OR metric_names IS NULL THEN
        RAISE EXCEPTION 'derived_series: name the assets and the metrics; each series is one of each'
              USING ERRCODE = '22023';
    END IF;

    v_assets := ARRAY(SELECT DISTINCT a FROM unnest(asset_ids) AS u(a) WHERE a IS NOT NULL ORDER BY 1);
    v_metrics := ARRAY(SELECT DISTINCT n FROM unnest(metric_names) AS u(n) WHERE n IS NOT NULL ORDER BY 1);

    -- Only a derived metric is computed here; a measured one is telemetry_carried()'s.
    SELECT string_agg(n, ', ' ORDER BY n) INTO v_missing
      FROM unnest(v_metrics) AS u(n)
     WHERE NOT EXISTS (SELECT 1 FROM public.metric_catalog m WHERE m.name = u.n AND m.derivation IS NOT NULL);
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'derived_series: % is not a derived metric; read a measured one with telemetry_carried()', v_missing
              USING ERRCODE = '22023';
    END IF;

    -- On the epoch grid, as the rollups' buckets are, counted in seconds as telemetry_carried() does.
    v_step := make_interval(secs => v_secs);
    v_from := date_bin(v_step, from_ts, timestamptz 'epoch');
    v_buckets := ceil(extract(epoch FROM to_ts - v_from) / v_secs)::bigint;
    v_mpb := (v_secs / 60)::integer;
    IF cardinality(v_assets)::bigint * cardinality(v_metrics) * v_buckets > c_max_rows THEN
        RAISE EXCEPTION 'derived_series: % buckets of % devices and % metrics is more than % rows; choose a wider bucket, fewer devices or a shorter window',
              v_buckets, cardinality(v_assets), cardinality(v_metrics), c_max_rows USING ERRCODE = '22023';
    END IF;
    SELECT coalesce(sum(CASE WHEN m.derivation ->> 'kind' = 'sum' THEN jsonb_array_length(m.derivation -> 'inputs') ELSE 1 END), 0)
      INTO v_inputs
      FROM public.metric_catalog m WHERE m.name = ANY (v_metrics);
    IF cardinality(v_assets)::bigint * v_inputs * v_buckets * v_mpb > c_max_minutes THEN
        RAISE EXCEPTION 'derived_series: this window reads % minutes of % inputs of % devices, more than % minutes; choose a shorter window or fewer devices',
              v_buckets * v_mpb, v_inputs, cardinality(v_assets), c_max_minutes USING ERRCODE = '22023';
    END IF;

    -- Whole minutes only: the minute that holds now is not finished. A window ending inside a minute
    -- reads that minute, as telemetry_carried() reads a bucket that starts before its end.
    v_last := date_trunc('minute', now());
    v_end := least(date_trunc('minute', to_ts) + CASE WHEN to_ts = date_trunc('minute', to_ts) THEN interval '0' ELSE interval '1 minute' END, v_last);

    FOR v_def IN
        SELECT m.name, m.derivation FROM public.metric_catalog m WHERE m.name = ANY (v_metrics) ORDER BY m.name
    LOOP
        v_kind := v_def.derivation ->> 'kind';
        v_input := v_def.derivation ->> 'input';
        v_states := ARRAY(SELECT jsonb_array_elements_text(v_def.derivation -> 'states'));
        IF v_kind = 'sum' THEN
            SELECT array_agg(i ->> 'metric' ORDER BY o), array_agg((i ->> 'sign')::integer ORDER BY o)
              INTO v_names, v_signs
              FROM jsonb_array_elements(v_def.derivation -> 'inputs') WITH ORDINALITY AS e(i, o);
        ELSE
            v_names := ARRAY[v_input]; v_signs := ARRAY[1];
        END IF;
        v_n_in := cardinality(v_names);

        -- As many devices as fit one read of a bucket and the minute before it, then as many whole
        -- buckets as fit with those devices.
        v_a_chunk := least(greatest(cardinality(v_assets), 1), greatest(1, (c_read_rows / (v_n_in * (v_mpb + 1)))::integer));
        v_k_chunk := greatest(1, (((c_read_rows / (v_a_chunk * v_n_in)) - 1) / v_mpb)::integer);

        FOR v_i IN 1..cardinality(v_assets) BY v_a_chunk LOOP
            v_chunk := v_assets[v_i : v_i + v_a_chunk - 1];
            v_cs := v_from;
            WHILE v_cs < v_end LOOP
                v_ce := least(v_cs + v_k_chunk * v_step, v_end);

                IF v_kind = 'counter_rate' THEN
                    RETURN QUERY
                    WITH c AS (
                        SELECT t.bucket_ts AS bts, t.asset_id AS aid, t.last_double AS v, t.n_rows AS n
                          FROM public.telemetry_carried(v_cs - interval '1 minute', v_ce, interval '1 minute',
                                                        v_chunk, ARRAY[v_input]) t
                         WHERE t.last_double IS NOT NULL
                    ), d AS (
                        SELECT c.bts, c.aid, c.v, c.n, lag(c.v) OVER (PARTITION BY c.aid ORDER BY c.bts) AS pv FROM c
                    ), m AS (
                        SELECT date_bin(v_step, d.bts, timestamptz 'epoch') AS b, d.aid,
                               (sum(CASE WHEN d.v >= d.pv THEN d.v - d.pv ELSE d.v END) FILTER (WHERE d.pv IS NOT NULL)) AS inc,
                               (count(*) FILTER (WHERE d.pv IS NOT NULL)) AS minutes,
                               sum(d.n)::bigint AS n
                          FROM d WHERE d.bts >= v_cs GROUP BY 1, 2
                    )
                    SELECT m.b, m.aid, v_def.name,
                           m.inc * 60 / m.minutes, m.inc * 60 / m.minutes, m.inc * 60 / m.minutes, m.inc * 60 / m.minutes,
                           m.n, m.n = 0
                      FROM m WHERE m.minutes > 0;

                ELSIF v_kind = 'time_in_state' THEN
                    RETURN QUERY
                    SELECT r.b, r.aid, v_def.name, r.ratio, r.ratio, r.ratio, r.ratio, r.n, r.n = 0
                      FROM (SELECT date_bin(v_step, t.bucket_ts, timestamptz 'epoch') AS b, t.asset_id AS aid,
                                   (count(*) FILTER (WHERE coalesce(t.last_string, t.last_bool::text) = ANY (v_states)))::double precision
                                     / count(*) AS ratio,
                                   sum(t.n_rows)::bigint AS n
                              FROM public.telemetry_carried(v_cs, v_ce, interval '1 minute', v_chunk, ARRAY[v_input]) t
                             WHERE t.last_string IS NOT NULL OR t.last_bool IS NOT NULL
                             GROUP BY 1, 2) r;

                ELSE
                    RETURN QUERY
                    WITH m AS (
                        SELECT t.bucket_ts AS bts, t.asset_id AS aid,
                               sum(u.sg * t.avg_double) AS s_avg, sum(u.sg * t.last_double) AS s_last, sum(t.n_rows)::bigint AS n
                          FROM public.telemetry_carried(v_cs, v_ce, interval '1 minute', v_chunk, v_names) t
                          JOIN unnest(v_names, v_signs) AS u(mn, sg) ON u.mn = t.metric_name
                         WHERE t.avg_double IS NOT NULL AND t.last_double IS NOT NULL
                         GROUP BY 1, 2
                        HAVING count(*) = v_n_in
                    )
                    SELECT date_bin(v_step, m.bts, timestamptz 'epoch'), m.aid, v_def.name,
                           avg(m.s_avg), min(m.s_avg), max(m.s_avg),
                           (array_agg(m.s_last ORDER BY m.bts DESC))[1],
                           sum(m.n)::bigint, sum(m.n) = 0
                      FROM m GROUP BY 1, 2;
                END IF;

                v_cs := v_cs + v_k_chunk * v_step;
            END LOOP;
        END LOOP;
    END LOOP;
END;
$fn$;

ALTER FUNCTION public.derived_series(timestamp with time zone, timestamp with time zone, interval, text[], text[])
    OWNER TO postgres;

COMMENT ON FUNCTION public.derived_series(timestamp with time zone, timestamp with time zone, interval, text[], text[]) IS
  'A derived metric''s series, computed at query time from telemetry_carried() at one minute: one row '
  'per device, metric and bucket that has a value. A counter rate is the increase per hour, a fall '
  'being a reset; a time in state is the share of the bucket''s minutes in the states; a sum is the '
  'time-average of the per-minute signed sum, only for minutes where every input has a value. avg_double '
  'is the value; n_rows counts the inputs'' readings and is_carried says there were none. Whole minutes '
  'only. Refuses a metric that is not derived, bad bounds and buckets (at most 4 days), more than 5,000 '
  'rows and more than 250,000 minutes of input, before any read. Runs as the caller (0282).';

-- -------------------------------------------------------------------------------------------------
-- 3. The current value
-- -------------------------------------------------------------------------------------------------
-- A fold of derived_series() at one minute over the window derived_window_minutes() names, so a
-- current value is computed by the one formula the charts use. A rate and a share are the mean of the
-- window's minute values, which is the whole window's rate and share; a sum is the last minute's value
-- at its end. A device with no value yet has no row. The devices go to derived_series() in chunks
-- that keep each call under its row cap.
CREATE OR REPLACE FUNCTION public.derived_current(asset_ids text[], metric_names text[])
RETURNS TABLE (
    asset_id text,
    metric_name text,
    value double precision,
    observed_at timestamp with time zone,
    window_minutes integer
)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
DECLARE
    -- derived_series()'s row cap, which a chunk of devices times the window's minutes stays under.
    c_call_rows CONSTANT integer := 5000;
    -- Devices times metrics one call may ask for.
    c_max_series CONSTANT integer := 5000;
    v_assets  text[];
    v_metrics text[];
    v_missing text;
    v_end     timestamp with time zone;
    v_def     record;
    v_win     integer;
    v_size    integer;
BEGIN
    IF asset_ids IS NULL OR metric_names IS NULL THEN
        RAISE EXCEPTION 'derived_current: name the assets and the metrics; each value is one of each'
              USING ERRCODE = '22023';
    END IF;
    v_assets := ARRAY(SELECT DISTINCT a FROM unnest(asset_ids) AS u(a) WHERE a IS NOT NULL ORDER BY 1);
    v_metrics := ARRAY(SELECT DISTINCT n FROM unnest(metric_names) AS u(n) WHERE n IS NOT NULL ORDER BY 1);
    SELECT string_agg(n, ', ' ORDER BY n) INTO v_missing
      FROM unnest(v_metrics) AS u(n)
     WHERE NOT EXISTS (SELECT 1 FROM public.metric_catalog m WHERE m.name = u.n AND m.derivation IS NOT NULL);
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'derived_current: % is not a derived metric; a measured one''s latest value is in telemetry_latest', v_missing
              USING ERRCODE = '22023';
    END IF;
    IF cardinality(v_assets)::bigint * cardinality(v_metrics) > c_max_series THEN
        RAISE EXCEPTION 'derived_current: % devices of % metrics is more than % values; ask for fewer',
              cardinality(v_assets), cardinality(v_metrics), c_max_series USING ERRCODE = '22023';
    END IF;

    v_end := date_trunc('minute', now());
    FOR v_def IN
        SELECT m.name, public.derived_window_minutes(m.derivation) AS win
          FROM public.metric_catalog m WHERE m.name = ANY (v_metrics) ORDER BY m.name
    LOOP
        v_win := v_def.win;
        v_size := greatest(1, c_call_rows / greatest(v_win, 1));
        FOR v_i IN 1..cardinality(v_assets) BY v_size LOOP
            RETURN QUERY
            SELECT s.asset_id, s.metric_name,
                   CASE WHEN v_win = 0 THEN (array_agg(s.last_double ORDER BY s.bucket_ts DESC))[1] ELSE avg(s.avg_double) END,
                   v_end, v_win
              FROM public.derived_series(v_end - make_interval(mins => greatest(v_win, 1)), v_end, interval '1 minute',
                                         v_assets[v_i : v_i + v_size - 1], ARRAY[v_def.name]) s
             GROUP BY s.asset_id, s.metric_name;
        END LOOP;
    END LOOP;
END;
$fn$;

ALTER FUNCTION public.derived_current(text[], text[]) OWNER TO postgres;

COMMENT ON FUNCTION public.derived_current(text[], text[]) IS
  'A derived metric''s current value for each device that has one: a counter rate and a time in state '
  'over the 60 minutes ending at the last whole minute, a sum at the last whole minute (see '
  'derived_window_minutes()), computed by derived_series(). observed_at is the minute it ends at. '
  'Refuses a metric that is not derived and more than 5,000 devices times metrics. Runs as the caller '
  '(0282).';

-- -------------------------------------------------------------------------------------------------
-- 4. Who may call them: whoever may read the telemetry views
-- -------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.derived_series(timestamp with time zone, timestamp with time zone, interval, text[], text[])
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.derived_series(timestamp with time zone, timestamp with time zone, interval, text[], text[])
    TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.derived_current(text[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.derived_current(text[], text[]) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn text;
  v_forms integer;
  v_bad text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.derived_series(timestamp with time zone, timestamp with time zone, interval, text[], text[])',
    'public.derived_current(text[], text[])'] LOOP
    SELECT count(*) INTO v_forms
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = split_part(split_part(v_fn, '.', 2), '(', 1);
    IF v_forms <> 1 THEN
      RAISE EXCEPTION '0282: % is declared % times, not once', v_fn, v_forms;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                    AND NOT prosecdef AND provolatile = 's' AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0282: % is not a STABLE SECURITY INVOKER function with its search_path pinned', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0282: anon may execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0282: authenticated and service_role must execute %, as they read the telemetry views', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.derived_window_minutes(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.derived_window_minutes(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '0282: derived_window_minutes() is granted otherwise than to the API roles but anon';
  END IF;
  IF public.derived_window_minutes('{"kind": "counter_rate", "input": "A/X"}') IS DISTINCT FROM 60
     OR public.derived_window_minutes('{"kind": "time_in_state", "input": "A/X", "states": ["B"]}') IS DISTINCT FROM 60
     OR public.derived_window_minutes('{"kind": "sum", "inputs": []}') IS DISTINCT FROM 0
     OR public.derived_window_minutes('{"kind": "average"}') IS NOT NULL
     OR public.derived_window_minutes(NULL) IS NOT NULL THEN
    RAISE EXCEPTION '0282: derived_window_minutes() names the wrong window for a kind';
  END IF;

  -- The refusals come before any read, so they hold on a stack with no historian.
  FOREACH v_bad IN ARRAY ARRAY['window', 'bucket', 'wide', 'assets', 'metrics', 'measured', 'current'] LOOP
    BEGIN
      CASE v_bad
        WHEN 'window' THEN PERFORM public.derived_series(now(), now() - interval '1 hour', interval '5 minutes', '{a}', '{m}');
        WHEN 'bucket' THEN PERFORM public.derived_series(now() - interval '1 hour', now(), interval '30 seconds', '{a}', '{m}');
        WHEN 'wide' THEN PERFORM public.derived_series(now() - interval '30 days', now(), interval '5 days', '{a}', '{m}');
        WHEN 'assets' THEN PERFORM public.derived_series(now() - interval '1 hour', now(), interval '5 minutes', NULL, '{m}');
        WHEN 'metrics' THEN PERFORM public.derived_series(now() - interval '1 hour', now(), interval '5 minutes', '{a}', NULL);
        WHEN 'measured' THEN PERFORM public.derived_series(now() - interval '1 hour', now(), interval '5 minutes', '{a}', '{not-in-the-catalogue}');
        ELSE PERFORM public.derived_current('{a}', '{not-in-the-catalogue}');
      END CASE;
      RAISE EXCEPTION '0282: derived_series() or derived_current() accepted a bad %', v_bad USING ERRCODE = 'P0001';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
