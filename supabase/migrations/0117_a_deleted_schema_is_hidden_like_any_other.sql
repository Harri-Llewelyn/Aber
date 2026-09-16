-- 0117: a deleted schema is hidden like any other deleted entity.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- `schemas` and `device_nameplate` join the `is_purged` anti-join, which named only the four
-- shopfloor tables. What decides membership is not whether a kind is equipment but whether THIS
-- FUNCTION CAN PROBE A TABLE FOR THE ROW: a type with no readable table behind it cannot be shown
-- to be absent from one. `device_nameplate` is keyed by its device's id, so `devices` answers for
-- it; that type carries no rows yet and is listed so it does not inherit this bug when it does.
--
-- The page had two disagreeing answers to "is this entity gone". The tab flags a lane deleted
-- whenever a lookup covering its kind does not hold the id, schemas included; the purged rule that
-- decides what is hidden and what `purged_assets` counts named four tables. So a deleted schema
-- wore the flag, could not be hidden, and -- the count being what draws the reveal control -- was
-- offered no way to be. The tab's `DELETABLE_KINDS` is now the same set on the other side.
--
-- `user_roles` and `service_principals` stay out: both are `auth.users` rows, which a SECURITY
-- INVOKER function cannot read. `area_floors` stays out for a different reason -- its table was
-- retired, and "the table is gone" is not "the row is gone".
--
-- The tab's wording becomes "deleted entities", a schema being a definition rather than equipment.
-- The wire key stays `purged_assets`: renaming it would break callers to buy nothing a comment
-- cannot say. The measurement is in supabase/README.md, "What can be shown to be deleted".

SET search_path TO public;

-- =================================================================================================
-- DROPPED AND RECREATED, NOT REPLACED, for the reason 0077 gives: CREATE OR REPLACE cannot change
-- an argument list, and leaving both declared would make every call by name ambiguous. 0077
-- recreates the nine-argument form on every boot and 0115 its ten-argument one; this file runs
-- after both and the last declaration wins, recorded in check-docs-drift.mjs's
-- INTENDED_REDECLARATIONS.
--
-- EVERY DECLARATION, AND NOT MERELY THE ONE THIS FILE WRITES, which is also why 0077 and 0115 do
-- it: a file that names one argument list owns the function only until something adds an argument
-- after it, and then leaves a second declaration standing on every replay. This file takes the
-- same list 0115 did and could have used CREATE OR REPLACE alone -- the loop is kept because the
-- migration that eventually adds an eleventh argument will otherwise resurrect this form. The
-- self-checks here and in 0077 call by name, which is the call that cannot choose between two
-- candidates.
--
-- THE GRANTS DO NOT FOLLOW THE FUNCTION ACROSS THE DROP, and a function nobody may execute fails
-- exactly like one that does not exist -- except that it fails in the browser, as an empty page,
-- rather than here as a migration error. They are re-granted below.
DO $own$
DECLARE
    v_existing record;
BEGIN
    FOR v_existing IN
        SELECT p.oid::regprocedure AS signature
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'digital_thread_page'
    LOOP
        -- No CASCADE, as in 0077: nothing may depend on this.
        EXECUTE format('DROP FUNCTION %s', v_existing.signature);
    END LOOP;
END
$own$;

