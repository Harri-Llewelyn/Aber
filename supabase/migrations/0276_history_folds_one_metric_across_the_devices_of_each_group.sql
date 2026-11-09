-- 0276: History folds one metric across the devices of each group, for the Area tab's cells.
--
-- telemetry_carried_by_group(from_ts, to_ts, bucket, asset_ids, group_keys, metric_name) returns one
-- row per group per bucket: the metric's mean across the group's devices, and its total. A group is
-- a cell of the area, named by the key paired with each device (asset_ids[i] is in group_keys[i]).
-- It reads telemetry_carried() for every device in one call, so a quiet bucket counts as the value
-- carried into it, and folds the rows where the read is made: what reaches the browser is groups
-- times buckets, not devices times buckets.
--
--   * `mean_double` is the mean of the devices that have a value in the bucket, carried or
--     measured. A device with none is left out of it, and `with_value` says how many were in.
--   * `total_double` is the sum, and only for a bucket in which EVERY device of the group has a
--     value. Otherwise it is null: a partial sum reads as a real one. `members` is the group's
--     devices as they were asked for, so `with_value = members` is exactly when the total is there.
--   * `measured` is how many of those devices had a reading in the bucket rather than a carried
--     value, so a bucket nobody reported in can be drawn as carried.
--   * A device that never reports the metric has no value in any bucket, so its group has no
--     total. Ask only for the devices that report it.
--   * A text or a flag metric has no `avg_double`, so it has no row.
--   * It refuses what telemetry_carried() refuses (more than 50,000 devices times buckets, bad
--     bounds and buckets), two lists of different lengths, and a missing list or metric, before
--     anything is read.
--   * It runs as the caller, as the telemetry views do.
--
-- Reasoning: supabase/README.md, "History folds one metric across the devices of each group (0276)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The read
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.telemetry_carried_by_group(
    from_ts timestamp with time zone,
    to_ts timestamp with time zone,
    bucket interval,
    asset_ids text[],
    group_keys text[],
    metric_name text
) RETURNS TABLE (
    group_key text,
    bucket_ts timestamp with time zone,
    mean_double double precision,
    total_double double precision,
    members integer,
    with_value integer,
    measured integer
)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
BEGIN
    IF asset_ids IS NULL OR group_keys IS NULL OR metric_name IS NULL THEN
        RAISE EXCEPTION 'telemetry_carried_by_group: name the assets, the group of each and the metric'
              USING ERRCODE = '22023';
    END IF;
    IF cardinality(asset_ids) <> cardinality(group_keys) THEN
        RAISE EXCEPTION 'telemetry_carried_by_group: % assets but % group keys; name one group for each asset',
              cardinality(asset_ids), cardinality(group_keys) USING ERRCODE = '22023';
    END IF;

    -- telemetry_carried() checks the bounds, the bucket and the size before it reads anything.
    RETURN QUERY
    WITH pairs AS (
        SELECT DISTINCT g.aid, g.gk FROM unnest(asset_ids, group_keys) AS g(aid, gk)
    ),
    sizes AS (
        SELECT p.gk, count(*)::integer AS n FROM pairs p GROUP BY p.gk
    ),
    series AS (
        SELECT c.bucket_ts AS b, c.asset_id AS aid, c.avg_double AS v, c.is_carried AS carried
          FROM public.telemetry_carried(from_ts, to_ts, bucket, asset_ids, ARRAY[metric_name]) c
         WHERE c.avg_double IS NOT NULL
    )
    SELECT p.gk,
           s.b,
           avg(s.v),
           CASE WHEN count(*) = z.n THEN sum(s.v) END,
           z.n,
           count(*)::integer,
           count(*) FILTER (WHERE NOT s.carried)::integer
      FROM series s
      JOIN pairs p ON p.aid = s.aid
      JOIN sizes z ON z.gk = p.gk
     GROUP BY p.gk, s.b, z.n
     ORDER BY 1, 2;
END;
$fn$;

ALTER FUNCTION public.telemetry_carried_by_group(timestamp with time zone, timestamp with time zone, interval, text[], text[], text)
    OWNER TO postgres;

COMMENT ON FUNCTION public.telemetry_carried_by_group(timestamp with time zone, timestamp with time zone, interval, text[], text[], text) IS
  'History''s group read: one row per group of devices per bucket, for one numeric metric, from '
  'telemetry_carried(). mean_double is the mean of the devices with a value in the bucket; '
  'total_double is their sum, only where every device of the group has one. A text or a flag '
  'metric has no row. Refuses what telemetry_carried() refuses and two lists of different '
  'lengths. Runs as the caller (0276).';

-- -------------------------------------------------------------------------------------------------
-- 2. Who may call it: whoever may read the telemetry views
-- -------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.telemetry_carried_by_group(timestamp with time zone, timestamp with time zone, interval, text[], text[], text)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.telemetry_carried_by_group(timestamp with time zone, timestamp with time zone, interval, text[], text[], text)
    TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn CONSTANT text := 'public.telemetry_carried_by_group(timestamp with time zone, timestamp with time zone, interval, text[], text[], text)';
  v_forms integer;
  v_bad text;
BEGIN
  SELECT count(*) INTO v_forms
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'telemetry_carried_by_group';
  IF v_forms <> 1 THEN
    RAISE EXCEPTION '0276: telemetry_carried_by_group is declared % times, not once', v_forms;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                  AND NOT prosecdef AND provolatile = 's' AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0276: % is not a STABLE SECURITY INVOKER function with its search_path pinned', v_fn;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0276: anon may execute %', v_fn;
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0276: authenticated and service_role must execute %, as they read the telemetry views', v_fn;
  END IF;

  -- The refusals come before any read, so they hold on a stack with no historian.
  FOREACH v_bad IN ARRAY ARRAY['window', 'bucket', 'assets', 'groups', 'metric', 'lengths', 'size'] LOOP
    BEGIN
      CASE v_bad
        WHEN 'window' THEN PERFORM public.telemetry_carried_by_group(now(), now() - interval '1 hour', interval '5 minutes', '{a}', '{g}', 'm');
        WHEN 'bucket' THEN PERFORM public.telemetry_carried_by_group(now() - interval '1 hour', now(), interval '30 seconds', '{a}', '{g}', 'm');
        WHEN 'assets' THEN PERFORM public.telemetry_carried_by_group(now() - interval '1 hour', now(), interval '5 minutes', NULL, '{g}', 'm');
        WHEN 'groups' THEN PERFORM public.telemetry_carried_by_group(now() - interval '1 hour', now(), interval '5 minutes', '{a}', NULL, 'm');
        WHEN 'metric' THEN PERFORM public.telemetry_carried_by_group(now() - interval '1 hour', now(), interval '5 minutes', '{a}', '{g}', NULL);
        WHEN 'lengths' THEN PERFORM public.telemetry_carried_by_group(now() - interval '1 hour', now(), interval '5 minutes', '{a,b}', '{g}', 'm');
        ELSE PERFORM public.telemetry_carried_by_group(now() - interval '1 year', now(), interval '1 minute', '{a}', '{g}', 'm');
      END CASE;
      RAISE EXCEPTION '0276: telemetry_carried_by_group() accepted a bad %', v_bad USING ERRCODE = 'P0001';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
