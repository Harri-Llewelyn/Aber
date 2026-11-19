-- 0315: A page of readings brings across only the rows it returns.
--
-- A read of public.telemetry or a rollup, newest first with a LIMIT, sent the historian its WHERE and
-- nothing else. postgres_fdw sends ORDER BY and LIMIT only when its row estimate says the LIMIT cuts,
-- and the foreign tables have no statistics, so it estimates a page's read at one row: every row
-- inside the time bound crossed and was sorted here. Measured with one week at 1 Hz, a 500-row page
-- of one metric brought 604,800 rows across.
--
-- telemetry_page() and telemetry_rollup_page() read one page as the dashboard, i3X and the AAS bundle
-- asked for it: newest first, at most p_limit rows after p_offset, of one device or every device, one
-- metric or every metric, between optional bounds. Each makes three remote reads, and sends each its
-- bounds:
--
--   * a count of the rows an hour of the window holds (a bin of 60 buckets for a rollup), as one remote
--     aggregate;
--   * the instant of the page's last row, from the bin that holds it, as one remote aggregate;
--   * the rows from that instant on: the page, the rows before it, and the rows that share its last
--     instant.
--
-- The rows, their order and the page's boundaries are the read's own. Ties at one instant come in
-- device and metric order. A window that holds fewer rows than the page is read whole.
--
-- Both run as the caller, SECURITY INVOKER, as the telemetry views and telemetry_carried() do.
--
-- Reasoning: supabase/README.md, "A page of readings brings across only the rows it returns (0315)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Where a page starts
-- -------------------------------------------------------------------------------------------------
-- The instant of the p_rows-th newest row in the window, or NULL when it holds fewer. Every bound and
-- list reaches the historian as a value, so postgres_fdw sends each WHERE and both aggregates whole.
-- The bins are counted first so the second aggregate sorts one bin, not the window.
CREATE OR REPLACE FUNCTION public.telemetry_page_start(
    p_relation text,
    p_asset_id text,
    p_metric_name text,
    p_from timestamp with time zone,
    p_to timestamp with time zone,
    p_to_inclusive boolean,
    p_rows bigint
) RETURNS timestamp with time zone
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_col    text;
    v_bin    interval;
    v_where  text := '';
    v_bins   timestamp with time zone[];
    v_counts bigint[];
    v_acc    bigint := 0;
    v_start  timestamp with time zone;
BEGIN
    CASE p_relation
        WHEN 'telemetry'    THEN v_col := 'time';   v_bin := interval '1 hour';
        WHEN 'telemetry_1m' THEN v_col := 'bucket'; v_bin := interval '1 hour';
        WHEN 'telemetry_5m' THEN v_col := 'bucket'; v_bin := interval '5 hours';
        WHEN 'telemetry_1h' THEN v_col := 'bucket'; v_bin := interval '60 hours';
        ELSE RAISE EXCEPTION 'telemetry_page_start: % is not telemetry or one of its rollups', p_relation
                   USING ERRCODE = '22023';
    END CASE;
    IF p_rows IS NULL OR p_rows < 1 THEN
        RAISE EXCEPTION 'telemetry_page_start: a page starts at its first row or later, not %', p_rows
              USING ERRCODE = '22023';
    END IF;

    IF p_asset_id IS NOT NULL THEN v_where := v_where || ' AND t.asset_id = $1'; END IF;
    IF p_metric_name IS NOT NULL THEN v_where := v_where || ' AND t.metric_name = $2'; END IF;
    IF p_from IS NOT NULL THEN v_where := v_where || format(' AND t.%I >= $3', v_col); END IF;
    IF p_to IS NOT NULL THEN
        v_where := v_where || format(' AND t.%I %s $4', v_col,
                                     CASE WHEN p_to_inclusive IS FALSE THEN '<' ELSE '<=' END);
    END IF;

    EXECUTE format($q$
      SELECT array_agg(o.b ORDER BY o.b DESC), array_agg(o.n ORDER BY o.b DESC)
        FROM (SELECT date_bin($5, t.%1$I, timestamptz 'epoch') AS b, count(*) AS n
                FROM timescale.%2$I t
               WHERE true %3$s
               GROUP BY 1) o
    $q$, v_col, p_relation, v_where)
    INTO v_bins, v_counts
    USING p_asset_id, p_metric_name, p_from, p_to, v_bin;

    FOR v_k IN 1 .. coalesce(cardinality(v_bins), 0) LOOP
        IF v_acc + v_counts[v_k] >= p_rows THEN
            EXECUTE format($q$
              SELECT (array_agg(t.%1$I ORDER BY t.%1$I DESC))[$7]
                FROM timescale.%2$I t
               WHERE t.%1$I >= $5 AND t.%1$I < $6 %3$s
            $q$, v_col, p_relation, v_where)
            INTO v_start
            USING p_asset_id, p_metric_name, p_from, p_to, v_bins[v_k], v_bins[v_k] + v_bin, p_rows - v_acc;
            RETURN v_start;
        END IF;
        v_acc := v_acc + v_counts[v_k];
    END LOOP;
    RETURN NULL;
