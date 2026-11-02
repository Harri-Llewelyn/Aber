-- 0223: The System page shows what the stack is doing: messages arriving, readings written,
-- messages lost, ingestion's links, gateways online and devices reporting.
--
--   * directory_prometheus_url(): where Prometheus answers, the fixed http://prometheus:9090. Both
--     Prometheus readers take the address from it; refresh_directory_liveness() is redeclared here,
--     after it, to read it.
--   * refresh_directory_figures(): the sibling of refresh_directory_liveness(), run every minute by
--     pg_cron. It collects the answer to the previous run's request from net._http_response, writes
--     each figure from it, and fires the next request. Its PromQL is fixed here: one instant query
--     whose answer carries every figure, each labelled `figure`.
--   * directory_figures: one row per figure, seeded here. Every signed-in user reads it, and only
--     the function, as its owner, writes it. A figure the last answer did not carry, or a run with
--     no usable answer, writes NULL: the page says "not observed", never the last value.
--   * directory_gateway_counts() and directory_devices_reporting(): the two figures read live from
--     this database, each its own call, so a historian outage leaves the gateway count standing.
--
-- Reasoning: supabase/README.md, "The System page shows what the stack is doing (0223)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Where Prometheus answers
-- -------------------------------------------------------------------------------------------------
-- Declared before refresh_directory_liveness() is redeclared below: pg_cron runs that function
-- every minute while db-init replays, so it must never name a function that does not exist yet.
CREATE OR REPLACE FUNCTION public.directory_prometheus_url() RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT 'http://prometheus:9090'::text;
$$;

ALTER FUNCTION public.directory_prometheus_url() OWNER TO postgres;

COMMENT ON FUNCTION public.directory_prometheus_url() IS
  'The Prometheus that refresh_directory_liveness() and refresh_directory_figures() query through '
  'pg_net: the chart''s own, at http://prometheus:9090, over the supabase-db -> prometheus route. '
  'The one place the address is written (0223).';

REVOKE ALL ON FUNCTION public.directory_prometheus_url() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.directory_prometheus_url() TO service_role;

-- -------------------------------------------------------------------------------------------------
-- 2. Liveness reads the address from it
-- -------------------------------------------------------------------------------------------------
-- 0001's body, with three changes. The address comes from directory_prometheus_url(). Content
-- that is not JSON, or a result that is not a list, counts as no answer: the cast used to raise,
-- which rolled back the run before it fired the next probe, so every later run collected the same
-- answer and raised again. And a scraped service the last answer did not report is set UNKNOWN
-- too: the sweep used to pass over every service the map names, so a probe that failed left each
-- one at its last ACTIVE.
CREATE OR REPLACE FUNCTION public.refresh_directory_liveness() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'net'
    AS $$
DECLARE
    v_prev      bigint;
    v_status    integer;
    v_body      jsonb;
    v_seen      text[] := ARRAY[]::text[];
