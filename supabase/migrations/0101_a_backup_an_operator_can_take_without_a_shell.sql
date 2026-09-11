-- 0101: a backup an operator can take without a shell.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- The tier 1 backup exists (scripts/backup-databases.sh, the chart's CronJob) and nothing in the
-- stack could run it: it needs pg_dump against both databases, the storage volume and the forge's
-- volume, none of which an edge function or a browser has. This file is the Capture page's shape
-- applied to backups: `backup_jobs` is the act, `backups` is the artefact, an Administrator-only
-- RPC queues a job, and the backup service (scripts/backup-service.mjs) claims it, takes the
-- backup and reports back through the gates below. The service never reads a row through
-- PostgREST and nothing outside it can call the gates: they are executable by a direct superuser
-- session only, which is the session pg_dump already needs.
--
-- ONE ROW SHAPE FOR BOTH ORIGINS. A scheduled backup and a requested one differ in `origin` and in
-- retention: a requested backup is PINNED until an Administrator releases it, because a backup
-- somebody asked for before a risky change is the one a timer must not delete first; a scheduled
-- backup falls to the retention window. The schedule is the service's: it registers
-- `enqueue_scheduled_backup()` with pg_cron when it starts, so a stack with no service queues
-- nothing that nobody will take.
--
-- THE ARTEFACT STAYS SERVER-SIDE. A dump holds auth.users, every OAuth secret's hash, the whole
-- digital_thread and the historian's password; the rows here describe it (where, how big, which
-- components, their digests) and nothing hands the bytes to a browser. Restore is a runbook
-- (supabase/README.md, Backup and Recovery), not a button.
--
-- Every act is a digital_thread row: BACKUP_REQUESTED, BACKUP_CANCELLED and BACKUP_RELEASED as
-- the user who did it; BACKUP_TAKEN, BACKUP_FAILED and BACKUP_PRUNED as 'service', the actor kind
-- for automation, with no user. audit_domain_for() files unclassified entity types under
-- 'security', which is where an act on the whole database belongs.
-- =================================================================================================

SET search_path TO public;

-- -------------------------------------------------------------------------------------------------
-- 1. The act
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_jobs (
    id           uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    origin       text NOT NULL,
    status       text DEFAULT 'PENDING'::text NOT NULL,
    note         text,
    requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    backup_id    uuid,
    error        text,
    created_at   timestamp with time zone DEFAULT now() NOT NULL,
    started_at   timestamp with time zone,
    finished_at  timestamp with time zone,
    CONSTRAINT backup_jobs_origin_valid CHECK ((origin = ANY (ARRAY['requested'::text, 'scheduled'::text]))),
    CONSTRAINT backup_jobs_status_valid CHECK ((status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text, 'CANCELLED'::text])))
);

-- One backup at a time across the stack: two pg_dumps of the historian at once double the IO on
-- a database taking live writes.
CREATE UNIQUE INDEX IF NOT EXISTS backup_jobs_single_flight
    ON public.backup_jobs ((true))
    WHERE status IN ('PENDING', 'RUNNING');

CREATE INDEX IF NOT EXISTS backup_jobs_finished_at_idx ON public.backup_jobs (finished_at DESC);

COMMENT ON TABLE public.backup_jobs IS 'One row per backup ATTEMPTED, including the ones that failed. At most one row is PENDING or RUNNING at a time (backup_jobs_single_flight). Written only through request_backup(), enqueue_scheduled_backup() and the backup service''s gates -- there is no direct-write RLS policy. Readable by Administrator only.';
COMMENT ON COLUMN public.backup_jobs.origin IS 'requested: an Administrator asked, and requested_by names them. scheduled: the service''s timer asked, and requested_by is NULL.';
COMMENT ON COLUMN public.backup_jobs.backup_id IS 'The backups row this job produced, set by backup_finalise(). Not a foreign key: a pruned backup keeps its job row, which is the history of the act.';
COMMENT ON COLUMN public.backup_jobs.error IS 'What the service said when it failed, capped at 2000 characters. The page shows this string.';

ALTER TABLE public.backup_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backup_jobs_select_administrator ON public.backup_jobs;
CREATE POLICY backup_jobs_select_administrator ON public.backup_jobs FOR SELECT TO authenticated
    USING (public.has_role(ARRAY['Administrator'::text]));

GRANT SELECT ON TABLE public.backup_jobs TO authenticated;
GRANT ALL ON TABLE public.backup_jobs TO service_role;

