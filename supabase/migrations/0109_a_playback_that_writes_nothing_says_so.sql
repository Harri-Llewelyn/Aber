-- 0109: a playback records how many of its messages the daemon will discard as too old.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- The ingestion daemon's answer to a metric stamped outside its sanity window is a COUNTER, not an
-- error. Nothing travels back to the publisher. So a playback whose rebased timestamps fall outside
-- that window published its whole capture, was recorded COMPLETED with the full `messages_sent`,
-- and wrote NOTHING to the historian -- indistinguishable, on the Capture page, from one that
-- worked. The worker logged a warning, and an operator on that page has no reason to read it.
--
-- `capture.py play` already refuses this case outright unless `--allow-unsane` is passed. The two
-- ends disagreed, and the CLI was right about the danger and too blunt about the remedy: a capture
-- with ONE stale device clock would become unplayable, and the page has no equivalent of the
-- escape hatch.
--
-- WHY THE CAPTURE IS IN THIS STATE IS NEVER EXOTIC. Rebasing preserves how far each timestamp sits
-- from the capture's own epoch, so: a genuinely old reading, which the daemon would have rejected
-- live too; a device clock skewed against the recorder's, which only becomes visible once the
-- capture is rebased onto a different absolute time; or a hand edit, which the file format exists
-- to invite. `--speed` is NOT among them -- the scheduler and the rebasing divide by the same
-- factor, so every message is in-window at the instant it is sent whatever speed is chosen.
--
-- THE SPLIT THIS TAKES. A playback that can write NOTHING is refused by the worker and recorded
-- FAILED, because a total no-op is never what anyone wanted and the Capture page already surfaces
-- a failure with its reason. A playback that will write SOME of its messages runs, and the count it
-- will lose is recorded here so the page can say so rather than reporting an unqualified success.
-- The operator decides what a partial replay is worth; nothing else can.
--
-- WHAT THIS COLUMN IS NOT. It is not a count of what the daemon actually dropped -- nothing reports
-- that back, which is the whole problem. It is what the worker COMPUTED would be dropped, from the
-- same plan it published, before it published it. A message is counted once however many of its
-- metrics are out of window, because the plan is message-granular and `messages_total` already
-- counts the same things.
-- =================================================================================================

ALTER TABLE public.playback_jobs
    ADD COLUMN IF NOT EXISTS messages_out_of_window integer DEFAULT 0 NOT NULL;

COMMENT ON COLUMN public.playback_jobs.messages_out_of_window IS
    'How many of this job''s planned messages carried timestamps the ingestion daemon will discard as outside its sanity window -- computed by the worker from the plan before publishing, never reported back by the daemon, whose answer to an out-of-window metric is a counter and not an error. COUNTED PER MESSAGE WHILE THE REFUSAL IS DECIDED PER METRIC: process_ddata() judges each metric on its own timestamp and falls back to the payload''s only when it has none, so a job carrying a count on every one of its messages may still have written a reading from each. The worker refuses, as FAILED, only a playback the window would discard entirely. Zero on every job written before 0109.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.playback_jobs'::regclass
           AND conname = 'playback_jobs_out_of_window_is_sane'
    ) THEN
        ALTER TABLE public.playback_jobs
            ADD CONSTRAINT playback_jobs_out_of_window_is_sane
            CHECK (messages_out_of_window >= 0);
    END IF;
END $$;

-- -------------------------------------------------------------------------------------------------
-- playback_finish(), taking the count.
--
-- DROP AND RECREATE RATHER THAN AN OVERLOAD, for the reason 0075 gives: a defaulted fourth argument
-- beside the three-argument form makes a three-argument call ambiguous, and PostgreSQL raises
-- "function is not unique" rather than choosing. The worker calls this with named arguments.
--
-- THE DROP IS FOR A DATABASE UPGRADED FROM BEFORE THIS FILE, and nothing else. 0001 and 0107 both
-- declare the four-argument signature, so on a boot of this chain no three-argument form is ever
-- created; on a database whose last boot predated that, one exists and this removes it. Keeping it
-- is not belt and braces for the replay: a DROP here could not close that window anyway, because
-- 0001 runs first on every boot. 0107 asserts the single declaration at the point it would reopen.
--
-- THE THREE OUTCOMES ARE 0107'S, UNCHANGED, AND THE ORDER STILL MATTERS: an error is FAILED,
-- otherwise a raised stop flag is CANCELLED, otherwise COMPLETED. The new argument is recorded, not
-- judged -- the worker decides what a total discard means, because only the worker holds the plan.
-- Putting that judgement here would mean this function could turn a job the worker had already
-- reported as sent into a failure, which is a second opinion about an event that is over.
-- -------------------------------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.playback_finish(uuid, integer, text);

