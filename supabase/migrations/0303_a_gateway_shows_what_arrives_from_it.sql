-- 0303: A gateway shows what arrives from it: how many messages a second, how many gaps in its
-- sequence numbers and messages missed in the last hour, and when each of its devices last sent a
-- reading.
--
--   * gateway_arrival_figures: one row per gateway, the three figures Prometheus holds for its
--     edge node. refresh_gateway_arrivals() is refresh_directory_figures()'s sibling, run every
--     minute by pg_cron: it collects the answer to the previous run's request from
--     net._http_response, writes every row from it, and fires the next request to the address
--     directory_prometheus_url() gives. Its PromQL is fixed here: one vector for each figure, summed
--     by edge_node, which is the gateway's sparkplug_id.
--   * gateway_arrivals: the table as the dashboard reads it. A row whose answer is more than 3
--     minutes old reads NULL, so a stopped job reads not observed and never the last value.
--   * gateway_devices_last_reading(): each device of a gateway with the time of its newest reading,
--     read live from the historian as the caller. It raises when the historian cannot be reached,
--     and the figures above stand.
--
-- Reasoning: supabase/README.md, "A gateway shows what arrives from it (0303)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The figures and the probe
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gateway_arrival_figures (
    gateway_id uuid NOT NULL,
    messages_per_second double precision,
    sequence_gaps_last_hour bigint,
    messages_missed_last_hour bigint,
    observed_at timestamp with time zone,
    CONSTRAINT gateway_arrival_figures_pkey PRIMARY KEY (gateway_id),
    CONSTRAINT gateway_arrival_figures_gateway_id_fkey FOREIGN KEY (gateway_id)
        REFERENCES public.gateways(id) ON DELETE CASCADE
);

ALTER TABLE public.gateway_arrival_figures OWNER TO postgres;
ALTER TABLE public.gateway_arrival_figures ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.gateway_arrival_figures IS
  'What arrives from each gateway, read from Prometheus every minute by refresh_gateway_arrivals(): '
  'one row per gateway. Whoever can read a gateway reads its row; only the function, as its owner, '
  'writes it. The dashboard reads gateway_arrivals, which blanks a row that is no longer fresh (0303).';
COMMENT ON COLUMN public.gateway_arrival_figures.gateway_id IS
  'The gateway. Its sparkplug_id is the edge_node label of the series the figures come from.';
COMMENT ON COLUMN public.gateway_arrival_figures.messages_per_second IS
  'Sparkplug messages the ingestion service acted on from the gateway, per second over the last 5 '
  'minutes. 0 when ingestion was observed and counted none; NULL when the last answer did not '
  'observe ingestion.';
COMMENT ON COLUMN public.gateway_arrival_figures.sequence_gaps_last_hour IS
  'Times in the last hour that a message''s Sparkplug sequence number was not the next one: at '
  'least one message from the gateway never arrived. NULL as messages_per_second is.';
COMMENT ON COLUMN public.gateway_arrival_figures.messages_missed_last_hour IS
  'Messages those gaps skipped over in the last hour, as a lower bound: a gap larger than 255 '
  'wraps and is undercounted. NULL as messages_per_second is.';
COMMENT ON COLUMN public.gateway_arrival_figures.observed_at IS
  'When Prometheus evaluated the figures; NULL with them.';

-- Whoever can read the gateway reads its figures: the policy asks the gateway table, under the
-- caller's own policies, so it follows gateways' if they change. No role writes the table.
REVOKE ALL ON TABLE public.gateway_arrival_figures FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.gateway_arrival_figures TO authenticated;

SELECT public.replay_policy('public.gateway_arrival_figures', 'gateway_arrival_figures_select_authenticated', $ddl$
CREATE POLICY gateway_arrival_figures_select_authenticated ON public.gateway_arrival_figures FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.gateways g WHERE g.id = gateway_arrival_figures.gateway_id));
$ddl$);

-- One row by CHECK (id), as directory_figures_probe: two requests in flight would race to write
-- the same rows from different observations.
CREATE TABLE IF NOT EXISTS public.gateway_arrival_probe (
    id boolean DEFAULT true NOT NULL,
    request_id bigint,
    requested_at timestamp with time zone,
    CONSTRAINT gateway_arrival_probe_pkey PRIMARY KEY (id),
    CONSTRAINT gateway_arrival_probe_id_check CHECK (id)
);

ALTER TABLE public.gateway_arrival_probe OWNER TO postgres;
ALTER TABLE public.gateway_arrival_probe ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.gateway_arrival_probe IS
  'The single in-flight pg_net request id for refresh_gateway_arrivals(), as '
  'directory_figures_probe holds the System page figures'' (0303).';