-- -------------------------------------------------------------------------------------------------
-- 2. The artefact
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backups (
    id           uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    stamp        text NOT NULL,
    origin       text NOT NULL,
    note         text,
    requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    job_id       uuid REFERENCES public.backup_jobs(id) ON DELETE SET NULL,
    location     text NOT NULL,
    components   jsonb DEFAULT '[]'::jsonb NOT NULL,
    size_bytes   bigint DEFAULT 0 NOT NULL,
    pinned       boolean DEFAULT false NOT NULL,
    released_at  timestamp with time zone,
    released_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    taken_at     timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT backups_stamp_key UNIQUE (stamp),
    CONSTRAINT backups_origin_valid CHECK ((origin = ANY (ARRAY['requested'::text, 'scheduled'::text]))),
    CONSTRAINT backups_stamp_is_a_directory_name CHECK ((stamp ~ '^[0-9]{8}T[0-9]{6}Z$'::text)),
    CONSTRAINT backups_components_is_an_array CHECK ((jsonb_typeof(components) = 'array'::text)),
    CONSTRAINT backups_size_is_not_negative CHECK ((size_bytes >= 0))
);

CREATE INDEX IF NOT EXISTS backups_taken_at_idx ON public.backups (taken_at DESC);

COMMENT ON TABLE public.backups IS 'One row per backup that EXISTS on the backup volume; the row is deleted when the service prunes the files, and BACKUP_PRUNED in digital_thread is the record that it did. Written only by backup_finalise() and released only by release_backup(). Readable by Administrator only. The bytes never leave the volume: nothing serves them to a browser.';
COMMENT ON COLUMN public.backups.stamp IS 'The UTC stamp the files carry, YYYYMMDDTHHMMSSZ, and the name of the directory under the backup volume holding them. What BACKUP_STAMP takes in restore-databases.sh.';
COMMENT ON COLUMN public.backups.location IS 'The directory holding this backup''s files, as a path inside the backup service''s container. Informational: a restore is run from a shell against the volume, not from this row.';
COMMENT ON COLUMN public.backups.components IS 'What the backup holds: an array of {name, file, size_bytes, sha256}. Names are supabase-db, timescaledb, storage-objects and forge; a component the service was not given a volume for is absent, not empty.';
COMMENT ON COLUMN public.backups.pinned IS 'True keeps the backup out of the retention prune. Set at creation for a requested backup, cleared by release_backup(). A scheduled backup is never pinned.';

ALTER TABLE public.backups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backups_select_administrator ON public.backups;
CREATE POLICY backups_select_administrator ON public.backups FOR SELECT TO authenticated
    USING (public.has_role(ARRAY['Administrator'::text]));

GRANT SELECT ON TABLE public.backups TO authenticated;
GRANT ALL ON TABLE public.backups TO service_role;

-- -------------------------------------------------------------------------------------------------
-- 3. The gate for the service's own functions
-- -------------------------------------------------------------------------------------------------
-- A direct session as a superuser, and nothing arriving through PostgREST: the service connects
-- as supabase_admin because pg_dump has to (the event triggers are its), so the same session is
-- the one that reports. `role` is 'none' in a plain session and the effective role under
-- PostgREST, which SET ROLEs on every request.
CREATE OR REPLACE FUNCTION public.require_backup_service_caller(p_fn text) RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
BEGIN
    IF coalesce(nullif(current_setting('role', true), 'none'), '') <> ''
       OR session_user NOT IN ('supabase_admin', 'postgres') THEN
        RAISE EXCEPTION '%: only the backup service may call this', p_fn
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.require_backup_service_caller(text) FROM PUBLIC, anon, authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 4. Asking
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_backup(p_note text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_running record;
    v_job_id  uuid;
BEGIN
    IF NOT public.has_role(ARRAY['Administrator'::text]) THEN
        RAISE EXCEPTION 'request_backup: only an Administrator may take a backup'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Reported rather than left to the index, so the refusal says what is in the way. A PENDING
    -- row nobody has claimed is the sign the service is not running, and the message says so.
    SELECT j.id, j.status, j.origin, j.created_at INTO v_running
      FROM public.backup_jobs j
     WHERE j.status IN ('PENDING', 'RUNNING')
     LIMIT 1;
    IF FOUND THEN
        IF v_running.status = 'PENDING' THEN
            RAISE EXCEPTION
              'request_backup: a % backup queued at % has not been claimed. One backup runs at a '
              'time; if the backup service is not running, nothing will take it -- cancel it or '
              'start the service.',
              v_running.origin, to_char(v_running.created_at, 'DD Mon YYYY HH24:MI')
                USING ERRCODE = 'unique_violation';
        END IF;
        RAISE EXCEPTION
          'request_backup: a % backup is running. One backup runs at a time; wait for it to finish.',
          v_running.origin
            USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO public.backup_jobs (origin, status, note, requested_by)
    VALUES ('requested', 'PENDING', nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
    RETURNING id INTO v_job_id;

    INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'backup_jobs', v_job_id, 'BACKUP_REQUESTED', NULL,
        jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), ''), 'origin', 'requested'),
        auth.uid(), 'user', txid_current(), now()
    );

    RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION public.request_backup(p_note text) IS 'Queue a backup of the whole stack: both databases, the storage objects and the forge, taken by the backup service and pinned until release_backup(). Administrator only. Refuses while another backup is queued or running, naming it.';

