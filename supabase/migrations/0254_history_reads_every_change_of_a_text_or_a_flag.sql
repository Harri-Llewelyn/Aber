-- 0254: History reads every change of a text or a flag at its own time, while raw telemetry holds it.
--
-- telemetry_changes(from_ts, to_ts, bucket, asset_ids, metric_names, max_changes) returns one row
-- per series, a series being one asset and one metric. `read` says how its chart is drawn:
--
--   * changes      Every change in the window, from raw telemetry: the first reading in it, then
--                  each reading whose value differs from the one before, each with its time. The
--                  value in force at from_ts, from before the window, is carried_string or
--                  carried_bool. A refresh of an unchanged value is collapsed here, so only changes
--                  cross to the browser.
--   * change_cap   More changes than max_changes (2,000 unless given, at most 5,000).
--   * reading_cap  More readings in the window than one series may bring across from raw (20,000).
--   * retention    The historian has dropped raw readings of the series inside the window.
--
-- The last three are charted from the bucket read, telemetry_carried() (0233). Past either cap,
-- marked_ts and marked_values name each bucket of `bucket` that held more than one value, and how
-- many, counted from raw. Past retention nothing is left to count. raw_from is the oldest raw
-- reading the historian holds.
--
--   * It compares text (val_string) and flags (val_bool), never a number's values.
--   * At most 50 series a read, refused before anything is read, as are the bounds 0233 refuses.
--   * It runs as the caller, as the telemetry views do.
--
-- Reasoning: supabase/README.md, "History reads every change of a text or a flag (0254)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The read
-- -------------------------------------------------------------------------------------------------
-- postgres_fdw sends a LIMIT to the historian only under its row estimate, which is one row for a
-- series over a window, so a LIMIT here would bound nothing that crosses. The 1-minute rollup's
-- count of readings bounds a raw read before it is made instead. The other reads are aggregates,
-- which it sends whole, one row back for each series or bucket.
CREATE OR REPLACE FUNCTION public.telemetry_changes(
    from_ts timestamp with time zone,
    to_ts timestamp with time zone,
    bucket interval,
    asset_ids text[],
    metric_names text[],
    max_changes integer DEFAULT 2000
) RETURNS TABLE (
    asset_id text,
    metric_name text,
    read text,
    change_ts timestamp with time zone[],
    val_string text[],
    val_bool boolean[],
    carried_string text,
    carried_bool boolean,
    n_changes integer,
    marked_ts timestamp with time zone[],
    marked_values integer[],
    raw_from timestamp with time zone
)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
DECLARE
    c_max_series   CONSTANT integer := 50;
    c_max_changes  CONSTANT integer := 5000;
    -- Buckets times series, as telemetry_carried() bounds its read.
    c_max_rows     CONSTANT bigint := 50000;
    -- The raw readings one series may bring across.
    c_max_readings CONSTANT bigint := 20000;
    -- The raw readings the historian counts values over for one series' marks.
    c_max_counted  CONSTANT bigint := 1000000;
    v_secs     numeric;
    v_step     interval;
    v_lo       timestamp with time zone;
    v_back     timestamp with time zone;
    v_buckets  bigint;
    v_horizon  timestamp with time zone;
    v_lost_to  timestamp with time zone;
    v_lost     boolean;
    v_pair     record;
    v_caid     text[];
    v_cmname   text[];
    v_cn       bigint[];
    v_said     text[];
    v_smname   text[];
    v_ss       text[];
    v_sb       boolean[];
    v_n        bigint;
    v_found    integer;
    v_has_seed boolean;
    v_seed_s   text;
    v_seed_b   boolean;
