-- 0084: the directory records what can reach a service, not only where it lives.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- `directory_services` held an address and no statement of who could use it. The seed's rows
-- described a loopback deployment, and two of them are `http://localhost:...`, which the page's
-- scheme-and-host test renders as a link that works only on the deployment host and looks like
-- the service being down anywhere else.
--
-- `exposure` describes the port, not the URL:
--   NETWORK   published on every interface.
--   HOST      published on 127.0.0.1 only: the deployment host, or an SSH tunnel.
--   INTERNAL  no host port; reachable inside the container network by service name.
--   UNKNOWN   not recorded. The default, so a row inserted by something that never heard of the
--             column neither offers an unchecked link nor hides a reachable service.
-- The two can disagree: Studio is NETWORK (the gateway publishes 54323 on every interface behind
-- a login) while its `endpoint_url` is the STUDIO_PUBLIC_URL default, so the page tests the
-- URL's host as well.
--
-- This describes the loopback deployment the seed describes; 0085 derives the browser-facing
-- rows from the chart's values.

ALTER TABLE public.directory_services
    ADD COLUMN IF NOT EXISTS exposure text DEFAULT 'UNKNOWN'::text NOT NULL;

-- Dropped and recreated rather than added conditionally: the value set is the part of this most
-- likely to change, and a replay must land the CURRENT set rather than skip because an older one
-- is already present.
ALTER TABLE public.directory_services
    DROP CONSTRAINT IF EXISTS directory_services_exposure_valid;

ALTER TABLE public.directory_services
    ADD CONSTRAINT directory_services_exposure_valid
    CHECK (exposure = ANY (ARRAY['NETWORK'::text, 'HOST'::text, 'INTERNAL'::text, 'UNKNOWN'::text]));

COMMENT ON COLUMN public.directory_services.exposure IS
    'Where this service can be reached FROM, as a property of its port binding rather than of its URL: NETWORK (published on every interface), HOST (bound to 127.0.0.1 -- the deployment host or an SSH tunnel), INTERNAL (no host port; container network only), UNKNOWN (not recorded). Describes the Compose deployment the seed describes; a deployment that publishes differently updates it. Consumed by the Directory page, which combines it with the URL''s own host -- a loopback ADDRESS cannot work from a remote browser however broadly the PORT is published.';

-- -------------------------------------------------------------------------------------------------
-- The fifteen seeded rows, keyed on id, not service_name: 0016 renames two of these. Every value
-- is the seed's loopback deployment as it was bound: 127.0.0.1 is HOST, no published port is
-- INTERNAL.
-- -------------------------------------------------------------------------------------------------
UPDATE public.directory_services SET exposure = v.exposure
FROM (VALUES
    -- NETWORK -- published on every interface.
    ('f1111111-0000-0000-0000-000000000001'::uuid, 'NETWORK'),  -- Studio, via envoy's 54323 listener
    ('f1111111-0000-0000-0000-000000000003'::uuid, 'NETWORK'),  -- Node-RED, 1880
    ('f1111111-0000-0000-0000-000000000004'::uuid, 'NETWORK'),  -- Mosquitto, 1883/9001/8883
    ('f1111111-0000-0000-0000-000000000006'::uuid, 'NETWORK'),  -- Grafana, 3002
    ('f1111111-0000-0000-0000-000000000007'::uuid, 'NETWORK'),  -- the gateway itself, 54321
    ('f1111111-0000-0000-0000-000000000008'::uuid, 'NETWORK'),  -- GoTrue, through that gateway
    ('f1111111-0000-0000-0000-000000000009'::uuid, 'NETWORK'),  -- PostgREST, likewise
    ('f1111111-0000-0000-0000-00000000000a'::uuid, 'NETWORK'),  -- Edge Functions, likewise
    ('f1111111-0000-0000-0000-00000000000d'::uuid, 'NETWORK'),  -- Swagger UI, 8088

    -- HOST -- bound to 127.0.0.1. All four were narrowed together, against the rule stated beside
    -- prometheus's port: a port is published broadly because it either AUTHENTICATES a browser
    -- session or is a PROTOCOL ENDPOINT that has to be reachable. None of these four is either.
    ('f1111111-0000-0000-0000-000000000005'::uuid, 'HOST'),     -- TimescaleDB, 127.0.0.1:5433
    ('f1111111-0000-0000-0000-00000000000b'::uuid, 'HOST'),     -- Supabase Postgres, 127.0.0.1:54322
    ('f1111111-0000-0000-0000-00000000000e'::uuid, 'HOST'),     -- Prometheus, 127.0.0.1:9090
    ('f1111111-0000-0000-0000-000000000010'::uuid, 'HOST'),     -- ingestion metrics, 127.0.0.1:9108

    -- INTERNAL -- no host port. Both already rendered as copy buttons because their hosts are
    -- container names; this records WHY, rather than leaving the page to infer it from the spelling.
    ('f1111111-0000-0000-0000-00000000000c'::uuid, 'INTERNAL'), -- ingestion's broker subscription
    ('f1111111-0000-0000-0000-00000000000f'::uuid, 'INTERNAL')  -- node_exporter, deliberately unpublished
) AS v(id, exposure)
WHERE public.directory_services.id = v.id
  AND public.directory_services.exposure IS DISTINCT FROM v.exposure;
