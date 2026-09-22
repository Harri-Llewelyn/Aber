-- 0103: the Directory's liveness map names the scrape jobs as the collector labels them.
--
-- directory_liveness_job_map() joins a Prometheus `job` label to a directory_services row, and a
-- service whose job it does not name reads UNKNOWN on the Directory page. The map named `envoy`,
-- which was the job the retired Compose scrape config gave the gateway; the chart's Alloy labels
-- every scraped pod's job with its component name, so the gateway is `supabase-envoy`. The other
-- five names were already the component names. Idempotent: CREATE OR REPLACE of one IMMUTABLE
-- function, the same shape 0001 declares.

CREATE OR REPLACE FUNCTION public.directory_liveness_job_map() RETURNS TABLE(prometheus_job text, service_name text)
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT * FROM (VALUES
        ('prometheus',     'Prometheus Metrics Store'),
        ('grafana',        'Grafana Dashboards'),
        ('ingestion',      'Ingestion Metrics Endpoint'),
        ('node',           'Host Metrics Exporter (node_exporter)'),
        ('supabase-envoy', 'Supabase API Gateway (Envoy)'),
        ('supabase-rest',  'Supabase PostgREST API')
    ) AS t(prometheus_job, service_name);
$$;

COMMENT ON FUNCTION public.directory_liveness_job_map() IS 'Prometheus scrape job -> directory_services.service_name, for the six services whose liveness is genuinely observed. The job is the pod''s component name, as the chart''s Alloy labels it. Everything not named here is written UNKNOWN.';
