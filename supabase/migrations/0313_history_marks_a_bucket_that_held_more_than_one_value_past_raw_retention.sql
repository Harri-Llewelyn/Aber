-- 0313: History marks a bucket that held more than one value past raw retention.
--
-- Past raw retention telemetry_changes() (0254) answered `retention` and marked nothing, so an hour
-- that flipped between two states read as if it held its last value throughout. The historian now
-- keeps state rollups beside the series rollups (timescaledb/aggregates.sql): telemetry_state_1m,
-- _5m and _1h hold each text or flag bucket's any_true, all_true, min_string and max_string.
--
--   * Three foreign tables, timescale.telemetry_state_1m, _5m and _1h, granted to authenticated
--     and service_role as the series rollups' are, and never to anon.
--   * The `retention` arm marks each bucket of `bucket` that held more than one value. A bucket
--     older than raw is marked from the state rollup of the widest width that divides the bucket,
--     as the bucket read takes the series rollups, and says only that: its marked_values entry
--     is NULL. A bucket raw holds whole is counted from raw, as past a cap. A bucket the state
--     rollups do not reach is not marked.
--   * Every other arm, bound and column is 0254's.
--
-- Reasoning: supabase/README.md, "History marks a bucket that held more than one value past raw
-- retention (0313)". Idempotent.
--
-- Redefines public.telemetry_changes: 0313's `retention` arm marks each bucket that held more than
--   one value, from the state rollups older than raw and from raw inside it; 0254's marked none

-- -------------------------------------------------------------------------------------------------
-- 1. The state rollups, over postgres_fdw
-- -------------------------------------------------------------------------------------------------
-- Read by telemetry_changes() as its caller. A foreign table persists across boots, so a changed
-- column needs a statement of its own here.
CREATE FOREIGN TABLE IF NOT EXISTS timescale.telemetry_state_1m (
    bucket timestamp with time zone NOT NULL,
    asset_id text NOT NULL,
    metric_name text NOT NULL,
    any_true boolean,
    all_true boolean,
    min_string text,
    max_string text,
    n_rows bigint
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'telemetry_state_1m'
);

CREATE FOREIGN TABLE IF NOT EXISTS timescale.telemetry_state_5m (
    bucket timestamp with time zone NOT NULL,
    asset_id text NOT NULL,
    metric_name text NOT NULL,
    any_true boolean,
    all_true boolean,
    min_string text,
    max_string text,
    n_rows numeric
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'telemetry_state_5m'
);

CREATE FOREIGN TABLE IF NOT EXISTS timescale.telemetry_state_1h (
    bucket timestamp with time zone NOT NULL,
    asset_id text NOT NULL,
    metric_name text NOT NULL,
    any_true boolean,
    all_true boolean,
    min_string text,
    max_string text,
    n_rows numeric
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'telemetry_state_1h'
);

ALTER FOREIGN TABLE timescale.telemetry_state_1m OWNER TO postgres;
ALTER FOREIGN TABLE timescale.telemetry_state_5m OWNER TO postgres;
ALTER FOREIGN TABLE timescale.telemetry_state_1h OWNER TO postgres;

REVOKE ALL ON TABLE timescale.telemetry_state_1m, timescale.telemetry_state_5m, timescale.telemetry_state_1h
    FROM PUBLIC, anon;