REVOKE ALL ON FUNCTION public.request_backup(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_backup(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cancel_backup_job(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job public.backup_jobs;
BEGIN
    IF NOT public.has_role(ARRAY['Administrator'::text]) THEN
        RAISE EXCEPTION 'cancel_backup_job: only an Administrator may cancel a backup'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- PENDING only. A RUNNING job is the service's: pg_dump is under way, and a row flipped under
    -- it would leave the job finishing into a state that says it did not.
    UPDATE public.backup_jobs
       SET status = 'CANCELLED', finished_at = now()
     WHERE id = p_job_id AND status = 'PENDING'
    RETURNING * INTO v_job;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'backup_jobs', v_job.id, 'BACKUP_CANCELLED',
        jsonb_build_object('status', 'PENDING', 'origin', v_job.origin, 'note', v_job.note),
        jsonb_build_object('status', 'CANCELLED'),
        auth.uid(), 'user', txid_current(), now()
    );

    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.cancel_backup_job(p_job_id uuid) IS 'Withdraw a queued backup before the service claims it. Administrator only. Returns false when the job was already claimed or finished, which is not an error.';

REVOKE ALL ON FUNCTION public.cancel_backup_job(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_backup_job(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.release_backup(p_backup_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_backup public.backups;
BEGIN
    IF NOT public.has_role(ARRAY['Administrator'::text]) THEN
        RAISE EXCEPTION 'release_backup: only an Administrator may release a backup'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    UPDATE public.backups
       SET pinned = false, released_at = now(), released_by = auth.uid()
     WHERE id = p_backup_id AND pinned
    RETURNING * INTO v_backup;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'backups', v_backup.id, 'BACKUP_RELEASED',
        jsonb_build_object('pinned', true),
        jsonb_build_object('pinned', false, 'stamp', v_backup.stamp, 'taken_at', v_backup.taken_at),
        auth.uid(), 'user', txid_current(), now()
    );

    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.release_backup(p_backup_id uuid) IS 'Let the retention window apply to a requested backup. Administrator only. Nothing is deleted here: the service prunes on its next pass, and only if the backup is older than the window. Returns false when the backup was not pinned.';

REVOKE ALL ON FUNCTION public.release_backup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_backup(uuid) TO authenticated, service_role;

-- The timer's insert. Registered with pg_cron by the service (backup_schedule()), so it exists
-- only where something will take what it queues. Skips rather than fails while a backup is in
-- flight: a nightly run that meets a stuck job leaves a PENDING row visible on the page.
CREATE OR REPLACE FUNCTION public.enqueue_scheduled_backup() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.backup_jobs WHERE status IN ('PENDING', 'RUNNING')) THEN
        RETURN false;
    END IF;

    INSERT INTO public.backup_jobs (origin, status) VALUES ('scheduled', 'PENDING');
    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.enqueue_scheduled_backup() IS 'Queue a scheduled backup, unless one is already queued or running. Called by pg_cron on the schedule the backup service registers; not a user''s function.';

REVOKE ALL ON FUNCTION public.enqueue_scheduled_backup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_scheduled_backup() TO service_role;

-- -------------------------------------------------------------------------------------------------
-- 5. The service's gates
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_schedule(p_cron text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public', 'cron'
    AS $$
BEGIN
    PERFORM public.require_backup_service_caller('backup_schedule');

    IF coalesce(btrim(p_cron), '') = '' THEN
        IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'enqueue_scheduled_backup') THEN
            PERFORM cron.unschedule('enqueue_scheduled_backup');
        END IF;
        RETURN false;
    END IF;

    PERFORM public.ensure_cron_job(
        'enqueue_scheduled_backup',
        p_cron,
        $job$SELECT public.enqueue_scheduled_backup()$job$
    );
    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.backup_schedule(p_cron text) IS 'Register (or, given an empty schedule, remove) the pg_cron job that queues scheduled backups. Called by the backup service at start with BACKUP_SCHEDULE, so the schedule exists exactly where a service will take what it queues.';

CREATE OR REPLACE FUNCTION public.backup_reconcile_jobs(p_reason text) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job  record;
    v_rows integer := 0;
BEGIN
    PERFORM public.require_backup_service_caller('backup_reconcile_jobs');

    -- A RUNNING row at service start is a backup the previous process did not finish; its files
    -- are partial and the service removes them. PENDING rows are left: the loop claims them.
    FOR v_job IN
        UPDATE public.backup_jobs
           SET status = 'FAILED', finished_at = now(),
               error  = left(coalesce(nullif(btrim(p_reason), ''), 'the backup service restarted'), 2000)
         WHERE status = 'RUNNING'
        RETURNING id, origin, started_at
    LOOP
        INSERT INTO public.digital_thread (
            entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
            causation_id, recorded_at
        ) VALUES (
            'backup_jobs', v_job.id, 'BACKUP_FAILED',
            jsonb_build_object('status', 'RUNNING', 'origin', v_job.origin, 'started_at', v_job.started_at),
            jsonb_build_object('status', 'FAILED', 'error', p_reason),
            NULL, 'service', txid_current(), now()
        );
        v_rows := v_rows + 1;
    END LOOP;

    RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION public.backup_reconcile_jobs(p_reason text) IS 'Fail every RUNNING job with the given reason. Called once by the backup service at start: a job left RUNNING was interrupted, and its files are partial.';

CREATE OR REPLACE FUNCTION public.backup_claim_job() RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job public.backup_jobs;
BEGIN
    PERFORM public.require_backup_service_caller('backup_claim_job');

    SELECT * INTO v_job
      FROM public.backup_jobs
     WHERE status = 'PENDING'
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    UPDATE public.backup_jobs
       SET status = 'RUNNING', started_at = now()
     WHERE id = v_job.id;

    RETURN to_jsonb(v_job) || jsonb_build_object('status', 'RUNNING', 'started_at', now());
END;
$$;

COMMENT ON FUNCTION public.backup_claim_job() IS 'Take the oldest PENDING job, mark it RUNNING and return it, or NULL. The backup service''s poll.';

CREATE OR REPLACE FUNCTION public.backup_finalise(p_job_id uuid, p_stamp text, p_location text, p_components jsonb, p_size_bytes bigint) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job       public.backup_jobs;
    v_backup_id uuid;
BEGIN
    PERFORM public.require_backup_service_caller('backup_finalise');

    SELECT * INTO v_job FROM public.backup_jobs WHERE id = p_job_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'backup_finalise: no backup job %', p_job_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_job.status <> 'RUNNING' THEN
        RAISE EXCEPTION 'backup_finalise: job % is %, not RUNNING', p_job_id, v_job.status
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    INSERT INTO public.backups (
        stamp, origin, note, requested_by, job_id, location, components, size_bytes, pinned, taken_at
    ) VALUES (
        p_stamp, v_job.origin, v_job.note, v_job.requested_by, v_job.id, p_location,
        coalesce(p_components, '[]'::jsonb), greatest(coalesce(p_size_bytes, 0), 0),
        v_job.origin = 'requested', coalesce(v_job.started_at, now())
    )
    RETURNING id INTO v_backup_id;

    UPDATE public.backup_jobs
       SET status = 'COMPLETED', finished_at = now(), backup_id = v_backup_id
     WHERE id = p_job_id;

    INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'backups', v_backup_id, 'BACKUP_TAKEN', NULL,
        jsonb_build_object(
            'stamp',      p_stamp,
            'origin',     v_job.origin,
            'note',       v_job.note,
            'job_id',     v_job.id,
            'size_bytes', greatest(coalesce(p_size_bytes, 0), 0),
            'components', coalesce(p_components, '[]'::jsonb),
            'pinned',     v_job.origin = 'requested'
        ),
        NULL, 'service', txid_current(), now()
    );

    RETURN v_backup_id;
END;
$$;

COMMENT ON FUNCTION public.backup_finalise(p_job_id uuid, p_stamp text, p_location text, p_components jsonb, p_size_bytes bigint) IS 'Record a finished backup: the backups row, the job COMPLETED, and BACKUP_TAKEN in the thread, in one transaction. A requested backup is born pinned.';

CREATE OR REPLACE FUNCTION public.backup_fail(p_job_id uuid, p_error text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job public.backup_jobs;
BEGIN
    PERFORM public.require_backup_service_caller('backup_fail');

    UPDATE public.backup_jobs
       SET status = 'FAILED', finished_at = now(),
           error = left(coalesce(nullif(btrim(p_error), ''), 'unspecified failure'), 2000)
     WHERE id = p_job_id AND status IN ('PENDING', 'RUNNING')
    RETURNING * INTO v_job;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'backup_jobs', v_job.id, 'BACKUP_FAILED',
        jsonb_build_object('origin', v_job.origin, 'note', v_job.note, 'started_at', v_job.started_at),
        jsonb_build_object('status', 'FAILED', 'error', v_job.error),
        NULL, 'service', txid_current(), now()
    );
END;
$$;

COMMENT ON FUNCTION public.backup_fail(p_job_id uuid, p_error text) IS 'Mark a job FAILED with what went wrong, and record BACKUP_FAILED. The service has already removed the partial files.';

CREATE OR REPLACE FUNCTION public.backup_prunable(p_retention_days integer) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
BEGIN
    PERFORM public.require_backup_service_caller('backup_prunable');

    -- Zero or less disables pruning, as BACKUP_RETENTION_DAYS=0 does in backup-databases.sh.
    IF coalesce(p_retention_days, 0) <= 0 THEN
        RETURN '[]'::jsonb;
    END IF;

    RETURN coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', b.id, 'stamp', b.stamp, 'location', b.location) ORDER BY b.taken_at)
          FROM public.backups b
         WHERE NOT b.pinned
           AND b.taken_at < now() - make_interval(days => p_retention_days)
    ), '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION public.backup_prunable(p_retention_days integer) IS 'The backups the retention window has expired and nobody has pinned, oldest first. The service deletes each one''s files and then calls backup_forget().';

CREATE OR REPLACE FUNCTION public.backup_forget(p_backup_id uuid, p_reason text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_backup public.backups;
BEGIN
    PERFORM public.require_backup_service_caller('backup_forget');

    DELETE FROM public.backups WHERE id = p_backup_id AND NOT pinned
    RETURNING * INTO v_backup;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'backups', v_backup.id, 'BACKUP_PRUNED',
        jsonb_build_object(
            'stamp', v_backup.stamp, 'origin', v_backup.origin, 'note', v_backup.note,
            'taken_at', v_backup.taken_at, 'size_bytes', v_backup.size_bytes
        ),
        jsonb_build_object('reason', p_reason),
        NULL, 'service', txid_current(), now()
    );

    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.backup_forget(p_backup_id uuid, p_reason text) IS 'Delete the row for a backup whose files are gone, and record BACKUP_PRUNED. Refuses a pinned backup: the files of one should not have been removed.';

REVOKE ALL ON FUNCTION public.backup_schedule(text)                                      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_reconcile_jobs(text)                                FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_claim_job()                                         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_finalise(uuid, text, text, jsonb, bigint)           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_fail(uuid, text)                                    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_prunable(integer)                                   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_forget(uuid, text)                                  FROM PUBLIC, anon, authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 6. Self-check
-- -------------------------------------------------------------------------------------------------
-- Read-only, and about this file's own additions: the tables are behind RLS, the single-flight
-- index exists, a user's RPC is closed to anon, and the service's gates are closed to every
-- PostgREST role.
DO $$
DECLARE
    v_problems text[] := ARRAY[]::text[];
    v_fn       text;
BEGIN
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.backup_jobs'::regclass) THEN
        v_problems := v_problems || 'backup_jobs is not behind RLS';
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.backups'::regclass) THEN
        v_problems := v_problems || 'backups is not behind RLS';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'backup_jobs' AND indexname = 'backup_jobs_single_flight'
    ) THEN
        v_problems := v_problems || 'backup_jobs_single_flight is missing';
    END IF;

    IF has_function_privilege('anon', 'public.request_backup(text)', 'EXECUTE') THEN
        v_problems := v_problems || 'request_backup() is callable by anon';
    END IF;

    FOREACH v_fn IN ARRAY ARRAY[
        'public.backup_schedule(text)',
        'public.backup_reconcile_jobs(text)',
        'public.backup_claim_job()',
        'public.backup_finalise(uuid, text, text, jsonb, bigint)',
        'public.backup_fail(uuid, text)',
        'public.backup_prunable(integer)',
        'public.backup_forget(uuid, text)'
    ] LOOP
        IF has_function_privilege('authenticated', v_fn, 'EXECUTE')
           OR has_function_privilege('service_role', v_fn, 'EXECUTE')
           OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
            v_problems := v_problems || (v_fn || ' is callable through PostgREST');
        END IF;
    END LOOP;

    IF array_length(v_problems, 1) > 0 THEN
        RAISE EXCEPTION '0101 self-check failed: %', array_to_string(v_problems, '; ');
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
