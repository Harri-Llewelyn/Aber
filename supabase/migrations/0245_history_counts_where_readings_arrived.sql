-- 0245: History's Overview counts where readings arrived, a device at a time, block by block.
--
-- telemetry_coverage(from_ts, to_ts, block, asset_ids) returns one row per device asked for: how
-- many readings it sent in each block of the window, over every metric, as an array, oldest block
-- first and 0 for a block with none. Block i starts at first_block + i * block_width. Each row also
-- says which stretch the counts cover (computed_from to computed_to): a block outside it is not
-- counted yet, which is not the same as one with no readings. The strip never shows a value.
--
--   * It reads the historian's rollups per device (telemetry_device_5m and _1h, timescaledb/
--     aggregates.sql) over postgres_fdw: one row a device a bucket, never raw telemetry.
--   * More than 40 devices read only those rollups' own widths, 5 minutes and 1 hour, unsummed:
--     nothing is grouped on the historian but each device's arrays. Up to 40 may take any whole
--     number of 5 minutes, summed from the widest rollup that divides it. Nothing finer: under 5
--     minutes only telemetry_1m could answer, whose real-time tail walks raw telemetry's index
--     for every device named.
--   * At most 1,000 devices, and 360,000 device-buckets read, refused before anything is read.
--   * It runs as the caller, as the telemetry views do.
--
-- Reasoning: supabase/README.md, "History counts where readings arrived (0245)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The read
-- -------------------------------------------------------------------------------------------------
-- The bounds and the list reach the historian as parameters, so postgres_fdw ships each WHERE and
-- its aggregate: array_agg() for a read at a rollup's own width, date_bin() and sum() for a summed
-- one. Each part is its own remote query, joined here. A device or block with no row has its 0.
CREATE OR REPLACE FUNCTION public.telemetry_coverage(
    from_ts timestamp with time zone,
    to_ts timestamp with time zone,
    block interval,
    asset_ids text[]
) RETURNS TABLE (
    asset_id text,
    first_block timestamp with time zone,
    block_width interval,
    counts integer[],
    computed_from timestamp with time zone,
    computed_to timestamp with time zone,
    complete boolean
)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
DECLARE
    -- One read's devices: the documented fleet.
    c_max_devices  CONSTANT integer := 1000;
    -- A selection this small may sum any block width, a year of days in about half a second; a
    -- larger one reads the rollups' own.
    c_small        CONSTANT integer := 40;
    -- Device-buckets one read may take from the historian: 1,000 devices over 26 hours of
    -- 5-minute buckets, or 40 over a year of hourly ones, with the stretch below.
    c_max_buckets  CONSTANT bigint := 360000;
    -- The most of the hourly rollup's refresh lag the 5-minute one fills. Past it, not counted yet.
    c_stitch       CONSTANT interval := INTERVAL '6 hours';
    v_ids    text[];
    v_secs   numeric;
    v_step   interval;
    v_from   timestamp with time zone;
    v_blocks integer;
    v_r5     timestamp with time zone;
    v_w5     timestamp with time zone;
    v_c5     boolean;
    v_r1     timestamp with time zone;
    v_w1     timestamp with time zone;
    v_c1     boolean;
    v_one_to timestamp with time zone;
    v_tail   timestamp with time zone;
    v_k      integer;
    v_cfrom  timestamp with time zone;
    v_cto    timestamp with time zone;
    v_done   boolean;