CREATE OR REPLACE FUNCTION public.digital_thread_page(
    p_limit integer DEFAULT 200,
    p_include_purged boolean DEFAULT false,
    p_entity_type text DEFAULT NULL::text,
    p_action text DEFAULT NULL::text,
    -- Exact ids, kept: the right primitive for "this entity's history" even though the tab now
    -- reaches that through p_search, which also matches an id.
    p_entity_ids uuid[] DEFAULT NULL::uuid[],
    p_since timestamp with time zone DEFAULT NULL::timestamp with time zone,
    p_until timestamp with time zone DEFAULT NULL::timestamp with time zone,
    -- THE CURSOR, and it is the position of the LAST ROW ALREADY SEEN rather than an index. Both
    -- halves or neither: a half-supplied cursor makes the row comparison below NULL, which filters
    -- out every row and would render as "no more events" on a thread that has plenty.
    p_before_recorded_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
    p_before_id bigint DEFAULT NULL::bigint,
    -- Appended last so every positional call written against the nine-argument form still resolves.
    p_search text DEFAULT NULL::text
) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
WITH pattern AS (
    -- The search as a LIKE pattern, built once. THE METACHARACTERS ARE ESCAPED: the box promises
    -- a substring of a name or an id, and an unescaped '%' would silently return the whole thread
    -- to somebody who typed a percentage into it. Backslash is the default LIKE escape, so the
    -- backslashes have to be doubled first or an escape would be introduced by the escaping.
    SELECT CASE
             WHEN p_search IS NULL OR btrim(p_search) = '' THEN NULL
             ELSE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
           END AS pattern
),
-- MATERIALIZED, AND MEASURED. Without it Postgres inlines this CTE and the helper lands in the
-- per-row Filter of every partition scan -- a STABLE function is allowed to be called once and is
-- not promised to be. On 4,065 rows that took a search from 53ms to 583ms, which is the shape of
-- cost that looks like "the thread got big" rather than like a query doing the wrong thing.
q AS MATERIALIZED (
    SELECT p.pattern,
           public.digital_thread_user_ids_matching(p.pattern) AS user_ids
      FROM pattern p
),
matching AS (
    SELECT t.*,
           -- SIX TYPES, FIVE PROBES, and the mismatch is `device_nameplate`: it is keyed by its
           -- device's id, so `devices` answers for it. A type is listed here only if one of the
           -- probes below can be asked about its rows -- `user_roles` and `service_principals`
           -- are auth.users rows with no public table to read, and would otherwise answer "absent
           -- from all five" about a person who is perfectly present. An entity type whose table
           -- has been RETIRED is a third case this still does not answer: "the table is gone" is
           -- not "the row is gone", so `area_floors` remains drawn and cannot be hidden.
           t.entity_type IN ('areas', 'cells', 'gateways', 'devices', 'schemas', 'device_nameplate')
       AND NOT EXISTS (SELECT 1 FROM public.areas    a WHERE a.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.cells    c WHERE c.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.devices  d WHERE d.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.schemas  s WHERE s.id = t.entity_id)
               AS is_purged
      FROM public.digital_thread t
     CROSS JOIN q
     WHERE (p_entity_type IS NULL OR t.entity_type = p_entity_type)
       AND (p_action      IS NULL OR t.action      = p_action)
       AND (p_entity_ids  IS NULL OR t.entity_id   = ANY (p_entity_ids))
       AND (p_since       IS NULL OR t.recorded_at >= p_since)
       AND (p_until       IS NULL OR t.recorded_at <= p_until)
       -- THE ID AND THE NAME THE TIMELINE DRAWS. Both snapshots are read because an INSERT has
       -- only `new_data` and a DELETE only `old_data`, and an UPDATE that renames something is
       -- findable under either name, which is what somebody searching for the old one wants.
       AND (q.pattern IS NULL
            OR t.entity_id::text ILIKE q.pattern
            -- The person a role assignment is about, who is not in the payload. Empty for a caller
            -- who may not ask, which matches no row.
            OR t.entity_id = ANY (q.user_ids)
            OR EXISTS (
                 SELECT 1
                   FROM unnest(ARRAY['name', 'sparkplug_id', 'schema_name',
                                     'label', 'key', 'role', 'stamp']) AS f(field)
                  WHERE (t.new_data ->> f.field) ILIKE q.pattern
                     OR (t.old_data ->> f.field) ILIKE q.pattern
               ))
),
visible AS (
    SELECT * FROM matching
     WHERE (p_include_purged OR NOT is_purged)
       -- The cursor is applied here and not in `matching`: `purged_assets` and `total_matching` are
       -- counted over `matching` and are facts about everything the filters select, not about what
       -- is left after paging.
       AND (p_before_id IS NULL
            OR p_before_recorded_at IS NULL
            OR (recorded_at, id) < (p_before_recorded_at, p_before_id))
     ORDER BY recorded_at DESC, id DESC
     LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
)
SELECT jsonb_build_object(
    'events', coalesce(
        (SELECT jsonb_agg(to_jsonb(v) - 'is_purged' ORDER BY v.recorded_at DESC, v.id DESC)
           FROM visible v),
        '[]'::jsonb),
    'purged_assets', (SELECT count(DISTINCT entity_id) FROM matching WHERE is_purged),
    -- HOW LONG THE THREAD IS UNDER THESE FILTERS, so a reader holding one page knows what fraction
    -- of it that is. Counted under the SAME predicate `visible` opens with, minus the cursor and
    -- the limit -- so it does not move as the reader pages, and a page can never report more rows
    -- than the total it is a fraction of.
    'total_matching', (SELECT count(*) FROM matching WHERE p_include_purged OR NOT is_purged),
    -- KEPT, AND IT MEANS "THERE IS A NEXT PAGE". It used to mean "your view is cut off", which was
    -- the same thing when there was no way to ask for more. Callers that only ever showed a banner
    -- keep working unchanged.
    'truncated', (SELECT count(*) FROM visible) >= greatest(1, least(coalesce(p_limit, 200), 1000)),
    -- WHERE THE READER GOT TO, or null at the end of the thread. Null is the ONLY end-of-data
    -- signal a caller should trust: an empty `events` array with a non-null cursor cannot happen,
    -- but a full page that happens to be the last one is ordinary, so "fewer rows than I asked
    -- for" is not a reliable test and callers must not invent one.
    'next_cursor', CASE
        WHEN (SELECT count(*) FROM visible) >= greatest(1, least(coalesce(p_limit, 200), 1000))
        THEN (SELECT jsonb_build_object('recorded_at', v.recorded_at, 'id', v.id)
                FROM visible v ORDER BY v.recorded_at ASC, v.id ASC LIMIT 1)
        ELSE NULL
    END
);
$$;

