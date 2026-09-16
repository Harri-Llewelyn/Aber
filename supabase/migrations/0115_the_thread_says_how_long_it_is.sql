-- 0115: the thread says how long it is, and a deleted asset can still be searched for.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- Three changes to `digital_thread_page()`, all so the page can state what it is showing. The
-- argument is in supabase/README.md, "Saying how much of the thread this is".
--
--   `total_matching`  how many rows the filters select, under the same purged rule the page opens
--                     with and before the cursor and the limit, so the tab can draw "200 of 467"
--                     and the second number holds still as the reader pages.
--   `areas`           joins the `is_purged` anti-join. 0077 named the three asset tables that
--                     existed and 0097 added a fourth, so a deleted area was counted in the total,
--                     uncounted by `purged_assets`, and hidden anyway by the tab's own filter.
--   `p_search`        matches `entity_id` and the snapshot fields the lane label falls back to, so
--                     an asset that has been deleted is findable by the name the page shows for
--                     it. The tab used to resolve a name against the LIVE tables and send ids.
--
-- THE FIELD LIST IS SHARED WITH `snapshotIdentity()` in
-- frontend/src/components/tabs/DigitalThreadTab.jsx. A field in one and not the other is a lane
-- you can see and cannot search for, or one you can find and cannot identify.
--
-- `is_purged` gains the fourth asset table and no general rule: an entity type whose TABLE has
-- been retired is still drawn and still cannot be hidden, because "the table is gone" is a
-- different question from "the row is gone".

SET search_path TO public;