END;
$fn$;

ALTER FUNCTION public.telemetry_page_start(text, text, text, timestamp with time zone, timestamp with time zone, boolean, bigint)
    OWNER TO postgres;

COMMENT ON FUNCTION public.telemetry_page_start(text, text, text, timestamp with time zone, timestamp with time zone, boolean, bigint) IS
  'Where a page of readings newest first starts: the time of the p_rows-th newest row of p_relation '
  '(telemetry, telemetry_1m, telemetry_5m or telemetry_1h) in the window, or NULL when it holds fewer. '
  'Read by telemetry_page() and telemetry_rollup_page() from two remote aggregates. Runs as the '
  'caller (0315).';

-- -------------------------------------------------------------------------------------------------
-- 2. A page of raw readings
-- -------------------------------------------------------------------------------------------------
-- The read is the page's rows and those before it, from the instant telemetry_page_start() names.
-- Every column is qualified: the result's own column names are variables in plpgsql.
CREATE OR REPLACE FUNCTION public.telemetry_page(
    p_asset_id text DEFAULT NULL,
    p_metric_name text DEFAULT NULL,
    p_from timestamp with time zone DEFAULT NULL,
    p_to timestamp with time zone DEFAULT NULL,
    p_to_inclusive boolean DEFAULT true,
    p_limit integer DEFAULT 500,
    p_offset integer DEFAULT 0
) RETURNS TABLE (
    "time" timestamp with time zone,
    asset_id text,
    metric_name text,
    val_double double precision,
    val_string text,
    val_bool boolean
)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_where text := '';
    v_start timestamp with time zone;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_offset IS NULL OR p_offset < 0 THEN
        RAISE EXCEPTION 'telemetry_page: a page is at least one row (p_limit %) after none or more (p_offset %)',
              p_limit, p_offset USING ERRCODE = '22023';
    END IF;

    v_start := public.telemetry_page_start('telemetry', p_asset_id, p_metric_name, p_from, p_to,
                                           p_to_inclusive, p_limit::bigint + p_offset);

    IF p_asset_id IS NOT NULL THEN v_where := v_where || ' AND t.asset_id = $1'; END IF;
    IF p_metric_name IS NOT NULL THEN v_where := v_where || ' AND t.metric_name = $2'; END IF;
    IF p_from IS NOT NULL THEN v_where := v_where || ' AND t."time" >= $3'; END IF;
    IF p_to IS NOT NULL THEN
        v_where := v_where || CASE WHEN p_to_inclusive IS FALSE THEN ' AND t."time" < $4' ELSE ' AND t."time" <= $4' END;
    END IF;
    IF v_start IS NOT NULL THEN v_where := v_where || ' AND t."time" >= $7'; END IF;

    RETURN QUERY EXECUTE format($q$
      SELECT t."time", t.asset_id, t.metric_name, t.val_double, t.val_string, t.val_bool
        FROM timescale.telemetry t
       WHERE true %s
       ORDER BY t."time" DESC, t.asset_id, t.metric_name
       LIMIT $5 OFFSET $6
    $q$, v_where)
    USING p_asset_id, p_metric_name, p_from, p_to, p_limit, p_offset, v_start;