BEGIN
    IF from_ts IS NULL OR to_ts IS NULL OR to_ts <= from_ts THEN
        RAISE EXCEPTION 'telemetry_coverage: to_ts (%) must be after from_ts (%)', to_ts, from_ts
              USING ERRCODE = '22023';
    END IF;
    v_secs := extract(epoch FROM block);
    IF block IS NULL OR extract(year FROM block) <> 0 OR extract(month FROM block) <> 0
       OR v_secs < 300 OR v_secs % 300 <> 0 THEN
        RAISE EXCEPTION 'telemetry_coverage: block must be a whole number of 5 minutes, at least one, and no months; got %',
              block USING ERRCODE = '22023';
    END IF;
    IF asset_ids IS NULL THEN
        RAISE EXCEPTION 'telemetry_coverage: name the devices; each lane is one'
              USING ERRCODE = '22023';
    END IF;
    v_ids := ARRAY(SELECT DISTINCT a FROM unnest(asset_ids) AS a WHERE a IS NOT NULL ORDER BY a);
    IF cardinality(v_ids) > c_max_devices THEN
        RAISE EXCEPTION 'telemetry_coverage: % devices is more than % a read; read them in parts',
              cardinality(v_ids), c_max_devices USING ERRCODE = '22023';
    END IF;
    IF cardinality(v_ids) > c_small AND v_secs NOT IN (300, 3600) THEN
        RAISE EXCEPTION 'telemetry_coverage: % devices read 5-minute or 1-hour blocks only, not %; more than % are never summed on the historian',
              cardinality(v_ids), block, c_small USING ERRCODE = '22023';
    END IF;

    -- The buckets the read takes from the historian, at the block asked for: reading a window hourly
    -- instead, below, takes fewer. A plpgsql IF ends its condition at the first THEN, so the count
    -- is taken first.
    v_k := CASE WHEN v_secs % 3600 = 0
                THEN ceil(extract(epoch FROM to_ts - date_bin(INTERVAL '1 hour', from_ts, timestamptz 'epoch')) / 3600) + extract(epoch FROM c_stitch) / 300
                ELSE ceil(extract(epoch FROM to_ts - date_bin(INTERVAL '5 minutes', from_ts, timestamptz 'epoch')) / 300) END;
    IF cardinality(v_ids)::bigint * v_k > c_max_buckets THEN
        RAISE EXCEPTION 'telemetry_coverage: % devices over this window is more than % buckets to read; choose a shorter window or fewer devices',
              cardinality(v_ids), c_max_buckets USING ERRCODE = '22023';
    END IF;

    -- What each rollup holds: its reach and its watermark (timescaledb/aggregates.sql). A rollup
    -- the historian does not report holds nothing.
    SELECT c.computed_from, c.computed_to, c.complete INTO v_r5, v_w5, v_c5
      FROM timescale.telemetry_device_coverage c WHERE c.relation = 'telemetry_device_5m';
    SELECT c.computed_from, c.computed_to, c.complete INTO v_r1, v_w1, v_c1
      FROM timescale.telemetry_device_coverage c WHERE c.relation = 'telemetry_device_1h';
    v_r5 := coalesce(v_r5, 'infinity'); v_w5 := coalesce(v_w5, '-infinity');
    v_r1 := coalesce(v_r1, 'infinity'); v_w1 := coalesce(v_w1, '-infinity');

    -- A block under an hour over a window older than the 5-minute rollup reaches is read hourly,
    -- as block_width says.
    IF v_secs % 3600 <> 0 AND from_ts < v_r5 THEN
        v_secs := 3600;
    END IF;

    -- On the epoch grid, as the rollups' buckets are, so each source bucket falls in one block.
    -- In seconds, so a day is 24 hours in any session time zone, as date_bin() counts it.
    v_step := make_interval(secs => v_secs);
    v_from := date_bin(v_step, from_ts, timestamptz 'epoch');
    v_blocks := ceil(extract(epoch FROM to_ts - v_from) / v_secs)::integer;

    -- Under an hour: the 5-minute rollup alone, which covers the window by the rule above.
    IF v_secs % 3600 <> 0 THEN
        IF v_secs = 300 THEN
            RETURN QUERY EXECUTE $q$
              WITH obs AS MATERIALIZED (
                SELECT o.asset_id AS aid, array_agg(o.bucket ORDER BY o.bucket) AS bs, array_agg(o.n_rows ORDER BY o.bucket) AS ns
                  FROM timescale.telemetry_device_5m o
                 WHERE o.bucket >= $4 AND o.bucket < $2 AND o.asset_id = ANY ($5::text[])
                 GROUP BY 1
              )
              SELECT d.aid, $4, $3,
                     CASE WHEN obs.aid IS NULL THEN array_fill(0, ARRAY[$10])
                          WHEN cardinality(obs.bs) = $10 THEN obs.ns::integer[]
                          ELSE ARRAY(SELECT coalesce(x.n, 0)::integer
                                       FROM generate_series(0, $10 - 1) AS g(i)
                                       LEFT JOIN unnest(obs.bs, obs.ns) AS x(b, n) ON x.b = $4 + g.i * $3
                                      ORDER BY g.i)
                     END,
                     $7, $8, $9
                FROM unnest($5::text[]) AS d(aid)
                LEFT JOIN obs ON obs.aid = d.aid
               ORDER BY d.aid
            $q$
            USING from_ts, to_ts, v_step, v_from, v_ids, v_secs, v_r5, v_w5, v_c5, v_blocks;
        ELSE
            RETURN QUERY EXECUTE $q$
              WITH obs AS MATERIALIZED (
                SELECT o.asset_id AS aid, date_bin($3, o.bucket, timestamptz 'epoch') AS b, sum(o.n_rows) AS n
                  FROM timescale.telemetry_device_5m o
                 WHERE o.bucket >= $4 AND o.bucket < $2 AND o.asset_id = ANY ($5::text[])
                 GROUP BY 1, 2
              ),
              cells AS (
                SELECT obs.aid, (extract(epoch FROM obs.b - $4) / $6)::integer AS i, obs.n FROM obs
              )
              SELECT d.aid, $4, $3,
                     array_agg(least(coalesce(c.n, 0), 2147483647)::integer ORDER BY g.i),
                     $7, $8, $9
                FROM unnest($5::text[]) AS d(aid)
               CROSS JOIN generate_series(0, $10 - 1) AS g(i)
                LEFT JOIN cells c ON c.aid = d.aid AND c.i = g.i
               GROUP BY d.aid
               ORDER BY d.aid
            $q$
            USING from_ts, to_ts, v_step, v_from, v_ids, v_secs, v_r5, v_w5, v_c5, v_blocks;
        END IF;
        RETURN;
    END IF;

    -- An hour and longer: the hourly rollup up to its watermark, then the 5-minute one from there,
    -- summed to the block on the historian, for at most c_stitch and never before its reach. Each
    -- bucket is read from one of them, so no reading counts twice.
    v_one_to := LEAST(to_ts, v_w1);
    v_tail := GREATEST(v_from, v_w1, to_ts - c_stitch, v_r5);
    IF isfinite(v_tail) THEN
        -- On the hour, so the stretch starts on a block of the hourly grid.
        v_tail := date_bin(INTERVAL '1 hour', v_tail - INTERVAL '1 microsecond', timestamptz 'epoch') + INTERVAL '1 hour';
    END IF;
    -- What the read covers: one stretch from the hourly rollup's reach to the 5-minute one's
    -- watermark, or the part a gap between them leaves after it.
    IF v_tail < LEAST(to_ts, v_w5) THEN
        IF v_one_to > GREATEST(v_from, v_r1) AND v_one_to >= LEAST(v_tail, to_ts) THEN
            v_cfrom := v_r1; v_done := v_c1;
        ELSE
            v_cfrom := v_tail; v_done := false;
        END IF;
        v_cto := v_w5;
    ELSIF v_one_to > GREATEST(v_from, v_r1) THEN
        v_cfrom := v_r1; v_cto := v_w1; v_done := v_c1;
    ELSE
        v_cfrom := 'infinity'; v_cto := '-infinity'; v_done := false;
    END IF;

    IF v_secs = 3600 THEN
        -- The blocks before the 5-minute stretch come from the hourly rollup as arrays, a row a
        -- device; the few after it are laid on a small grid.
        v_k := LEAST(v_blocks, GREATEST(0, floor(extract(epoch FROM LEAST(v_tail, to_ts) - v_from) / 3600)::integer));
        IF v_tail >= to_ts THEN
            v_k := v_blocks;
        END IF;
        RETURN QUERY EXECUTE $q$
          WITH hourly AS MATERIALIZED (
            SELECT o.asset_id AS aid, array_agg(o.bucket ORDER BY o.bucket) AS bs, array_agg(o.n_rows ORDER BY o.bucket) AS ns
              FROM timescale.telemetry_device_1h o
             WHERE o.bucket >= $4 AND o.bucket < $11 AND o.asset_id = ANY ($5::text[])
             GROUP BY 1
          ),
          recent AS MATERIALIZED (
            SELECT o.asset_id AS aid, date_bin($3, o.bucket, timestamptz 'epoch') AS b, sum(o.n_rows) AS n
              FROM timescale.telemetry_device_5m o
             WHERE o.bucket >= $12 AND o.bucket < $2 AND o.asset_id = ANY ($5::text[])
             GROUP BY 1, 2
          ),
          tails AS (
            SELECT d.aid, array_agg(least(coalesce(r.n, 0), 2147483647)::integer ORDER BY g.i) AS arr
              FROM unnest($5::text[]) AS d(aid)
             CROSS JOIN generate_series($13, $10 - 1) AS g(i)
              LEFT JOIN recent r ON r.aid = d.aid AND r.b = $4 + g.i * $3
             GROUP BY d.aid
          )
          SELECT d.aid, $4, $3,
                 CASE WHEN $13 = 0 THEN '{}'::integer[]
                      WHEN h.aid IS NULL THEN array_fill(0, ARRAY[$13])
                      WHEN cardinality(h.bs) = $13 THEN h.ns::integer[]
                      ELSE ARRAY(SELECT coalesce(x.n, 0)::integer
                                   FROM generate_series(0, $13 - 1) AS g(i)
                                   LEFT JOIN unnest(h.bs, h.ns) AS x(b, n) ON x.b = $4 + g.i * $3
                                  ORDER BY g.i)
                 END || coalesce(t.arr, '{}'::integer[]),
                 $7, $8, $9
            FROM unnest($5::text[]) AS d(aid)
            LEFT JOIN hourly h ON h.aid = d.aid
            LEFT JOIN tails t ON t.aid = d.aid
           ORDER BY d.aid
        $q$
        USING from_ts, to_ts, v_step, v_from, v_ids, v_secs, v_cfrom, v_cto, v_done, v_blocks, v_one_to, v_tail, v_k;
        RETURN;
    END IF;

    -- Wider than an hour, for a small selection: both parts summed into the block, so a block the
    -- watermark falls inside takes each part once.
    RETURN QUERY EXECUTE $q$
      WITH hourly AS MATERIALIZED (
        SELECT o.asset_id AS aid, date_bin($3, o.bucket, timestamptz 'epoch') AS b, sum(o.n_rows) AS n
          FROM timescale.telemetry_device_1h o
         WHERE o.bucket >= $4 AND o.bucket < $11 AND o.asset_id = ANY ($5::text[])
         GROUP BY 1, 2
      ),
      recent AS MATERIALIZED (
        SELECT o.asset_id AS aid, date_bin($3, o.bucket, timestamptz 'epoch') AS b, sum(o.n_rows) AS n
          FROM timescale.telemetry_device_5m o
         WHERE o.bucket >= $12 AND o.bucket < $2 AND o.asset_id = ANY ($5::text[])
         GROUP BY 1, 2
      ),
      cells AS (
        SELECT u.aid, (extract(epoch FROM u.b - $4) / $6)::integer AS i, sum(u.n) AS n
          FROM (SELECT * FROM hourly UNION ALL SELECT * FROM recent) u
         GROUP BY 1, 2
      )
      SELECT d.aid, $4, $3,
             array_agg(least(coalesce(c.n, 0), 2147483647)::integer ORDER BY g.i),
             $7, $8, $9
        FROM unnest($5::text[]) AS d(aid)
       CROSS JOIN generate_series(0, $10 - 1) AS g(i)
        LEFT JOIN cells c ON c.aid = d.aid AND c.i = g.i
       GROUP BY d.aid
       ORDER BY d.aid
    $q$
    USING from_ts, to_ts, v_step, v_from, v_ids, v_secs, v_cfrom, v_cto, v_done, v_blocks, v_one_to, v_tail;
