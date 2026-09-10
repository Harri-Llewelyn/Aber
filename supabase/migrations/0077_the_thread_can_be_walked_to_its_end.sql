-- 0077: the Digital Thread stops ending at 200 rows.
--
-- `digital_thread_page()` gains a keyset cursor so the tab can ask for the next page. Raising the
-- cap was the wrong fix: `matching` already scans every row the filters select to count purged
-- assets over the whole match.
--
-- KEYSET, NOT OFFSET. The table is append-only and read newest-first, so between two pages every
-- offset has shifted by however many events arrived. The cursor is `(recorded_at, id)`, not
-- `recorded_at` alone: log_digital_thread_event() stamps every row in one transaction with the
-- same `now()`, and a batch relocation is one transaction, so `recorded_at` is not a total order.
-- The index matches that order.

CREATE INDEX IF NOT EXISTS idx_digital_thread_recorded_id
    ON public.digital_thread (recorded_at DESC, id DESC);

COMMENT ON INDEX public.idx_digital_thread_recorded_id IS
  'Serves digital_thread_page()''s keyset order. MUST match its ORDER BY (recorded_at DESC, id DESC) exactly -- a cursor walking one order against an index in another degrades to a full sort per page, which is invisible until the table is large.';

-- =================================================================================================
-- DROPPED AND RECREATED, NOT REPLACED: CREATE OR REPLACE would leave both argument lists
-- declared, and with the new ones defaulted a seven-argument call would be ambiguous. 0001
-- recreates the seven-argument form on every boot; this file runs after it and the last
-- declaration wins, recorded in check-docs-drift.mjs's INTENDED_REDECLARATIONS.
DROP FUNCTION IF EXISTS public.digital_thread_page(
    integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone);

CREATE OR REPLACE FUNCTION public.digital_thread_page(
    p_limit integer DEFAULT 200,
    p_include_purged boolean DEFAULT false,
    p_entity_type text DEFAULT NULL::text,
    p_action text DEFAULT NULL::text,
    p_entity_ids uuid[] DEFAULT NULL::uuid[],
    p_since timestamp with time zone DEFAULT NULL::timestamp with time zone,
    p_until timestamp with time zone DEFAULT NULL::timestamp with time zone,
    -- THE CURSOR, and it is the position of the LAST ROW ALREADY SEEN rather than an index. Both
    -- halves or neither: a half-supplied cursor makes the row comparison below NULL, which filters
    -- out every row and would render as "no more events" on a thread that has plenty.
    p_before_recorded_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
    p_before_id bigint DEFAULT NULL::bigint
) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
WITH matching AS (
    SELECT t.*,
           -- Scoped to the three asset types: only entity types that name one of those tables can be
           -- purged from it. `service_principals` is an auth.users row with no public table to probe and
           -- would otherwise answer "absent from all three".
           t.entity_type IN ('cells', 'gateways', 'devices')
       AND NOT EXISTS (SELECT 1 FROM public.cells    c WHERE c.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.devices  d WHERE d.id = t.entity_id)
               AS is_purged
      FROM public.digital_thread t
     WHERE (p_entity_type IS NULL OR t.entity_type = p_entity_type)
       AND (p_action      IS NULL OR t.action      = p_action)
       AND (p_entity_ids  IS NULL OR t.entity_id   = ANY (p_entity_ids))
       AND (p_since       IS NULL OR t.recorded_at >= p_since)
       AND (p_until       IS NULL OR t.recorded_at <= p_until)
),
visible AS (
    SELECT * FROM matching
     WHERE (p_include_purged OR NOT is_purged)
       -- The cursor is applied here and not in `matching`: `purged_assets` is counted over `matching`
       -- and is a fact about everything the filters select, not about what is left after paging.
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
    -- KEPT, AND IT NOW MEANS "THERE IS A NEXT PAGE". It used to mean "your view is cut off", which
    -- was the same thing when there was no way to ask for more. Callers that only ever showed a
    -- banner keep working unchanged.
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

COMMENT ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint) IS
  'One page of the Digital Thread, with deleted assets filtered server-side and counted over the whole match rather than the page. Keyset paged on (recorded_at DESC, id DESC): pass the previous response''s `next_cursor` back as p_before_recorded_at/p_before_id. A null next_cursor is the only end-of-data signal. `is_purged` applies only to cells, gateways and devices -- an entity type with no table behind it cannot have been deleted from one.';

