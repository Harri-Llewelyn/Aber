-- 0279: An export of readings is checked, bounded and recorded in the database.
--
-- export_telemetry(from_ts, to_ts, asset_ids, metric_names, resolution) is the only way the
-- dashboard exports readings: the Device, Overview and Cell views of History each call it. It
-- returns one jsonb document, the rows and what is true of them, which the browser writes as a CSV.
--
--   * It refuses, before it reads anything: a caller who is not an Administrator or a Shopfloor
--     Manager (42501), a session that has not given its second factor while that is required
--     (0251), a window that does not end after it starts or is longer than history.export_max_days
--     (0278, 22023, naming the limit and where it is set), an unknown resolution, no device or no
--     metric, and more than 1,000 devices or 500 metrics (22023).
--   * resolution is raw, or the bucket of one of the historian's rollups: 1m, 5m or 1h. A rollup is
--     never read in raw's place. A row is one reading: its time, device, metric, value and unit.
--     Raw rows carry the reading as published; a rollup's carry the bucket's start and its average,
--     or its last value for a text or a flag, which have no average.
--   * It returns at most 50,000 rows. Past that it returns the readings up to a minute and says so:
--     truncated, with the time its rows end (read_to). postgres_fdw sends a LIMIT only under its row
--     estimate, so a read naming devices and metrics brings every row inside its time bound across
--     the wrapper first. The read is therefore bounded by time instead: the rollup's own count of
--     what each hour holds, then each minute of the hour that does not fit, names the stretch that
--     does, and the historian is asked for that stretch alone.
--   * Raw is read from the oldest reading the historian still holds. A window that starts before it
--     is read from there, and says where (read_from, raw_from), as the raw retention is shorter than
--     the rollups'.
--   * An export that returns rows writes one TELEMETRY_EXPORTED row in the Audit Trail, in the
--     asset lane, naming who exported, the devices and metrics, the window, the resolution and how
--     many rows left, and the id of that row comes back with them (audit_id). One that returns
--     none writes none: nothing left the site.
--
-- This bounds the export, not access to the readings: an Operator still reads whatever a chart
-- reads, through the views and functions it always has. The classifier rules for the new action are
-- in 0232 and 0249, where those functions are declared.
--
-- Reasoning: supabase/README.md, "An export of readings is checked, bounded and recorded (0279)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The export
-- -------------------------------------------------------------------------------------------------
-- SECURITY DEFINER: it writes audit_trail, which no application role may. The role check is the
-- first statement, and it names the two roles as every writer here does (mirror check 90). The
-- readings are read as the owner through the same foreign tables the telemetry views read, behind
-- the same FOR PUBLIC mapping, so what it reads is what an Administrator or a Shopfloor Manager may
-- read there.
CREATE OR REPLACE FUNCTION public.export_telemetry(
    from_ts timestamp with time zone,
    to_ts timestamp with time zone,
    asset_ids text[],
    metric_names text[],
    resolution text DEFAULT 'raw'
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET extra_float_digits TO 1
    AS $fn$
DECLARE
    c_max_rows    CONSTANT integer := 50000;
    c_max_assets  CONSTANT integer := 1000;
    c_max_metrics CONSTANT integer := 500;
    c_iso         CONSTANT text := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
    v_uid       uuid := auth.uid();
    v_days      numeric;
    v_assets    text[];
    v_metrics   text[];
    v_res       text;
    v_count_rel text;
    v_weight    text;
    v_read_rel  text;
    v_time_col  text;
    v_value     text;
    v_raw_from  timestamp with time zone;
    v_lo        timestamp with time zone;
    v_cut       timestamp with time zone;
    v_truncated boolean := false;
    v_hours     timestamp with time zone[];
    v_hour_n    bigint[];
    v_mins      timestamp with time zone[];
    v_min_n     bigint[];
    v_total     bigint := 0;
    v_rows      jsonb := '[]'::jsonb;
    v_n         bigint := 0;
    v_edge      text;
    v_devices   jsonb;
    v_audit_id  bigint;
    v_stopped   boolean;
BEGIN
    IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
        RAISE EXCEPTION 'Only an Administrator or a Shopfloor Manager may export readings.'
              USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.require_mfa();

    IF from_ts IS NULL OR to_ts IS NULL OR to_ts <= from_ts THEN
        RAISE EXCEPTION 'An export window must end after it starts.' USING ERRCODE = '22023';
    END IF;
    v_days := public.telemetry_export_max_days();
    IF to_ts - from_ts > make_interval(secs => v_days::double precision * 86400.0) THEN
        RAISE EXCEPTION 'An export can cover at most % %, set on Settings › History. This window is % days.',
              trim_scale(v_days), CASE WHEN v_days = 1 THEN 'day' ELSE 'days' END,
              ceil(extract(epoch FROM to_ts - from_ts) / 86400.0)::bigint
              USING ERRCODE = '22023';
    END IF;
    v_res := coalesce(resolution, '');
    IF NOT v_res = ANY (ARRAY['raw', '1m', '5m', '1h']) THEN
        RAISE EXCEPTION 'The resolution is raw, 1m, 5m or 1h, not %.', quote_literal(resolution)
              USING ERRCODE = '22023';
    END IF;
    v_assets := ARRAY(SELECT DISTINCT btrim(a.x) FROM unnest(asset_ids) AS a(x)
                       WHERE a.x IS NOT NULL AND btrim(a.x) <> '' ORDER BY 1);
    v_metrics := ARRAY(SELECT DISTINCT btrim(m.x) FROM unnest(metric_names) AS m(x)
                        WHERE m.x IS NOT NULL AND btrim(m.x) <> '' ORDER BY 1);
    IF cardinality(v_assets) = 0 OR cardinality(v_metrics) = 0 THEN
        RAISE EXCEPTION 'An export names at least one device and one metric.' USING ERRCODE = '22023';
    END IF;
    IF cardinality(v_assets) > c_max_assets OR cardinality(v_metrics) > c_max_metrics THEN
        RAISE EXCEPTION 'An export names at most % devices and % metrics, not % and %.',
              c_max_assets, c_max_metrics, cardinality(v_assets), cardinality(v_metrics)
              USING ERRCODE = '22023';
    END IF;

    -- What is counted, and what is read. Raw is counted by the 1-minute rollup's readings; a
    -- rollup is counted by its own rows.
    IF v_res = 'raw' THEN
        v_count_rel := 'telemetry_1m'; v_weight := 'sum(t.n_rows)::bigint';
        v_read_rel := 'telemetry'; v_time_col := '"time"';
        v_value := 'coalesce(to_jsonb(t.val_double), to_jsonb(t.val_string), to_jsonb(t.val_bool))';
        -- Raw is dropped a chunk at a time, oldest first, so it is whole from its oldest reading on.
        SELECT min(t."time") INTO v_raw_from FROM timescale.telemetry t;
        v_lo := least(greatest(from_ts, coalesce(v_raw_from, to_ts)), to_ts);
    ELSE
        v_count_rel := 'telemetry_' || v_res; v_weight := 'count(*)';
        v_read_rel := v_count_rel; v_time_col := 'bucket';
        v_value := 'coalesce(to_jsonb(t.sum_double / nullif(t.n_double, 0)::double precision), '
                   'to_jsonb(t.last_string), to_jsonb(t.last_bool))';
        v_lo := from_ts;
    END IF;
    v_cut := to_ts;

    IF v_lo < to_ts THEN
        -- How many rows each hour of the window holds, in one remote aggregate.
        EXECUTE format($q$
          SELECT array_agg(o.h ORDER BY o.h), array_agg(o.n ORDER BY o.h)
            FROM (SELECT date_bin($5, t.bucket, timestamptz 'epoch') AS h, %s AS n
                    FROM timescale.%I t
                   WHERE t.bucket >= $1 AND t.bucket < $2
                     AND t.asset_id = ANY ($3::text[]) AND t.metric_name = ANY ($4::text[])
                   GROUP BY 1) o
        $q$, v_weight, v_count_rel)
        INTO v_hours, v_hour_n
        USING date_bin(interval '1 minute', v_lo, timestamptz 'epoch'), to_ts, v_assets, v_metrics, interval '1 hour';

        FOR i IN 1 .. coalesce(cardinality(v_hours), 0) LOOP
            IF v_total + v_hour_n[i] > c_max_rows THEN
                -- This hour does not fit whole: take the minutes of it that do, and stop there.
                v_truncated := true;
                v_cut := greatest(v_hours[i], v_lo);
                EXECUTE format($q$
                  SELECT array_agg(o.h ORDER BY o.h), array_agg(o.n ORDER BY o.h)
                    FROM (SELECT date_bin($5, t.bucket, timestamptz 'epoch') AS h, %s AS n
                            FROM timescale.%I t
                           WHERE t.bucket >= $1 AND t.bucket < $2
                             AND t.asset_id = ANY ($3::text[]) AND t.metric_name = ANY ($4::text[])
                           GROUP BY 1) o
                $q$, v_weight, v_count_rel)
                INTO v_mins, v_min_n
                USING greatest(v_hours[i], date_bin(interval '1 minute', v_lo, timestamptz 'epoch')),
                      least(v_hours[i] + interval '1 hour', to_ts), v_assets, v_metrics, interval '1 minute';
                v_stopped := false;
                FOR j IN 1 .. coalesce(cardinality(v_mins), 0) LOOP
                    IF v_total + v_min_n[j] > c_max_rows THEN
                        v_cut := greatest(v_mins[j], v_lo);
                        v_stopped := true;
                        EXIT;
                    END IF;
                    v_total := v_total + v_min_n[j];
                END LOOP;
                -- Every minute fit: what was counted a moment ago has changed, and the hour is whole.
                IF NOT v_stopped THEN
                    v_cut := least(v_hours[i] + interval '1 hour', to_ts);
                END IF;
                EXIT;
            END IF;
            v_total := v_total + v_hour_n[i];
        END LOOP;
    END IF;

    IF v_lo < v_cut THEN
        -- One remote read of the stretch the counts say fits. The LIMIT trims here, after the rows
        -- have crossed, and only guards a count that was short: the rollup is read as it was a
        -- moment before. The unit is the catalogue's. A number is written as the shortest text that
        -- reads back as the same double, whatever the session's extra_float_digits.
        EXECUTE format($q$
          WITH u AS (
            SELECT c.name, c.units FROM public.metric_catalog c WHERE c.name = ANY ($5::text[])
          ),
          r AS (
            SELECT t.%s AS ts, t.asset_id AS aid, t.metric_name AS mname, %s AS v
              FROM timescale.%I t
             WHERE t.%s >= $1 AND t.%s < $2
               AND t.asset_id = ANY ($3::text[]) AND t.metric_name = ANY ($4::text[])
             ORDER BY t.%s, t.asset_id, t.metric_name
             LIMIT $6
          )
          SELECT coalesce(jsonb_agg(jsonb_build_array(to_char(r.ts AT TIME ZONE 'UTC', %L), r.aid, r.mname, r.v,
                                                      u.units)
                                    ORDER BY r.ts, r.aid, r.mname), '[]'::jsonb),
                 count(*)
            FROM r LEFT JOIN u ON u.name = r.mname
        $q$, v_time_col, v_value, v_read_rel, v_time_col, v_time_col, v_time_col, c_iso)
        INTO v_rows, v_n
        USING v_lo, v_cut, v_assets, v_metrics, v_metrics, c_max_rows + 1;

        IF v_n > c_max_rows THEN
            -- A count that was short: the extra row is not exported, and the rows end where it began.
            v_edge := v_rows -> c_max_rows ->> 0;
            v_rows := v_rows - c_max_rows;
            v_n := c_max_rows;
            v_truncated := true;
            v_cut := v_edge::timestamp with time zone;
        END IF;
    END IF;

    IF v_n > 0 THEN
        v_devices := coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.aid, 'name', d.name)
                                                ORDER BY coalesce(d.name, a.aid), a.aid)
                                 FROM unnest(v_assets) AS a(aid)
                                 LEFT JOIN public.devices d ON d.sparkplug_id = a.aid), '[]'::jsonb);
        -- `name` labels the lane, as every audit row's does. The window and the cut are in UTC to
        -- the millisecond, whatever the session's zone.
        INSERT INTO public.audit_trail (
            entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
            causation_id, recorded_at
        ) VALUES (
            'telemetry', md5('telemetry:readings')::uuid, 'TELEMETRY_EXPORTED', NULL,
            jsonb_build_object(
                'name', 'Readings',
                'devices', v_devices,
                'metrics', to_jsonb(v_metrics),
                'from', to_char(from_ts AT TIME ZONE 'UTC', c_iso),
                'to', to_char(to_ts AT TIME ZONE 'UTC', c_iso),
                'resolution', v_res,
                'rows', v_n,
                'truncated', v_truncated,
                'read_to', to_char(v_cut AT TIME ZONE 'UTC', c_iso),
                'exported_by_email', nullif(auth.jwt() ->> 'email', '')),
            v_uid, public.audit_actor_source(), txid_current(), now()
        )
        RETURNING id INTO v_audit_id;
    END IF;

    RETURN jsonb_build_object(
        'audit_id', v_audit_id,
        'resolution', v_res,
        'columns', jsonb_build_array('time', 'asset_id', 'metric_name', 'value', 'unit'),
        'rows', v_rows,
        'row_count', v_n,
        'max_rows', c_max_rows,
        'truncated', v_truncated,
        'read_from', to_char(v_lo AT TIME ZONE 'UTC', c_iso),
        'read_to', to_char(v_cut AT TIME ZONE 'UTC', c_iso),
        'raw_from', to_char(v_raw_from AT TIME ZONE 'UTC', c_iso));