GRANT SELECT ON TABLE timescale.telemetry_state_1m, timescale.telemetry_state_5m, timescale.telemetry_state_1h
    TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 2. The read
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
    v_state    text;
    v_whole    timestamp with time zone;
    v_raw_ts   timestamp with time zone[];
    v_raw_n    integer[];
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
    -- Past raw, a bucket is marked from the state rollup whose width is the widest that divides
    -- it, as telemetry_carried() reads the series rollups.
    v_state := CASE WHEN v_secs % 3600 = 0 THEN 'telemetry_state_1h'
                    WHEN v_secs % 300 = 0 THEN 'telemetry_state_5m'
                    ELSE 'telemetry_state_1m' END;

    -- Retention drops raw telemetry a whole chunk at a time, oldest first, so raw is complete from
    -- its oldest reading on.
    SELECT min(t."time") INTO v_horizon FROM timescale.telemetry t;
    -- The first bucket raw holds whole: one starting at or after the hour holding the oldest raw
    -- reading, which a chunk ends on. Every bucket before it is past raw.
    v_whole := CASE WHEN v_horizon IS NULL THEN to_ts
                    ELSE date_bin(v_step, date_bin(interval '1 hour', v_horizon, timestamptz 'epoch') - interval '1 microsecond',
                                  timestamptz 'epoch') + v_step END;

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
                -- Each bucket past raw that held more than one value, said by its state rollup,
                -- which cannot say how many: its count is NULL. A text's flags and a flag's text
                -- are NULL, which drops a group as false does; with no coalesce() the historian
                -- evaluates the HAVING, so only the marked buckets cross.
                EXECUTE format($q$
                  SELECT array_agg(o.b ORDER BY o.b), array_agg(NULL::integer ORDER BY o.b)
                    FROM (SELECT date_bin($5, t.bucket, timestamptz 'epoch') AS b
                            FROM timescale.%I t
                           WHERE t.asset_id = $1 AND t.metric_name = $2 AND t.bucket >= $3 AND t.bucket < $4
                           GROUP BY 1
                          HAVING (bool_or(t.any_true) AND NOT bool_and(t.all_true))
                              OR min(t.min_string) <> max(t.max_string)) o
                $q$, v_state)
                INTO marked_ts, marked_values
                USING v_pair.aid, v_pair.mname, v_lo, least(v_whole, to_ts), v_step;
                -- Each bucket raw holds whole, counted from raw as past a cap.
                IF v_whole < to_ts THEN
                    EXECUTE $q$
                      SELECT coalesce(sum(t.n_rows), 0)::bigint FROM timescale.telemetry_1m t
                       WHERE t.asset_id = $1 AND t.metric_name = $2 AND t.bucket >= $3 AND t.bucket < $4
                    $q$
                    INTO v_n
                    USING v_pair.aid, v_pair.mname, v_whole, to_ts;
                    IF v_n BETWEEN 1 AND c_max_counted THEN
                        EXECUTE $q$
                          SELECT array_agg(o.b ORDER BY o.b), array_agg(greatest(o.ns, o.nb)::integer ORDER BY o.b)
                            FROM (SELECT date_bin($5, t."time", timestamptz 'epoch') AS b,
                                         count(DISTINCT t.val_string) AS ns, count(DISTINCT t.val_bool) AS nb
                                    FROM timescale.telemetry t
                                   WHERE t.asset_id = $1 AND t.metric_name = $2 AND t."time" >= $3 AND t."time" < $4
                                   GROUP BY 1
                                  HAVING count(DISTINCT t.val_string) > 1 OR count(DISTINCT t.val_bool) > 1) o
                        $q$
                        INTO v_raw_ts, v_raw_n
                        USING v_pair.aid, v_pair.mname, v_whole, to_ts, v_step;
                        marked_ts := marked_ts || v_raw_ts;
                        marked_values := marked_values || v_raw_n;
                    END IF;
                END IF;
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
  'dropped inside the window). Past a cap or retention, marked_ts and marked_values name the buckets '
  'that held more than one value and how many; NULL for a bucket older than raw, which the state '
  'rollups say held more than one, not how many. Runs as the caller (0254, 0313).';

-- -------------------------------------------------------------------------------------------------
-- 3. Who may call it: whoever may read the telemetry views
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
  v_table text;
  v_bad text;
BEGIN
  SELECT count(*) INTO v_forms
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'telemetry_changes';
  IF v_forms <> 1 THEN
    RAISE EXCEPTION '0313: telemetry_changes is declared % times, not once', v_forms;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                  AND NOT prosecdef AND provolatile = 's' AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0313: % is not a STABLE SECURITY INVOKER function with its search_path pinned', v_fn;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0313: anon may execute %', v_fn;
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0313: authenticated and service_role must execute %, as they read the telemetry views', v_fn;
  END IF;

  FOREACH v_table IN ARRAY ARRAY['timescale.telemetry_state_1m', 'timescale.telemetry_state_5m', 'timescale.telemetry_state_1h'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_foreign_table t WHERE t.ftrelid = to_regclass(v_table)) THEN
      RAISE EXCEPTION '0313: % is not a foreign table on the historian', v_table;
    END IF;
    IF has_table_privilege('anon', v_table, 'SELECT') THEN
      RAISE EXCEPTION '0313: anon may read %', v_table;
    END IF;
    IF NOT has_table_privilege('authenticated', v_table, 'SELECT')
       OR NOT has_table_privilege('service_role', v_table, 'SELECT') THEN
      RAISE EXCEPTION '0313: authenticated and service_role must read %, as telemetry_changes() reads it as its caller', v_table;
    END IF;
  END LOOP;

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
      RAISE EXCEPTION '0313: telemetry_changes() accepted a bad %', v_bad USING ERRCODE = 'P0001';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