BEGIN
    SELECT request_id INTO v_prev FROM public.directory_liveness_probe WHERE id;

    -- ---- Collect the previous run's answer, if there was one. --------------------------------
    IF v_prev IS NOT NULL THEN
        SELECT status_code, CASE WHEN pg_input_is_valid(content, 'jsonb') THEN content::jsonb END
          INTO v_status, v_body
          FROM net._http_response WHERE id = v_prev;

        -- A 200 WITH A BODY IS THE ONLY THING THAT WRITES ACTIVE. Every other outcome -- no row
        -- yet, a timeout, a non-200, unparseable content -- falls through to the UNKNOWN sweep
        -- below. Leaving the previous values in place would be the original defect again: a status
        -- that describes an observation nobody made.
        IF v_status = 200 AND v_body->>'status' = 'success'
           AND jsonb_typeof(v_body->'data'->'result') = 'array' THEN
            WITH observed AS (
                SELECT r->'metric'->>'job'  AS job,
                       (r->'value'->>1)     AS up
                  FROM jsonb_array_elements(v_body->'data'->'result') AS r
            ), mapped AS (
                SELECT m.service_name, o.up
                  FROM public.directory_liveness_job_map() m
                  JOIN observed o ON o.job = m.prometheus_job
            ), written AS (
                UPDATE public.directory_services d
                   SET status = CASE WHEN mapped.up = '1' THEN 'ACTIVE' ELSE 'DOWN' END,
                       -- ONLY AN UP READING MOVES THE HEARTBEAT. For DOWN it is cleared rather than
                       -- frozen: "last seen at X" and "not up now" are different claims, and a
                       -- lingering timestamp beside a red status reads as the former.
                       last_heartbeat = CASE WHEN mapped.up = '1' THEN now() ELSE NULL END
                  FROM mapped
                 WHERE d.service_name = mapped.service_name
                RETURNING d.service_name
            )
            SELECT coalesce(array_agg(service_name), ARRAY[]::text[]) INTO v_seen FROM written;
        END IF;
    END IF;

    -- ---- Everything not observed this run is set UNKNOWN. ------------------------------------
    -- On EVERY run, the services the map names included. A probe that failed, a job no longer
    -- scraped, or a service renamed so the map stops matching must not keep the last ACTIVE it
    -- was given -- which would be a fabricated status with a real timestamp, the most convincing
    -- kind.
    UPDATE public.directory_services
       SET status = 'UNKNOWN', last_heartbeat = NULL
     WHERE service_name <> ALL (v_seen)
       AND (status <> 'UNKNOWN' OR last_heartbeat IS NOT NULL);

    -- ---- Fire the next request. ---------------------------------------------------------------
    -- AFTER the collection, so a failure above does not cost this run its probe.
    UPDATE public.directory_liveness_probe
       SET request_id = net.http_get(public.directory_prometheus_url() || '/api/v1/query?query=up',
                                     timeout_milliseconds := 4000),
           requested_at = now()
     WHERE id;

    RETURN cardinality(v_seen);
END;
$$;

ALTER FUNCTION public.refresh_directory_liveness() OWNER TO postgres;

COMMENT ON FUNCTION public.refresh_directory_liveness() IS
  'Collects the previous Prometheus `up` probe, writes ACTIVE/DOWN for each service '
  'directory_liveness_job_map() names that the answer reports and UNKNOWN for every other, then '
  'queues the next probe to directory_prometheus_url(). Returns how many rows were written from a '
  'real observation. Run every minute by cron; safe to call by hand (0223).';

REVOKE ALL ON FUNCTION public.refresh_directory_liveness() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_directory_liveness() TO service_role;

-- -------------------------------------------------------------------------------------------------
-- 3. The figures and the probe
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.directory_figures (
    key text NOT NULL,
    value double precision,
    observed_at timestamp with time zone,
    detail jsonb,
    CONSTRAINT directory_figures_pkey PRIMARY KEY (key)
);

ALTER TABLE public.directory_figures OWNER TO postgres;
ALTER TABLE public.directory_figures ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.directory_figures IS
  'What the stack is doing, read from Prometheus every minute by refresh_directory_figures(): one '
  'row per figure, seeded by 0223. Every signed-in user reads it for the System page; only the '
  'function, as its owner, writes it.';
COMMENT ON COLUMN public.directory_figures.key IS
  'The figure, named as the `figure` label refresh_directory_figures()''s query gives it.';
COMMENT ON COLUMN public.directory_figures.value IS
  'The figure from the last run''s answer: a rate per second, a count over the last hour, or 1 '
  'and 0 for a link. NULL when that answer did not carry it, which the page shows as not observed.';
COMMENT ON COLUMN public.directory_figures.observed_at IS
  'When Prometheus evaluated the value. NULL with the value.';
COMMENT ON COLUMN public.directory_figures.detail IS
  'What a tooltip adds: messages_per_second''s rate by Sparkplug message type (by_msg_type), and '
  'messages_refused_last_hour''s largest reason (largest_reason, largest). NULL otherwise.';

-- Every signed-in user reads it; no role writes it, service_role included.
REVOKE ALL ON TABLE public.directory_figures FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.directory_figures TO authenticated;

SELECT public.replay_policy('public.directory_figures', 'directory_figures_select_authenticated', $ddl$
CREATE POLICY directory_figures_select_authenticated ON public.directory_figures FOR SELECT TO authenticated USING (true);
$ddl$);

-- The figures that exist. A key must match a `figure` label in the function's query, and the
-- dashboard reads them by name (frontend/src/utils/systemFigures.js, mirror check 39).
INSERT INTO public.directory_figures (key) VALUES
    ('messages_per_second'),
    ('readings_per_second'),
    ('messages_refused_last_hour'),
    ('messages_shed_last_hour'),
    ('messages_missed_last_hour'),
    ('ingestion_broker_link'),
    ('ingestion_historian_link')