END;
$fn$;

ALTER FUNCTION public.export_telemetry(timestamp with time zone, timestamp with time zone, text[], text[], text)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.export_telemetry(timestamp with time zone, timestamp with time zone, text[], text[], text)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.export_telemetry(timestamp with time zone, timestamp with time zone, text[], text[], text)
    TO authenticated;

COMMENT ON FUNCTION public.export_telemetry(timestamp with time zone, timestamp with time zone, text[], text[], text) IS
  'Exports readings of asset_ids (Sparkplug ids) and metric_names over [from_ts, to_ts) as one '
  'jsonb document: columns, rows (time, asset_id, metric_name, value, unit), row_count, truncated, '
  'read_from, read_to, raw_from and audit_id. resolution is raw or the 1m, 5m or 1h rollup''s '
  'average, never one in place of another. An Administrator or a Shopfloor Manager only (42501), '
  'and a window no longer than history.export_max_days (22023). At most 50,000 rows: past that the '
  'rows end at read_to and truncated is true. Writes one TELEMETRY_EXPORTED row in the Audit Trail, '
  'and none when no row is returned (0279).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn CONSTANT text := 'public.export_telemetry(timestamp with time zone, timestamp with time zone, text[], text[], text)';
  v_forms integer;
  v_role  text;
BEGIN
  SELECT count(*) INTO v_forms
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'export_telemetry';
  IF v_forms <> 1 THEN
    RAISE EXCEPTION '0279: export_telemetry is declared % times, not once', v_forms;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                  AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0279: % is not SECURITY DEFINER with its search_path pinned', v_fn;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0279: % may execute %', v_role, v_fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0279: authenticated may not execute %; the dashboard calls it', v_fn;
  END IF;

  -- The rules for the action are 0232's and 0249's: the Audit Trail's lane and class for it.
  IF public.audit_domain_for('telemetry', 'TELEMETRY_EXPORTED') <> 'asset' THEN
    RAISE EXCEPTION '0279: audit_domain_for() files telemetry exports in the % lane; it must be asset',
      public.audit_domain_for('telemetry', 'TELEMETRY_EXPORTED');
  END IF;
  IF public.audit_event_class('TELEMETRY_EXPORTED', 'telemetry', 'asset', NULL, '{"name": "Readings"}') <> 'read' THEN
    RAISE EXCEPTION '0279: audit_event_class() does not answer read for TELEMETRY_EXPORTED';
  END IF;

  -- A request with no person behind it is refused before anything is read.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.export_telemetry(now() - interval '1 hour', now(), ARRAY['dev'], ARRAY['m']);
    RAISE EXCEPTION '0279: export_telemetry() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$check$;

NOTIFY pgrst, 'reload schema';
