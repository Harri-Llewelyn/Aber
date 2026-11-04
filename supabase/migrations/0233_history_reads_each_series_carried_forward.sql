-- 0233: History reads each series carried forward across the buckets nobody reported in.
--
-- telemetry_carried(from_ts, to_ts, bucket, asset_ids, metric_names) returns one row per series
-- per bucket of the window, a series being one asset and one metric. A bucket with readings
-- carries the rollup's average, minimum, maximum and last values. A bucket with none carries the
-- last value forward, its average, minimum and maximum all that value, and says so in is_carried.
-- Under report-by-exception a quiet bucket means unchanged, not unknown.
--
--   * It reads the historian's rollups over postgres_fdw: the widest of telemetry_1m, _5m and _1h
--     whose width divides the bucket. A wider bucket is combined from them on the historian.
--   * Each series is seeded from the newest rollup bucket before the window, never from raw
--     telemetry, which the historian drops after 14 days by default. A series silent longer than
--     its rollup is kept is seeded from telemetry_1h, which is kept longest.
--   * Nothing is carried past now, and a series with nothing to carry has no row.
--   * It runs as the caller, as the telemetry views do, and refuses a read of more than 50,000 rows.
--
-- Reasoning: supabase/README.md, "History reads each series carried forward (0233)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The read
-- -------------------------------------------------------------------------------------------------
-- The bounds and lists reach the historian as parameters, so postgres_fdw ships every WHERE and
-- aggregate; now() and a lateral join would be evaluated here and pull rows across. The seed is one
-- query over the lookback, then one LIMIT 1 query for each series that read nothing in it: a
-- parameterised join cannot carry a LIMIT to the historian.
CREATE OR REPLACE FUNCTION public.telemetry_carried(
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
    last_string text,
    last_bool boolean,
    n_rows bigint,
    is_carried boolean
)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
DECLARE
    -- Ten times the dashboard's row cap, so a later reader has room and no read is unbounded.
    c_max_rows CONSTANT bigint := 50000;
    -- How many source buckets the bulk seed looks back over before the window.
    c_lookback CONSTANT integer := 288;
    v_secs     numeric;
    v_source   text;
    v_width    interval;
    v_from     timestamp with time zone;
    v_back     timestamp with time zone;
    v_series   bigint;
    v_buckets  bigint;
    v_found    bigint;
    v_aid      text[];
    v_mname    text[];
    v_d        double precision[];
    v_s        text[];
    v_b        boolean[];
    v_pair     record;
    v_sd       double precision;
    v_ss       text;
    v_sb       boolean;
