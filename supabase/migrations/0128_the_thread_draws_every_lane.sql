-- 0128: the thread draws every lane.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- The Digital Thread capped its lanes at `ui.digital_thread_lane_limit` and folded the rest behind
-- a "Show all lanes" button at the foot of the page. Lanes are ordered busiest-first across the
-- whole page, so the hidden ones belonged to every section, and pressing a button at the bottom
-- expanded rows at the top. The cap was a render guard from when the page grew with its content;
-- the timeline scrolls inside the card now and a page holds at most 200 events, so the cap and
-- its button are gone from the frontend.
--
-- A SETTING NOTHING READS IS A CONTROL THAT DOES NOTHING, which is the rule 0002 states for
-- declaring one. 0002 no longer declares this key, but 0002 replays on every boot and only ever
-- adds rows -- a stack that already holds the row keeps it, as a dead control on the Settings
-- page. This is the DELETE for those stacks. It is audited like any other write to the table,
-- under the `migration` actor, so the thread records its own control being retired.

SET search_path TO public;

DELETE FROM public.system_settings
 WHERE key = 'ui.digital_thread_lane_limit';

-- Self-check: properties, not a count. The retired key is absent, and the thread's remaining
-- setting is still there, which is what tells a DELETE that matched by key from one that matched
-- more widely than it was written for.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'ui.digital_thread_lane_limit') THEN
        RAISE EXCEPTION
            '0128 self-check: ui.digital_thread_lane_limit is still declared, and nothing reads it.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'ui.digital_thread_poll_seconds') THEN
        RAISE EXCEPTION
            '0128 self-check: ui.digital_thread_poll_seconds is gone too -- the DELETE reached a row '
            'it was not written for.';
    END IF;

    RAISE NOTICE '0128: ui.digital_thread_lane_limit retired; the thread draws every lane.';
END $$;
