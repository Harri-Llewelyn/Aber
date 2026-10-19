-- 0191: A playback reports what really happened, and Stop ends one that has stalled.
--
-- The playback worker reported progress only after a publish, so a job waiting out a long gap in
-- its capture, or a worker stuck before its first publish, left the row RUNNING with nothing to say
-- so. request_playback_stop() only set a flag the worker would read on its next tick, and the
-- one-per-target index then refused every playback onto the Playback gateway until the worker
-- restarted.
--
--   * playback_jobs.progress_reported_at is stamped by every playback_progress() call. The worker
--     now reports at least once a second while a job runs, including while it waits.
--   * request_playback_stop() on a RUNNING job whose last report (or, before the first, its claim)
--     is more than a minute old ends the job here: CANCELLED, with what it had reported published.
--     A worker that comes back is told to stop by its next playback_progress() call, which answers
--     true for a row that is no longer RUNNING, and its playback_finish() leaves the row alone.
--
-- Signatures, return types and grants are 0001's.

-- -------------------------------------------------------------------------------------------------
-- When the worker last reported
-- -------------------------------------------------------------------------------------------------
ALTER TABLE public.playback_jobs
    ADD COLUMN IF NOT EXISTS progress_reported_at timestamp with time zone;

COMMENT ON COLUMN public.playback_jobs.progress_reported_at IS 'When the playback worker last called playback_progress() for this job; null until its first report. request_playback_stop() ends a RUNNING job whose last report, or claim when there is none, is more than a minute old (0191).';

CREATE OR REPLACE FUNCTION public.playback_progress(p_job_id uuid, p_messages_sent integer, p_messages_total integer, p_elapsed_seconds integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_stop boolean;
BEGIN
    PERFORM public.require_playback_caller('playback_progress');

    UPDATE public.playback_jobs
       SET messages_sent        = greatest(coalesce(p_messages_sent, 0), 0),
           messages_total       = greatest(coalesce(p_messages_total, messages_total), 0),
           elapsed_seconds      = greatest(coalesce(p_elapsed_seconds, 0), 0),
           progress_reported_at = now()
     WHERE id = p_job_id AND status = 'RUNNING'
    RETURNING stop_requested INTO v_stop;

    -- Cancelled, swept by a restart, or ended by a Stop while stalled: there is nothing left for
    -- the worker to complete into, so it is told to stop.
    IF NOT FOUND THEN
        RETURN true;
    END IF;
    RETURN coalesce(v_stop, false);
END;
$$;

COMMENT ON FUNCTION public.playback_progress(p_job_id uuid, p_messages_sent integer, p_messages_total integer, p_elapsed_seconds integer) IS 'The playback worker reporting a RUNNING job''s progress, at least once a second while it runs and waits, and stamping progress_reported_at. Answers whether to stop: true when stop_requested is set, and true when the row is no longer RUNNING (0191).';

-- -------------------------------------------------------------------------------------------------
-- Stop ends a job whose worker has stopped reporting
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_playback_stop(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job    public.playback_jobs;
    v_silent integer;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION 'request_playback_stop: requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_job FROM public.playback_jobs WHERE id = p_job_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'request_playback_stop: no playback job %', p_job_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_job.status NOT IN ('PENDING', 'RUNNING') THEN
        RETURN false;
    END IF;

    -- Never claimed: cancelled outright, or a worker that is down leaves it PENDING for ever.
    IF v_job.status = 'PENDING' THEN
        UPDATE public.playback_jobs
           SET status = 'CANCELLED', stop_requested = true, finished_at = now(),
               error = 'cancelled before the worker claimed it'
         WHERE id = p_job_id;
        RETURN true;
    END IF;

    v_silent := floor(extract(epoch FROM now() - coalesce(v_job.progress_reported_at,
                                                           v_job.started_at, v_job.created_at)));

    -- A worker reports at least once a second while a job runs, so a minute of silence means it is
    -- not reading the flag. Ended here, so the target is free again.
    IF v_silent > 60 THEN
        UPDATE public.playback_jobs
           SET status = 'CANCELLED', stop_requested = true, finished_at = now(),
               error = format('stopped here because the playback worker had not reported for %s '
                              'seconds; it had reported %s message(s) published%s',
                              v_silent, v_job.messages_sent,
                              CASE WHEN v_job.messages_total > 0
                                   THEN format(' of %s', v_job.messages_total) ELSE '' END)
         WHERE id = p_job_id;
        RETURN true;
    END IF;

    UPDATE public.playback_jobs SET stop_requested = true WHERE id = p_job_id;
    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.request_playback_stop(p_job_id uuid) IS 'Stop a playback. A PENDING job is cancelled outright. A RUNNING job gets stop_requested, which the worker reads within a second; one whose worker has not reported for more than a minute is ended here as CANCELLED, saying how much it had reported published, so a stalled worker cannot hold the target (0191). Returns false for a job already finished.';

-- -------------------------------------------------------------------------------------------------
-- Self-check: this file's own declarations
-- -------------------------------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'playback_jobs'
                      AND column_name = 'progress_reported_at') THEN
        RAISE EXCEPTION '0191 self-check: playback_jobs.progress_reported_at is missing';
    END IF;
    IF position('progress_reported_at = now()' IN
                (SELECT prosrc FROM pg_proc WHERE oid = 'public.playback_progress(uuid, integer, integer, integer)'::regprocedure)) = 0 THEN
        RAISE EXCEPTION '0191 self-check: playback_progress() does not stamp progress_reported_at';
    END IF;
    IF position('v_silent > 60' IN
                (SELECT prosrc FROM pg_proc WHERE oid = 'public.request_playback_stop(uuid)'::regprocedure)) = 0 THEN
        RAISE EXCEPTION '0191 self-check: request_playback_stop() does not end a stalled job';
    END IF;
END $$;
