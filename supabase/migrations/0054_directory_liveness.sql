-- =============================================================================================
-- 0054: the Directory reports liveness it has actually observed
-- =============================================================================================
--
-- `directory_services.status` and `.last_heartbeat` were never written by anything. The only
-- writes in the repository are `0002`'s seed INSERTs, and the seed contains the literal string
-- 'ACTIVE'. So every row said ACTIVE on every stack at every age, and `last_heartbeat` was the
-- moment the row was seeded -- not a moment anything was heard from.
--
-- THE GREEN PILL WAS THE MORE HARMFUL HALF, which is worth stating because the instinct is the
-- other way round. A stale date reads as stale and makes a reader suspicious on their own. A green
-- badge is BELIEVED, and it would have said ACTIVE for a service that had been down a week.
--
-- The Directory page has already corrected this exact class of fabrication once -- it used to
-- render a hardcoded SYNCED / a8f3e4b for Node-RED, removed because "nothing in the stack can
-- observe what Node-RED is running, so any such claim is fabricated". Same fabrication, same file,
-- two columns over.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT MAKES THIS POSSIBLE NOW, AND WHAT IT STILL CANNOT SEE
--
-- Prometheus scrapes six of the fifteen registered services and knows their true `up` state. The
-- other nine have no exporter, and this migration does NOT invent one for them: it writes UNKNOWN.
--
-- THAT IS THE POINT RATHER THAN A SHORTFALL. Replacing a fabricated ACTIVE with a fabricated probe
-- result would be the same defect wearing better clothes. `endpoint_url` holds BROWSER addresses --
-- `http://localhost:8088`, `postgres://localhost:54322` -- which from inside any container name the
-- container itself, so a TCP probe against them would be answering a question about the wrong host
-- and reporting it as service health. Nine rows say UNKNOWN because nine services are unobserved.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THERE IS NO EDGE FUNCTION HERE
--
-- The obvious shape is pg_cron calling an edge function that queries Prometheus and writes back.
-- It is not needed: `supabase-db` can reach `prometheus:9090` directly, and `pg_net` is already in
-- this schema (`0001`, `0006`, `0038`). Measured before choosing -- net.http_get() against the
-- Prometheus query API returns 200 with the whole `up` vector in one call.
--
-- So this is a migration and a cron entry, with no new deployable, no entry in the edge-function
-- router allow-list, and no thirteenth function to keep in the registry and the docs.
--
-- PG_NET IS ASYNCHRONOUS, and that shapes the function below. `net.http_get()` queues a request and
-- returns an id; the reply lands in `net._http_response` later. So each run does two things: it
-- COLLECTS the answer to the request the previous run fired, and then fires the next one. Status is
-- therefore one tick old, which at a one-minute schedule is well inside the staleness any of this
-- is trying to describe.
--
-- ---------------------------------------------------------------------------------------------
-- IDEMPOTENT. Every statement is guarded or re-runnable, and the cron entry is unscheduled before
-- it is scheduled -- `cron.schedule` APPENDS, as `0032` records having learned.
--
-- Related: 0002 (the seed that was the only writer), 0031/0032 (the cron idiom),
--          0038 (net.http_post, and why fire-and-forget needs a collector),
--          prometheus/prometheus.yml (the six jobs whose `up` is real), issue #48.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. The vocabulary
-- ---------------------------------------------------------------------------------------------
-- UNKNOWN IS THE DEFAULT, not ACTIVE. A row nothing has looked at yet has an unknown state, and
-- defaulting to ACTIVE is precisely how the previous behaviour came to be a lie that nobody wrote
-- on purpose.
ALTER TABLE public.directory_services
    ALTER COLUMN status SET DEFAULT 'UNKNOWN';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'directory_services_status_valid'
    ) THEN
        -- Existing rows are normalised first, or the constraint cannot be added to a table whose
        -- seed wrote a value it now forbids.
        UPDATE public.directory_services
           SET status = 'UNKNOWN'
         WHERE status NOT IN ('ACTIVE', 'DOWN', 'UNKNOWN');

        ALTER TABLE public.directory_services
            ADD CONSTRAINT directory_services_status_valid
            CHECK (status IN ('ACTIVE', 'DOWN', 'UNKNOWN'));
    END IF;
END $$;

