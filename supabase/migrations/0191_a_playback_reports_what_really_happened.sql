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
--   * playback_worker_status.credential_sources, written by the new
--     playback_report_credential_sources(), says which password source the worker uses for each
--     gateway: the delivered one, or the Helm value it falls back to when the broker refuses the
--     delivered one.
--
-- The redeclared functions keep 0001's signatures, return types and grants.

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
-- Which password the worker uses for each gateway
-- -------------------------------------------------------------------------------------------------
-- The worker holds up to three passwords per gateway: the one delivered when its credential was
-- issued, the Helm value secrets.mqttPlaybackCredentials, and the MQTT_PLAYBACK_USER/PASSWORD
-- pair. It tries them in that order, the one the broker last accepted first, and reports the order
-- here by source name, so the playback dialog can say which password it holds. Never a password.
ALTER TABLE public.playback_worker_status
    ADD COLUMN IF NOT EXISTS credential_sources jsonb DEFAULT '{}'::jsonb NOT NULL;

COMMENT ON COLUMN public.playback_worker_status.credential_sources IS 'For each gateway the worker holds a password for, the sources it holds one from, in the order it tries them: "delivered", "helm" or "environment". The first is the one in use. Written by playback_report_credential_sources() (0191).';

CREATE OR REPLACE FUNCTION public.playback_report_credential_sources(p_sources jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_held    text[];
    v_sources jsonb;
BEGIN
    PERFORM public.require_playback_caller('playback_report_credential_sources');

    SELECT held_edge_nodes INTO v_held FROM public.playback_worker_status WHERE id;

    -- Only gateways the worker reports holding, and only the three source names, each once.
    v_sources := COALESCE(
      (SELECT jsonb_object_agg(e.key, (
                SELECT coalesce(jsonb_agg(s.name ORDER BY s.first), '[]'::jsonb)
                  FROM (SELECT v.value #>> '{}' AS name, min(v.ordinality) AS first
                          FROM jsonb_array_elements(e.value) WITH ORDINALITY AS v(value, ordinality)
                         WHERE jsonb_typeof(v.value) = 'string'
                           AND v.value #>> '{}' IN ('delivered', 'helm', 'environment')
                         GROUP BY 1) s))
         FROM jsonb_each(CASE WHEN jsonb_typeof(p_sources) = 'object' THEN p_sources
                              ELSE '{}'::jsonb END) AS e
        WHERE e.key = ANY(coalesce(v_held, '{}'))
          AND jsonb_typeof(e.value) = 'array'),
      '{}'::jsonb
    );

    UPDATE public.playback_worker_status
       SET credential_sources = v_sources
     WHERE id AND credential_sources IS DISTINCT FROM v_sources;
END;
$$;

ALTER FUNCTION public.playback_report_credential_sources(p_sources jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.playback_report_credential_sources(p_sources jsonb) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.playback_report_credential_sources(p_sources jsonb) TO service_role;
GRANT ALL ON FUNCTION public.playback_report_credential_sources(p_sources jsonb) TO authenticated;

COMMENT ON FUNCTION public.playback_report_credential_sources(p_sources jsonb) IS 'The playback worker reporting, for each gateway it holds, the password sources in the order it tries them ("delivered", "helm", "environment"); the first is the one in use. Keeps only gateways in held_edge_nodes and those three names. Called on the worker''s heartbeat after playback_report_credentials(); only the playback worker may call it (0191).';

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
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'playback_worker_status'
                      AND column_name = 'credential_sources') THEN
        RAISE EXCEPTION '0191 self-check: playback_worker_status.credential_sources is missing';
    END IF;
    IF has_function_privilege('anon', 'public.playback_report_credential_sources(jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION '0191 self-check: anon may call playback_report_credential_sources()';
    END IF;
END $$;
