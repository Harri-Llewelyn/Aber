-- =============================================================================================
-- Migration: 0139_the_drawer_knows_how_many_rows_a_transaction_wrote.sql (applied as 0006 until the 1.0 squash)
-- Each Audit Trail event says how many rows its transaction wrote (#431)
-- =============================================================================================
--
-- The drawer's "Same transaction" section is drawn from the loaded, filtered events, and a
-- transaction whose other rows are outside the entity filter or on a page not yet fetched looks
-- identical to a single-row act. So it hedged, and offered "Show whole transaction" to every
-- event. `transaction_rows` is the missing fact: how many rows share the event's causation_id,
-- counted over the whole table.
--
-- The function is otherwise 0001's, and folds into it at the next squash (rule 1 of the fold).
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.audit_trail_page(p_limit integer DEFAULT 200, p_include_purged boolean DEFAULT false, p_entity_type text DEFAULT NULL::text, p_action text DEFAULT NULL::text, p_entity_ids uuid[] DEFAULT NULL::uuid[], p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_recorded_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id bigint DEFAULT NULL::bigint, p_search text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $_$
WITH term AS (
    SELECT CASE WHEN p_search IS NULL OR btrim(p_search) = '' THEN NULL ELSE btrim(p_search) END AS raw
),
pattern AS (
    -- The search as a LIKE pattern, built once. THE METACHARACTERS ARE ESCAPED: the box promises
    -- a substring of a name or an id, and an unescaped '%' would silently return the whole trail
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
-- cost that looks like "the trail got big" rather than like a query doing the wrong thing.
q AS MATERIALIZED (
    SELECT p.pattern,
           p.id_term,
           public.audit_trail_user_ids_matching(p.pattern)        AS user_ids,
           public.audit_trail_backup_job_ids_matching(p.pattern)  AS job_ids
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
      FROM public.audit_trail t
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
        (SELECT jsonb_agg(
                  (to_jsonb(v) - 'is_purged')
                  -- HOW MANY ROWS THE TRANSACTION WROTE (0006), over the whole table and not the
                  -- page, so the drawer can tell a single-row act from a group whose other rows
                  -- the filters hide or a later page holds. One probe of
                  -- idx_audit_trail_causation per row on the page. Under the caller's own
                  -- policies, like the rows themselves: it is the number a reader could load.
                  -- Null where there is no causation: NULL is not a group, and counting it would
                  -- make every legacy row one act.
                  || jsonb_build_object('transaction_rows',
                       CASE WHEN v.causation_id IS NULL THEN NULL
                            ELSE (SELECT count(*) FROM public.audit_trail d
                                   WHERE d.causation_id = v.causation_id)
                       END)
                  ORDER BY v.recorded_at DESC, v.id DESC)
           FROM visible v),
        '[]'::jsonb),
    'purged_assets', (SELECT count(DISTINCT entity_id) FROM matching WHERE is_purged),
    -- HOW LONG THE TRAIL IS UNDER THESE FILTERS, so a reader holding one page knows what fraction
    -- of it that is. Counted under the SAME predicate `visible` opens with, minus the cursor and
    -- the limit -- so it does not move as the reader pages, and a page can never report more rows
    -- than the total it is a fraction of.
    'total_matching', (SELECT count(*) FROM matching WHERE p_include_purged OR NOT is_purged),
    -- KEPT, AND IT MEANS "THERE IS A NEXT PAGE". It used to mean "your view is cut off", which was
    -- the same thing when there was no way to ask for more. Callers that only ever showed a banner
    -- keep working unchanged.
    'truncated', (SELECT count(*) FROM visible) >= greatest(1, least(coalesce(p_limit, 200), 1000)),
    -- WHERE THE READER GOT TO, or null at the end of the trail. Null is the ONLY end-of-data
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
$_$;

ALTER FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) OWNER TO postgres;

COMMENT ON FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) IS 'One page of the Audit Trail, with deleted entities filtered server-side and counted over the whole match rather than the page. `total_matching` is how many rows the filters select in total, under the same purged rule as the page, so a reader knows what fraction of the trail they hold. Keyset paged on (recorded_at DESC, id DESC): pass the previous response''s `next_cursor` back as p_before_recorded_at/p_before_id. A null next_cursor is the only end-of-data signal. `p_search` matches the entity id and the audit-snapshot fields the timeline labels a lane from, so an entity is findable by the name the page shows for it; LIKE metacharacters in it are literal. A term of 1 to 18 digits ALSO matches the audit row''s own id and its causation_id (0121), which is how the other two ids the event drawer shows are searchable; it is an additional disjunct, so a numeric name still matches by name. `transaction_rows` on each event is how many rows share its causation_id, counted over the whole table under the caller''s own policies rather than over the page, and null where there is no causation (0006). Two labels are not in any payload and are matched through a SECURITY DEFINER helper each: the person a role assignment is about (0115), and a backup job''s note and the stamp of the backup it produced (0118). `is_purged` applies to areas, cells, gateways, devices, schemas and device nameplates -- every entity type this function can probe a table for. A type with no readable table behind it (user_roles and service_principals, which are auth.users rows; area_floors, whose table was retired) is never called deleted. `purged_assets` keeps its wire name and counts all of them.';

-- Stated here as rule 3 of the fold asks, although CREATE OR REPLACE keeps the ACL 0001 set.
REVOKE ALL ON FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) TO authenticated;
GRANT ALL ON FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) TO service_role;