END;
$fn$;

ALTER FUNCTION public.telemetry_page(text, text, timestamp with time zone, timestamp with time zone, boolean, integer, integer)
    OWNER TO postgres;

COMMENT ON FUNCTION public.telemetry_page(text, text, timestamp with time zone, timestamp with time zone, boolean, integer, integer) IS
  'One page of raw readings newest first, as public.telemetry has them: at most p_limit rows after '
  'p_offset, of p_asset_id (a Sparkplug id) and p_metric_name, either NULL for every one, at or after '
  'p_from and before or at p_to (before it when p_to_inclusive is false). Ties at one instant come in '
  'device and metric order. The historian sends the rows of the page, those before it and those that '
  'share its last instant, and no others. Runs as the caller (0315).';

-- -------------------------------------------------------------------------------------------------
-- 3. A page of a rollup's buckets
-- -------------------------------------------------------------------------------------------------
-- The rollup views' columns, the average computed as they compute it.
CREATE OR REPLACE FUNCTION public.telemetry_rollup_page(
    p_resolution text,
    p_asset_id text DEFAULT NULL,
    p_metric_name text DEFAULT NULL,
    p_from timestamp with time zone DEFAULT NULL,
    p_to timestamp with time zone DEFAULT NULL,
    p_to_inclusive boolean DEFAULT true,
    p_limit integer DEFAULT 500,
    p_offset integer DEFAULT 0
) RETURNS TABLE (
    bucket timestamp with time zone,
    asset_id text,
    metric_name text,
    avg_double double precision,
    min_double double precision,
    max_double double precision,
    last_double double precision,
    last_string text,
    last_bool boolean,
    n_double bigint,
    n_rows bigint
)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_rel   text;
    v_where text := '';
    v_start timestamp with time zone;
BEGIN
    IF p_resolution IS NULL OR NOT p_resolution = ANY (ARRAY['1m', '5m', '1h']) THEN
        RAISE EXCEPTION 'telemetry_rollup_page: the resolution is 1m, 5m or 1h, not %', quote_nullable(p_resolution)
              USING ERRCODE = '22023';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_offset IS NULL OR p_offset < 0 THEN
        RAISE EXCEPTION 'telemetry_rollup_page: a page is at least one row (p_limit %) after none or more (p_offset %)',
              p_limit, p_offset USING ERRCODE = '22023';
    END IF;
    v_rel := 'telemetry_' || p_resolution;

    v_start := public.telemetry_page_start(v_rel, p_asset_id, p_metric_name, p_from, p_to,
                                           p_to_inclusive, p_limit::bigint + p_offset);

    IF p_asset_id IS NOT NULL THEN v_where := v_where || ' AND t.asset_id = $1'; END IF;
    IF p_metric_name IS NOT NULL THEN v_where := v_where || ' AND t.metric_name = $2'; END IF;
    IF p_from IS NOT NULL THEN v_where := v_where || ' AND t.bucket >= $3'; END IF;
    IF p_to IS NOT NULL THEN
        v_where := v_where || CASE WHEN p_to_inclusive IS FALSE THEN ' AND t.bucket < $4' ELSE ' AND t.bucket <= $4' END;
    END IF;
    IF v_start IS NOT NULL THEN v_where := v_where || ' AND t.bucket >= $7'; END IF;

    RETURN QUERY EXECUTE format($q$
      SELECT t.bucket, t.asset_id, t.metric_name, t.sum_double / nullif(t.n_double, 0)::double precision,
             t.min_double, t.max_double, t.last_double, t.last_string, t.last_bool, t.n_double, t.n_rows
        FROM timescale.%I t
       WHERE true %s
       ORDER BY t.bucket DESC, t.asset_id, t.metric_name
       LIMIT $5 OFFSET $6
    $q$, v_rel, v_where)
    USING p_asset_id, p_metric_name, p_from, p_to, p_limit, p_offset, v_start;