-- =================================================================================================
-- DROPPED AND RECREATED, NOT REPLACED, for the reason 0077 gives: CREATE OR REPLACE cannot change
-- an argument list, and leaving both declared would make every call by name ambiguous. 0077
-- recreates the nine-argument form on every boot; this file runs after it and the last declaration
-- wins, recorded in check-docs-drift.mjs's INTENDED_REDECLARATIONS.
--
-- EVERY DECLARATION, NOT 0077'S, and 0077 does the same for the same reason: a file that names one
-- argument list owns the function only until something adds an argument after it, and then leaves
-- a second declaration standing on every replay. The self-checks here and in 0077 call by name,
-- which is the call that cannot choose between two candidates.
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
WITH q AS (
    -- The search as a LIKE pattern, built once. THE METACHARACTERS ARE ESCAPED: the box promises
    -- a substring of a name or an id, and an unescaped '%' would silently return the whole thread
    -- to somebody who typed a percentage into it. Backslash is the default LIKE escape, so the
    -- backslashes have to be doubled first or an escape would be introduced by the escaping.
    SELECT CASE
             WHEN p_search IS NULL OR btrim(p_search) = '' THEN NULL
             ELSE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
           END AS pattern
),
matching AS (
    SELECT t.*,
           -- Scoped to the four asset types: only an entity type that names one of those tables can
           -- be purged from it. `service_principals` is an auth.users row with no public table to
           -- probe and would otherwise answer "absent from all four", and an entity type whose
           -- table has been retired is a separate question this does not answer.
           t.entity_type IN ('areas', 'cells', 'gateways', 'devices')
       AND NOT EXISTS (SELECT 1 FROM public.areas    a WHERE a.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.cells    c WHERE c.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.devices  d WHERE d.id = t.entity_id)
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
  'One page of the Digital Thread, with deleted assets filtered server-side and counted over the whole match rather than the page. `total_matching` is how many rows the filters select in total, under the same purged rule as the page, so a reader knows what fraction of the thread they hold. Keyset paged on (recorded_at DESC, id DESC): pass the previous response''s `next_cursor` back as p_before_recorded_at/p_before_id. A null next_cursor is the only end-of-data signal. `p_search` matches the entity id and the audit-snapshot fields the timeline labels a lane from, so a deleted asset is findable by the name the page shows for it; LIKE metacharacters in it are literal. `is_purged` applies to areas, cells, gateways and devices -- an entity type with no table behind it cannot have been deleted from one.';

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
  v_declared  integer;
  v_page      jsonb;
  v_total     bigint;
  v_direct    bigint;
  v_all       bigint;
  v_name      text;
  v_found     bigint;
  v_wildcard  bigint;
BEGIN
  -- 1. ONE DECLARATION. Two candidates make every call by argument name ambiguous, which is how
  --    this failed: the chain aborted inside 0077, on the SECOND boot, with a database left half
  --    migrated. Cheap to assert and impossible to notice otherwise.
  SELECT count(*) INTO v_declared
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'digital_thread_page';

  IF v_declared <> 1 THEN
    RAISE EXCEPTION
      '0115 self-check: digital_thread_page is declared % time(s), not once -- calls by argument '
      'name cannot choose a candidate, and the next migration to call one will abort the chain.',
      v_declared;
  END IF;

  v_page  := public.digital_thread_page(p_limit => 1, p_include_purged => false);
  v_total := (v_page ->> 'total_matching')::bigint;

  -- 2. THE TOTAL IS THE TOTAL. Counted here the long way round, from the table, under the same
  --    purged rule the page opens with.
  SELECT count(*) INTO v_direct
    FROM public.digital_thread t
   WHERE NOT (t.entity_type IN ('areas', 'cells', 'gateways', 'devices')
          AND NOT EXISTS (SELECT 1 FROM public.areas    a WHERE a.id = t.entity_id)
          AND NOT EXISTS (SELECT 1 FROM public.cells    c WHERE c.id = t.entity_id)
          AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.id = t.entity_id)
          AND NOT EXISTS (SELECT 1 FROM public.devices  d WHERE d.id = t.entity_id));

  IF v_total <> v_direct THEN
    RAISE EXCEPTION
      '0115 self-check: total_matching is % but the table holds % row(s) under the same purged '
      'rule -- the count and the page are reading different sets.', v_total, v_direct;
  END IF;

  -- 3. A PAGE IS PART OF ITS OWN TOTAL. Cheap, and it is the assertion that catches a total
  --    counted after the LIMIT rather than before it.
  IF v_total < jsonb_array_length(v_page -> 'events') THEN
    RAISE EXCEPTION
      '0115 self-check: a page of % row(s) reports a total of % -- total_matching is being counted '
      'over the page instead of over the match.',
      jsonb_array_length(v_page -> 'events'), v_total;
  END IF;

  -- 4. REVEALING THE DELETED ASSETS CANNOT REVEAL FEWER. `p_include_purged` widens the set, and
  --    the total has to widen with it or it is describing the wrong one.
  v_all := (public.digital_thread_page(p_limit => 1, p_include_purged => true)
            ->> 'total_matching')::bigint;

  IF v_all < v_total THEN
    RAISE EXCEPTION
      '0115 self-check: including deleted assets totals % against % without them -- including rows '
      'has removed some.', v_all, v_total;
  END IF;

  -- Everything below needs rows to be about. A first boot has none, and an empty thread must not
  -- fail the chain.
  IF v_all = 0 THEN
    RAISE NOTICE '0115: digital_thread is empty; the search self-checks have nothing to read yet.';
    RETURN;
  END IF;

  -- 5. A SEARCH MATCHING NOTHING RETURNS NOTHING, rather than everything. This is the failure the
  --    old client-side resolution had in the other direction -- an empty id list read as no filter
  --    would be worse than the empty page it produced.
  v_found := (public.digital_thread_page(
                p_limit => 1, p_include_purged => true,
                p_search => 'no-entity-is-named-this-0115') ->> 'total_matching')::bigint;

  IF v_found <> 0 THEN
    RAISE EXCEPTION
      '0115 self-check: a search matching no entity selected % row(s) -- p_search is not filtering.',
      v_found;
  END IF;

  -- 6. A NAME IN THE AUDIT SNAPSHOT IS FINDABLE, which is the whole point: that name is what the
  --    timeline labels the lane with, live row or not. Taken from a row that has one rather than
  --    seeded, because this file may not write to an append-only table.
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
        '0115 self-check: the audit snapshot names %, and searching for it finds nothing -- the '
        'search is not reading the fields the lane label falls back to.', v_name;
    END IF;
  END IF;

  -- 7. A METACHARACTER IS A CHARACTER. A bare '%' selecting the whole thread is what an unescaped
  --    pattern looks like; every row containing a literal percent sign is the only other way this
  --    can happen, and it is not a state this database reaches.
  v_wildcard := (public.digital_thread_page(
                   p_limit => 1, p_include_purged => true,
                   p_search => '%') ->> 'total_matching')::bigint;

  IF v_wildcard = v_all THEN
    RAISE EXCEPTION
      '0115 self-check: searching for a bare %% selected all % row(s) -- LIKE metacharacters are '
      'reaching the pattern unescaped.', v_all;
  END IF;

  RAISE NOTICE '0115: the thread reports % row(s) under the default filters and % with deleted '
               'assets shown; the search filters, and its metacharacters are literal.',
               v_total, v_all;
END
$check$;