CREATE OR REPLACE FUNCTION public.playback_finish(
    p_job_id                 uuid,
    p_messages_sent          integer,
    p_error                  text    DEFAULT NULL::text,
    -- Defaulted so a worker image older than this migration keeps finishing jobs rather than
    -- failing every RPC on an unknown argument. Such a worker records 0, which is what the column
    -- means on every row written before 0109: not "none were discarded", but "nobody counted".
    p_messages_out_of_window integer DEFAULT 0
) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    PERFORM public.require_playback_caller('playback_finish');

    UPDATE public.playback_jobs
       SET status = CASE
                      WHEN p_error IS NOT NULL THEN 'FAILED'
                      WHEN stop_requested THEN 'CANCELLED'
                      ELSE 'COMPLETED'
                    END,
           finished_at = now(),
           messages_sent = greatest(coalesce(p_messages_sent, messages_sent), 0),
           messages_out_of_window = greatest(coalesce(p_messages_out_of_window, 0), 0),
           error = left(nullif(btrim(coalesce(p_error, '')), ''), 2000)
     WHERE id = p_job_id AND status IN ('PENDING', 'RUNNING');
END;
$$;

COMMENT ON FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text, p_messages_out_of_window integer) IS
    'The playback worker recording the end of a job. Three outcomes, in this order: an error is FAILED; a job whose stop_requested flag was raised while it ran is CANCELLED; anything else is COMPLETED. The error outranks the flag because it is the half an operator can act on. Only a PENDING or RUNNING row is touched, so a job already cancelled before it was claimed keeps the status request_playback_stop() gave it. p_messages_out_of_window is recorded and not judged: the worker holds the plan and decides there, and a job whose every message would be discarded is reported here as an error.';

REVOKE ALL ON FUNCTION public.playback_finish(uuid, integer, text, integer) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.playback_finish(uuid, integer, text, integer) TO service_role;
GRANT ALL ON FUNCTION public.playback_finish(uuid, integer, text, integer) TO authenticated;

-- -------------------------------------------------------------------------------------------------
-- Self-check
--
-- Shape and reachability only, never a count of rows: this replays on every boot against a database
-- that may hold any number of finished playbacks, and an absolute count asserted here is a check
-- that passes on the first boot and fails on the second.
-- -------------------------------------------------------------------------------------------------
DO $$
DECLARE
    v_src      text;
    v_problems text[] := ARRAY[]::text[];
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'playback_jobs'
           AND column_name = 'messages_out_of_window'
    ) THEN
        RAISE EXCEPTION '0109: playback_jobs.messages_out_of_window is missing.';
    END IF;

    -- Exactly one playback_finish. Two would mean the DROP above stopped matching the old
    -- signature, and every call would then fail as ambiguous -- at which point no playback can be
    -- recorded as finished and each one blocks its gateway until the worker restarts.
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'playback_finish') <> 1 THEN
        v_problems := v_problems
            || 'playback_finish() is overloaded, so every call to it is ambiguous';
    END IF;

    SELECT prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'playback_finish'
     LIMIT 1;

    IF v_src IS NULL THEN
        RAISE EXCEPTION '0109: playback_finish() is missing.';
    END IF;

    -- 0107's arm, which this file rewrites the function around and must not drop on the way past.
    IF position('stop_requested' IN v_src) = 0 THEN
        v_problems := v_problems
            || 'playback_finish() no longer reads stop_requested, so an interrupted playback is '
               'recorded as one that ran to the end';
    END IF;

    IF position('messages_out_of_window' IN v_src) = 0 THEN
        v_problems := v_problems
            || 'playback_finish() does not write messages_out_of_window, so a playback the daemon '
               'will discard reports an unqualified success';
    END IF;

    IF array_length(v_problems, 1) > 0 THEN
        RAISE EXCEPTION '0109: %', array_to_string(v_problems, '; ');
    END IF;
END $$;
