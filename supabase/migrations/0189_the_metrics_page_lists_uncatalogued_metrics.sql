-- 0189: The Metrics page lists the metric names devices declare that no catalog row describes.
--
-- Ingestion records the names a device's last DBIRTH declared in `devices.last_birth_metrics` and
-- never checks them against `metric_catalog`. `uncatalogued_metrics` is that comparison, one row per
-- name. The Metrics page's Uncatalogued tab reads it, and a Grafana panel or an alert rule can read
-- the same rows later. Reasoning: supabase/README.md, "Uncatalogued metrics (0189)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- The view
-- -------------------------------------------------------------------------------------------------
-- A name matches a catalog row exactly, case included, as the catalog's unique key, i3X and the AAS
-- export match it. A deprecated row is still a row. Archived devices and replay lanes are left out
-- with the fleet counts' predicate (platform_health_rows(), 0185); quarantined devices stay in, so a
-- metric can be catalogued before its device is approved. Sparkplug's control metrics are commands
-- to the edge node or device, not readings, and their names hold spaces the catalog refuses:
-- `Device Control/*` arrives in a DBIRTH (the gateway appliance sends `Device Control/Rebirth`), and
-- `bdSeq` and `Node Control/*` belong in an NBIRTH. `datatypes` are the codes the births carried
-- with a value (asset_config); a metric declared without one has none.
CREATE OR REPLACE VIEW public.uncatalogued_metrics WITH (security_invoker='true') AS
 SELECT m.metric_name,
    count(DISTINCT d.id)::integer AS device_count,
    jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name,
                                 'quarantined', coalesce(d.is_quarantined, false))
              ORDER BY d.name, d.id) AS devices,
    max(d.last_birth_metrics_at) AS last_declared_at,
    coalesce(array_agg(DISTINCT ac.datatype ORDER BY ac.datatype)
               FILTER (WHERE ac.datatype IS NOT NULL), '{}'::integer[]) AS datatypes
   FROM public.devices d
     JOIN public.gateways g ON g.id = d.gateway_id
     CROSS JOIN LATERAL ( SELECT DISTINCT u.name AS metric_name
           FROM unnest(d.last_birth_metrics) u(name)) m
     LEFT JOIN public.asset_config ac ON ac.asset_id = d.sparkplug_id AND ac.metric_name = m.metric_name
  WHERE NOT d.is_archived
    AND NOT g.is_shadow
    AND NULLIF(m.metric_name, '') IS NOT NULL
    AND m.metric_name <> 'bdSeq'
    AND NOT starts_with(m.metric_name, 'Node Control/')
    AND NOT starts_with(m.metric_name, 'Device Control/')
    AND NOT EXISTS ( SELECT 1
           FROM public.metric_catalog mc
          WHERE mc.name = m.metric_name)
  GROUP BY m.metric_name;

ALTER VIEW public.uncatalogued_metrics OWNER TO postgres;

COMMENT ON VIEW public.uncatalogued_metrics IS 'One row per metric name a device''s last DBIRTH declared that no metric_catalog row has, deprecated rows included, matched exactly: how many devices declare it, which (id, name, quarantined), the latest last_birth_metrics_at among them, and the datatype codes their births carried. Leaves out archived devices, replay lanes (devices of a shadow gateway) and the Sparkplug control metrics (bdSeq, Node Control/*, Device Control/*). security_invoker: the caller''s RLS on devices, gateways, asset_config and metric_catalog applies.';

-- Read as the tables beneath it are, by a signed-in caller under their own policies. anon holds
-- nothing.
REVOKE ALL ON TABLE public.uncatalogued_metrics FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.uncatalogued_metrics TO authenticated;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.uncatalogued_metrics'::regclass
                    AND 'security_invoker=true' = ANY (coalesce(reloptions, '{}'::text[]))) THEN
    RAISE EXCEPTION '0189: uncatalogued_metrics does not run as its caller; it would bypass the RLS on devices';
  END IF;
  IF has_table_privilege('anon', 'public.uncatalogued_metrics', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION '0189: anon holds a privilege on uncatalogued_metrics';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.uncatalogued_metrics', 'SELECT') THEN
    RAISE EXCEPTION '0189: authenticated may not read uncatalogued_metrics; the Metrics page reads it';
  END IF;
  IF has_table_privilege('authenticated', 'public.uncatalogued_metrics', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION '0189: authenticated holds a write privilege on uncatalogued_metrics';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