END;
$fn$;

ALTER FUNCTION public.telemetry_rollup_page(text, text, text, timestamp with time zone, timestamp with time zone, boolean, integer, integer)
    OWNER TO postgres;

COMMENT ON FUNCTION public.telemetry_rollup_page(text, text, text, timestamp with time zone, timestamp with time zone, boolean, integer, integer) IS
  'One page of a rollup''s buckets newest first, as telemetry_1m, telemetry_5m or telemetry_1h has '
  'them (p_resolution 1m, 5m or 1h): at most p_limit rows after p_offset, of p_asset_id and '
  'p_metric_name, either NULL for every one, at or after p_from and before or at p_to (before it '
  'when p_to_inclusive is false). The historian sends the rows of the page, those before it and those '
  'that share its last bucket, and no others. Runs as the caller (0315).';

-- -------------------------------------------------------------------------------------------------
-- 4. Who may call them: whoever may read the telemetry views
-- -------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.telemetry_page_start(text, text, text, timestamp with time zone, timestamp with time zone, boolean, bigint)
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.telemetry_page(text, text, timestamp with time zone, timestamp with time zone, boolean, integer, integer)
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.telemetry_rollup_page(text, text, text, timestamp with time zone, timestamp with time zone, boolean, integer, integer)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.telemetry_page_start(text, text, text, timestamp with time zone, timestamp with time zone, boolean, bigint)
    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.telemetry_page(text, text, timestamp with time zone, timestamp with time zone, boolean, integer, integer)
    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.telemetry_rollup_page(text, text, text, timestamp with time zone, timestamp with time zone, boolean, integer, integer)
    TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fns CONSTANT text[] := ARRAY[
    'public.telemetry_page_start(text, text, text, timestamp with time zone, timestamp with time zone, boolean, bigint)',
    'public.telemetry_page(text, text, timestamp with time zone, timestamp with time zone, boolean, integer, integer)',
    'public.telemetry_rollup_page(text, text, text, timestamp with time zone, timestamp with time zone, boolean, integer, integer)'];
  v_fn    text;
  v_forms integer;
  v_bad   text;
BEGIN
  SELECT count(*) INTO v_forms
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('telemetry_page_start', 'telemetry_page', 'telemetry_rollup_page');
  IF v_forms <> 3 THEN
    RAISE EXCEPTION '0315: the three page functions are declared % times, not once each', v_forms;
  END IF;
  FOREACH v_fn IN ARRAY v_fns LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                    AND NOT prosecdef AND provolatile = 's' AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0315: % is not a STABLE SECURITY INVOKER function with its search_path pinned', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0315: anon may execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0315: authenticated and service_role must execute %, as they read the telemetry views', v_fn;
    END IF;
  END LOOP;

  -- The refusals come before any read, so they hold on a stack with no historian.
  FOREACH v_bad IN ARRAY ARRAY['limit', 'offset', 'resolution', 'relation', 'rows'] LOOP
    BEGIN
      CASE v_bad
        WHEN 'limit' THEN PERFORM public.telemetry_page('a', NULL, NULL, NULL, true, 0, 0);
        WHEN 'offset' THEN PERFORM public.telemetry_rollup_page('1m', 'a', NULL, NULL, NULL, true, 10, -1);
        WHEN 'resolution' THEN PERFORM public.telemetry_rollup_page('30s', 'a');
        WHEN 'relation' THEN PERFORM public.telemetry_page_start('assets', 'a', NULL, NULL, NULL, true, 1);
        ELSE PERFORM public.telemetry_page_start('telemetry', 'a', NULL, NULL, NULL, true, 0);
      END CASE;
      RAISE EXCEPTION '0315: a page read accepted a bad %', v_bad USING ERRCODE = 'P0001';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
