-- 0296: An export saves a derived metric's values.
--
-- export_telemetry() (0279) read the historian's raw table or one of its rollups, and a derived
-- metric (0267) has no row in either: it is computed where it is read. The dashboard left it out of
-- the dialog. Now a name that is a derived metric is read through derived_series() (0282), the
-- function History and the evaluator read, so the file holds the numbers the chart shows.
--
--   * Every check 0279 made is made first and in its order: the roles, the second factor, the window
--     and history.export_max_days, the resolution, and the devices and metrics named. Then the 50,000
--     rows, and the one TELEMETRY_EXPORTED row in the Audit Trail, as before.
--   * A derived metric has no readings, only buckets, so it is never raw. Its bucket is the
--     resolution's: 1, 5 or 60 minutes, and one minute where the resolution is raw. A row is the
--     bucket's start and its value, as a rollup's is. Measured names are read as they were.
--   * The rows count against the same 50,000. A derived metric's rows are not counted by a rollup, so
--     the count is a bound: the devices that have every input of it, and the buckets of the window.
--     The hours and then the minutes are walked as before, over the measured count and this bound
--     together, and the cut they name holds for both reads.
--   * It reads derived metrics in chunks that each stay inside derived_series()'s own limits (5,000
--     rows, 250,000 minutes of input), a metric at a time. The devices that have every input are
--     found by one remote aggregate over telemetry_1h, which holds a series for as long as any
--     rollup does, as telemetry_carried() seeds from it.
--   * A derived metric's window starts where the export's does. Raw, which the historian drops long
--     before its rollups, begins later for a measured name only (raw_from, read_from).
--   * The unit is the catalogue's, which a rate and a sum carry, and "% of the time" for a time in
--     state, the unit History draws it in. Its value is a fraction from 0 to 1, as it is everywhere
--     it is data, and the dashboard's comment row says so.
--   * The document gains derived: each derived metric asked for, with its kind, its definition in
--     words and its unit, so the file can mark them. The Audit Trail row gains the same names and
--     definitions when any was asked for, and is the row it was when none was.
--
-- derivation_words(jsonb) says a definition as the dashboard does ("rate of Controller/PART_COUNT, per
-- hour"). Mirror checks 109 and 110 hold its words and the share's unit to the dashboard's.
--
-- Reasoning: supabase/README.md, "An export saves a derived metric's values (0296)". Idempotent.
--
-- Redefines public.export_telemetry: 0279 reads measured names only. 0296 reads a derived name through
--   derived_series() in chunks, counts its rows against the 50,000 and names it and its definition in
--   the document and the Audit Trail row. Every check, every refusal and every measured read stay as
--   0279 made them

-- -------------------------------------------------------------------------------------------------
-- 1. A definition in words
-- -------------------------------------------------------------------------------------------------
-- The dashboard's describeDerivation(): "rate of A, per hour", "share of time A is X, Y or Z", "A + B
-- − C" (a true minus sign, and a first input that is taken away begins with one). Not granted to a
-- browser role: export_telemetry() is its one caller. STABLE, not IMMUTABLE, as format() is.
CREATE OR REPLACE FUNCTION public.derivation_words(p_derivation jsonb) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
DECLARE
    c_rate  CONSTANT text := 'rate of %s, per hour';
    c_share CONSTANT text := 'share of time %s is %s';
    c_or    CONSTANT text := ' or ';
    c_comma CONSTANT text := ', ';
    c_plus  CONSTANT text := ' + ';
    c_minus CONSTANT text := ' − ';
    c_neg   CONSTANT text := '−';
    v_kind   text := p_derivation ->> 'kind';
    v_states text[];
    v_n      integer;
    v_words  text;
    v_in     record;
BEGIN
    IF p_derivation IS NULL THEN
        RETURN '';
    END IF;
    IF v_kind = 'counter_rate' THEN
        RETURN format(c_rate, p_derivation ->> 'input');
    ELSIF v_kind = 'time_in_state' THEN
        v_states := ARRAY(SELECT jsonb_array_elements_text(p_derivation -> 'states'));
        v_n := coalesce(cardinality(v_states), 0);
        v_words := CASE WHEN v_n <= 1 THEN coalesce(v_states[1], '')
                        ELSE array_to_string(v_states[1 : v_n - 1], c_comma) || c_or || v_states[v_n] END;
        RETURN format(c_share, p_derivation ->> 'input', v_words);
    ELSIF v_kind = 'sum' THEN
        v_words := '';
        FOR v_in IN
            SELECT i ->> 'metric' AS metric, coalesce((i ->> 'sign')::numeric, 1) < 0 AS taken, o
              FROM jsonb_array_elements(p_derivation -> 'inputs') WITH ORDINALITY AS e(i, o)
             ORDER BY o
        LOOP
            v_words := v_words || CASE WHEN v_in.o = 1 THEN CASE WHEN v_in.taken THEN c_neg ELSE '' END
                                       WHEN v_in.taken THEN c_minus
                                       ELSE c_plus END || v_in.metric;
        END LOOP;
        RETURN v_words;
    END IF;
    RETURN 'unknown kind ' || coalesce(v_kind, 'undefined');
END
$fn$;

ALTER FUNCTION public.derivation_words(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.derivation_words(jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.derivation_words(jsonb) IS
  'A derived metric''s definition (metric_catalog.derivation) in the words the dashboard uses: "rate of '
  'A, per hour", "share of time A is X or Y", "A + B − C". Read by export_telemetry(), and by nothing '
  'else (0296).';

-- -------------------------------------------------------------------------------------------------
-- 2. The export
-- -------------------------------------------------------------------------------------------------
-- SECURITY DEFINER, as 0279 declared it, and the role check is still the first statement (mirror check
-- 90). derived_series() and telemetry_carried() run as the caller, which here is the owner, through the
-- same foreign tables and the same mapping the other reads use.
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
    -- What one derived_series() call may return and read (0282): a chunk stays inside both.
    c_series_rows    CONSTANT integer := 5000;
    c_series_minutes CONSTANT integer := 250000;
    -- A time in state's unit, as History draws it (the dashboard's SHARE_UNIT, mirror check 110).
    c_share_unit  CONSTANT text := '% of the time';
    v_uid       uuid := auth.uid();
    v_days      numeric;
    v_assets    text[];
    v_metrics   text[];
    v_measured  text[];
    v_derived   text[];
    v_res       text;
    v_count_rel text;
    v_weight    text;
    v_read_rel  text;
    v_time_col  text;
    v_value     text;
    v_raw_from  timestamp with time zone;
    v_lo        timestamp with time zone;
    v_read_from timestamp with time zone;
    v_grid      timestamp with time zone;
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
    v_step      interval;
    v_step_secs integer;
    v_defs      jsonb := '[]'::jsonb;
    v_def       jsonb;
    v_inputs    text[];
    v_names     text[];
    v_pair_a    text[];
    v_pair_m    text[];
    v_cover     jsonb := '{}'::jsonb;
    v_cov       text[];
    v_per_step  bigint := 0;
    v_h         timestamp with time zone;
    v_m         timestamp with time zone;
    v_k         integer;
    v_n_h       bigint;
    v_n_m       bigint;
    v_unit      text;
    v_cap       integer;
    v_a         integer;
    v_b         integer;
    v_cs        timestamp with time zone;
    v_ce        timestamp with time zone;
    v_end       timestamp with time zone;
    v_part      jsonb;
    v_part_n    bigint;
    v_drows     jsonb := '[]'::jsonb;
    v_dn        bigint := 0;
    v_derived_doc jsonb := '[]'::jsonb;
    v_derived_log jsonb := '[]'::jsonb;
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

    -- A name that is a derived metric is computed (derived_series()); every other is read.
    v_derived := ARRAY(SELECT m.x FROM unnest(v_metrics) AS m(x)
                        WHERE EXISTS (SELECT 1 FROM public.metric_catalog c
                                       WHERE c.name = m.x AND c.derivation IS NOT NULL) ORDER BY 1);
    v_measured := ARRAY(SELECT m.x FROM unnest(v_metrics) AS m(x) WHERE NOT m.x = ANY (v_derived) ORDER BY 1);

    -- What is counted, and what is read. Raw is counted by the 1-minute rollup's readings; a
    -- rollup is counted by its own rows. A derived metric's bucket is the rollup's, or a minute
    -- where the resolution is raw.
    IF v_res = 'raw' THEN
        v_count_rel := 'telemetry_1m'; v_weight := 'sum(t.n_rows)::bigint';
        v_read_rel := 'telemetry'; v_time_col := '"time"';
        v_value := 'coalesce(to_jsonb(t.val_double), to_jsonb(t.val_string), to_jsonb(t.val_bool))';
    ELSE
        v_count_rel := 'telemetry_' || v_res; v_weight := 'count(*)';
        v_read_rel := v_count_rel; v_time_col := 'bucket';
        v_value := 'coalesce(to_jsonb(t.sum_double / nullif(t.n_double, 0)::double precision), '
                   'to_jsonb(t.last_string), to_jsonb(t.last_bool))';
    END IF;
    v_step := CASE v_res WHEN '5m' THEN interval '5 minutes' WHEN '1h' THEN interval '1 hour'
                         ELSE interval '1 minute' END;
    v_step_secs := extract(epoch FROM v_step)::integer;

    -- Where the measured read begins. Raw is dropped a chunk at a time, oldest first, so it is whole
    -- from its oldest reading on; a read with no measured name has no start, and no raw horizon.
    IF cardinality(v_measured) = 0 THEN
        v_lo := to_ts;
    ELSIF v_res = 'raw' THEN
        SELECT min(t."time") INTO v_raw_from FROM timescale.telemetry t;
        v_lo := least(greatest(from_ts, coalesce(v_raw_from, to_ts)), to_ts);
    ELSE
        v_lo := from_ts;
    END IF;
    v_read_from := CASE WHEN cardinality(v_measured) = 0 THEN from_ts ELSE v_lo END;

    -- The derived metrics asked for, their definitions, and the devices that have every input of each:
    -- a device that lacks one has no row (derived_series()), so it costs the count nothing.
    IF cardinality(v_derived) > 0 THEN
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'name', c.name,
                   'kind', c.derivation ->> 'kind',
                   'definition', public.derivation_words(c.derivation),
                   'unit', CASE WHEN c.derivation ->> 'kind' = 'time_in_state' THEN c_share_unit ELSE c.units END,
                   'inputs', CASE WHEN c.derivation ->> 'kind' = 'sum'
                                  THEN (SELECT jsonb_agg(i -> 'metric') FROM jsonb_array_elements(c.derivation -> 'inputs') AS e(i))
                                  ELSE jsonb_build_array(c.derivation -> 'input') END) ORDER BY c.name), '[]'::jsonb)
          INTO v_defs
          FROM public.metric_catalog c
         WHERE c.name = ANY (v_derived);
        v_derived_doc := (SELECT coalesce(jsonb_agg(jsonb_build_object('metric', d ->> 'name', 'kind', d ->> 'kind',
                                                                      'definition', d ->> 'definition', 'unit', d -> 'unit')
                                                    ORDER BY d ->> 'name'), '[]'::jsonb)
                            FROM jsonb_array_elements(v_defs) AS e(d));
        v_derived_log := (SELECT coalesce(jsonb_agg(jsonb_build_object('name', d ->> 'name', 'definition', d ->> 'definition')
                                                    ORDER BY d ->> 'name'), '[]'::jsonb)
                            FROM jsonb_array_elements(v_defs) AS e(d));
        v_inputs := ARRAY(SELECT DISTINCT jsonb_array_elements_text(d -> 'inputs') FROM jsonb_array_elements(v_defs) AS e(d));

        -- The devices that have ever had a value of an input, in one remote aggregate. The 1-hour
        -- rollup holds a series for as long as any does, and is real-time to now.
        EXECUTE $q$
          SELECT array_agg(o.asset_id), array_agg(o.metric_name)
            FROM (SELECT t.asset_id, t.metric_name
                    FROM timescale.telemetry_1h t
                   WHERE t.bucket < $1
                     AND t.asset_id = ANY ($2::text[]) AND t.metric_name = ANY ($3::text[])
                   GROUP BY 1, 2) o
        $q$
        INTO v_pair_a, v_pair_m
        USING to_ts, v_assets, v_inputs;

        FOR v_def IN SELECT e.d FROM jsonb_array_elements(v_defs) AS e(d) LOOP
            v_names := ARRAY(SELECT jsonb_array_elements_text(v_def -> 'inputs'));
            v_cov := ARRAY(SELECT p.aid
                             FROM unnest(v_pair_a, v_pair_m) AS p(aid, mname)
                            WHERE p.mname = ANY (v_names)
                            GROUP BY p.aid HAVING count(*) = cardinality(v_names)
                            ORDER BY p.aid);
            v_cover := v_cover || jsonb_build_object(v_def ->> 'name', to_jsonb(v_cov));
            v_per_step := v_per_step + coalesce(cardinality(v_cov), 0);
        END LOOP;
    END IF;

    -- Where the walk begins: the measured read's start, or the window's where a derived metric has a
    -- device.
    v_grid := least(CASE WHEN cardinality(v_measured) > 0 THEN v_lo END,
                    CASE WHEN v_per_step > 0 THEN from_ts END);
    v_cut := to_ts;

    IF v_grid IS NOT NULL AND v_grid < to_ts THEN
        -- How many rows each hour of the window holds, in one remote aggregate.
        IF cardinality(v_measured) > 0 AND v_lo < to_ts THEN
            EXECUTE format($q$
              SELECT array_agg(o.h ORDER BY o.h), array_agg(o.n ORDER BY o.h)
                FROM (SELECT date_bin($5, t.bucket, timestamptz 'epoch') AS h, %s AS n
                        FROM timescale.%I t
                       WHERE t.bucket >= $1 AND t.bucket < $2
                         AND t.asset_id = ANY ($3::text[]) AND t.metric_name = ANY ($4::text[])
                       GROUP BY 1) o
            $q$, v_weight, v_count_rel)
            INTO v_hours, v_hour_n
            USING date_bin(interval '1 minute', v_lo, timestamptz 'epoch'), to_ts, v_assets, v_measured, interval '1 hour';
        END IF;

        -- Walk the hours in order, the measured count and the derived bound together. A derived
        -- metric's bound is a row for each device that has its inputs and each bucket that starts in
        -- the hour; a bucket that starts before the window is not read.
        v_h := date_bin(interval '1 hour', v_grid, timestamptz 'epoch');
        v_k := 1;
        WHILE v_h < to_ts LOOP
            WHILE v_k <= coalesce(cardinality(v_hours), 0) AND v_hours[v_k] < v_h LOOP
                v_k := v_k + 1;
            END LOOP;
            v_n_h := 0;
            IF v_k <= coalesce(cardinality(v_hours), 0) AND v_hours[v_k] = v_h THEN
                v_n_h := v_hour_n[v_k];
            END IF;
            IF v_per_step > 0 THEN
                v_n_h := v_n_h + v_per_step * greatest(0,
                    ceil(extract(epoch FROM least(v_h + interval '1 hour', to_ts)) / v_step_secs)::bigint
                    - ceil(extract(epoch FROM greatest(v_h, from_ts)) / v_step_secs)::bigint);
            END IF;

            IF v_total + v_n_h > c_max_rows THEN
                -- This hour does not fit whole: take the minutes of it that do, and stop there.
                v_truncated := true;
                v_cut := greatest(v_h, v_grid);
                v_mins := NULL; v_min_n := NULL;
                IF cardinality(v_measured) > 0 AND v_lo < to_ts THEN
                    EXECUTE format($q$
                      SELECT array_agg(o.h ORDER BY o.h), array_agg(o.n ORDER BY o.h)
                        FROM (SELECT date_bin($5, t.bucket, timestamptz 'epoch') AS h, %s AS n
                                FROM timescale.%I t
                               WHERE t.bucket >= $1 AND t.bucket < $2
                                 AND t.asset_id = ANY ($3::text[]) AND t.metric_name = ANY ($4::text[])
                               GROUP BY 1) o
                    $q$, v_weight, v_count_rel)
                    INTO v_mins, v_min_n
                    USING greatest(v_h, date_bin(interval '1 minute', v_lo, timestamptz 'epoch')),
                          least(v_h + interval '1 hour', to_ts), v_assets, v_measured, interval '1 minute';
                END IF;
                v_stopped := false;
                v_m := greatest(v_h, date_bin(interval '1 minute', v_grid, timestamptz 'epoch'));
                v_k := 1;
                WHILE v_m < least(v_h + interval '1 hour', to_ts) LOOP
                    WHILE v_k <= coalesce(cardinality(v_mins), 0) AND v_mins[v_k] < v_m LOOP
                        v_k := v_k + 1;
                    END LOOP;
                    v_n_m := 0;
                    IF v_k <= coalesce(cardinality(v_mins), 0) AND v_mins[v_k] = v_m THEN
                        v_n_m := v_min_n[v_k];
                    END IF;
                    IF v_per_step > 0 THEN
                        v_n_m := v_n_m + v_per_step * greatest(0,
                            ceil(extract(epoch FROM least(v_m + interval '1 minute', to_ts)) / v_step_secs)::bigint
                            - ceil(extract(epoch FROM greatest(v_m, from_ts)) / v_step_secs)::bigint);
                    END IF;
                    IF v_total + v_n_m > c_max_rows THEN
                        v_cut := greatest(v_m, v_grid);
                        v_stopped := true;
                        EXIT;
                    END IF;
                    v_total := v_total + v_n_m;
                    v_m := v_m + interval '1 minute';
                END LOOP;
                -- Every minute fit: what was counted a moment ago has changed, and the hour is whole.
                IF NOT v_stopped THEN
                    v_cut := least(v_h + interval '1 hour', to_ts);
                END IF;
                EXIT;
            END IF;
            v_total := v_total + v_n_h;
            v_h := v_h + interval '1 hour';
        END LOOP;
    END IF;

    IF cardinality(v_measured) > 0 AND v_lo < v_cut THEN
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
        USING v_lo, v_cut, v_assets, v_measured, v_measured, c_max_rows + 1;
    END IF;

    IF v_per_step > 0 AND from_ts < v_cut THEN
        -- Each derived metric on the devices that have its inputs, in chunks of whole buckets that
        -- derived_series() takes: a call is at most c_series_rows rows (devices times buckets) and
        -- c_series_minutes minutes of input (those times its inputs times the bucket's minutes).
        v_end := date_bin(v_step, v_cut, timestamptz 'epoch');
        IF v_end < v_cut THEN
            v_end := v_end + v_step;
        END IF;
        FOR v_def IN SELECT e.d FROM jsonb_array_elements(v_defs) AS e(d) LOOP
            v_cov := ARRAY(SELECT jsonb_array_elements_text(v_cover -> (v_def ->> 'name')));
            CONTINUE WHEN coalesce(cardinality(v_cov), 0) = 0;
            v_unit := v_def ->> 'unit';
            v_cap := least(c_series_rows,
                           c_series_minutes / (jsonb_array_length(v_def -> 'inputs') * (v_step_secs / 60)));
            v_a := least(cardinality(v_cov), v_cap);
            v_b := greatest(1, v_cap / v_a);
            FOR v_i IN 1..cardinality(v_cov) BY v_a LOOP
                v_cs := date_bin(v_step, from_ts, timestamptz 'epoch');
                WHILE v_cs < v_cut LOOP
                    v_ce := least(v_cs + v_b * v_step, v_end);
                    SELECT coalesce(jsonb_agg(jsonb_build_array(to_char(s.bucket_ts AT TIME ZONE 'UTC', c_iso),
                                                                s.asset_id, s.metric_name, to_jsonb(s.avg_double), v_unit)),
                                    '[]'::jsonb),
                           count(*)
                      INTO v_part, v_part_n
                      FROM public.derived_series(v_cs, v_ce, v_step, v_cov[v_i : v_i + v_a - 1],
                                                 ARRAY[v_def ->> 'name']) s
                     WHERE s.bucket_ts >= from_ts AND s.bucket_ts < v_cut;
                    v_drows := v_drows || v_part;
                    v_dn := v_dn + v_part_n;
                    v_cs := v_cs + v_b * v_step;
                    -- The bound above says this does not happen; a count that was short stops the read.
                    EXIT WHEN v_dn > c_max_rows;
                END LOOP;
                EXIT WHEN v_dn > c_max_rows;
            END LOOP;
            EXIT WHEN v_dn > c_max_rows;
        END LOOP;

        IF v_dn > 0 THEN
            SELECT coalesce(jsonb_agg(x.e ORDER BY x.e ->> 0, x.e ->> 1, x.e ->> 2), '[]'::jsonb)
              INTO v_rows
              FROM (SELECT a.e FROM jsonb_array_elements(v_rows) AS a(e)
                    UNION ALL
                    SELECT b.e FROM jsonb_array_elements(v_drows) AS b(e)) x;
            v_n := v_n + v_dn;
        END IF;
    END IF;

    IF v_n > c_max_rows THEN
        -- A count that was short: the extra rows are not exported, and the rows end where the first began.
        v_edge := v_rows -> c_max_rows ->> 0;
        v_rows := (SELECT coalesce(jsonb_agg(x.e ORDER BY x.o), '[]'::jsonb)
                     FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS x(e, o)
                    WHERE x.o <= c_max_rows);
        v_n := c_max_rows;
        v_truncated := true;
        v_cut := v_edge::timestamp with time zone;
    END IF;

    IF v_n > 0 THEN
        v_devices := coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.aid, 'name', d.name)
                                                ORDER BY coalesce(d.name, a.aid), a.aid)
                                 FROM unnest(v_assets) AS a(aid)
                                 LEFT JOIN public.devices d ON d.sparkplug_id = a.aid), '[]'::jsonb);
        -- `name` labels the lane, as every audit row's does. The window and the cut are in UTC to
        -- the millisecond, whatever the session's zone. `derived` is there only when a derived metric
        -- was asked for.
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
                'exported_by_email', nullif(auth.jwt() ->> 'email', ''))
            || CASE WHEN cardinality(v_derived) > 0 THEN jsonb_build_object('derived', v_derived_log) ELSE '{}'::jsonb END,
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
        'read_from', to_char(v_read_from AT TIME ZONE 'UTC', c_iso),
        'read_to', to_char(v_cut AT TIME ZONE 'UTC', c_iso),
        'raw_from', to_char(v_raw_from AT TIME ZONE 'UTC', c_iso),
        'derived', v_derived_doc);
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
  'read_from, read_to, raw_from, audit_id and derived. resolution is raw or the 1m, 5m or 1h rollup''s '
  'average, never one in place of another. A derived metric is read through derived_series() in '
  'buckets of the resolution''s width, a minute for raw, and named in derived with its definition and '
  'unit. An Administrator or a Shopfloor Manager only (42501), and a window no longer than '
  'history.export_max_days (22023). At most 50,000 rows, derived ones included: past that the rows '
  'end at read_to and truncated is true. Writes one TELEMETRY_EXPORTED row in the Audit Trail, and '
  'none when no row is returned (0279, 0296).';

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
    RAISE EXCEPTION '0296: export_telemetry is declared % times, not once', v_forms;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                  AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0296: % is not SECURITY DEFINER with its search_path pinned', v_fn;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0296: % may execute %', v_role, v_fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0296: authenticated may not execute %; the dashboard calls it', v_fn;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, 'public.derivation_words(jsonb)', 'EXECUTE') THEN
      RAISE EXCEPTION '0296: % may execute derivation_words(), which export_telemetry() alone calls', v_role;
    END IF;
  END LOOP;

  -- The words of a definition, kind by kind: what the Derived tab's table says of it.
  IF public.derivation_words('{"kind": "counter_rate", "input": "A/X"}') <> 'rate of A/X, per hour'
     OR public.derivation_words('{"kind": "time_in_state", "input": "A/X", "states": ["B"]}') <> 'share of time A/X is B'
     OR public.derivation_words('{"kind": "time_in_state", "input": "A/X", "states": ["B", "C"]}') <> 'share of time A/X is B or C'
     OR public.derivation_words('{"kind": "time_in_state", "input": "A/X", "states": ["B", "C", "D"]}') <> 'share of time A/X is B, C or D'
     OR public.derivation_words('{"kind": "sum", "inputs": [{"metric": "A", "sign": 1}, {"metric": "B", "sign": 1}, {"metric": "C", "sign": -1}]}') <> 'A + B − C'
     OR public.derivation_words('{"kind": "sum", "inputs": [{"metric": "A", "sign": -1}, {"metric": "B", "sign": 1}]}') <> '−A + B' THEN
    RAISE EXCEPTION '0296: derivation_words() does not say a definition as the dashboard does';
  END IF;

  -- A request with no person behind it is refused before anything is read.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.export_telemetry(now() - interval '1 hour', now(), ARRAY['dev'], ARRAY['m']);
    RAISE EXCEPTION '0296: export_telemetry() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$check$;

NOTIFY pgrst, 'reload schema';