COMMENT ON COLUMN public.directory_services.status IS
  'Observed liveness: ACTIVE (Prometheus reports up=1), DOWN (up=0), or UNKNOWN (nothing observes '
  'this service). Written only by refresh_directory_liveness(). UNKNOWN is not a failure -- nine of '
  'the fifteen registered services have no exporter, and saying so is the point.';

COMMENT ON COLUMN public.directory_services.last_heartbeat IS
  'When this service was last OBSERVED up. NULL whenever status is not ACTIVE, including UNKNOWN: a '
  'timestamp on a row nothing probes would imply a freshness it does not have, which is the defect '
  'this column had before 0054 -- it held the moment the row was seeded.';


-- ---------------------------------------------------------------------------------------------
-- 2. Which Prometheus job speaks for which service
-- ---------------------------------------------------------------------------------------------
-- A FUNCTION RATHER THAN A TABLE, deliberately. This is a mapping between two things that both
-- live in the repository -- scrape jobs in prometheus.yml and seeded rows in 0002 -- so it is
-- source, not data. A table would invite it to be edited in Studio and drift from both.
--
-- `kong` IS NOT HERE, AND THAT IS NOT AN OVERSIGHT. The gateway job was renamed `envoy` when
-- Compose migrated off Kong, and `supabase-rest` was added afterwards. Issue #48 lists the old
-- names; this list is against the file as it is now, and scripts/check-docs-drift.mjs asserts that
-- every job named here still exists in prometheus.yml.
CREATE OR REPLACE FUNCTION public.directory_liveness_job_map()
    RETURNS TABLE (prometheus_job text, service_name text)
    LANGUAGE sql IMMUTABLE
    AS $fn$
    SELECT * FROM (VALUES
        ('prometheus',    'Prometheus Metrics Store'),
        ('grafana',       'Grafana Dashboards'),
        ('ingestion',     'Ingestion Metrics Endpoint'),
        ('node',          'Host Metrics Exporter (node_exporter)'),
        ('envoy',         'Supabase API Gateway (Kong)'),
        ('supabase-rest', 'Supabase PostgREST API')
    ) AS t(prometheus_job, service_name);
$fn$;

COMMENT ON FUNCTION public.directory_liveness_job_map() IS
  'Prometheus scrape job -> directory_services.service_name, for the six services whose liveness is '
  'genuinely observed. Everything not named here is written UNKNOWN.';


-- ---------------------------------------------------------------------------------------------
-- 3. Where the in-flight request id lives
-- ---------------------------------------------------------------------------------------------
-- ONE ROW, and it is infrastructure rather than settings: no page reads it and PostgREST has no
-- business exposing it. Same posture as one_shot_migrations -- RLS on with no policy denies every
-- application role, and the migration owner writes it.
CREATE TABLE IF NOT EXISTS public.directory_liveness_probe (
    id           boolean PRIMARY KEY DEFAULT true CHECK (id),
    request_id   bigint,
    requested_at timestamptz
);

ALTER TABLE public.directory_liveness_probe ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.directory_liveness_probe FROM anon, authenticated;

