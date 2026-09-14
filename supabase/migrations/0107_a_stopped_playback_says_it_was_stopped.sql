-- 0107: a playback stopped by the operator is recorded as cancelled, not completed.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- `request_playback_stop()` has two arms. A PENDING job no worker has claimed is set CANCELLED
-- there and then. A RUNNING one cannot be, because the worker is mid-publish, so the function
-- raises a flag -- `stop_requested` -- and the worker observes it on its next progress call,
-- stops publishing, and reports what it managed.
--
-- Nothing then read the flag again. `playback_finish()` decided on the error alone, and a stopped
-- playback carries no error, so a job the operator interrupted was recorded COMPLETED: the same
-- status as a capture published in full, with a lower `messages_sent` as the only difference and
-- nothing saying that difference was deliberate. The Capture page's failure banner selects
-- FAILED and CANCELLED, so a stopped job left no trace there either.
--
-- THE ORDER OF THE THREE ARMS IS THE DECISION HERE. An error outranks the stop: a job that was
-- asked to stop AND failed is a failure, because the error is the actionable half and the
-- operator already knows they pressed stop. So: an error is FAILED, otherwise a raised flag is
-- CANCELLED, otherwise COMPLETED.
--
-- The worker needs no change. It already breaks out of its publish loop when `playback_progress()`
-- answers true and reports the count it reached, and CANCELLED is already one of the five statuses
-- `playback_jobs_status_valid` admits.
-- =================================================================================================

CREATE OR REPLACE FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text DEFAULT NULL::text) RETURNS void
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
           error = left(nullif(btrim(coalesce(p_error, '')), ''), 2000)
     WHERE id = p_job_id AND status IN ('PENDING', 'RUNNING');
END;
$$;

COMMENT ON FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text) IS
    'The playback worker recording the end of a job. Three outcomes, in this order: an error is FAILED; a job whose stop_requested flag was raised while it ran is CANCELLED; anything else is COMPLETED. The error outranks the flag because it is the half an operator can act on. Only a PENDING or RUNNING row is touched, so a job already cancelled before it was claimed keeps the status request_playback_stop() gave it.';

REVOKE ALL ON FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text) TO service_role;
GRANT ALL ON FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text) TO authenticated;

-- -------------------------------------------------------------------------------------------------
-- Self-check
--
-- Asserts the shape of the function and the reachability of the arm, never a count of rows: this
-- replays on every boot, against a database that may hold any number of finished playbacks.
-- -------------------------------------------------------------------------------------------------
DO $$
DECLARE
    v_src      text;
    v_problems text[] := ARRAY[]::text[];
BEGIN
    SELECT prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'playback_finish';

    IF v_src IS NULL THEN
        RAISE EXCEPTION '0107: playback_finish() is missing.';
    END IF;

    IF position('stop_requested' IN v_src) = 0 THEN
        v_problems := v_problems
            || 'playback_finish() no longer reads stop_requested, so an interrupted playback is '
               'recorded as one that ran to the end';
    END IF;

    -- CANCELLED has to remain admissible, or the new arm writes a status the CHECK refuses and
    -- every stopped playback fails at the last statement of the job it had already finished.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'playback_jobs_status_valid'
           AND conrelid = 'public.playback_jobs'::regclass
           AND pg_get_constraintdef(oid) LIKE '%CANCELLED%'
    ) THEN
        v_problems := v_problems
            || 'playback_jobs_status_valid does not admit CANCELLED';
    END IF;

    IF array_length(v_problems, 1) > 0 THEN
        RAISE EXCEPTION '0107 self-check failed: %', array_to_string(v_problems, '; ');
    END IF;

    RAISE NOTICE '0107: a playback stopped while running is recorded CANCELLED.';
END $$;

NOTIFY pgrst, 'reload schema';