REVOKE ALL ON TABLE public.gateway_arrival_probe FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.gateway_arrival_probe TO service_role;

INSERT INTO public.gateway_arrival_probe (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- -------------------------------------------------------------------------------------------------
-- 2. The collector
-- -------------------------------------------------------------------------------------------------
-- Declared before the job is scheduled, so the first run finds it. directory_prometheus_url() is
-- 0223's, and every file after it may name it.
CREATE OR REPLACE FUNCTION public.refresh_gateway_arrivals() RETURNS integer
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
    -- One instant query; `or` joins the vectors, which the `figure` label keeps apart. A gateway
    -- is a series only once ingestion has counted something from it, and a gap's series is made
    -- when its first message is counted, so a gateway with no series reads 0 -- but only when
    -- ingestion itself was scraped (`ingestion_scraped`), which is what makes a 0 an observation.
    v_query     CONSTANT text :=
           'label_replace(sum by (edge_node) (rate(aber_ingestion_messages_total[5m])), "figure", "messages_per_second", "", "")'
        || ' or label_replace(sum by (edge_node) (increase(aber_ingestion_sequence_gaps_total[1h])), "figure", "sequence_gaps_last_hour", "", "")'
        || ' or label_replace(sum by (edge_node) (increase(aber_ingestion_sequence_messages_missed_total[1h])), "figure", "messages_missed_last_hour", "", "")'
        || ' or label_replace(sum(aber_ingestion_up), "figure", "ingestion_scraped", "", "")';
BEGIN
    SELECT request_id INTO v_prev FROM public.gateway_arrival_probe WHERE id;

    -- ---- Collect the previous run's answer. ---------------------------------------------------
    -- Only a 200 whose body is a successful Prometheus vector is an answer. No row yet, a
    -- timeout, a non-200 or unparseable content leaves v_result empty, so every row is NULL.
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

    -- ---- Write every gateway's row, from the answer or as not observed. -----------------------
    -- Without `ingestion_scraped` in the answer nothing is known about any gateway, whatever else
    -- it carries: Prometheus still answers a rate for a few minutes after a target goes away. A
    -- gateway the answer names no series for reads 0 when ingestion was scraped. A sample that is
    -- not a figure (Infinity, NaN, a time that is not one) reads NULL, never a 0 nobody observed.
    -- Any answer this cannot read clears every row rather than aborting the run, which would cost
    -- it the next request.
    BEGIN
        WITH sample AS (
            SELECT r->'metric'->>'figure' AS figure,
                   r->'metric'->>'edge_node' AS edge_node,
                   CASE WHEN pg_input_is_valid(r->'value'->>1, 'double precision')
                        THEN (r->'value'->>1)::double precision END AS v,
                   CASE WHEN pg_input_is_valid(r->'value'->>0, 'double precision')
                        THEN to_timestamp((r->'value'->>0)::double precision) END AS at
              FROM jsonb_array_elements(v_result) AS r
             WHERE jsonb_typeof(r) = 'object'
        ), figures AS (
            SELECT figure, edge_node, at,
                   CASE WHEN at IS NOT NULL
                         AND v NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
                        THEN v END AS v
              FROM sample
        ), scraped AS (
            SELECT max(at) AS at FROM figures WHERE figure = 'ingestion_scraped' AND v IS NOT NULL
        )
        INSERT INTO public.gateway_arrival_figures
               (gateway_id, messages_per_second, sequence_gaps_last_hour, messages_missed_last_hour, observed_at)
        SELECT g.id,
               CASE WHEN s.at IS NOT NULL THEN (
                   SELECT CASE WHEN count(*) = 0 THEN 0 ELSE max(t.v) END FROM figures t
                    WHERE t.figure = 'messages_per_second' AND t.edge_node = g.sparkplug_id) END,
               CASE WHEN s.at IS NOT NULL THEN (
                   SELECT CASE WHEN count(*) = 0 THEN 0 ELSE round(max(t.v))::bigint END FROM figures t
                    WHERE t.figure = 'sequence_gaps_last_hour' AND t.edge_node = g.sparkplug_id) END,
               CASE WHEN s.at IS NOT NULL THEN (
                   SELECT CASE WHEN count(*) = 0 THEN 0 ELSE round(max(t.v))::bigint END FROM figures t
                    WHERE t.figure = 'messages_missed_last_hour' AND t.edge_node = g.sparkplug_id) END,
               s.at
          FROM public.gateways g CROSS JOIN scraped s
        ON CONFLICT (gateway_id) DO UPDATE
           SET messages_per_second = EXCLUDED.messages_per_second,
               sequence_gaps_last_hour = EXCLUDED.sequence_gaps_last_hour,
               messages_missed_last_hour = EXCLUDED.messages_missed_last_hour,
               observed_at = EXCLUDED.observed_at;

        SELECT count(*)::integer INTO v_observed
          FROM public.gateway_arrival_figures WHERE observed_at IS NOT NULL;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'refresh_gateway_arrivals: the answer to request % could not be read (%), so no gateway is observed',
            v_prev, SQLERRM;
        UPDATE public.gateway_arrival_figures
           SET messages_per_second = NULL, sequence_gaps_last_hour = NULL,
               messages_missed_last_hour = NULL, observed_at = NULL;
        v_observed := 0;
    END;

    -- ---- Fire the next request. ---------------------------------------------------------------
    UPDATE public.gateway_arrival_probe
       SET request_id = net.http_get(public.directory_prometheus_url() || '/api/v1/query',
                                     params := jsonb_build_object('query', v_query),
                                     timeout_milliseconds := 4000),
           requested_at = now()
     WHERE id;

    RETURN v_observed;
END;
$$;

ALTER FUNCTION public.refresh_gateway_arrivals() OWNER TO postgres;

COMMENT ON FUNCTION public.refresh_gateway_arrivals() IS
  'Collects the answer to the previous Prometheus query, writes every gateway''s row in '
  'gateway_arrival_figures from it or as NULL where it carries none, then queues the next query to '
  'directory_prometheus_url(). Returns how many gateways were observed. Run every minute by cron; '
  'safe to call by hand (0303).';

REVOKE ALL ON FUNCTION public.refresh_gateway_arrivals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_gateway_arrivals() TO service_role;

-- After the function, so the first run finds it. ensure_cron_job() unschedules first, so a replay
-- keeps one job.
SELECT public.ensure_cron_job(
  'refresh-gateway-arrivals',
  '* * * * *',
  $job$SELECT public.refresh_gateway_arrivals()$job$
);

-- -------------------------------------------------------------------------------------------------
-- 3. The figures as the dashboard reads them
-- -------------------------------------------------------------------------------------------------
-- Fresh is an answer evaluated within the last 3 minutes: the answer collected is a minute old and
-- the next one comes a minute later, so one missed run still reads, and a stopped job reads not
-- observed within 3 minutes. security_invoker, so the table's policy decides who sees a row.
CREATE OR REPLACE VIEW public.gateway_arrivals WITH (security_invoker = true) AS
SELECT f.gateway_id,
       CASE WHEN f.observed_at >= now() - interval '3 minutes' THEN f.messages_per_second END
           AS messages_per_second,
       CASE WHEN f.observed_at >= now() - interval '3 minutes' THEN f.sequence_gaps_last_hour END
           AS sequence_gaps_last_hour,
       CASE WHEN f.observed_at >= now() - interval '3 minutes' THEN f.messages_missed_last_hour END
           AS messages_missed_last_hour,
       CASE WHEN f.observed_at >= now() - interval '3 minutes' THEN f.observed_at END
           AS observed_at
  FROM public.gateway_arrival_figures f;

ALTER VIEW public.gateway_arrivals OWNER TO postgres;

COMMENT ON VIEW public.gateway_arrivals IS
  'gateway_arrival_figures with every figure NULL unless Prometheus evaluated it within the last 3 '
  'minutes: not observed, never the last value. One row per gateway the caller may read (0303).';

REVOKE ALL ON TABLE public.gateway_arrivals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.gateway_arrivals TO authenticated;

-- -------------------------------------------------------------------------------------------------
-- 4. Each device's last reading, read live
-- -------------------------------------------------------------------------------------------------
-- Run as the caller, over the historian's foreign telemetry_latest, which raises when the
-- historian cannot be reached. The device ids are collected first and sent as one array: the
-- foreign scan then asks the historian for those devices alone and never joins across the link.
-- A gateway with no device does not touch the historian. A device with no reading has a NULL time.
CREATE OR REPLACE FUNCTION public.gateway_devices_last_reading(p_gateway_id uuid)
    RETURNS TABLE(device_id uuid, last_reading_at timestamp with time zone)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
    v_ids CONSTANT text[] := ARRAY(
        SELECT d.sparkplug_id FROM public.devices d
         WHERE d.gateway_id = p_gateway_id AND d.is_archived IS NOT TRUE);
BEGIN
    IF cardinality(v_ids) = 0 THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT d.id, r.newest
      FROM public.devices d
      LEFT JOIN (SELECT t.asset_id, max(t."time") AS newest
                   FROM public.telemetry_latest t
                  WHERE t.asset_id = ANY (v_ids)
                  GROUP BY t.asset_id) r ON r.asset_id = d.sparkplug_id
     WHERE d.gateway_id = p_gateway_id AND d.is_archived IS NOT TRUE;
END;
$$;

ALTER FUNCTION public.gateway_devices_last_reading(uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.gateway_devices_last_reading(uuid) IS
  'For the Gateways drawer: each device of the gateway that is not archived, with the time of its '
  'newest reading, read from the historian''s telemetry_latest as the caller. NULL for a device '
  'with no reading. Raises when the historian cannot be reached, which the drawer shows as not '
  'observed (0303).';

REVOKE ALL ON FUNCTION public.gateway_devices_last_reading(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gateway_devices_last_reading(uuid) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_role text;
  v_name text;
  v_src text;
BEGIN
  -- The collector reads Prometheus's address from the helper, so no second copy of it is left to
  -- drift, and its query names the three figures and the one that makes a zero an observation.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.refresh_gateway_arrivals()'::regprocedure;
  IF v_src NOT LIKE '%directory_prometheus_url()%' OR v_src LIKE '%prometheus:9090%' THEN
    RAISE EXCEPTION '0303: refresh_gateway_arrivals() does not take its address from directory_prometheus_url()';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['messages_per_second', 'sequence_gaps_last_hour',
                                'messages_missed_last_hour', 'ingestion_scraped'] LOOP
    IF position(format('"figure", "%s"', v_name) IN v_src) = 0 THEN
      RAISE EXCEPTION '0303: refresh_gateway_arrivals()''s query does not name the figure %', v_name;
    END IF;
  END LOOP;
  IF v_src NOT LIKE '%sum by (edge_node)%' THEN
    RAISE EXCEPTION '0303: refresh_gateway_arrivals()''s query does not sum by edge_node';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-gateway-arrivals'
                    AND schedule = '* * * * *' AND command LIKE '%refresh_gateway_arrivals()%') THEN
    RAISE EXCEPTION '0303: refresh_gateway_arrivals() is not scheduled every minute';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gateway_arrival_probe WHERE id) THEN
    RAISE EXCEPTION '0303: gateway_arrival_probe has no row, so no request would ever be fired';
  END IF;

  -- Read by whoever reads the gateway, written by no role, and nothing to anon.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.gateway_arrival_figures'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '0303: gateway_arrival_figures does not have row-level security on';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'public.gateway_arrival_figures', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION '0303: % may write gateway_arrival_figures; only refresh_gateway_arrivals() writes it', v_role;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.gateway_arrival_figures'::regclass AND polcmd <> 'r') THEN
    RAISE EXCEPTION '0303: gateway_arrival_figures has a write policy';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.gateway_arrival_figures'::regclass
                    AND polcmd = 'r' AND pg_get_expr(polqual, polrelid) LIKE '%gateways%') THEN
    RAISE EXCEPTION '0303: gateway_arrival_figures'' policy does not ask the gateways table';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['public.gateway_arrival_figures', 'public.gateway_arrivals'] LOOP
    IF has_table_privilege('anon', v_name, 'SELECT') OR NOT has_table_privilege('authenticated', v_name, 'SELECT') THEN
      RAISE EXCEPTION '0303: % must be readable by authenticated and by no one signed out', v_name;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.gateway_arrival_probe', 'SELECT')
     OR has_table_privilege('authenticated', 'public.gateway_arrival_probe', 'SELECT') THEN
    RAISE EXCEPTION '0303: an API role may read gateway_arrival_probe';
  END IF;

  -- The view runs as the reader, or it would show every gateway's row to anyone who could read it.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.gateway_arrivals'::regclass
                    AND 'security_invoker=true' = ANY (reloptions)) THEN
    RAISE EXCEPTION '0303: gateway_arrivals is not a security_invoker view';
  END IF;

  -- The collector is the database's own; the live read is the caller's.
  IF has_function_privilege('anon', 'public.refresh_gateway_arrivals()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.refresh_gateway_arrivals()', 'EXECUTE') THEN
    RAISE EXCEPTION '0303: an API role may execute refresh_gateway_arrivals()';
  END IF;
  IF has_function_privilege('anon', 'public.gateway_devices_last_reading(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.gateway_devices_last_reading(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0303: gateway_devices_last_reading() must be executable by authenticated and by no one signed out';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.gateway_devices_last_reading(uuid)'::regprocedure) THEN
    RAISE EXCEPTION '0303: gateway_devices_last_reading() is SECURITY DEFINER; it must read as the caller';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
