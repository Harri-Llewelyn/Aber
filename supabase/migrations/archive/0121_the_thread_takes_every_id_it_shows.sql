-- 0121: the search takes every id the drawer shows, not just the entity's.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- The event drawer offers three copyable ids and the search box accepted one of them. `p_search`
-- matched `entity_id` and the snapshot fields a lane is labelled from; the audit row's own id and
-- the transaction that wrote it had no consumer anywhere in the platform -- no filter, no search,
-- no RPC argument. A reader handed a mutation id in a ticket had nowhere to put it.
--
-- A SEARCH TERM THAT IS A BARE INTEGER ALSO MATCHES `id` AND `causation_id`. Additive: the name
-- disjuncts are untouched, so an entity whose name happens to be digits still matches by name and
-- no result is taken away. Both columns are bigint and both are indexed -- digital_thread_pkey
-- leads on `id`, idx_digital_thread_causation covers the other.
--
-- BOUNDED TO 18 DIGITS. `raw::bigint` on a longer run of digits raises numeric_value_out_of_range
-- and fails the whole page; bigint's maximum is 19 digits, so 18 can never overflow. A longer
-- number is still matched by the name disjuncts, as any other text is.
--
-- This is what makes the drawer's "Same transaction" list exact. It reads the loaded, filtered
-- events, so it could only ever report the siblings that happened to be on the page and said so;
-- searching the causation id makes the loaded set the transaction.
--
-- RLS IS UNCHANGED AND STILL APPLIES: this function is SECURITY INVOKER, so a Shopfloor_Manager
-- searching a mutation id reads what digital_thread_select_asset admits and nothing else.

SET search_path TO public;

