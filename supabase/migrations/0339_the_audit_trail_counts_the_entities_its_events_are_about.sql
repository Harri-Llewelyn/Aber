-- 0339: The Audit Trail counts the entities its events are about.
--
-- The foot of the Audit Trail said "200 of 18,431" and did not say what it counted. It now says
-- "200 events of 18,431 events for 57 entities". audit_trail_page() gives the last figure as
-- `matching_entities`: how many entities the matching events are about, under the same filters and
-- the same purged rule as `total_matching`, over the whole match rather than the page.
--
-- The tally the totals are summed from is kept per entity as well, so the figure is one more sum over
-- it, not a second read of the trail. Every other arm, argument and behaviour is 0168's.
--
-- Redefines public.audit_trail_page: its tally is kept per entity, and it gives matching_entities.
--
-- Reasoning: supabase/README.md, "The Audit Trail counts the entities its events are about (0339)".
-- Idempotent.

CREATE OR REPLACE FUNCTION public.audit_trail_page(p_limit integer DEFAULT 200, p_include_purged boolean DEFAULT false, p_entity_type text[] DEFAULT NULL::text[], p_action text[] DEFAULT NULL::text[], p_entity_ids uuid[] DEFAULT NULL::uuid[], p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_recorded_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id bigint DEFAULT NULL::bigint, p_search text DEFAULT NULL::text, p_changed_by uuid[] DEFAULT NULL::uuid[], p_class text[] DEFAULT NULL::text[], p_counts boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    SET plan_cache_mode TO 'force_custom_plan'
    AS $_$
-- PLANNED FOR EACH CALL, WITH ITS VALUES. force_custom_plan makes every argument a constant to the
-- planner, so a filter nobody chose folds away, a window prunes the months outside it, and a class
-- not asked for drops its branch. A generic plan keeps all of them, and reads every row.
--
-- THE CLASSES ARE READ FROM THEIR INDEXES. audit_trail_matching() (0228) returns one class's rows,
-- and each class has a partial index covering what the filters, the policies and the counts read.
-- So the counts are an index-only scan, and the page is the newest few of each class, merged.
DECLARE
  v_all       text[] := ARRAY['created', 'operational', 'configuration', 'lifecycle', 'read'];
  v_raw       text := nullif(btrim(p_search), '');
  v_pattern   text;
  v_id_term   bigint;
  -- Ids the search matches by something not in the row: a person, a backup job's note or stamp,
  -- and the backups a job took.
  v_also      uuid[] := '{}'::uuid[];
  -- Every entity the purged rule can find, so a row's test is one lookup.
  v_live      uuid[];
  v_limit     integer := greatest(1, least(coalesce(p_limit, 200), 1000));
  -- NULL or an empty list is no constraint.
  v_types     text[] := CASE WHEN cardinality(p_entity_type) > 0 THEN p_entity_type END;
  v_actions   text[] := CASE WHEN cardinality(p_action) > 0 THEN p_action END;
  v_people    uuid[] := CASE WHEN cardinality(p_changed_by) > 0 THEN p_changed_by END;
  v_classes   text[] := CASE WHEN cardinality(p_class) > 0 THEN p_class END;
  v_counts    boolean := coalesce(p_counts, false);
  v_since     timestamptz := coalesce(p_since, '-infinity');
  v_until     timestamptz := coalesce(p_until, 'infinity');
  -- Both halves of the cursor, or neither.
  v_before_at timestamptz := CASE WHEN p_before_id IS NOT NULL THEN p_before_recorded_at END;
  v_before_id bigint := CASE WHEN p_before_recorded_at IS NOT NULL THEN p_before_id END;
  -- The classes the page is drawn from, and the classes counted: all of them for the counts, which
  -- leave each filter's own choice out of its own figures.
  v_page      text[];
  v_scan      text[];
  v_scan_types   text[];
  v_scan_actions text[];
BEGIN
  IF v_raw IS NOT NULL THEN
    -- The search as a LIKE pattern. THE METACHARACTERS ARE ESCAPED: an unescaped '%' would return
    -- the whole trail to somebody who typed a percentage. Backslashes first, as LIKE's escape.
    v_pattern := '%' || replace(replace(replace(v_raw, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    -- The same term as a row id, when it is nothing but digits; 18 at most, so the cast cannot
    -- overflow.
    IF v_raw ~ '^[0-9]{1,18}$' THEN
      v_id_term := v_raw::bigint;
    END IF;
    v_also := public.audit_trail_user_ids_matching(v_pattern)
           || public.audit_trail_backup_job_ids_matching(v_pattern);
    -- A backup request's id also finds the backup it took: the Backup taken row records the job,
    -- and every later row of that backup is keyed by the backup's own id. Read from the trail,
    -- since a pruned backup's row is gone from `backups`.
    IF v_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_also := v_also || ARRAY(
        SELECT DISTINCT b.entity_id FROM public.audit_trail b
         WHERE b.entity_type = 'backups' AND b.action = 'BACKUP_TAKEN'
           AND b.new_data ->> 'job_id' = lower(v_raw));
    END IF;
  END IF;

  v_live := ARRAY(SELECT a.id FROM public.areas a UNION ALL SELECT c.id FROM public.cells c
                  UNION ALL SELECT g.id FROM public.gateways g UNION ALL SELECT d.id FROM public.devices d
                  UNION ALL SELECT s.id FROM public.schemas s);
  v_page := coalesce(v_classes, v_all);
  v_scan := CASE WHEN v_counts THEN v_all ELSE v_page END;
  v_scan_types := CASE WHEN v_counts THEN NULL ELSE v_types END;
  v_scan_actions := CASE WHEN v_counts THEN NULL ELSE v_actions END;

  RETURN (
    WITH counted AS (
      SELECT * FROM public.audit_trail_matching('created', v_scan_types, v_scan_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, NULL, NULL) WHERE 'created' = ANY (v_scan)
      UNION ALL
      SELECT * FROM public.audit_trail_matching('operational', v_scan_types, v_scan_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, NULL, NULL) WHERE 'operational' = ANY (v_scan)
      UNION ALL
      SELECT * FROM public.audit_trail_matching('configuration', v_scan_types, v_scan_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, NULL, NULL) WHERE 'configuration' = ANY (v_scan)
      UNION ALL
      SELECT * FROM public.audit_trail_matching('lifecycle', v_scan_types, v_scan_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, NULL, NULL) WHERE 'lifecycle' = ANY (v_scan)
      UNION ALL
      SELECT * FROM public.audit_trail_matching('read', v_scan_types, v_scan_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, NULL, NULL) WHERE 'read' = ANY (v_scan)
    ),
    -- One row per class, kind, action and entity, so the totals, the entities, the purged count and
    -- the counts are sums over a few thousand rows rather than over the trail.
    tally AS MATERIALIZED (
      SELECT r.class, r.entity_type, r.action, r.is_purged, r.entity_id,
             CASE WHEN r.is_purged THEN r.entity_id END AS gone,
             count(*) AS n
        FROM counted r
       GROUP BY 1, 2, 3, 4, 5
    ),
    judged AS MATERIALIZED (
      SELECT g.*,
             (v_types   IS NULL OR g.entity_type = ANY (v_types))   AS by_type,
             (v_actions IS NULL OR g.action      = ANY (v_actions)) AS by_action,
             (v_classes IS NULL OR g.class       = ANY (v_classes)) AS by_class,
             (p_include_purged OR NOT g.is_purged) AS shown
        FROM tally g
    ),
    -- The newest of each class after the cursor, merged. A class with nothing to show is not read.
    page AS MATERIALIZED (
      SELECT c.id, c.recorded_at, c.class FROM (
        (SELECT m.id, m.recorded_at, m.class FROM public.audit_trail_matching('created', v_types, v_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, v_before_at, v_before_id) m
          WHERE 'created' = ANY (v_page) AND (p_include_purged OR NOT m.is_purged)
            AND EXISTS (SELECT 1 FROM judged j WHERE j.class = 'created' AND j.shown AND j.by_type AND j.by_action)
          ORDER BY m.recorded_at DESC, m.id DESC LIMIT v_limit)
        UNION ALL
        (SELECT m.id, m.recorded_at, m.class FROM public.audit_trail_matching('operational', v_types, v_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, v_before_at, v_before_id) m
          WHERE 'operational' = ANY (v_page) AND (p_include_purged OR NOT m.is_purged)
            AND EXISTS (SELECT 1 FROM judged j WHERE j.class = 'operational' AND j.shown AND j.by_type AND j.by_action)
          ORDER BY m.recorded_at DESC, m.id DESC LIMIT v_limit)
        UNION ALL
        (SELECT m.id, m.recorded_at, m.class FROM public.audit_trail_matching('configuration', v_types, v_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, v_before_at, v_before_id) m
          WHERE 'configuration' = ANY (v_page) AND (p_include_purged OR NOT m.is_purged)
            AND EXISTS (SELECT 1 FROM judged j WHERE j.class = 'configuration' AND j.shown AND j.by_type AND j.by_action)
          ORDER BY m.recorded_at DESC, m.id DESC LIMIT v_limit)
        UNION ALL
        (SELECT m.id, m.recorded_at, m.class FROM public.audit_trail_matching('lifecycle', v_types, v_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, v_before_at, v_before_id) m
          WHERE 'lifecycle' = ANY (v_page) AND (p_include_purged OR NOT m.is_purged)
            AND EXISTS (SELECT 1 FROM judged j WHERE j.class = 'lifecycle' AND j.shown AND j.by_type AND j.by_action)
          ORDER BY m.recorded_at DESC, m.id DESC LIMIT v_limit)
        UNION ALL
        (SELECT m.id, m.recorded_at, m.class FROM public.audit_trail_matching('read', v_types, v_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, v_before_at, v_before_id) m
          WHERE 'read' = ANY (v_page) AND (p_include_purged OR NOT m.is_purged)
            AND EXISTS (SELECT 1 FROM judged j WHERE j.class = 'read' AND j.shown AND j.by_type AND j.by_action)
          ORDER BY m.recorded_at DESC, m.id DESC LIMIT v_limit)
      ) c
      ORDER BY c.recorded_at DESC, c.id DESC
      LIMIT v_limit
    )
    SELECT jsonb_build_object(
      'events', coalesce(
          (SELECT jsonb_agg(
                    to_jsonb(t)
                    || jsonb_build_object(
                         'class', p.class,
                         -- HOW MANY ROWS THE TRANSACTION WROTE (0139), over the whole table and not
                         -- the page, under the caller's own policies. Null where there is no
                         -- causation: NULL is not a group.
                         'transaction_rows',
                         CASE WHEN t.causation_id IS NULL THEN NULL
                              ELSE (SELECT count(*) FROM public.audit_trail d WHERE d.causation_id = t.causation_id)
                         END)
                    ORDER BY t.recorded_at DESC, t.id DESC)
             FROM page p
             JOIN public.audit_trail t ON t.id = p.id AND t.recorded_at = p.recorded_at),
          '[]'::jsonb),
      'purged_assets', (SELECT count(DISTINCT gone) FROM judged
                         WHERE is_purged AND by_type AND by_action AND by_class),
      -- HOW LONG THE TRAIL IS UNDER THESE FILTERS, without the cursor, so it does not move as the
      -- reader pages.
      'total_matching', (SELECT coalesce(sum(n), 0) FROM judged
                          WHERE shown AND by_type AND by_action AND by_class),
      -- HOW MANY ENTITIES THOSE ROWS ARE ABOUT, under the same rule: a device and its nameplate are one.
      'matching_entities', (SELECT count(DISTINCT entity_id) FROM judged
                             WHERE shown AND by_type AND by_action AND by_class),
      -- THERE IS A NEXT PAGE. Null next_cursor is the only end-of-data signal.
      'truncated', (SELECT count(*) FROM page) >= v_limit,
      'next_cursor', CASE
          WHEN (SELECT count(*) FROM page) >= v_limit
          THEN (SELECT jsonb_build_object('recorded_at', p.recorded_at, 'id', p.id)
                  FROM page p ORDER BY p.recorded_at ASC, p.id ASC LIMIT 1)
      END,
      -- Each class's, kind's and action's events under every filter but its own, when asked for.
      'counts', CASE WHEN v_counts THEN jsonb_build_object(
          'class', (SELECT coalesce(jsonb_object_agg(x.class, x.n), '{}') FROM
                      (SELECT class, sum(n) AS n FROM judged WHERE shown AND by_type AND by_action
                        GROUP BY class) x),
          'entity_type', (SELECT coalesce(jsonb_object_agg(x.entity_type, x.n), '{}') FROM
                      (SELECT entity_type, sum(n) AS n FROM judged WHERE shown AND by_action AND by_class
                        GROUP BY entity_type) x),
          'action', (SELECT coalesce(jsonb_object_agg(x.action, x.n), '{}') FROM
                      (SELECT action, sum(n) AS n FROM judged WHERE shown AND by_type AND by_class
                        GROUP BY action) x))
      END
    )
  );
END
$_$;

ALTER FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text[], p_action text[], p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text, p_changed_by uuid[], p_class text[], p_counts boolean) OWNER TO postgres;

COMMENT ON FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text[], p_action text[], p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text, p_changed_by uuid[], p_class text[], p_counts boolean) IS 'One page of the Audit Trail, with deleted entities filtered server-side and counted over the whole match rather than the page. `total_matching` is how many rows the filters select in total, under the same purged rule as the page, so a reader knows what fraction of the trail they hold. `matching_entities` is how many entities those rows are about, under the same rule, counted by entity id, so a device and its nameplate are one (0339). Keyset paged on (recorded_at DESC, id DESC): pass the previous response''s `next_cursor` back as p_before_recorded_at/p_before_id. A null next_cursor is the only end-of-data signal. `p_search` matches the entity id and the audit-snapshot fields the timeline labels a lane from, so an entity is findable by the name the page shows for it; LIKE metacharacters in it are literal. A term of 1 to 18 digits ALSO matches the audit row''s own id and its causation_id (0121), which is how the other two ids the event drawer shows are searchable; it is an additional disjunct, so a numeric name still matches by name. A backup request''s id also matches the rows of the backup it took, found through its Backup taken row (0228). `p_entity_type`, `p_action`, `p_changed_by` and `p_class` are lists, each matched as any of its values, and the four are combined with AND: NULL or an empty list is no constraint, and a one-element list is the single value it holds (0227). `p_changed_by` keeps the rows whose changed_by is one of those people''s or machine identities'' ids, under the caller''s own policies (0222). `p_class` keeps the rows audit_event_class() puts in those classes, and each event carries its `class` (0228). With `p_counts`, `counts` gives each class, kind and action its events under every filter but its own. `transaction_rows` on each event is how many rows share its causation_id, counted over the whole table under the caller''s own policies rather than over the page, and null where there is no causation (0139). Two labels are not in any payload and are matched through a SECURITY DEFINER helper each: the person a role assignment is about (0115), and a backup job''s note and the stamp of the backup it produced (0118). `is_purged` applies to areas, cells, gateways, devices, schemas, device nameplates and device schema attachments -- every entity type this function can probe a table for. A type with no readable table behind it (user_roles and service_principals, which are auth.users rows; area_floors, whose table was retired) is never called deleted. `purged_assets` keeps its wire name and counts all of them.';

-- Every role that reads the Audit Trail runs it; audit_trail's policies decide the rows. By name, as 0228.
REVOKE ALL ON FUNCTION public.audit_trail_page(integer, boolean, text[], text[], uuid[], timestamp with time zone,
                                               timestamp with time zone, timestamp with time zone, bigint, text,
                                               uuid[], text[], boolean) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.audit_trail_page(integer, boolean, text[], text[], uuid[], timestamp with time zone,
                                              timestamp with time zone, timestamp with time zone, bigint, text,
                                              uuid[], text[], boolean) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider. Structure only: what the function says, how it is planned,
-- and who runs it.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_page regprocedure := to_regprocedure(
    'public.audit_trail_page(integer, boolean, text[], text[], uuid[], timestamp with time zone, '
    'timestamp with time zone, timestamp with time zone, bigint, text, uuid[], text[], boolean)');
  v_src  text;
  v_role text;
BEGIN
  IF v_page IS NULL THEN
    RAISE EXCEPTION '0339: audit_trail_page() is missing';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_page;
  IF position('''matching_entities''' IN v_src) = 0
     OR position('SELECT r.class, r.entity_type, r.action, r.is_purged, r.entity_id,' IN v_src) = 0 THEN
    RAISE EXCEPTION '0339: audit_trail_page does not count the entities its rows are about from a tally kept per entity';
  END IF;
  -- 0168's figures are all still given.
  IF position('''total_matching''' IN v_src) = 0 OR position('''purged_assets''' IN v_src) = 0
     OR position('''next_cursor''' IN v_src) = 0 OR position('''counts''' IN v_src) = 0 THEN
    RAISE EXCEPTION '0339: audit_trail_page lost one of total_matching, purged_assets, next_cursor or counts';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_page AND NOT prosecdef
                    AND 'search_path=public' = ANY (proconfig)
                    AND 'plan_cache_mode=force_custom_plan' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0339: audit_trail_page is SECURITY DEFINER, or lacks its pinned search_path or force_custom_plan';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF NOT has_function_privilege(v_role, v_page, 'EXECUTE') THEN
      RAISE EXCEPTION '0339: % cannot execute %; the Audit Trail reads through it', v_role, v_page;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', v_page, 'EXECUTE') THEN
    RAISE EXCEPTION '0339: anon may execute %', v_page;
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
