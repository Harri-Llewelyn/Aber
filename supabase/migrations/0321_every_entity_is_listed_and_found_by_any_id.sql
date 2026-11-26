-- 0321: Every entity is listed and found by any id.
--
-- Nothing answered "what is this id?". The Audit Trail's search matches an entity id, and finds only
-- what has audit rows; entityUrl() in the dashboard knows five kinds. Nothing listed what is in service
-- either: the one page that lists entities of several kinds held only what was taken out.
--
--   * entity_directory: one row for each thing a page of the dashboard lists by its id. Areas, cells,
--     gateways, devices, schema versions, metrics, captures, backups, automations and the machine
--     identities an Administrator made, with the areas, cells, gateways and devices deleted from the
--     archive (retired_entities). A row has its id, the further ids it goes by, its state in the archive
--     lifecycle, where it is, and what its own page opens it by. It runs as its caller, so the policies of
--     the tables beneath decide the rows.
--   * find_entities(): the rows one text names. A whole id, the start of one (8 characters or more), or
--     any part of a name, a whole id first. It runs as its caller too, and reads the view. With p_per_kind
--     it answers at most that many rows of each kind, so one kind cannot fill the answer.
--   * A replay lane is a recording of a device, so a live one is not listed. An archived one is, because the
--     Archived tab lists it. People are not listed: nothing but a SECURITY DEFINER function reads them.
--   * That page is now Entities, so the two comments that name it say so.
--
-- Reasoning: supabase/README.md, "Every entity is listed and found by any id (0321)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The view
-- -------------------------------------------------------------------------------------------------
-- `kind` is the word audit_trail.entity_type uses. `state` is the archive lifecycle's: only an area, a cell,
-- a gateway or a device is ever archived or retired, so a superseded schema version and a deprecated metric
-- are active, and `variant` says what they are. `second_ids` are ids alone, the row's own: a capture's
-- subject is in `gateway_id` or `device_id`, so a device's id finds the device and not its captures.
CREATE OR REPLACE VIEW public.entity_directory WITH (security_invoker='true') AS
 SELECT 'areas'::text AS kind,
    (a.id)::text AS id,
    a.name,
    a.description,
        CASE
            WHEN a.is_archived THEN 'archived'::text
            ELSE 'active'::text
        END AS state,
    NULL::text AS variant,
    '{}'::text[] AS second_ids,
    NULL::uuid AS area_id,
    NULL::uuid AS cell_id,
    NULL::uuid AS gateway_id,
    NULL::uuid AS device_id,
    (a.id)::text AS page_id
   FROM public.areas a
UNION ALL
 SELECT 'cells'::text,
    (c.id)::text,
    c.name,
    c.description,
        CASE
            WHEN COALESCE(c.is_archived, false) THEN 'archived'::text
            ELSE 'active'::text
        END,
    NULL::text,
    '{}'::text[],
    c.area_id,
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    (c.id)::text
   FROM public.cells c
UNION ALL
 SELECT 'gateways'::text,
    (g.id)::text,
    g.name,
    g.description,
        CASE
            WHEN COALESCE(g.is_archived, false) THEN 'archived'::text
            ELSE 'active'::text
        END,
        CASE
            WHEN g.is_shadow THEN 'playback'::text
            ELSE NULL::text
        END,
    array_remove(ARRAY[g.sparkplug_id], NULL::text),
    COALESCE(g.area_id, c.area_id),
    g.cell_id,
    NULL::uuid,
    NULL::uuid,
    (g.id)::text
   FROM public.gateways g
     LEFT JOIN public.cells c ON c.id = g.cell_id
UNION ALL
 SELECT 'devices'::text,
    (d.id)::text,
    d.name,
    d.description,
        CASE
            WHEN COALESCE(d.is_archived, false) THEN 'archived'::text
            ELSE 'active'::text
        END,
        CASE
            WHEN d.shadow_of IS NOT NULL THEN 'replay_lane'::text
            WHEN COALESCE(d.is_quarantined, false) THEN 'quarantined'::text
            ELSE NULL::text
        END,
    array_remove(ARRAY[d.sparkplug_id, NULLIF(d.reported_identity, d.sparkplug_id)], NULL::text),
    dl.effective_area_id,
    dl.effective_cell_id,
    d.gateway_id,
    NULL::uuid,
    (d.id)::text
   FROM public.devices d
     LEFT JOIN public.device_locations dl ON dl.device_id = d.id
  WHERE d.shadow_of IS NULL OR COALESCE(d.is_archived, false)
