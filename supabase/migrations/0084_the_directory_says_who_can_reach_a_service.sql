-- 0084: the directory records what can reach a service, not only where it lives.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT WAS WRONG
--
-- `directory_services` held an address and no statement of who could use it, so the page rendering
-- those rows had to guess. `isBrowsableEndpoint` in DirectoryTab.jsx guesses well, and the guess is
-- the right one for the question it can answer -- scheme plus host tells you whether a string is a
-- WEB PAGE, and that is genuinely all a URL carries. It cannot tell you whether the browser reading
-- it can reach that page, because nothing in this table said.
--
-- Four of these rows are now bound to `127.0.0.1` in docker-compose.yml: both databases, Prometheus
-- and the ingestion metrics endpoint. Two of the four are `http://localhost:...`, so the scheme-and-
-- host test says "web page", correctly, and the page renders a link. That link works for a browser
-- running ON the deployment host and fails for every other browser -- and the dashboard is published
-- on :3000 for exactly those other browsers. The failure looks like the service being down.
--
-- That is the same failure the container-hostname clause was written to avoid.
-- `http://node-exporter:9100/metrics` was given a copy button rather than a link because "a link
-- that cannot resolve costs a failed tab and a wrong conclusion about the stack". A loopback-bound
-- port costs the same thing for the same reason; the address just happens to be spelled in a way
-- that test could not catch.
--
-- =================================================================================================
-- THREE VALUES, AND THEY DESCRIBE THE PORT RATHER THAN THE URL
--
--   NETWORK   published on every interface. Another machine can reach it, subject to the firewall
--             and to DNS, neither of which this stack controls or claims to.
--   HOST      published on 127.0.0.1 only. The deployment host, or an SSH tunnel from anywhere else.
--   INTERNAL  no host port at all. Reachable from inside the container network by service name and
--             from nowhere outside it.
--   UNKNOWN   not recorded. The default, and the reason the column is not nullable -- see below.
--
-- THE PORT, NOT THE URL, AND THE TWO CAN DISAGREE. `Supabase Studio` is NETWORK: supabase-envoy
-- publishes 54323 on every interface and holds the console behind an OAuth flow and an
-- `Administrator` check (0081). Its `endpoint_url` still reads `http://127.0.0.1:54323`, because
-- that is the STUDIO_PUBLIC_URL default and an operator sets it to a real hostname when the
-- deployment has one. Both facts are true at once and neither substitutes for the other, which is
-- why the consuming page tests the URL's own host as well as this column: a loopback ADDRESS cannot
-- work from a remote browser however broadly the PORT is published.
--
-- UNKNOWN RATHER THAN NULL, and rather than assuming. `directory_services` is a registry anything
-- may insert into -- the same reason DirectoryTab derives its groups from the rows instead of
-- hardcoding them -- so a row will eventually arrive from something that never heard of this
-- column. Defaulting to NETWORK would have the page offer a link on a service nobody has checked;
-- defaulting to INTERNAL would hide a service that is running and reachable. UNKNOWN says the thing
-- that is actually true, and matches what `status` already does for the same reason (0054).
--
-- THIS DESCRIBES THE COMPOSE DEPLOYMENT THE SEED DESCRIBES, and is deliberately an ordinary column
-- rather than anything derived. On Kubernetes these rows are wrong before this column is reached --
-- their `endpoint_url` says `localhost` and the chart serves `grafana.<publicBaseDomain>` through an
-- Ingress -- and that is a larger problem this migration does not pretend to solve. What it does do
-- is make the wrongness quieter: a row marked HOST offers a copy button and a tunnel hint instead of
-- a link that was never going to work.
-- =================================================================================================

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
-- The fifteen seeded rows.
--
-- KEYED ON id, NOT service_name. 0016 renames two of these, and a name-keyed UPDATE against a
-- database seeded before that rename matches nothing, and says nothing about having matched nothing.
-- The ids are stable and 0002 inserts them explicitly.
--
-- Every value here is read off the `ports:` blocks in docker-compose.yml. Where that file binds
-- 127.0.0.1 the row is HOST; where a service has no `ports:` at all the row is INTERNAL.
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