INSERT INTO public.directory_liveness_probe (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.directory_liveness_probe IS
  'The single in-flight pg_net request id for the Prometheus liveness probe. One row by CHECK (id), '
  'because two concurrent probes would race to write the same directory rows from different '
  'observations.';


-- ---------------------------------------------------------------------------------------------
-- 4. The writer
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_directory_liveness()
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'net'
    AS $fn$
DECLARE
    v_prev      bigint;
    v_status    integer;
    v_body      jsonb;
    v_observed  integer := 0;
    v_url       CONSTANT text := 'http://prometheus:9090/api/v1/query?query=up';
BEGIN
    SELECT request_id INTO v_prev FROM public.directory_liveness_probe WHERE id;

    -- ---- Collect the previous run's answer, if there was one. --------------------------------
    IF v_prev IS NOT NULL THEN
        SELECT status_code, CASE WHEN content IS NULL THEN NULL ELSE content::jsonb END
          INTO v_status, v_body
          FROM net._http_response WHERE id = v_prev;

        -- A 200 WITH A BODY IS THE ONLY THING THAT WRITES ACTIVE. Every other outcome -- no row
        -- yet, a timeout, a non-200, unparseable content -- falls through to the UNKNOWN sweep
        -- below. Leaving the previous values in place would be the original defect again: a status
        -- that describes an observation nobody made.
        IF v_status = 200 AND v_body IS NOT NULL AND v_body->>'status' = 'success' THEN
            WITH observed AS (
                SELECT r->'metric'->>'job'  AS job,
                       (r->'value'->>1)     AS up
                  FROM jsonb_array_elements(v_body->'data'->'result') AS r
            ), mapped AS (
                SELECT m.service_name, o.up
                  FROM public.directory_liveness_job_map() m
                  JOIN observed o ON o.job = m.prometheus_job
            )
            UPDATE public.directory_services d
               SET status = CASE WHEN mapped.up = '1' THEN 'ACTIVE' ELSE 'DOWN' END,
                   -- ONLY AN UP READING MOVES THE HEARTBEAT. For DOWN it is cleared rather than
                   -- frozen: "last seen at X" and "not up now" are different claims, and a
                   -- lingering timestamp beside a red status reads as the former.
                   last_heartbeat = CASE WHEN mapped.up = '1' THEN now() ELSE NULL END
              FROM mapped
             WHERE d.service_name = mapped.service_name;

            GET DIAGNOSTICS v_observed = ROW_COUNT;
        END IF;
    END IF;

    -- ---- Everything unobserved is set UNKNOWN on EVERY run. ----------------------------------
    -- Not only on the first. If a job disappears from prometheus.yml, or a service is renamed so
    -- the map stops matching, its row must fall back to UNKNOWN rather than keeping the last
    -- ACTIVE it was ever given -- which would be a fabricated status with a real timestamp, the
    -- most convincing kind.
    UPDATE public.directory_services
       SET status = 'UNKNOWN', last_heartbeat = NULL
     WHERE service_name NOT IN (SELECT service_name FROM public.directory_liveness_job_map())
       AND (status <> 'UNKNOWN' OR last_heartbeat IS NOT NULL);

    -- ---- Fire the next request. ---------------------------------------------------------------
    -- AFTER the collection, so a failure above does not cost this run its probe.
    UPDATE public.directory_liveness_probe
       SET request_id = net.http_get(v_url, timeout_milliseconds := 4000),
           requested_at = now()
     WHERE id;

    RETURN v_observed;
END;
$fn$;

COMMENT ON FUNCTION public.refresh_directory_liveness() IS
  'Collects the previous Prometheus `up` probe, writes ACTIVE/DOWN for the six observed services '
  'and UNKNOWN for the rest, then queues the next probe. Returns how many rows were written from a '
  'real observation. Run every minute by cron; safe to call by hand.';

REVOKE ALL ON FUNCTION public.refresh_directory_liveness() FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- 5. The schedule
-- ---------------------------------------------------------------------------------------------
-- UNSCHEDULED BEFORE SCHEDULED. `cron.schedule` APPENDS, so replaying this file on every boot
-- would otherwise accumulate a duplicate job per boot -- which 0032 records having found.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-directory-liveness') THEN
        PERFORM cron.unschedule('refresh-directory-liveness');
    END IF;

    PERFORM cron.schedule(
        'refresh-directory-liveness',
        '* * * * *',
        'SELECT public.refresh_directory_liveness()'
    );
END $$;


-- ---------------------------------------------------------------------------------------------
-- 6. Self-check
-- ---------------------------------------------------------------------------------------------
-- WHAT IS WORTH ASSERTING is that the map names services that exist. A typo there is silent: the
-- JOIN simply matches nothing, the service falls into the UNKNOWN sweep, and the page shows
-- "not observed" for something Prometheus is scraping perfectly well. That reads as a monitoring
-- gap rather than a spelling mistake.
DO $selfcheck$
DECLARE
    v_missing text;
BEGIN
    SELECT string_agg(m.service_name, ', ') INTO v_missing
      FROM public.directory_liveness_job_map() m
     WHERE NOT EXISTS (
        SELECT 1 FROM public.directory_services d WHERE d.service_name = m.service_name
     );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
          '0054 self-check: directory_liveness_job_map() names service(s) that do not exist in '
          'directory_services: %. The join would match nothing and the page would report them as '
          'unobserved, which reads as a missing exporter rather than a typo.', v_missing;
    END IF;

    RAISE NOTICE
      '0054 self-check: the liveness map names % service(s), all of which exist.',
      (SELECT count(*) FROM public.directory_liveness_job_map());
END;
$selfcheck$;