UNION ALL
 SELECT 'schemas'::text,
    (s.id)::text,
    s.schema_name,
    s.description,
    'active'::text,
    (s.status)::text,
    array_remove(ARRAY[s.semantic_id], NULL::text),
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    (s.id)::text
   FROM public.schemas s
UNION ALL
 SELECT 'metric_catalog'::text,
    (m.id)::text,
    m.name,
    m.description,
    'active'::text,
        CASE
            WHEN m.deprecated THEN 'deprecated'::text
            WHEN m.derivation IS NOT NULL THEN 'derived'::text
            ELSE NULL::text
        END,
    array_remove(m.semantic_id || ARRAY( SELECT i.semantic_id
           FROM public.metric_semantic_ids i
          WHERE i.metric_id = m.id AND i.semantic_id IS DISTINCT FROM m.semantic_id
          ORDER BY i.semantic_id), NULL::text),
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    (m.id)::text
   FROM public.metric_catalog m
UNION ALL
 SELECT 'captures'::text,
    (k.id)::text,
    COALESCE(d.name, g.name, k.subject_sparkplug_id),
    k.note,
    'active'::text,
    k.subject_kind,
    ARRAY[k.storage_path],
    NULL::uuid,
    NULL::uuid,
    k.gateway_id,
    k.device_id,
    (COALESCE(k.device_id, k.gateway_id))::text
   FROM public.captures k
     LEFT JOIN public.devices d ON d.id = k.device_id
     LEFT JOIN public.gateways g ON g.id = k.gateway_id
UNION ALL
 SELECT 'backups'::text,
    (b.id)::text,
    b.stamp,
    b.note,
    'active'::text,
    b.origin,
    ARRAY[b.stamp],
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    (b.job_id)::text
   FROM public.backups b
UNION ALL
 SELECT 'automations'::text,
    (u.id)::text,
    u.alias,
    NULLIF(u.description, ''::text),
    'active'::text,
        CASE
            WHEN u.enabled THEN NULL::text
            ELSE 'disabled'::text
        END,
    ARRAY[u.key],
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    u.key
   FROM public.automations u
UNION ALL
 SELECT 'service_principals'::text,
    (p.principal_id)::text,
    p.name,
    p.purpose,
    'active'::text,
        CASE
            WHEN w.principal_id IS NOT NULL THEN 'withdrawn'::text
            ELSE NULL::text
        END,
    '{}'::text[],
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    (p.principal_id)::text
   FROM public.machine_principals p
     LEFT JOIN public.revoked_service_principals w ON w.principal_id = p.principal_id
UNION ALL
 SELECT r.entity_type,
    (r.entity_id)::text,
    r.name,
    (r.old_data ->> 'description'::text),
    'retired'::text,
        CASE
            WHEN (r.old_data ->> 'shadow_of'::text) IS NOT NULL THEN 'replay_lane'::text
            ELSE NULL::text
        END,
    array_remove(ARRAY[r.sparkplug_id, NULLIF(r.old_data ->> 'reported_identity'::text, r.sparkplug_id)], NULL::text),
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    NULL::text
   FROM public.retired_entities r;

ALTER VIEW public.entity_directory OWNER TO postgres;

COMMENT ON VIEW public.entity_directory IS 'Every entity a page of the dashboard lists by its id, one row each: areas, cells, gateways, devices, schema versions, metrics, captures, backups, automations and the machine identities an Administrator made, and the areas, cells, gateways and devices archived and then deleted. kind is the word audit_trail.entity_type uses. state is the archive lifecycle''s: active, archived or retired. variant is what sets a row apart within its kind: a schema version''s status, a capture''s subject (gateway or device), a backup''s origin, or playback, quarantined, replay_lane, deprecated, derived, disabled or withdrawn. second_ids are its further ids: a Sparkplug id, a reported identity, semantic ids, a capture''s stored path, a backup''s stamp, an automation''s key. area_id and cell_id are where it is, gateway_id a device''s gateway, and a capture''s subject is in gateway_id and device_id. page_id is what its own page opens it by: a capture''s subject, a backup''s job (NULL once the job is gone), an automation''s key, else its id; NULL for a retired one, which has no page. A replay lane is listed only once archived. People are not here: list_user_accounts() is the read of them. security_invoker: the caller''s RLS on every table beneath applies (0321).';