BEGIN
    IF from_ts IS NULL OR to_ts IS NULL OR to_ts <= from_ts THEN
        RAISE EXCEPTION 'telemetry_carried: to_ts (%) must be after from_ts (%)', to_ts, from_ts
              USING ERRCODE = '22023';
    END IF;
    v_secs := extract(epoch FROM bucket);
    IF bucket IS NULL OR extract(year FROM bucket) <> 0 OR extract(month FROM bucket) <> 0
       OR v_secs < 60 OR v_secs % 60 <> 0 THEN
        RAISE EXCEPTION 'telemetry_carried: bucket must be a whole number of minutes, at least one, and no months; got %',
              bucket USING ERRCODE = '22023';
    END IF;
    IF asset_ids IS NULL OR metric_names IS NULL THEN
        RAISE EXCEPTION 'telemetry_carried: name the assets and the metrics; each series is one of each'
              USING ERRCODE = '22023';
    END IF;

    -- On the epoch grid, as the rollups' buckets are, so each source bucket falls in one bucket here.
    v_from := date_bin(bucket, from_ts, timestamptz 'epoch');
    v_series := cardinality(asset_ids)::bigint * cardinality(metric_names);
    v_buckets := ceil(extract(epoch FROM to_ts - v_from) / v_secs)::bigint;
    IF v_series * v_buckets > c_max_rows THEN
        RAISE EXCEPTION 'telemetry_carried: % buckets of % series is more than % rows; choose a wider bucket or fewer series',
              v_buckets, v_series, c_max_rows USING ERRCODE = '22023';
    END IF;

    IF v_secs % 3600 = 0 THEN
        v_source := 'telemetry_1h'; v_width := interval '1 hour';
    ELSIF v_secs % 300 = 0 THEN
        v_source := 'telemetry_5m'; v_width := interval '5 minutes';
    ELSE
        v_source := 'telemetry_1m'; v_width := interval '1 minute';
    END IF;
    v_back := v_from - c_lookback * v_width;

    -- Each series' newest values in the lookback, in one query the historian aggregates.
    EXECUTE format($q$
      SELECT array_agg(o.asset_id), array_agg(o.metric_name), array_agg(o.d), array_agg(o.s), array_agg(o.b)
        FROM (SELECT t.asset_id, t.metric_name,
                     (array_agg(t.last_double ORDER BY t.bucket DESC) FILTER (WHERE t.last_double IS NOT NULL))[1] AS d,
                     (array_agg(t.last_string ORDER BY t.bucket DESC) FILTER (WHERE t.last_string IS NOT NULL))[1] AS s,
                     (array_agg(t.last_bool   ORDER BY t.bucket DESC) FILTER (WHERE t.last_bool IS NOT NULL))[1] AS b
                FROM timescale.%I t
               WHERE t.bucket >= $1 AND t.bucket < $2
                 AND t.asset_id = ANY ($3::text[]) AND t.metric_name = ANY ($4::text[])
               GROUP BY 1, 2) o
    $q$, v_source)
    INTO v_aid, v_mname, v_d, v_s, v_b
    USING v_back, v_from, asset_ids, metric_names;
    v_aid := coalesce(v_aid, '{}'); v_mname := coalesce(v_mname, '{}');
    v_d := coalesce(v_d, '{}'); v_s := coalesce(v_s, '{}'); v_b := coalesce(v_b, '{}');

    -- Every other series on its own: its newest bucket before the lookback, else telemetry_1h's.
    FOR v_pair IN
        SELECT DISTINCT a.aid, m.mname
          FROM unnest(asset_ids) AS a(aid) CROSS JOIN unnest(metric_names) AS m(mname)
         WHERE NOT EXISTS (SELECT 1 FROM unnest(v_aid, v_mname) AS k(aid, mname)
                            WHERE k.aid = a.aid AND k.mname = m.mname)
    LOOP
        EXECUTE format($q$
          SELECT t.last_double, t.last_string, t.last_bool
            FROM timescale.%I t
           WHERE t.asset_id = $1 AND t.metric_name = $2 AND t.bucket < $3
           ORDER BY t.bucket DESC LIMIT 1
        $q$, v_source)
        INTO v_sd, v_ss, v_sb USING v_pair.aid, v_pair.mname, v_back;
        GET DIAGNOSTICS v_found = ROW_COUNT;
        IF v_found = 0 AND v_source <> 'telemetry_1h' THEN
            SELECT t.last_double, t.last_string, t.last_bool INTO v_sd, v_ss, v_sb
              FROM timescale.telemetry_1h t
             WHERE t.asset_id = v_pair.aid AND t.metric_name = v_pair.mname
               AND t.bucket < date_bin(interval '1 hour', v_back, timestamptz 'epoch')
             ORDER BY t.bucket DESC LIMIT 1;
            GET DIAGNOSTICS v_found = ROW_COUNT;
        END IF;
        IF v_found > 0 THEN
            v_aid := v_aid || v_pair.aid; v_mname := v_mname || v_pair.mname;
            v_d := v_d || v_sd; v_s := v_s || v_ss; v_b := v_b || v_sb;
        END IF;
    END LOOP;

    -- The window: the historian's buckets, then every bucket up to now for each series, each
    -- quiet one taking the last value before it, else the seed. count() over the rows so far
    -- numbers each run that starts at a value, and the run's max() is that value.
    RETURN QUERY EXECUTE format($q$
      WITH series AS (
        SELECT DISTINCT a.aid, m.mname
          FROM unnest($4::text[]) AS a(aid) CROSS JOIN unnest($5::text[]) AS m(mname)
      ),
      seed AS (
        SELECT * FROM unnest($7::text[], $8::text[], $9::double precision[], $10::text[], $11::boolean[])
                   AS x(aid, mname, d, st, bo)
      ),
      obs AS (
        SELECT date_bin($3, o.bucket, timestamptz 'epoch') AS b,
               o.asset_id AS aid, o.metric_name AS mname,
               sum(o.sum_double) AS sum_d, sum(o.n_double) AS n_d,
               min(o.min_double) AS min_d, max(o.max_double) AS max_d,
               (array_agg(o.last_double ORDER BY o.bucket DESC) FILTER (WHERE o.last_double IS NOT NULL))[1] AS last_d,
               (array_agg(o.last_string ORDER BY o.bucket DESC) FILTER (WHERE o.last_string IS NOT NULL))[1] AS last_s,
               (array_agg(o.last_bool   ORDER BY o.bucket DESC) FILTER (WHERE o.last_bool IS NOT NULL))[1] AS last_b,
               sum(o.n_rows)::bigint AS n
          FROM timescale.%I o
         WHERE o.bucket >= $6 AND o.bucket < $2
           AND o.asset_id = ANY ($4::text[]) AND o.metric_name = ANY ($5::text[])
         GROUP BY 1, 2, 3
      ),
      grid AS (
        SELECT s.aid, s.mname, g.b, obs.sum_d, obs.n_d, obs.min_d, obs.max_d,
               obs.last_d, obs.last_s, obs.last_b, coalesce(obs.n, 0) AS n
          FROM series s
         CROSS JOIN generate_series($6, $2, $3) AS g(b)
          LEFT JOIN obs ON obs.aid = s.aid AND obs.mname = s.mname AND obs.b = g.b
         WHERE g.b < $2 AND g.b <= now()
      ),
      runs AS (
        SELECT grid.*,
               count(grid.last_d) OVER w AS run_d,
               count(grid.last_s) OVER w AS run_s,
               count(grid.last_b) OVER w AS run_b
          FROM grid
        WINDOW w AS (PARTITION BY grid.aid, grid.mname ORDER BY grid.b ROWS UNBOUNDED PRECEDING)
      ),
      filled AS (
        SELECT r.*,
               coalesce(max(r.last_d) OVER (PARTITION BY r.aid, r.mname, r.run_d), sd.d) AS cd,
               coalesce(max(r.last_s) OVER (PARTITION BY r.aid, r.mname, r.run_s), sd.st) AS cs,
               coalesce(bool_or(r.last_b) OVER (PARTITION BY r.aid, r.mname, r.run_b), sd.bo) AS cb
          FROM runs r
          LEFT JOIN seed sd ON sd.aid = r.aid AND sd.mname = r.mname
      )
      SELECT f.b, f.aid, f.mname,
             CASE WHEN f.n > 0 THEN f.sum_d / nullif(f.n_d, 0) ELSE f.cd END,
             CASE WHEN f.n > 0 THEN f.min_d ELSE f.cd END,
             CASE WHEN f.n > 0 THEN f.max_d ELSE f.cd END,
             f.cd, f.cs, f.cb, f.n, f.n = 0
        FROM filled f
       WHERE f.n > 0 OR f.cd IS NOT NULL OR f.cs IS NOT NULL OR f.cb IS NOT NULL
       ORDER BY f.aid, f.mname, f.b
    $q$, v_source)
    USING from_ts, to_ts, bucket, asset_ids, metric_names, v_from, v_aid, v_mname, v_d, v_s, v_b;