END;
$fn$;

ALTER FUNCTION public.telemetry_coverage(timestamp with time zone, timestamp with time zone, interval, text[])
    OWNER TO postgres;

COMMENT ON FUNCTION public.telemetry_coverage(timestamp with time zone, timestamp with time zone, interval, text[]) IS
  'History''s Overview read: one row per device, its readings in each block of the window over '
  'every metric as an array (oldest first, 0 for none), from the historian''s rollups per device, '
  'with the stretch they are counted over. Runs as the caller (0245).';

-- -------------------------------------------------------------------------------------------------
-- 2. Who may call it: whoever may read the telemetry views
-- -------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.telemetry_coverage(timestamp with time zone, timestamp with time zone, interval, text[])
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.telemetry_coverage(timestamp with time zone, timestamp with time zone, interval, text[])
    TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn CONSTANT text := 'public.telemetry_coverage(timestamp with time zone, timestamp with time zone, interval, text[])';
  v_forms integer;
  v_bad text;
  v_many text[] := ARRAY(SELECT 'd' || g FROM generate_series(1, 41) g);
BEGIN
  SELECT count(*) INTO v_forms
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'telemetry_coverage';
  IF v_forms <> 1 THEN
    RAISE EXCEPTION '0245: telemetry_coverage is declared % times, not once', v_forms;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                  AND NOT prosecdef AND provolatile = 's' AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0245: % is not a STABLE SECURITY INVOKER function with its search_path pinned', v_fn;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0245: anon may execute %', v_fn;
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0245: authenticated and service_role must execute %, as they read the telemetry views', v_fn;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_foreign_table t JOIN pg_class c ON c.oid = t.ftrelid
                  WHERE c.oid IN ('timescale.telemetry_device_5m'::regclass, 'timescale.telemetry_device_1h'::regclass)
                    AND 'fetch_size=10000' = ANY (t.ftoptions)
                 HAVING count(*) = 2) THEN
    RAISE EXCEPTION '0245: the device rollups'' foreign tables must fetch 10,000 rows at a time (0001)';
  END IF;

  -- The refusals come before any read, so they hold on a stack with no historian.
  FOREACH v_bad IN ARRAY ARRAY['window', 'block', 'devices', 'width', 'size'] LOOP
    BEGIN
      CASE v_bad
        WHEN 'window' THEN PERFORM public.telemetry_coverage(now(), now() - interval '1 hour', interval '5 minutes', '{a}');
        WHEN 'block' THEN PERFORM public.telemetry_coverage(now() - interval '1 hour', now(), interval '2 minutes', '{a}');
        WHEN 'devices' THEN PERFORM public.telemetry_coverage(now() - interval '1 hour', now(), interval '5 minutes', NULL);
        WHEN 'width' THEN PERFORM public.telemetry_coverage(now() - interval '1 hour', now(), interval '10 minutes', v_many);
        ELSE PERFORM public.telemetry_coverage(now() - interval '2000 days', now(), interval '1 hour', v_many);
      END CASE;
      RAISE EXCEPTION '0245: telemetry_coverage() accepted a bad %', v_bad USING ERRCODE = 'P0001';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