COMMENT ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint, text) IS
  'One page of the Digital Thread, with deleted entities filtered server-side and counted over the whole match rather than the page. `total_matching` is how many rows the filters select in total, under the same purged rule as the page, so a reader knows what fraction of the thread they hold. Keyset paged on (recorded_at DESC, id DESC): pass the previous response''s `next_cursor` back as p_before_recorded_at/p_before_id. A null next_cursor is the only end-of-data signal. `p_search` matches the entity id and the audit-snapshot fields the timeline labels a lane from, so a deleted entity is findable by the name the page shows for it; LIKE metacharacters in it are literal. `is_purged` applies to areas, cells, gateways, devices, schemas and device nameplates -- every entity type this function can probe a table for. A type with no readable table behind it (user_roles and service_principals, which are auth.users rows; area_floors, whose table was retired) is never called deleted. `purged_assets` keeps its wire name and counts all of them.';

-- The grants 0077 puts on the nine-argument form do not follow it across the DROP. See the note
-- above the DROP for why that failure is worse than a loud one.
REVOKE ALL ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint, text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint, text) TO service_role;
GRANT ALL ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint, text) TO authenticated;

-- =================================================================================================
-- SELF-CHECKS. Read-only, on whatever rows the database happens to hold, and RELATIVE THROUGHOUT:
-- every assertion compares two computations of the same quantity rather than either of them to a
-- number written here. An absolute count in a self-check passes on the boot that wrote it and
-- fails on the next one that adds a row (0069, corrected by 0086).
--
-- Migrations run as the owner, and `digital_thread` has row security enabled but not FORCED, so
-- the function and the direct counts below both see every row. A caller reaching this through
-- PostgREST sees their own lane, and the arithmetic holds within it.
-- =================================================================================================
DO $check$
DECLARE
  v_declared      integer;
  v_page          jsonb;
  v_total         bigint;
  v_direct        bigint;
  v_all           bigint;
  v_schema_rows   bigint;
  v_schema_gone   bigint;
  v_schema_shown  bigint;
  v_name          text;
  v_found         bigint;
