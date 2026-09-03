-- =============================================================================================
-- Migration: 0039_digital_thread_page.sql
-- The Digital Thread's row budget is spent on rows the page will actually show
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- THE BUG, AS AN OPERATOR MET IT. The Digital Thread page, with every filter cleared, listed FOUR
-- assets on a stack holding twenty-six. Changing the action filter from "Any Action" to "Update"
-- listed all of them. A LESS SPECIFIC FILTER SHOWED FEWER RESULTS, which is the shape of a bug
-- rather than of a preference.
--
-- WHY. The page fetches the newest 200 events, then hides the ones belonging to assets that have
-- been deleted -- a deliberate feature (issue #44), because a deleted `Test` gateway is noise on
-- every visit. But the LIMIT IS APPLIED BEFORE THE HIDING. On the stack where this was found, 12
-- of the 16 assets in that window had been deleted, so 87 of the 200 rows were spent on rows that
-- were then discarded -- and the four surviving assets were all that reached the screen. The four
-- live gateways had no event inside the window at all, so the Gateways section rendered empty on a
-- fleet of four healthy gateways.
--
-- THE FILE ALREADY KNEW. `namedEntityIds` in DigitalThreadTab.jsx carries the rule this violates:
-- "The row limit is applied by the database, so filtering after the fact would page through 200
-- mixed rows and then show whichever fraction happened to match -- the same reason the action
-- filter and the time range are SQL predicates." The name filter, the action filter and the time
-- range were all pushed down for exactly this reason. The purged filter was not.
--
-- ---------------------------------------------------------------------------------------------
-- WHY AN RPC AND NOT A `NOT IN (...)` ON THE EXISTING QUERY.
--
-- "Not purged" is an ANTI-JOIN against three tables, and PostgREST cannot express one. The
-- alternative was to send the browser's list of live entity ids as an `in.()` filter -- which
-- works, and breaks twice:
--
--   * A URL CARRYING EVERY LIVE ASSET ID. At 37 characters per UUID a fleet of five hundred is an
--     18 KB query string, past what nginx will accept by default. It would work on a demonstrator
--     and fail on a plant.
--   * IT WOULD HAVE REMOVED THE BUTTON THAT REVEALS THEM. `purgedAssetCount` is derived from the
--     purged rows PRESENT in the fetched page, and the "Show deleted assets (12)" control only
--     renders when that count is non-zero. Filtering them out in the query would leave the count
--     at zero, the button unrendered, and no way to turn the view back on -- a fix whose own
--     mechanism hides its escape hatch.
--
-- So the page and the count have to come from the same statement. This returns both.
--
-- ---------------------------------------------------------------------------------------------
-- SECURITY INVOKER, DELIBERATELY. `digital_thread` is readable only by Administrator,
-- Shopfloor_Manager and Auditor (its RLS policy), and running as the caller is what keeps that
-- true through this function -- a DEFINER here would hand every authenticated user the audit
-- trail. The liveness test reads `cells`, `gateways` and `devices`, whose SELECT policies are
-- `true` for `authenticated`, so an invoker who may read the thread can also resolve which of its
-- subjects still exist. If those policies are ever narrowed, THIS FUNCTION BECOMES WRONG RATHER
-- THAN UNAUTHORISED: rows the caller cannot see would read as deleted assets. The self-check at
-- the bottom asserts the policies are still open.
-- =============================================================================================

SET search_path TO public;


CREATE OR REPLACE FUNCTION public.digital_thread_page(
    p_limit          integer     DEFAULT 200,
    p_include_purged boolean     DEFAULT false,
    p_entity_type    text        DEFAULT NULL,
    p_action         text        DEFAULT NULL,
    p_entity_ids     uuid[]      DEFAULT NULL,
    p_since          timestamptz DEFAULT NULL,
    p_until          timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
WITH matching AS (
    SELECT t.*,
           -- `digital_thread.entity_id` and all three primary keys are `uuid`, so these compare
           -- directly. NOT NARROWED BY `entity_type`: the audit row records which TABLE the
           -- trigger fired on, and an asset is live if it is still in any of them -- three cheap
           -- index probes on a uuid, rather than a CASE that would have to stay in step with the
           -- trigger's TG_TABLE_NAME vocabulary.
           NOT EXISTS (SELECT 1 FROM public.cells    c WHERE c.id = t.entity_id)
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
     WHERE p_include_purged OR NOT is_purged
     ORDER BY recorded_at DESC
     LIMIT GREATEST(1, LEAST(coalesce(p_limit, 200), 2000))
)
SELECT jsonb_build_object(
    -- `- 'is_purged'` so the shape the client receives is exactly a digital_thread row. The flag is
    -- an implementation detail of this function and would otherwise leak into the CSV export,
    -- which is a file an auditor opens.
    'events', coalesce(
        (SELECT jsonb_agg(to_jsonb(v) - 'is_purged' ORDER BY v.recorded_at DESC) FROM visible v),
        '[]'::jsonb),
    -- COUNTED OVER `matching`, NOT OVER THE PAGE. "12 deleted assets are hidden" is a fact about
    -- everything the current filters select, not about the 200 rows that happened to fit -- and
    -- counting it over the page is what made the old control disappear exactly when the page was
    -- most truncated.
    'purged_assets', (SELECT count(DISTINCT entity_id) FROM matching WHERE is_purged),
    -- Whether the limit bit. The page has no way to know otherwise, and "showing the newest 200"
    -- is the difference between a quiet view and a quietly incomplete one.
    'truncated', (SELECT count(*) FROM visible) >= GREATEST(1, LEAST(coalesce(p_limit, 200), 2000))
);
$fn$;

COMMENT ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamptz, timestamptz) IS
  'One page of the Digital Thread, with the deleted-asset filter applied BEFORE the row limit so '
  'the budget is spent on rows that will be shown. Returns {events, purged_assets, truncated}: the '
  'count is over everything the filters select rather than over the page, because it drives the '
  'control that reveals them. SECURITY INVOKER -- digital_thread''s RLS is the access decision.';

-- Readable by exactly the roles that may read the table it pages. `authenticated` covers them; the
-- RLS policy on digital_thread is what distinguishes Administrator/Shopfloor_Manager/Auditor from
-- an Operator, and it still applies inside an INVOKER function.
REVOKE ALL ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamptz, timestamptz) TO authenticated;