BEGIN
    IF from_ts IS NULL OR to_ts IS NULL OR to_ts <= from_ts THEN
        RAISE EXCEPTION 'telemetry_changes: to_ts (%) must be after from_ts (%)', to_ts, from_ts
              USING ERRCODE = '22023';
    END IF;
    v_secs := extract(epoch FROM bucket);
    IF bucket IS NULL OR extract(year FROM bucket) <> 0 OR extract(month FROM bucket) <> 0
       OR v_secs < 60 OR v_secs % 60 <> 0 THEN
        RAISE EXCEPTION 'telemetry_changes: bucket must be a whole number of minutes, at least one, and no months; got %',
              bucket USING ERRCODE = '22023';
    END IF;
    IF asset_ids IS NULL OR metric_names IS NULL THEN
        RAISE EXCEPTION 'telemetry_changes: name the assets and the metrics; each series is one of each'
              USING ERRCODE = '22023';
    END IF;
    IF cardinality(asset_ids)::bigint * cardinality(metric_names) > c_max_series THEN
        RAISE EXCEPTION 'telemetry_changes: % series is more than % a read; read them in parts',
              cardinality(asset_ids)::bigint * cardinality(metric_names), c_max_series USING ERRCODE = '22023';
    END IF;
    IF max_changes IS NULL OR max_changes < 1 OR max_changes > c_max_changes THEN
        RAISE EXCEPTION 'telemetry_changes: max_changes must be 1 to %; got %', c_max_changes, max_changes
              USING ERRCODE = '22023';
    END IF;

    -- On the epoch grid, as telemetry_carried()'s buckets are, so a mark lands on its bucket.
    v_step := make_interval(secs => v_secs);
    v_lo := date_bin(v_step, from_ts, timestamptz 'epoch');
    v_buckets := ceil(extract(epoch FROM to_ts - v_lo) / v_secs)::bigint;
    IF cardinality(asset_ids)::bigint * cardinality(metric_names) * v_buckets > c_max_rows THEN
        RAISE EXCEPTION 'telemetry_changes: % buckets of % series is more than % rows; choose a wider bucket or fewer series',
              v_buckets, cardinality(asset_ids)::bigint * cardinality(metric_names), c_max_rows USING ERRCODE = '22023';
    END IF;
    -- The 1-minute rollup seeds from the day before the bucket, telemetry_1h from before that.
    v_back := date_bin(interval '1 hour', v_lo - interval '1 day', timestamptz 'epoch');

    -- Retention drops raw telemetry a whole chunk at a time, oldest first, so raw is complete from
    -- its oldest reading on.
    SELECT min(t."time") INTO v_horizon FROM timescale.telemetry t;

    -- How many readings each series holds over the window's buckets, from the 1-minute rollup.
    EXECUTE $q$
      SELECT array_agg(o.asset_id), array_agg(o.metric_name), array_agg(o.n)
        FROM (SELECT t.asset_id, t.metric_name, sum(t.n_rows)::bigint AS n
                FROM timescale.telemetry_1m t
               WHERE t.bucket >= $1 AND t.bucket < $2
                 AND t.asset_id = ANY ($3::text[]) AND t.metric_name = ANY ($4::text[])
               GROUP BY 1, 2) o
    $q$
    INTO v_caid, v_cmname, v_cn
    USING v_lo, to_ts, asset_ids, metric_names;

    -- Each series' last value in the day before the bucket holding from_ts, in one query.
    EXECUTE $q$
      SELECT array_agg(o.asset_id), array_agg(o.metric_name), array_agg(o.s), array_agg(o.b)
        FROM (SELECT t.asset_id, t.metric_name,
                     (array_agg(t.last_string ORDER BY t.bucket DESC) FILTER (WHERE t.last_string IS NOT NULL))[1] AS s,
                     (array_agg(t.last_bool   ORDER BY t.bucket DESC) FILTER (WHERE t.last_bool IS NOT NULL))[1] AS b
                FROM timescale.telemetry_1m t
               WHERE t.bucket >= $1 AND t.bucket < $2
                 AND t.asset_id = ANY ($3::text[]) AND t.metric_name = ANY ($4::text[])
                 AND (t.last_string IS NOT NULL OR t.last_bool IS NOT NULL)
               GROUP BY 1, 2) o
    $q$
    INTO v_said, v_smname, v_ss, v_sb
    USING v_back, v_lo, asset_ids, metric_names;

    FOR v_pair IN
        SELECT DISTINCT a.aid, m.mname
          FROM unnest(asset_ids) AS a(aid) CROSS JOIN unnest(metric_names) AS m(mname)
         ORDER BY 1, 2
    LOOP
        asset_id := v_pair.aid;
        metric_name := v_pair.mname;
        read := NULL; change_ts := NULL; val_string := NULL; val_bool := NULL;
        carried_string := NULL; carried_bool := NULL; n_changes := NULL;
        marked_ts := NULL; marked_values := NULL; raw_from := v_horizon;

        -- Readings of the series that raw no longer holds, in the window: the rollups keep them.
        -- Buckets before the hour holding the oldest raw reading, which a chunk ends on.
        IF v_horizon IS NULL OR from_ts < v_horizon THEN
            v_lost_to := CASE WHEN v_horizon IS NULL THEN to_ts
                              ELSE least(date_bin(interval '1 hour', v_horizon, timestamptz 'epoch'), to_ts) END;
            v_lost := false;
            IF date_bin(interval '1 hour', from_ts, timestamptz 'epoch') < v_lost_to THEN
                EXECUTE $q$
                  SELECT EXISTS (SELECT 1 FROM timescale.telemetry_1h t
                                  WHERE t.asset_id = $1 AND t.metric_name = $2 AND t.bucket >= $3 AND t.bucket < $4)
                $q$
                INTO v_lost
                USING v_pair.aid, v_pair.mname, date_bin(interval '1 hour', from_ts, timestamptz 'epoch'), v_lost_to;
            END IF;
            IF v_lost THEN
                read := 'retention';
                RETURN NEXT;
                CONTINUE;
            END IF;
        END IF;

        SELECT k.n INTO v_n
          FROM unnest(v_caid, v_cmname, v_cn) AS k(aid, mname, n)
         WHERE k.aid = v_pair.aid AND k.mname = v_pair.mname;
        v_n := coalesce(v_n, 0);

        IF v_n > c_max_readings THEN
            read := 'reading_cap';
            -- Each bucket's distinct values, counted on the historian; a bucket of one comes back as none.
            IF v_n <= c_max_counted THEN
                EXECUTE $q$
                  SELECT array_agg(o.b ORDER BY o.b), array_agg(greatest(o.ns, o.nb)::integer ORDER BY o.b)
                    FROM (SELECT date_bin($5, t."time", timestamptz 'epoch') AS b,
                                 count(DISTINCT t.val_string) AS ns, count(DISTINCT t.val_bool) AS nb
                            FROM timescale.telemetry t
                           WHERE t.asset_id = $1 AND t.metric_name = $2 AND t."time" >= $3 AND t."time" < $4
                           GROUP BY 1
                          HAVING count(DISTINCT t.val_string) > 1 OR count(DISTINCT t.val_bool) > 1) o
                $q$
                INTO marked_ts, marked_values
                USING v_pair.aid, v_pair.mname, v_lo, to_ts, v_step;
            END IF;
            RETURN NEXT;
            CONTINUE;
        END IF;

        -- One remote read of the series from the bucket holding from_ts. lag() runs here over its
        -- rows: the newest before from_ts is the value carried in, and each bucket's marks count
        -- from them all.
        EXECUTE $q$
          WITH raw AS MATERIALIZED (
            SELECT t."time" AS ts, t.val_string AS s, t.val_bool AS b
              FROM timescale.telemetry t
             WHERE t.asset_id = $1 AND t.metric_name = $2 AND t."time" >= $3 AND t."time" < $4
          ),
          inside AS (
            SELECT r.ts, r.s, r.b, lag(r.s) OVER w AS ps, lag(r.b) OVER w AS pb, row_number() OVER w AS i
              FROM raw r
             WHERE r.ts >= $5
            WINDOW w AS (ORDER BY r.ts)
          ),
          kept AS (
            SELECT k.ts, k.s, k.b FROM inside k WHERE k.i = 1 OR (k.s, k.b) IS DISTINCT FROM (k.ps, k.pb)
          ),
          before AS (
            SELECT r.s, r.b FROM raw r WHERE r.ts < $5 ORDER BY r.ts DESC LIMIT 1
          ),
          marks AS (
            SELECT date_bin($6, r.ts, timestamptz 'epoch') AS mb,
                   greatest(count(DISTINCT r.s), count(DISTINCT r.b))::integer AS nv
              FROM raw r
             GROUP BY 1
          )
          SELECT (SELECT count(*) FROM kept)::integer,
                 (SELECT array_agg(k.ts ORDER BY k.ts) FROM kept k),
                 (SELECT array_agg(k.s ORDER BY k.ts) FROM kept k),
                 (SELECT array_agg(k.b ORDER BY k.ts) FROM kept k),
                 EXISTS (SELECT 1 FROM before),
                 (SELECT x.s FROM before x),
                 (SELECT x.b FROM before x),
                 (SELECT array_agg(m.mb ORDER BY m.mb) FROM marks m WHERE m.nv > 1),
                 (SELECT array_agg(m.nv ORDER BY m.mb) FROM marks m WHERE m.nv > 1)
        $q$
        INTO n_changes, change_ts, val_string, val_bool, v_has_seed, v_seed_s, v_seed_b, marked_ts, marked_values
        USING v_pair.aid, v_pair.mname, v_lo, to_ts, from_ts, v_step;

        IF n_changes > max_changes THEN
            read := 'change_cap';
            change_ts := NULL; val_string := NULL; val_bool := NULL;
            RETURN NEXT;
            CONTINUE;
        END IF;

        read := 'changes';
        marked_ts := NULL; marked_values := NULL;
        IF v_has_seed THEN
            carried_string := v_seed_s; carried_bool := v_seed_b;
        ELSE
            SELECT k.s, k.b INTO carried_string, carried_bool
              FROM unnest(v_said, v_smname, v_ss, v_sb) AS k(aid, mname, s, b)
             WHERE k.aid = v_pair.aid AND k.mname = v_pair.mname;
            GET DIAGNOSTICS v_found = ROW_COUNT;
            IF v_found = 0 THEN
                EXECUTE $q$
                  SELECT (array_agg(t.last_string ORDER BY t.bucket DESC) FILTER (WHERE t.last_string IS NOT NULL))[1],
                         (array_agg(t.last_bool   ORDER BY t.bucket DESC) FILTER (WHERE t.last_bool IS NOT NULL))[1]
                    FROM timescale.telemetry_1h t
                   WHERE t.asset_id = $1 AND t.metric_name = $2 AND t.bucket < $3
                $q$
                INTO carried_string, carried_bool
                USING v_pair.aid, v_pair.mname, v_back;
            END IF;
        END IF;
        RETURN NEXT;
    END LOOP;