-- One transaction, so no read during a later boot is refused between the two.
BEGIN;
REVOKE ALL ON TABLE public.entity_directory FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.entity_directory TO authenticated;
COMMIT;

-- -------------------------------------------------------------------------------------------------
-- 2. The search
-- -------------------------------------------------------------------------------------------------
-- A PostgREST filter cannot match the start of an array's element, so the rule is a function. It compares
-- text and never a pattern, since a semantic id holds `%`, `_` and `#`, and it ignores case, since an id is
-- pasted from many places. Each row's ids are one string, every id on a line of its own, so a whole id is a
-- whole line and the start of one is the start of a line. The start counts from 8 characters, an uuid's first
-- group. OFFSET 0 keeps each row's text worked out once rather than once for each comparison.
--
-- With p_per_kind, a kind's places go by rank, then what is in service (the three states are in that order by
-- their letters), then by name, a shorter one first so that Press 2 is before Press 10, which is how the
-- dashboard orders them. The states then decide the order of the whole answer too, for a total that stops
-- short. Without it every row keeps its place.
--
-- A database that ran this file before p_per_kind holds the two-argument form. PostgREST calls by argument
-- names and could not choose between the two, so that one goes in the transaction that brings the other: no
-- request finds two forms, or none. Guarded, so a boot with nothing to drop prints nothing.
BEGIN;
DO $drop$
BEGIN
  IF to_regprocedure('public.find_entities(text, integer)') IS NOT NULL THEN
    DROP FUNCTION public.find_entities(text, integer);
  END IF;
END
$drop$;

CREATE OR REPLACE FUNCTION public.find_entities(p_query text, p_limit integer DEFAULT 200, p_per_kind integer DEFAULT NULL)
RETURNS SETOF public.entity_directory
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT f.kind, f.id, f.name, f.description, f.state, f.variant, f.second_ids, f.area_id, f.cell_id,
         f.gateway_id, f.device_id, f.page_id
    FROM (
      SELECT e.*, m.rank,
             row_number() OVER (PARTITION BY e.kind
                                ORDER BY m.rank, e.state, length(e.name), e.name, e.id) AS place
        FROM (SELECT lower(btrim(p_query, E' \t\r\n')) AS text) q
        CROSS JOIN public.entity_directory e
        CROSS JOIN LATERAL (
          SELECT lower(E'\n' || e.id || E'\n' || array_to_string(e.second_ids, E'\n') || E'\n') AS ids,
                 lower(e.name) AS name
          OFFSET 0
        ) t
        CROSS JOIN LATERAL (
          SELECT CASE
                   WHEN strpos(t.ids, E'\n' || q.text || E'\n') > 0 THEN 0
                   WHEN t.name = q.text THEN 1
                   WHEN length(q.text) >= 8 AND strpos(t.ids, E'\n' || q.text) > 0 THEN 2
                   WHEN strpos(t.name, q.text) > 0 THEN 3
                 END AS rank
          OFFSET 0
        ) m
       WHERE q.text <> '' AND m.rank IS NOT NULL
    ) f
   WHERE p_per_kind IS NULL OR f.place <= greatest(p_per_kind, 1)
   ORDER BY f.rank, CASE WHEN p_per_kind IS NOT NULL THEN f.state END, f.name, f.kind, f.id, f.state
   LIMIT least(greatest(coalesce(p_limit, 200), 1), 500);
$$;