-- The grants 0001 puts on the seven-argument form do not follow it across the DROP, and a function
-- nobody may execute fails identically to one that does not exist -- except that it fails at the
-- call site, in the browser, as an empty page rather than as a migration error.
REVOKE ALL ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint) TO service_role;
GRANT ALL ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint) TO authenticated;

-- =================================================================================================
-- SELF-CHECK: walk the thread and prove the walk is exact. Read-only, on whatever rows exist:
-- the table is append-only, so a fixture could never be taken back. The page size is small
-- enough to land inside a same-timestamp batch, where a repeated or skipped row would show.
DO $walk$
DECLARE
  v_page       jsonb;
  v_cursor     jsonb := NULL;
  v_seen       bigint[] := '{}';
  v_ids        bigint[];
  v_total      bigint;
  v_pages      integer := 0;
  v_page_size  constant integer := 7;
  v_max_pages  constant integer := 40;
BEGIN
  SELECT count(*) INTO v_total FROM public.digital_thread;

  -- Nothing to walk on a first boot, and an empty table must not fail the chain.
  IF v_total = 0 THEN
    RAISE NOTICE '0077: digital_thread is empty; the paging walk has nothing to check yet.';
    RETURN;
  END IF;

  LOOP
    v_pages := v_pages + 1;
    EXIT WHEN v_pages > v_max_pages;

    v_page := public.digital_thread_page(
      p_limit              => v_page_size,
      p_include_purged     => true,
      p_before_recorded_at => (v_cursor ->> 'recorded_at')::timestamptz,
      p_before_id          => (v_cursor ->> 'id')::bigint
    );

    SELECT coalesce(array_agg((e ->> 'id')::bigint), '{}')
      INTO v_ids
      FROM jsonb_array_elements(v_page -> 'events') e;

    -- NO ROW MAY APPEAR TWICE. The `&&` overlap operator asks it directly rather than by counting,
    -- so the failure names the collision instead of a total that happens not to add up.
    IF v_seen && v_ids THEN
      RAISE EXCEPTION
        '0077: the cursor repeated row(s) % on page % -- keyset paging is returning the same event '
        'more than once, which on a same-timestamp batch means the order is not total.',
        (SELECT array_agg(x) FROM unnest(v_ids) x WHERE x = ANY (v_seen)), v_pages;
    END IF;

    v_seen := v_seen || v_ids;
    v_cursor := v_page -> 'next_cursor';
    EXIT WHEN v_cursor IS NULL OR v_cursor = 'null'::jsonb;
  END LOOP;

  -- AND NO ROW MAY BE SKIPPED, checked only when the walk actually reached the end. Bounded above
  -- by v_max_pages so a large table does not turn every boot into a full re-read; a deployment past
  -- 280 rows proves the no-repeat half above and leaves this one to the suite, which controls its
  -- own fixture and can always reach the end.
  IF v_cursor IS NULL OR v_cursor = 'null'::jsonb THEN
    IF array_length(v_seen, 1) <> v_total THEN
      RAISE EXCEPTION
        '0077: the walk ended after % row(s) but digital_thread holds % -- the cursor skipped rows.',
        coalesce(array_length(v_seen, 1), 0), v_total;
    END IF;
    RAISE NOTICE '0077: paging walk covered all % row(s) exactly once.', v_total;
  END IF;
END
$walk$;