END;
$fn$;

ALTER FUNCTION public.telemetry_changes(timestamp with time zone, timestamp with time zone, interval, text[], text[], integer)
    OWNER TO postgres;

COMMENT ON FUNCTION public.telemetry_changes(timestamp with time zone, timestamp with time zone, interval, text[], text[], integer) IS
  'History''s read of a text or a flag: one row per series (asset and metric). read is changes '
  '(every change in the window from raw telemetry, each at its time, and the value carried in), '
  'change_cap (more than max_changes), reading_cap (more than 20,000 readings) or retention (raw '
  'dropped inside the window). Past a cap, marked_ts and marked_values name the buckets that held '
  'more than one value. Runs as the caller (0254).';

-- -------------------------------------------------------------------------------------------------
-- 2. Who may call it: whoever may read the telemetry views
-- -------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.telemetry_changes(timestamp with time zone, timestamp with time zone, interval, text[], text[], integer)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.telemetry_changes(timestamp with time zone, timestamp with time zone, interval, text[], text[], integer)
    TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn CONSTANT text := 'public.telemetry_changes(timestamp with time zone, timestamp with time zone, interval, text[], text[], integer)';
  v_forms integer;
  v_bad text;
BEGIN
  SELECT count(*) INTO v_forms
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'telemetry_changes';
  IF v_forms <> 1 THEN
    RAISE EXCEPTION '0254: telemetry_changes is declared % times, not once', v_forms;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                  AND NOT prosecdef AND provolatile = 's' AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0254: % is not a STABLE SECURITY INVOKER function with its search_path pinned', v_fn;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0254: anon may execute %', v_fn;
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0254: authenticated and service_role must execute %, as they read the telemetry views', v_fn;
  END IF;

  -- The refusals come before any read, so they hold on a stack with no historian.
  FOREACH v_bad IN ARRAY ARRAY['window', 'bucket', 'series', 'many', 'cap', 'size'] LOOP
    BEGIN
      CASE v_bad
        WHEN 'window' THEN PERFORM public.telemetry_changes(now(), now() - interval '1 hour', interval '5 minutes', '{a}', '{m}');
        WHEN 'bucket' THEN PERFORM public.telemetry_changes(now() - interval '1 hour', now(), interval '30 seconds', '{a}', '{m}');
        WHEN 'series' THEN PERFORM public.telemetry_changes(now() - interval '1 hour', now(), interval '5 minutes', NULL, '{m}');
        WHEN 'many' THEN PERFORM public.telemetry_changes(now() - interval '1 hour', now(), interval '5 minutes', '{a,b}',
                                                           array(SELECT 'm' || g FROM generate_series(1, 26) g));
        WHEN 'cap' THEN PERFORM public.telemetry_changes(now() - interval '1 hour', now(), interval '5 minutes', '{a}', '{m}', 5001);
        ELSE PERFORM public.telemetry_changes(now() - interval '1 year', now(), interval '1 minute', '{a}', '{m}');
      END CASE;
      RAISE EXCEPTION '0254: telemetry_changes() accepted a bad %', v_bad USING ERRCODE = 'P0001';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