-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_all      jsonb;
    v_live     jsonb;
    v_open     int;
BEGIN
    -- The liveness test depends on these three being readable by whoever may read the thread. If
    -- that stops being true this function does not fail, it MISREPORTS -- every asset the caller
    -- cannot see becomes a deleted one.
    SELECT count(*) INTO v_open
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname IN ('cells', 'gateways', 'devices')
       AND p.polcmd IN ('r', '*')
       AND pg_get_expr(p.polqual, p.polrelid) = 'true';
    IF v_open < 3 THEN
        RAISE EXCEPTION
          '0039 self-check: only % of cells/gateways/devices still have an unrestricted SELECT '
          'policy. digital_thread_page() decides "this asset was deleted" by failing to find the '
          'row, so a narrowed policy turns invisible rows into deleted ones -- silently.', v_open;
    END IF;

    v_all  := public.digital_thread_page(p_limit => 500, p_include_purged => true);
    v_live := public.digital_thread_page(p_limit => 500, p_include_purged => false);

    -- THE PROPERTY THE MIGRATION EXISTS FOR: hiding deleted assets must never yield MORE rows, and
    -- the purged count must be reported identically either way -- it is a fact about the filters,
    -- not about which view is showing.
    IF jsonb_array_length(v_live -> 'events') > jsonb_array_length(v_all -> 'events') THEN
        RAISE EXCEPTION '0039 self-check: hiding deleted assets returned MORE events than showing them.';
    END IF;
    IF (v_all ->> 'purged_assets') <> (v_live ->> 'purged_assets') THEN
        RAISE EXCEPTION
          '0039 self-check: purged_assets differs between the two views (% vs %). It drives the '
          'control that reveals them, so it must not depend on whether they are currently shown.',
          v_all ->> 'purged_assets', v_live ->> 'purged_assets';
    END IF;

    RAISE NOTICE
      '0039 self-check passed: % event(s) with deleted assets shown, % without, % deleted asset(s) '
      'reported either way.',
      jsonb_array_length(v_all -> 'events'), jsonb_array_length(v_live -> 'events'),
      v_all ->> 'purged_assets';
END;
$selfcheck$;