END;
$fn$;

ALTER FUNCTION public.telemetry_carried(timestamp with time zone, timestamp with time zone, interval, text[], text[])
    OWNER TO postgres;

COMMENT ON FUNCTION public.telemetry_carried(timestamp with time zone, timestamp with time zone, interval, text[], text[]) IS
  'History''s read: one row per series (asset and metric) per bucket of the window, from the '
  'historian''s rollups. A bucket with readings has their average, minimum, maximum and last '
  'values; a quiet one carries the last value forward, seeded from the rollups before the window, '
  'and is_carried says so. No row past now or before a series'' first value. Runs as the caller '
  '(0233).';

-- -------------------------------------------------------------------------------------------------
-- 2. Who may call it: whoever may read the telemetry views
-- -------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.telemetry_carried(timestamp with time zone, timestamp with time zone, interval, text[], text[])
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.telemetry_carried(timestamp with time zone, timestamp with time zone, interval, text[], text[])
    TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn CONSTANT text := 'public.telemetry_carried(timestamp with time zone, timestamp with time zone, interval, text[], text[])';
  v_forms integer;
  v_bad text;
BEGIN
  SELECT count(*) INTO v_forms
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'telemetry_carried';
  IF v_forms <> 1 THEN
    RAISE EXCEPTION '0233: telemetry_carried is declared % times, not once', v_forms;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                  AND NOT prosecdef AND provolatile = 's' AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0233: % is not a STABLE SECURITY INVOKER function with its search_path pinned', v_fn;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0233: anon may execute %', v_fn;
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0233: authenticated and service_role must execute %, as they read the telemetry views', v_fn;
  END IF;

  -- The refusals come before any read, so they hold on a stack with no historian.
  FOREACH v_bad IN ARRAY ARRAY['window', 'bucket', 'series', 'size'] LOOP
    BEGIN
      CASE v_bad
        WHEN 'window' THEN PERFORM public.telemetry_carried(now(), now() - interval '1 hour', interval '5 minutes', '{a}', '{m}');
        WHEN 'bucket' THEN PERFORM public.telemetry_carried(now() - interval '1 hour', now(), interval '30 seconds', '{a}', '{m}');
        WHEN 'series' THEN PERFORM public.telemetry_carried(now() - interval '1 hour', now(), interval '5 minutes', NULL, '{m}');
        ELSE PERFORM public.telemetry_carried(now() - interval '1 year', now(), interval '1 minute', '{a}', '{m}');
      END CASE;
      RAISE EXCEPTION '0233: telemetry_carried() accepted a bad %', v_bad USING ERRCODE = 'P0001';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