BEGIN
  -- 1. ONE DECLARATION. Two candidates make every call by argument name ambiguous, which is how
  --    0115 failed: the chain aborted inside 0077, on the SECOND boot, with a database left half
  --    migrated. Cheap to assert and impossible to notice otherwise.
  SELECT count(*) INTO v_declared
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'digital_thread_page';

  IF v_declared <> 1 THEN
    RAISE EXCEPTION
      '0117 self-check: digital_thread_page is declared % time(s), not once -- calls by argument '
      'name cannot choose a candidate, and the next migration to call one will abort the chain.',
      v_declared;
  END IF;

  v_page  := public.digital_thread_page(p_limit => 1, p_include_purged => false);
  v_total := (v_page ->> 'total_matching')::bigint;

  -- 2. THE TOTAL IS THE TOTAL, counted here the long way round and under THIS file's rule rather
  --    than 0115's. This is the assertion that fails if the six types above and the five probes
  --    below them ever stop agreeing with each other.
  SELECT count(*) INTO v_direct
    FROM public.digital_thread t
   WHERE NOT (t.entity_type IN ('areas', 'cells', 'gateways', 'devices', 'schemas',
                                'device_nameplate')
          AND NOT EXISTS (SELECT 1 FROM public.areas    a WHERE a.id = t.entity_id)
          AND NOT EXISTS (SELECT 1 FROM public.cells    c WHERE c.id = t.entity_id)
          AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.id = t.entity_id)
          AND NOT EXISTS (SELECT 1 FROM public.devices  d WHERE d.id = t.entity_id)
          AND NOT EXISTS (SELECT 1 FROM public.schemas  s WHERE s.id = t.entity_id));

  IF v_total <> v_direct THEN
    RAISE EXCEPTION
      '0117 self-check: total_matching is % but the table holds % row(s) under the same purged '
      'rule -- the count and the page are reading different sets.', v_total, v_direct;
  END IF;

  -- 3. A PAGE IS PART OF ITS OWN TOTAL. Cheap, and it is the assertion that catches a total
  --    counted after the LIMIT rather than before it.
  IF v_total < jsonb_array_length(v_page -> 'events') THEN
    RAISE EXCEPTION
      '0117 self-check: a page of % row(s) reports a total of % -- total_matching is being counted '
      'over the page instead of over the match.',
      jsonb_array_length(v_page -> 'events'), v_total;
  END IF;

  -- 4. REVEALING THE DELETED ENTITIES CANNOT REVEAL FEWER. `p_include_purged` widens the set, and
  --    the total has to widen with it or it is describing the wrong one.
  v_all := (public.digital_thread_page(p_limit => 1, p_include_purged => true)
            ->> 'total_matching')::bigint;

  IF v_all < v_total THEN
    RAISE EXCEPTION
      '0117 self-check: including deleted entities totals % against % without them -- including '
      'rows has removed some.', v_all, v_total;
  END IF;

  -- 5. THE SCHEMA LANE IS SUBJECT TO THE RULE, which is the whole of this file. Asserted through
  --    the filter the tab actually sends, and stated as a subtraction so it holds on a database
  --    with no deleted schemas as well as on one that is mostly them.
  SELECT count(*),
         count(*) FILTER (
           WHERE NOT EXISTS (SELECT 1 FROM public.schemas s WHERE s.id = t.entity_id))
    INTO v_schema_rows, v_schema_gone
    FROM public.digital_thread t
   WHERE t.entity_type = 'schemas';

  v_schema_shown := (public.digital_thread_page(
                       p_limit => 1, p_include_purged => false,
                       p_entity_type => 'schemas') ->> 'total_matching')::bigint;

  IF v_schema_shown <> v_schema_rows - v_schema_gone THEN
    RAISE EXCEPTION
      '0117 self-check: the Schemas filter shows % of % row(s) with % belonging to schemas that '
      'are no longer in the table -- a deleted schema is still being drawn by default.',
      v_schema_shown, v_schema_rows, v_schema_gone;
  END IF;

  -- Everything below needs rows to be about. A first boot has none, and an empty thread must not
  -- fail the chain.
  IF v_all = 0 THEN
    RAISE NOTICE '0117: digital_thread is empty; the search self-check has nothing to read yet.';
    RETURN;
  END IF;

  -- 6. THE SEARCH STILL READS THE SNAPSHOT. This file rewrites the whole function to change one
  --    expression in it, so the cheapest thing worth asserting is that the rest arrived intact:
  --    a name in the audit payload is what the timeline labels a deleted lane with, and 0115
  --    exists so that name can be searched for.
  SELECT coalesce(t.new_data ->> 'name', t.old_data ->> 'name') INTO v_name
    FROM public.digital_thread t
   WHERE coalesce(t.new_data ->> 'name', t.old_data ->> 'name', '') <> ''
   LIMIT 1;

  IF v_name IS NOT NULL THEN
    v_found := (public.digital_thread_page(
                  p_limit => 1, p_include_purged => true,
                  p_search => v_name) ->> 'total_matching')::bigint;

    IF v_found = 0 THEN
      RAISE EXCEPTION
        '0117 self-check: the audit snapshot names %, and searching for it finds nothing -- the '
        'search is not reading the fields the lane label falls back to.', v_name;
    END IF;
  END IF;

  RAISE NOTICE '0117: the thread reports % row(s) under the default filters and % with deleted '
               'entities shown; % schema row(s) of % are hidden as deleted.',
               v_total, v_all, v_schema_gone, v_schema_rows;
END
$check$;
