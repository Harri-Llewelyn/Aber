-- 0214: Each device shows its place in the Unified Namespace, or why it has none.
--
-- The bridge (ingestion/uns_publish.py) built a device's topic from four reads of its own, and the
-- dashboard showed nothing. `device_uns_paths` works the path out once, per device: its path below
-- the root, `<enterprise>/<site>/<area>/<cell>/<device>` at the levels the device occupies, or the
-- reason it has none. The bridge reads it behind its TTL cache; the Devices, Areas and Cells pages
-- read it to show a topic, a subscription filter, a skip reason and what a rename moves.
--
-- Reasoning: supabase/README.md, "Each device shows its place in the Unified Namespace (0214)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- The view
-- -------------------------------------------------------------------------------------------------
-- The rule is the bridge's, in its order: no site name first, then the Simulated and Shadow lanes,
-- then no location, then a cell in no area, then any segment that is empty or holds / + or #. The
-- enterprise is the group the gateway last published under, else its configured one; a device with
-- no gateway takes the site's group, as a new gateway does. The bridge publishes under the group the
-- message arrived on, so it swaps the first segment, which this view always spells as `enterprise`.
-- The site name is trimmed of spaces, tabs and line breaks.
CREATE OR REPLACE VIEW public.device_uns_paths WITH (security_invoker='true') AS
 SELECT p.device_id,
    p.area_id,
    p.cell_id,
    p.enterprise,
        CASE
            WHEN r.skip_reason IS NULL THEN array_to_string(p.segments, '/'::text)
            ELSE NULL::text
        END AS uns_path,
    r.skip_reason
   FROM ( SELECT dl.device_id,
            dl.location_source,
            dl.effective_area_id AS area_id,
            dl.effective_cell_id AS cell_id,
            e.enterprise,
            s.site,
                CASE dl.location_source
                    WHEN 'site_wide'::text THEN ARRAY[e.enterprise, s.site, d.name]
                    WHEN 'area_wide'::text THEN ARRAY[e.enterprise, s.site, a.name, d.name]
                    ELSE ARRAY[e.enterprise, s.site, a.name, c.name, d.name]
                END AS segments
           FROM public.device_locations dl
             JOIN public.devices d ON d.id = dl.device_id
             LEFT JOIN public.gateways g ON g.id = dl.gateway_id
             LEFT JOIN public.areas a ON a.id = dl.effective_area_id
             LEFT JOIN public.cells c ON c.id = dl.effective_cell_id
             CROSS JOIN LATERAL ( SELECT COALESCE(g.observed_sparkplug_group, g.sparkplug_group,
                    ( SELECT NULLIF(v.value #>> '{}'::text[], ''::text)
                           FROM public.system_settings v
                          WHERE v.key = 'sparkplug.group_id'::text)) AS enterprise) e
             CROSS JOIN ( SELECT ( SELECT NULLIF(btrim(v.value #>> '{}'::text[], E' \t\n\x0B\f\r'::text), ''::text)
                           FROM public.system_settings v
                          WHERE v.key = 'site.name'::text AND jsonb_typeof(v.value) = 'string'::text) AS site) s) p
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN p.site IS NULL THEN 'site_unset'::text
                    WHEN p.location_source = ANY (ARRAY['shadow'::text, 'simulated'::text]) THEN 'lane'::text
                    WHEN p.location_source = 'unassigned'::text THEN 'unassigned'::text
                    WHEN p.location_source = ANY (ARRAY['explicit'::text, 'inherited'::text])
                         AND p.area_id IS NULL THEN 'cell_unfiled'::text
                    WHEN EXISTS ( SELECT 1
                           FROM unnest(p.segments) seg(name)
                          WHERE seg.name IS NULL OR seg.name = ''::text OR seg.name ~ '[/+#]'::text) THEN 'unsafe_name'::text
                    ELSE NULL::text
                END AS skip_reason) r;

ALTER VIEW public.device_uns_paths OWNER TO postgres;

COMMENT ON VIEW public.device_uns_paths IS 'Each device''s place in the Unified Namespace: uns_path, its path below the bridge''s root (<enterprise>/<site>/<area>/<cell>/<device>, without the levels it does not occupy), or skip_reason, why it has none: site_unset, lane, unassigned, cell_unfiled or unsafe_name, in that order. Exactly one is set. enterprise is the gateway''s observed_sparkplug_group, else its sparkplug_group, else the sparkplug.group_id setting, and uns_path always starts with it and a slash. area_id and cell_id are device_locations'' effective ones. The UNS bridge (ingestion/uns_publish.py) and the dashboard read it. security_invoker: the caller''s RLS on devices, gateways, cells, areas and system_settings applies (0214).';

-- Read as the tables beneath it are, by a signed-in caller under their own policies, the ingestion
-- principal included. anon holds nothing.
REVOKE ALL ON TABLE public.device_uns_paths FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.device_uns_paths TO authenticated;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_columns text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.device_uns_paths'::regclass
                    AND 'security_invoker=true' = ANY (coalesce(reloptions, '{}'::text[]))) THEN
    RAISE EXCEPTION '0214: device_uns_paths does not run as its caller; it would bypass the RLS on devices';
  END IF;
  IF has_table_privilege('anon', 'public.device_uns_paths', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION '0214: anon holds a privilege on device_uns_paths';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.device_uns_paths', 'SELECT') THEN
    RAISE EXCEPTION '0214: authenticated may not read device_uns_paths; the UNS bridge and the dashboard read it';
  END IF;
  IF has_table_privilege('authenticated', 'public.device_uns_paths', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION '0214: authenticated holds a write privilege on device_uns_paths';
  END IF;

  -- The bridge selects these by name.
  SELECT string_agg(attname, ',' ORDER BY attnum) INTO v_columns
    FROM pg_attribute
   WHERE attrelid = 'public.device_uns_paths'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_columns IS DISTINCT FROM 'device_id,area_id,cell_id,enterprise,uns_path,skip_reason' THEN
    RAISE EXCEPTION '0214: device_uns_paths has the columns %, not the ones ingestion/uns_publish.py reads', v_columns;
  END IF;

  -- Over whatever rows exist: one row per device, a path or a reason and never both, a reason from
  -- the bridge's set, and a path that starts with its enterprise.
  IF EXISTS (SELECT 1 FROM public.device_uns_paths GROUP BY device_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0214: device_uns_paths answers some device twice';
  END IF;
  IF EXISTS (SELECT 1 FROM public.device_uns_paths
              WHERE (uns_path IS NULL) = (skip_reason IS NULL)
                 OR skip_reason NOT IN ('site_unset', 'lane', 'unassigned', 'cell_unfiled', 'unsafe_name')
                 OR NOT starts_with(uns_path, enterprise || '/')) THEN
    RAISE EXCEPTION '0214: device_uns_paths answers some device with both a path and a reason, neither, a reason the bridge does not count, or a path that does not start with its enterprise';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
