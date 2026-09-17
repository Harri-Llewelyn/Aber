-- 0118: a backup job says which act it was, so no lane is a bare uuid.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- Two additions to the search, both so the timeline can label the last two lanes that had nothing
-- to label themselves with.
--
--   `origin`    joins the shared snapshot field list. A backup job has no name -- the table has no
--               name column -- and the one identity its payload carries is what KIND of act it
--               was: requested or scheduled. The tab draws that as the Backups page words it and
--               appends the short id, because an origin is a category and every job of a kind
--               shares it. ILIKE is case-blind, so the stored value is what a reader types.
--   `job_ids`   matches a job by the note an operator typed and by the stamp of the backup it
--               produced. Neither is in the audit payload: the note is on `backup_jobs` and the
--               stamp on `backups`, and both are what the Backups page identifies one by.
--
-- THE HELPER IS SECURITY DEFINER FOR THE REASON 0115'S IS. `backup_jobs` and `backups` are
-- Administrator-only, but `digital_thread_select_security` admits Administrator AND Auditor -- so
-- an Auditor can see a backup lane and, through a plain join in a SECURITY INVOKER function, could
-- never search it. The gate inside is that same pair, and an unauthorised caller gets an empty
-- array rather than an error, because this is one disjunct of a search and raising would fail the
-- whole page for somebody whose search simply does not reach that lane.
--
-- The one lane this does NOT touch is the service principal, and deliberately: there is no
-- `service_principals` table -- the audit row IS the record -- so the dashboard names those from
-- its own registry of ids a migration pinned (`KNOWN_PRINCIPALS` in utils/serviceIdentities.js).
-- A name held in frontend source cannot be matched by a database search, so that lane is findable
-- by its id. supabase/README.md, "Naming the last two lanes", says so.

SET search_path TO public;

-- -------------------------------------------------------------------------------------------------
-- The two labels a backup job's payload does not carry
-- -------------------------------------------------------------------------------------------------
-- A `backup_jobs` audit row holds the origin, the note and the status and nothing else; the note
-- lives on the table and the stamp of the backup it produced on another table again. Both are what
-- the Backups page identifies a job by, so both are what somebody types into the search.
--
-- LEFT JOIN, not JOIN: over half the jobs on a working stack never produced a backup -- they were
-- cancelled, or they failed -- and an inner join would make those unsearchable by their note as
-- well, which is the only handle they have.
--
-- SECURITY DEFINER because both tables are Administrator-only while the audit lane admits Auditors
-- too, and an empty array rather than an error for anybody else: see the header.
CREATE OR REPLACE FUNCTION public.digital_thread_backup_job_ids_matching(p_pattern text)
    RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(array_agg(j.id), '{}'::uuid[])
    FROM public.backup_jobs j
    LEFT JOIN public.backups b ON b.id = j.backup_id
   WHERE p_pattern IS NOT NULL
     AND public.has_role(ARRAY['Administrator', 'Auditor'])
     AND (j.note ILIKE p_pattern OR b.stamp ILIKE p_pattern)
$$;

COMMENT ON FUNCTION public.digital_thread_backup_job_ids_matching(text) IS
  'The ids of backup jobs whose note, or the stamp of the backup they produced, matches a LIKE pattern -- the two things the Backups page identifies a job by and neither of which is in its audit payload. For digital_thread_page()''s search. Administrator and Auditor only, matching the roles digital_thread_select_security admits, and an empty array rather than an error for anybody else because this is part of a query rather than a request of its own.';