-- =================================================================================================
-- DROPPED AND RECREATED, NOT REPLACED, for the reason 0077 gives: CREATE OR REPLACE cannot change
-- an argument list, and leaving both declared would make every call by name ambiguous. 0077
-- recreates the nine-argument form on every boot, 0115 its ten-argument one, and 0117 and 0118
-- theirs; this file runs after all of them and the last declaration wins, recorded in
-- check-docs-drift.mjs's INTENDED_REDECLARATIONS.
--
-- EVERY DECLARATION, AND NOT MERELY THE ONE THIS FILE WRITES. This file takes the same argument
-- list 0118 did and could have used CREATE OR REPLACE alone; the loop is kept because the
-- migration that eventually adds an eleventh argument will otherwise resurrect this form.
--
-- THE GRANTS DO NOT FOLLOW THE FUNCTION ACROSS THE DROP, and a function nobody may execute fails
-- exactly like one that does not exist -- except in the browser, as an empty page, rather than
-- here as a migration error. They are re-granted below.
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
WITH term AS (
    SELECT CASE WHEN p_search IS NULL OR btrim(p_search) = '' THEN NULL ELSE btrim(p_search) END AS raw
),
pattern AS (
    -- The search as a LIKE pattern, built once. THE METACHARACTERS ARE ESCAPED: the box promises
    -- a substring of a name or an id, and an unescaped '%' would silently return the whole thread
    -- to somebody who typed a percentage into it. Backslash is the default LIKE escape, so the
    -- backslashes have to be doubled first or an escape would be introduced by the escaping.
    SELECT CASE
             WHEN t.raw IS NULL THEN NULL
             ELSE '%' || replace(replace(replace(t.raw, '\', '\\'), '%', '\%'), '_', '\_') || '%'
           END AS pattern,
           -- THE SAME TERM AS A ROW ID, when it is nothing but digits. 18 at most: bigint tops out
           -- at 19, and a cast that overflows raises rather than missing.
           CASE
             WHEN t.raw ~ '^[0-9]{1,18}$' THEN t.raw::bigint
             ELSE NULL
           END AS id_term
      FROM term t
),
-- MATERIALIZED, AND MEASURED. Without it Postgres inlines this CTE and the helper lands in the
-- per-row Filter of every partition scan -- a STABLE function is allowed to be called once and is
-- not promised to be. On 4,065 rows that took a search from 53ms to 583ms, which is the shape of
-- cost that looks like "the thread got big" rather than like a query doing the wrong thing.
q AS MATERIALIZED (
    SELECT p.pattern,
           p.id_term,
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
            -- THE OTHER TWO IDS THE DRAWER SHOWS: this audit row, and the transaction that wrote
            -- it. Only when the term is nothing but digits, so this adds rows to a numeric search
            -- and changes no other one.
            OR (q.id_term IS NOT NULL
                AND (t.id = q.id_term OR t.causation_id = q.id_term))
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
  'One page of the Digital Thread, with deleted entities filtered server-side and counted over the whole match rather than the page. `total_matching` is how many rows the filters select in total, under the same purged rule as the page, so a reader knows what fraction of the thread they hold. Keyset paged on (recorded_at DESC, id DESC): pass the previous response''s `next_cursor` back as p_before_recorded_at/p_before_id. A null next_cursor is the only end-of-data signal. `p_search` matches the entity id and the audit-snapshot fields the timeline labels a lane from, so an entity is findable by the name the page shows for it; LIKE metacharacters in it are literal. A term of 1 to 18 digits ALSO matches the audit row''s own id and its causation_id (0121), which is how the other two ids the event drawer shows are searchable; it is an additional disjunct, so a numeric name still matches by name. Two labels are not in any payload and are matched through a SECURITY DEFINER helper each: the person a role assignment is about (0115), and a backup job''s note and the stamp of the backup it produced (0118). `is_purged` applies to areas, cells, gateways, devices, schemas and device nameplates -- every entity type this function can probe a table for. A type with no readable table behind it (user_roles and service_principals, which are auth.users rows; area_floors, whose table was retired) is never called deleted. `purged_assets` keeps its wire name and counts all of them.';

-- The grants do not follow the function across the DROP. See the note above the DROP for why that
-- failure is worse than a loud one.
REVOKE ALL ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint, text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint, text) TO service_role;
GRANT ALL ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint, text) TO authenticated;

-- =================================================================================================
-- SELF-CHECKS. Read-only, on whatever rows the database happens to hold, and RELATIVE THROUGHOUT:
-- every assertion compares two computations of the same quantity rather than either of them to a
-- number written here. An absolute count in a self-check passes on the boot that wrote it and
-- fails on the next one that adds a row (0069, corrected by 0086).
-- =================================================================================================
DO $check$
DECLARE
  v_declared   integer;
  v_all        bigint;
  v_id         bigint;
  v_causation  bigint;
  v_siblings   bigint;
  v_found      bigint;
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
      '0121 self-check: digital_thread_page is declared % time(s); every call by argument name '
      'is ambiguous unless it is exactly one.', v_declared;
  END IF;

  SELECT count(*) INTO v_all FROM public.digital_thread;

  IF v_all = 0 THEN
    RAISE NOTICE '0121: digital_thread is empty; the id self-checks have nothing to read yet.';
    RETURN;
  END IF;

  -- 2. A MUTATION ID FINDS ITS OWN ROW. The headline of this file: the drawer offers the value and
  --    the box now takes it.
  SELECT id INTO v_id FROM public.digital_thread ORDER BY id DESC LIMIT 1;

  v_found := (public.digital_thread_page(
                p_limit => 1, p_include_purged => true,
                p_search => v_id::text) ->> 'total_matching')::bigint;

  IF v_found < 1 THEN
    RAISE EXCEPTION
      '0121 self-check: searching for mutation id % found nothing -- the numeric disjunct is not '
      'reaching digital_thread.id.', v_id;
  END IF;

  -- 3. A TRANSACTION ID FINDS ITS WHOLE GROUP, which is what makes the drawer's sibling list exact
  --    rather than "whatever happened to be loaded". Compared against a direct count of the group,
  --    never against a number written here.
  SELECT causation_id INTO v_causation
    FROM public.digital_thread
   WHERE causation_id IS NOT NULL
   ORDER BY id DESC LIMIT 1;

  IF v_causation IS NOT NULL THEN
    SELECT count(*) INTO v_siblings
      FROM public.digital_thread WHERE causation_id = v_causation;

    v_found := (public.digital_thread_page(
                  p_limit => 1, p_include_purged => true,
                  p_search => v_causation::text) ->> 'total_matching')::bigint;

    IF v_found < v_siblings THEN
      RAISE EXCEPTION
        '0121 self-check: transaction % wrote % row(s) and searching for it selected % -- the '
        'sibling list cannot be made exact from a search that misses members.',
        v_causation, v_siblings, v_found;
    END IF;
  END IF;

  -- 4. IT IS STILL A FILTER. A numeric term no row carries must select nothing: a disjunct that
  --    matches everything reads as "the search broke" only after somebody trusts an answer.
  v_found := (public.digital_thread_page(
                p_limit => 1, p_include_purged => true,
                p_search => '999999999999999999') ->> 'total_matching')::bigint;

  IF v_found <> 0 THEN
    RAISE EXCEPTION
      '0121 self-check: a numeric search matching no row selected % row(s).', v_found;
  END IF;

  -- 5. AN OVERLONG RUN OF DIGITS IS TEXT, NOT A NUMBER. 19 digits would overflow the bigint cast
  --    and fail the page rather than miss; the guard is the length bound in the pattern CTE, and
  --    this is the assertion that it is still there.
  v_found := (public.digital_thread_page(
                p_limit => 1, p_include_purged => true,
                p_search => '99999999999999999999999999') ->> 'total_matching')::bigint;

  IF v_found <> 0 THEN
    RAISE EXCEPTION
      '0121 self-check: a 26-digit search selected % row(s).', v_found;
  END IF;

  -- 6. A METACHARACTER IS A CHARACTER. Re-asserted rather than assumed: this file rewrites the
  --    expression that escapes them by copying it, and a copy is exactly where it would be lost.
  v_found := (public.digital_thread_page(
                p_limit => 1, p_include_purged => true,
                p_search => '%') ->> 'total_matching')::bigint;

  IF v_found = v_all THEN
    RAISE EXCEPTION
      '0121 self-check: searching for a bare %% selected all % row(s) -- LIKE metacharacters are '
      'reaching the pattern unescaped.', v_all;
  END IF;

  RAISE NOTICE '0121: the search takes a mutation id and a transaction id; % row(s) in the thread.',
               v_all;
END
$check$;
