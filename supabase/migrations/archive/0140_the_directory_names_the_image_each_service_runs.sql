-- =============================================================================================
-- Migration: 0140_the_directory_names_the_image_each_service_runs.sql (applied as 0007 until the 1.0 squash)
-- The Directory shows the version of each service the release deploys
-- =============================================================================================
--
-- `directory_services.image` holds the image reference the chart renders for the row's workload.
-- db-init passes the chart's map as `directory_images` (JSON, component -> image) on every run, so
-- the column follows each install and upgrade. It is the release's pin, not an observation of the
-- running pod.
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

ALTER TABLE public.directory_services ADD COLUMN IF NOT EXISTS image text;

COMMENT ON COLUMN public.directory_services.image IS
  'The image reference (repository:tag) this release deploys for the service, as the chart renders '
  'it. Written by record_directory_images() on every db-init run; NULL when the chart does not '
  'deploy the service or nothing has recorded it.';

-- Each chart-managed row and the component (app.kubernetes.io/component) whose image serves it.
-- The Host Metrics Exporter row is Alloy, which runs node_exporter's collectors in-process.
-- check-docs-drift.mjs holds this list equal to the chart's `aber.directoryImages`.
CREATE OR REPLACE FUNCTION public.record_directory_images(p_images jsonb)
RETURNS integer
    LANGUAGE sql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    WITH served_by(id, component) AS (VALUES
        ('f1111111-0000-0000-0000-000000000001'::uuid, 'supabase-studio'),
        ('f1111111-0000-0000-0000-000000000003'::uuid, 'node-red'),
        ('f1111111-0000-0000-0000-000000000004'::uuid, 'mosquitto'),
        ('f1111111-0000-0000-0000-000000000005'::uuid, 'timescaledb'),
        ('f1111111-0000-0000-0000-000000000006'::uuid, 'grafana'),
        ('f1111111-0000-0000-0000-000000000007'::uuid, 'supabase-envoy'),
        ('f1111111-0000-0000-0000-000000000008'::uuid, 'supabase-auth'),
        ('f1111111-0000-0000-0000-000000000009'::uuid, 'supabase-rest'),
        ('f1111111-0000-0000-0000-00000000000a'::uuid, 'supabase-functions'),
        ('f1111111-0000-0000-0000-00000000000b'::uuid, 'supabase-db'),
        ('f1111111-0000-0000-0000-00000000000c'::uuid, 'ingestion'),
        ('f1111111-0000-0000-0000-00000000000d'::uuid, 'swagger-ui'),
        ('f1111111-0000-0000-0000-00000000000e'::uuid, 'prometheus'),
        ('f1111111-0000-0000-0000-00000000000f'::uuid, 'alloy'),
        ('f1111111-0000-0000-0000-000000000010'::uuid, 'ingestion'),
        ('f1111111-0000-0000-0000-000000000011'::uuid, 'gitea')
    ), changed AS (
        -- A component missing from the map clears its row: the chart no longer deploys it, and
        -- the previous release's version would otherwise stay on the page.
        UPDATE public.directory_services d
           SET image = NULLIF(p_images ->> s.component, '')
          FROM served_by s
         WHERE d.id = s.id
           AND d.image IS DISTINCT FROM NULLIF(p_images ->> s.component, '')
        RETURNING 1
    )
    SELECT count(*)::integer FROM changed;
$$;

ALTER FUNCTION public.record_directory_images(jsonb) OWNER TO postgres;

COMMENT ON FUNCTION public.record_directory_images(jsonb) IS
  'Writes directory_services.image for the chart-managed rows from a component -> image map, '
  'clearing rows whose component is absent. Leaves every other row alone. Returns how many rows '
  'changed. Called by this migration with the chart''s map; db-init runs it as postgres.';

-- Only db-init calls it, as the owner. Revoked BY NAME rather than by re-running the anon sweep,
-- which would strip the auth_pre_request() grant 0001 restates after its own sweep.
REVOKE ALL ON FUNCTION public.record_directory_images(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- psql does not substitute variables inside dollar quotes, so the map is read here. A runner that
-- passes no map (test:db, the schema-equivalence check) records nothing and clears nothing.
\if :{?directory_images} \else \set directory_images '' \endif

SELECT public.record_directory_images(m.images) AS directory_images_changed
  FROM (SELECT NULLIF(:'directory_images', '')::jsonb AS images) m
 WHERE m.images IS NOT NULL;