REVOKE ALL ON FUNCTION public.digital_thread_backup_job_ids_matching(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.digital_thread_backup_job_ids_matching(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.digital_thread_backup_job_ids_matching(text) TO service_role;

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
           public.digital_thread_user_ids_matching(p.pattern)        AS user_ids,
           public.digital_thread_backup_job_ids_matching(p.pattern)  AS job_ids
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
            -- The note and the produced backup's stamp, which are on two tables and in no payload.
            -- Empty on the same terms, and for the same reason.
            OR t.entity_id = ANY (q.job_ids)
            OR EXISTS (
                 SELECT 1
                   FROM unnest(ARRAY['name', 'sparkplug_id', 'schema_name',
                                     'label', 'key', 'role', 'stamp', 'origin']) AS f(field)
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
  'One page of the Digital Thread, with deleted entities filtered server-side and counted over the whole match rather than the page. `total_matching` is how many rows the filters select in total, under the same purged rule as the page, so a reader knows what fraction of the thread they hold. Keyset paged on (recorded_at DESC, id DESC): pass the previous response''s `next_cursor` back as p_before_recorded_at/p_before_id. A null next_cursor is the only end-of-data signal. `p_search` matches the entity id and the audit-snapshot fields the timeline labels a lane from, so an entity is findable by the name the page shows for it; LIKE metacharacters in it are literal. Two labels are not in any payload and are matched through a SECURITY DEFINER helper each: the person a role assignment is about (0115), and a backup job''s note and the stamp of the backup it produced (0118). `is_purged` applies to areas, cells, gateways, devices, schemas and device nameplates -- every entity type this function can probe a table for. A type with no readable table behind it (user_roles and service_principals, which are auth.users rows; area_floors, whose table was retired) is never called deleted. `purged_assets` keeps its wire name and counts all of them.';

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
-- THE HELPERS CANNOT BE EXERCISED FROM HERE. Both gate on `has_role()`, a migration carries no JWT,
-- and so both answer '{}' whatever they hold -- which is the correct answer to "is the owner an
-- Administrator", and the reason the checks below assert their SHAPE and leave their results to
-- test_digital_thread_paging.py, which connects as a role.
-- =================================================================================================
DO $check$
DECLARE
  v_declared  integer;
  v_page      jsonb;
  v_total     bigint;
  v_direct    bigint;
  v_all       bigint;
  v_origin    text;
  v_found     bigint;
  v_wildcard  bigint;
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
      '0118 self-check: digital_thread_page is declared % time(s), not once -- calls by argument '
      'name cannot choose a candidate, and the next migration to call one will abort the chain.',
      v_declared;
  END IF;

  -- 2. THE NEW HELPER IS SECURITY DEFINER AND NOT PUBLIC. Without the first it reads two
  --    Administrator-only tables as the caller, so an Auditor's search of a backup lane would
  --    answer nothing -- silently, since an empty disjunct is indistinguishable from no match.
  --    Without the second, any anonymous caller could probe for backup notes, because the gate
  --    inside is a role check rather than a grant.
  IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'digital_thread_backup_job_ids_matching'
         AND p.prosecdef
  ) THEN
    RAISE EXCEPTION
      '0118 self-check: digital_thread_backup_job_ids_matching() is missing or not SECURITY DEFINER';
  END IF;

  IF has_function_privilege('public', 'public.digital_thread_backup_job_ids_matching(text)', 'EXECUTE') THEN
    RAISE EXCEPTION
      '0118 self-check: PUBLIC may execute digital_thread_backup_job_ids_matching()';
  END IF;

  -- A NULL pattern matches nothing, which is what an unfiltered page relies on: the disjunct is
  -- evaluated on every call, and one that matched rows for a null search would widen every page.
  IF public.digital_thread_backup_job_ids_matching(NULL) <> '{}'::uuid[] THEN
    RAISE EXCEPTION
      '0118 self-check: digital_thread_backup_job_ids_matching(NULL) named a job -- an unfiltered '
      'page would gain a disjunct that matches rows for no reason';
  END IF;

  -- 3. THE HELPERS ARE RESOLVED ONCE, NOT PER ROW. There are two STABLE functions in that CTE now,
  --    and a STABLE function is ALLOWED to be evaluated once rather than promised to be: inlined,
  --    the first one landed in the per-row Filter of every partition scan and took a search from
  --    53ms to 583ms. Asserted on the deployed text, because the cost is invisible until the
  --    thread is large and then reads as the thread being large.
  IF position('MATERIALIZED' IN pg_get_functiondef(
       'public.digital_thread_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION
      '0118 self-check: the pattern CTE is no longer MATERIALIZED -- both helpers will be called '
      'once per row scanned.';
  END IF;

  v_page  := public.digital_thread_page(p_limit => 1, p_include_purged => false);
  v_total := (v_page ->> 'total_matching')::bigint;

  -- 4. THE PURGED RULE SURVIVED THE REWRITE. This file rewrites the whole function to change the
  --    search in it, so the cheapest thing worth asserting is that 0117's rule arrived intact.
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
      '0118 self-check: total_matching is % but the table holds % row(s) under the same purged '
      'rule -- the count and the page are reading different sets.', v_total, v_direct;
  END IF;

  v_all := (public.digital_thread_page(p_limit => 1, p_include_purged => true)
            ->> 'total_matching')::bigint;

  IF v_all < v_total THEN
    RAISE EXCEPTION
      '0118 self-check: including deleted entities totals % against % without them -- including '
      'rows has removed some.', v_all, v_total;
  END IF;

  -- Everything below needs rows to be about. A first boot has none, and an empty thread must not
  -- fail the chain.
  IF v_all = 0 THEN
    RAISE NOTICE '0118: digital_thread is empty; the search self-checks have nothing to read yet.';
    RETURN;
  END IF;

  -- 5. AN ORIGIN IS SEARCHABLE, which is the half of this file that needs no role. It is what the
  --    timeline now labels a backup job with, and a label the search cannot match is the drift the
  --    shared field list exists to prevent.
  SELECT coalesce(t.new_data ->> 'origin', t.old_data ->> 'origin') INTO v_origin
    FROM public.digital_thread t
   WHERE coalesce(t.new_data ->> 'origin', t.old_data ->> 'origin', '') <> ''
   LIMIT 1;

  IF v_origin IS NOT NULL THEN
    v_found := (public.digital_thread_page(
                  p_limit => 1, p_include_purged => true,
                  p_search => v_origin) ->> 'total_matching')::bigint;

    IF v_found = 0 THEN
      RAISE EXCEPTION
        '0118 self-check: a row records origin %, and searching for it finds nothing -- the search '
        'is not reading the field the backup-job lane is labelled from.', v_origin;
    END IF;
  END IF;

  -- 6. A METACHARACTER IS A CHARACTER. Re-asserted rather than assumed: this file rewrites the
  --    expression that escapes them by copying it, and a copy is exactly where it would be lost.
  v_wildcard := (public.digital_thread_page(
                   p_limit => 1, p_include_purged => true,
                   p_search => '%') ->> 'total_matching')::bigint;

  IF v_wildcard = v_all THEN
    RAISE EXCEPTION
      '0118 self-check: searching for a bare %% selected all % row(s) -- LIKE metacharacters are '
      'reaching the pattern unescaped.', v_all;
  END IF;

  RAISE NOTICE '0118: the thread reports % row(s) under the default filters and % with deleted '
               'entities shown; an origin is searchable and both helpers are sealed.',
               v_total, v_all;
END
$check$;