ALTER FUNCTION public.find_entities(text, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.find_entities(text, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.find_entities(text, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.find_entities(text, integer, integer) IS
  'The rows of entity_directory one text names, for "what is this id?": a whole id (the key or any of '
  'second_ids), the start of one from 8 characters, or any part of a name, whatever the case. A whole id '
  'comes first, then a whole name, then the rest. At most p_limit rows, 200 by default and never more than '
  '500; blank text answers none. With p_per_kind, at most that many rows of each kind, the best first: among '
  'equals what is in service, then by name, a shorter one first. SECURITY INVOKER: the rows the caller may '
  'read (0321).';
COMMIT;

-- -------------------------------------------------------------------------------------------------
-- 3. The comments that name the page
-- -------------------------------------------------------------------------------------------------
-- 0001 states both under the page's old name and replays first on every boot; these stand after it.
COMMENT ON COLUMN public.areas.is_archived IS 'Out of commission but not gone: listed on the Entities page''s Archived tab, restorable, and still the <area> segment of every uns/ topic beneath it. Its cells stay filed in it. Never proposable.';

COMMENT ON TABLE public.retired_entities IS 'One row per asset that was archived and then deleted, written by record_retired_entity() on the DELETE. Not derived from audit_trail, which is partitioned for an eventual DETACH: a tombstone outlives the month that recorded the delete. Readable by whoever may manage the archive or read the trail''s asset lane; written by nothing but the trigger.';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_columns text;
  v_find    regprocedure := to_regprocedure('public.find_entities(text, integer, integer)');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.entity_directory'::regclass
                    AND 'security_invoker=true' = ANY (coalesce(reloptions, '{}'::text[]))) THEN
    RAISE EXCEPTION '0321: entity_directory does not run as its caller; it would bypass the RLS of every table beneath it';
  END IF;
  IF to_regprocedure('public.find_entities(text, integer)') IS NOT NULL THEN
    RAISE EXCEPTION '0321: the two-argument find_entities() stands beside the one this file declares, and a call without p_per_kind could be either''s';
  END IF;
  -- Its last argument alone may be left out, or its last two.
  IF v_find IS NULL OR NOT EXISTS (SELECT 1 FROM pg_proc
                                    WHERE oid = v_find AND pronargdefaults = 2
                                      AND proargnames[1:3] = ARRAY['p_query', 'p_limit', 'p_per_kind']) THEN
    RAISE EXCEPTION '0321: find_entities() does not take p_query alone, with p_limit and p_per_kind as the caller likes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE oid = v_find
                AND (prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=public'])) THEN
    RAISE EXCEPTION '0321: find_entities() is SECURITY DEFINER, or its search_path is not pinned to public';
  END IF;

  IF has_table_privilege('anon', 'public.entity_directory', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_function_privilege('anon', v_find, 'EXECUTE')
     OR has_function_privilege('service_role', v_find, 'EXECUTE') THEN
    RAISE EXCEPTION '0321: anon may read the entities, or service_role may call find_entities()';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.entity_directory', 'SELECT')
     OR NOT has_function_privilege('authenticated', v_find, 'EXECUTE') THEN
    RAISE EXCEPTION '0321: a signed-in caller may not read entity_directory or call find_entities(); the Entities page does both, and the search bar the second';
  END IF;
  IF has_table_privilege('authenticated', 'public.entity_directory', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION '0321: authenticated holds a write privilege on entity_directory';
  END IF;

  -- The dashboard reads these by name.
  SELECT string_agg(attname, ',' ORDER BY attnum) INTO v_columns
    FROM pg_attribute
   WHERE attrelid = 'public.entity_directory'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_columns IS DISTINCT FROM 'kind,id,name,description,state,variant,second_ids,area_id,cell_id,gateway_id,device_id,page_id' THEN
    RAISE EXCEPTION '0321: entity_directory has the columns %, not the ones the Entities page reads', v_columns;
  END IF;

  -- No function stands between the view and the tables: one that ran as its owner would show a role
  -- rows its own policies do not. A view's rule depends on each function it calls.
  IF EXISTS (SELECT 1
               FROM pg_rewrite r
               JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
                               AND d.refclassid = 'pg_proc'::regclass
               JOIN pg_proc p ON p.oid = d.refobjid
              WHERE r.ev_class = 'public.entity_directory'::regclass
                AND p.pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION '0321: entity_directory calls a function of public; it reads tables and views alone';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