ON CONFLICT (key) DO NOTHING;

-- One row by CHECK (id), as directory_liveness_probe: two requests in flight would race to write
-- the same rows from different observations.
CREATE TABLE IF NOT EXISTS public.directory_figures_probe (
    id boolean DEFAULT true NOT NULL,
    request_id bigint,
    requested_at timestamp with time zone,
    CONSTRAINT directory_figures_probe_pkey PRIMARY KEY (id),
    CONSTRAINT directory_figures_probe_id_check CHECK (id)
);

ALTER TABLE public.directory_figures_probe OWNER TO postgres;
ALTER TABLE public.directory_figures_probe ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.directory_figures_probe IS
  'The single in-flight pg_net request id for refresh_directory_figures(), as '
  'directory_liveness_probe holds liveness''s (0223).';

REVOKE ALL ON TABLE public.directory_figures_probe FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.directory_figures_probe TO service_role;

INSERT INTO public.directory_figures_probe (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- -------------------------------------------------------------------------------------------------
-- 4. The collector
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_directory_figures() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'net'
    AS $$
DECLARE
    v_prev      bigint;
    v_status    integer;
    v_content   text;
    v_body      jsonb;
    v_result    jsonb := '[]'::jsonb;
    v_observed  integer := 0;
    -- One instant query; `or` joins the vectors, which the `figure` label keeps apart. The
    -- ingestion series that appear only at their first event read 0 while the daemon is scraped
    -- (`or sum(aber_ingestion_up) * 0`), and nothing while it is not. Messages lost is the Stack &
    -- Ingestion Health dashboard's Messages Lost panel over the last hour.
    v_query     CONSTANT text :=
           'label_replace(sum(rate(aber_ingestion_messages_total[5m])) or sum(aber_ingestion_up) * 0, "figure", "messages_per_second", "", "")'
        || ' or label_replace(sum by (msg_type) (rate(aber_ingestion_messages_total[5m])), "figure", "messages_by_type", "", "")'
        || ' or label_replace(sum(rate(aber_ingestion_metrics_written_total[5m])), "figure", "readings_per_second", "", "")'
        || ' or label_replace(sum(increase(aber_ingestion_messages_dropped_total[1h])), "figure", "messages_refused_last_hour", "", "")'
        || ' or label_replace(sum by (reason) (increase(aber_ingestion_messages_dropped_total[1h])), "figure", "messages_refused_by_reason", "", "")'
        || ' or label_replace(sum(increase(broker_publish_messages_dropped[1h])), "figure", "messages_shed_last_hour", "", "")'
        || ' or label_replace(sum(increase(aber_ingestion_sequence_messages_missed_total[1h])) or sum(aber_ingestion_up) * 0, "figure", "messages_missed_last_hour", "", "")'
        || ' or label_replace(min(aber_ingestion_mqtt_connected), "figure", "ingestion_broker_link", "", "")'
        || ' or label_replace(min(aber_ingestion_db_connected), "figure", "ingestion_historian_link", "", "")';
BEGIN
    SELECT request_id INTO v_prev FROM public.directory_figures_probe WHERE id;

    -- ---- Collect the previous run's answer. ---------------------------------------------------
    -- Only a 200 whose body is a successful Prometheus vector is an answer. No row yet, a
    -- timeout, a non-200 or unparseable content leaves v_result empty, so every figure is NULL.
    IF v_prev IS NOT NULL THEN
        SELECT status_code, content INTO v_status, v_content
          FROM net._http_response WHERE id = v_prev;
        IF v_status = 200 AND pg_input_is_valid(v_content, 'jsonb') THEN
            v_body := v_content::jsonb;
            IF v_body->>'status' = 'success' AND jsonb_typeof(v_body->'data'->'result') = 'array' THEN
                v_result := v_body->'data'->'result';
            END IF;
        END IF;
    END IF;

    -- ---- Write every row, from the answer or as not observed. ---------------------------------
    -- A row the answer does not name gets NULLs from the empty sub-select. Infinity and NaN are
    -- not figures. Any answer this cannot read clears every row rather than aborting the run,
    -- which would cost it the next request.
    BEGIN
        WITH sample AS (
            SELECT r->'metric'->>'figure' AS figure,
                   r->'metric' AS labels,
                   CASE WHEN pg_input_is_valid(r->'value'->>1, 'double precision')
                        THEN (r->'value'->>1)::double precision END AS v,
                   CASE WHEN pg_input_is_valid(r->'value'->>0, 'double precision')
                        THEN to_timestamp((r->'value'->>0)::double precision) END AS at
              FROM jsonb_array_elements(v_result) AS r
             WHERE jsonb_typeof(r) = 'object'
        ), finite AS (
            SELECT * FROM sample
             WHERE v NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
               AND at IS NOT NULL
        )
        UPDATE public.directory_figures f
           SET (value, observed_at, detail) = (
                 SELECT s.v, s.at,
                        CASE f.key
                          WHEN 'messages_per_second' THEN (
                            SELECT jsonb_build_object('by_msg_type', jsonb_object_agg(t.labels->>'msg_type', t.v))
                              FROM finite t
                             WHERE t.figure = 'messages_by_type' AND t.labels->>'msg_type' IS NOT NULL
                            HAVING count(*) > 0)
                          WHEN 'messages_refused_last_hour' THEN (
                            SELECT jsonb_build_object('largest_reason', t.labels->>'reason', 'largest', t.v)
                              FROM finite t
                             WHERE t.figure = 'messages_refused_by_reason' AND t.labels->>'reason' IS NOT NULL
                               AND t.v > 0
                             ORDER BY t.v DESC, t.labels->>'reason'
                             LIMIT 1)
                        END
                   FROM finite s
                  WHERE s.figure = f.key
                  ORDER BY s.at DESC
                  LIMIT 1);

        SELECT count(*)::integer INTO v_observed FROM public.directory_figures WHERE value IS NOT NULL;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'refresh_directory_figures: the answer to request % could not be read (%), so no figure is observed',
            v_prev, SQLERRM;
        UPDATE public.directory_figures SET value = NULL, observed_at = NULL, detail = NULL;
        v_observed := 0;
    END;

    -- ---- Fire the next request. ---------------------------------------------------------------
    UPDATE public.directory_figures_probe
       SET request_id = net.http_get(public.directory_prometheus_url() || '/api/v1/query',
                                     params := jsonb_build_object('query', v_query),
                                     timeout_milliseconds := 4000),
           requested_at = now()
     WHERE id;

    RETURN v_observed;
END;
$$;

ALTER FUNCTION public.refresh_directory_figures() OWNER TO postgres;

COMMENT ON FUNCTION public.refresh_directory_figures() IS
  'Collects the answer to the previous Prometheus query, writes each directory_figures row from it '
  'or NULL where it carries none, then queues the next query to directory_prometheus_url(). '
  'Returns how many figures were observed. Run every minute by cron; safe to call by hand (0223).';

REVOKE ALL ON FUNCTION public.refresh_directory_figures() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_directory_figures() TO service_role;

-- After the function, so the first run finds it. ensure_cron_job() unschedules first, so a replay
-- keeps one job.
SELECT public.ensure_cron_job(
  'refresh-directory-figures',
  '* * * * *',
  $job$SELECT public.refresh_directory_figures()$job$
);

-- -------------------------------------------------------------------------------------------------
-- 5. The two figures read live from this database
-- -------------------------------------------------------------------------------------------------
-- Run as the caller, under gateways' RLS, which lets every signed-in user read every gateway.
-- Enrolled: not archived, not the Playback gateway, and past PENDING_ENROLLMENT (a bundle issued
-- and not yet redeemed). Online is gateway_status's live_status, so a gateway whose heartbeat has
-- aged out is not counted.
CREATE OR REPLACE FUNCTION public.directory_gateway_counts()
    RETURNS TABLE(online integer, enrolled integer)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT (count(*) FILTER (WHERE g.live_status = 'ONLINE'))::integer,
         count(*)::integer
    FROM public.gateway_status g
   WHERE g.is_archived IS NOT TRUE
     AND NOT g.is_shadow
     AND g.status IS DISTINCT FROM 'PENDING_ENROLLMENT';
$$;

ALTER FUNCTION public.directory_gateway_counts() OWNER TO postgres;

COMMENT ON FUNCTION public.directory_gateway_counts() IS
  'For the System page: how many gateways are ONLINE, of those enrolled (not archived, not the '
  'Playback gateway, not awaiting setup). Counts only, read as the caller (0223).';

REVOKE ALL ON FUNCTION public.directory_gateway_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_gateway_counts() TO authenticated, service_role;

-- Run as the caller, over the historian's foreign telemetry_latest, which raises when the
-- historian cannot be reached. The bound is a variable, not now() in the WHERE: postgres_fdw sends
-- a parameter to the historian but evaluates now() here, which would fetch every series.
CREATE OR REPLACE FUNCTION public.directory_devices_reporting() RETURNS integer
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
    v_since CONSTANT timestamp with time zone := now() - interval '5 minutes';
BEGIN
    RETURN (SELECT count(DISTINCT t.asset_id)::integer
              FROM public.telemetry_latest t
             WHERE t."time" >= v_since);
END;
$$;

ALTER FUNCTION public.directory_devices_reporting() OWNER TO postgres;

COMMENT ON FUNCTION public.directory_devices_reporting() IS
  'For the System page: how many devices (telemetry asset ids) have a reading from the last 5 '
  'minutes, read from the historian''s telemetry_latest as the caller. Raises when the historian '
  'cannot be reached, which the page shows as not observed (0223).';

REVOKE ALL ON FUNCTION public.directory_devices_reporting() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_devices_reporting() TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_role text;
  v_fn text;
  v_key text;
  v_src text;
BEGIN
  -- Liveness reads the address from the helper, so no second copy of it is left to drift.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.refresh_directory_liveness()'::regprocedure;
  IF v_src NOT LIKE '%directory_prometheus_url()%' OR v_src LIKE '%prometheus:9090%' THEN
    RAISE EXCEPTION '0223: refresh_directory_liveness() does not take its address from directory_prometheus_url()';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.refresh_directory_figures()'::regprocedure;
  IF v_src NOT LIKE '%directory_prometheus_url()%' OR v_src LIKE '%prometheus:9090%' THEN
    RAISE EXCEPTION '0223: refresh_directory_figures() does not take its address from directory_prometheus_url()';
  END IF;

  -- Every seeded figure is one the query names, or it would read not observed for ever.
  FOR v_key IN SELECT key FROM public.directory_figures LOOP
    IF position(format('"figure", "%s"', v_key) IN v_src) = 0 THEN
      RAISE EXCEPTION '0223: directory_figures holds %, which refresh_directory_figures()''s query does not name', v_key;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-directory-figures'
                    AND schedule = '* * * * *' AND command LIKE '%refresh_directory_figures()%') THEN
    RAISE EXCEPTION '0223: refresh_directory_figures() is not scheduled every minute';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.directory_figures_probe WHERE id) THEN
    RAISE EXCEPTION '0223: directory_figures_probe has no row, so no request would ever be fired';
  END IF;

  -- Read by every signed-in user, written by no role, and nothing to anon.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.directory_figures'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '0223: directory_figures does not have row-level security on';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'public.directory_figures', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION '0223: % may write directory_figures; only refresh_directory_figures() writes it', v_role;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.directory_figures'::regclass AND polcmd <> 'r') THEN
    RAISE EXCEPTION '0223: directory_figures has a write policy';
  END IF;
  IF has_table_privilege('anon', 'public.directory_figures', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.directory_figures', 'SELECT') THEN
    RAISE EXCEPTION '0223: directory_figures must be readable by authenticated and by no one signed out';
  END IF;
  IF has_table_privilege('anon', 'public.directory_figures_probe', 'SELECT')
     OR has_table_privilege('authenticated', 'public.directory_figures_probe', 'SELECT') THEN
    RAISE EXCEPTION '0223: an API role may read directory_figures_probe';
  END IF;

  -- The collectors and the helper are the database's own; the live reads are the caller's.
  FOREACH v_fn IN ARRAY ARRAY['public.directory_prometheus_url()', 'public.refresh_directory_liveness()',
                              'public.refresh_directory_figures()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0223: an API role may execute %', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.directory_gateway_counts()', 'public.directory_devices_reporting()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0223: % must be executable by authenticated and by no one signed out', v_fn;
    END IF;
    IF (SELECT prosecdef FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION '0223: % is SECURITY DEFINER; it must read as the caller', v_fn;
    END IF;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
