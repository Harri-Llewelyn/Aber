-- 0127: the Directory observes both databases.
--
-- Every service in directory_liveness_job_map() reads its liveness from a Prometheus `up` series;
-- a service the map does not name is written UNKNOWN. Both databases were in that position, and
-- honestly so -- nothing scraped them. A postgres_exporter sidecar now runs in each database pod
-- and Alloy labels each scraped pod's `job` with its component, so `supabase-db` and `timescaledb`
-- are jobs that exist and these two rows join to them.
--
-- THE SERVICE NAMES MUST MATCH directory_services.service_name EXACTLY, because that column is
-- what the join uses. 'Supabase PostgreSQL' and 'TimescaleDB Telemetry Store' are the rows seeded
-- by 0002; a near-miss here leaves the page reading UNKNOWN against a database that is being
-- scraped, which is the harder fault to see of the two.
--
-- Idempotent: CREATE OR REPLACE of one IMMUTABLE function, the same shape 0001 declares and 0103
-- last replaced.

CREATE OR REPLACE FUNCTION public.directory_liveness_job_map() RETURNS TABLE(prometheus_job text, service_name text)
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT * FROM (VALUES
        ('prometheus',     'Prometheus Metrics Store'),
        ('grafana',        'Grafana Dashboards'),
        ('ingestion',      'Ingestion Metrics Endpoint'),
        ('node',           'Host Metrics Exporter (node_exporter)'),
        ('supabase-envoy', 'Supabase API Gateway (Envoy)'),
        ('supabase-rest',  'Supabase PostgREST API'),
        ('supabase-db',    'Supabase PostgreSQL'),
        ('timescaledb',    'TimescaleDB Telemetry Store')
    ) AS t(prometheus_job, service_name);
$$;

COMMENT ON FUNCTION public.directory_liveness_job_map() IS 'Prometheus scrape job -> directory_services.service_name, for the eight services whose liveness is genuinely observed. The job is the pod''s component name, as the chart''s Alloy labels it. Everything not named here is written UNKNOWN.';
