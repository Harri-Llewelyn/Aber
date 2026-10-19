-- 0193: Captures and replays leave an audit trail, and a playback's history outlives its target.
--
-- A capture holds the plant's raw traffic and a replay writes readings into the historian, and
-- neither left a row in audit_trail. playback_jobs.target_gateway_id is ON DELETE CASCADE, so
-- deleting the Playback gateway erased the record of every replay published as it.
--
--   * One audit row per act, written by the function that performs it, in the asset lane:
--     CAPTURE_STARTED and CAPTURE_STOPPED (capture_jobs), CAPTURE_UPLOADED, CAPTURE_RECORDED,
--     CAPTURE_DOWNLOAD_ISSUED and CAPTURE_DELETED (captures), PLAYBACK_STARTED and
--     PLAYBACK_STOPPED (playback_jobs). Progress reports write none.
--   * CAPTURE_DELETED is written by a trigger on captures, so every deletion is recorded: the
--     page's, a replacement's, and the cascade of a deleted subject, one row per capture.
--   * issue_capture_download() writes CAPTURE_DOWNLOAD_ISSUED and answers the path the page then
--     signs a link for.
--   * A gateway that playback_jobs name cannot be deleted, and neither can the last unarchived
--     Playback gateway. A trigger refuses both, so the foreign key's CASCADE is never reached:
--     0001's constraint guard puts back CASCADE on every boot, so a changed key would be dropped
--     and added twice per boot. The nightly purge skips a gateway with replay history.
--   * playback_finish() sets the target OFFLINE, with its replay lanes, when it ends a RUNNING
--     job. The broker sends no Will when it cuts a session, and the worker cannot send the NDEATH.
--   * start_playback_job() no longer says a credential is issued to obtain the worker's password:
--     the platform delivers it (0078). ensure_shadow_devices() no longer says to restore the
--     Playback gateway from Archived Entities: it can be neither archived nor deleted.
--
-- Reasoning: supabase/README.md, "Captures and replays leave an audit trail (0193)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Who wrote a row, and the subject it names
-- -------------------------------------------------------------------------------------------------
-- log_audit_trail_event()'s ladder, for the functions that write their own rows: a person is
-- 'user', the ingestion principal 'ingestion', any other machine 'service', and the owner's
-- session with no token 'migration'.
CREATE OR REPLACE FUNCTION public.audit_actor_source() RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_role  text;
BEGIN
    IF v_actor IS NOT NULL AND NOT public.is_machine_principal(v_actor) THEN
        RETURN 'user';
    END IF;
    IF public.is_ingestion_caller() THEN
        RETURN 'ingestion';
    END IF;
    IF v_actor IS NOT NULL THEN
        RETURN 'service';
    END IF;
    v_role := coalesce(nullif(nullif(current_setting('role', true), 'none'), ''), session_user);
    RETURN CASE WHEN v_role IN ('postgres', 'supabase_admin') THEN 'migration' ELSE 'service' END;
END;
$$;

ALTER FUNCTION public.audit_actor_source() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.audit_actor_source() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.audit_actor_source() IS
  'The actor_source a function writing its own audit_trail row records: user for a person, '
  'ingestion for the ingestion principal, service for any other machine identity, migration for '
  'the owner''s session with no token. log_audit_trail_event()''s ladder without the X-Aber-Actor '
  'header (0193). Called by the capture and playback gates only.';

-- The capture subject as an audit row names it: the name it has now (null once it is deleted),
-- and the sparkplug_id it was recorded under, which the Audit Trail labels a lane by.
CREATE OR REPLACE FUNCTION public.capture_subject_identity(p_subject_kind text, p_gateway_id uuid, p_device_id uuid, p_sparkplug_id text) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'name', CASE WHEN p_subject_kind = 'device'
                 THEN (SELECT d.name FROM public.devices d WHERE d.id = p_device_id)
                 ELSE (SELECT g.name FROM public.gateways g WHERE g.id = p_gateway_id) END,
    'sparkplug_id', p_sparkplug_id,
    'subject_kind', p_subject_kind,
    'subject_id', CASE WHEN p_subject_kind = 'device' THEN p_device_id ELSE p_gateway_id END);
$$;

ALTER FUNCTION public.capture_subject_identity(p_subject_kind text, p_gateway_id uuid, p_device_id uuid, p_sparkplug_id text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.capture_subject_identity(text, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.capture_subject_identity(p_subject_kind text, p_gateway_id uuid, p_device_id uuid, p_sparkplug_id text) IS
  'The name, sparkplug_id, kind and id of a capture''s subject, as the capture and playback audit '
  'rows carry them (0193). name is null once the subject is deleted; sparkplug_id is the one the '
  'capture was filed under.';

-- -------------------------------------------------------------------------------------------------
-- 2. The three tables are filed in the asset lane
-- -------------------------------------------------------------------------------------------------
-- The asset lane's readers are Administrator, Shopfloor_Manager and Auditor, the roles that may
-- read captures, capture_jobs and playback_jobs. Otherwise unchanged from 0168.
CREATE OR REPLACE FUNCTION public.audit_domain_for(p_entity_type text, p_action text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
    -- Identity and authority. Every act on these is Administrator-only to perform AND the table
    -- itself is Administrator-only to read, which is what makes the lane agree with its contents.
    WHEN p_entity_type IN ('service_principals', 'user_roles', 'system_settings')
      THEN 'security'

    -- The asset trail: the shopfloor's own history. CREDENTIAL_ISSUED lands here on `gateways`
    -- deliberately: a Manager may mint a host-run gateway's broker credential. `schemas` and
    -- `metric_catalog` are Administrator-only writes to tables every authenticated user reads.
    -- The capture and playback acts are a Manager's, on tables the same three roles read.
    WHEN p_entity_type IN ('areas', 'cells', 'devices', 'gateways', 'links',
                           'schemas', 'device_nameplate', 'device_submodels', 'change_proposals',
                           'cell_links', 'gateway_links', 'device_links',
                           'metric_catalog', 'captures', 'capture_jobs', 'playback_jobs')
      THEN 'asset'

    -- Fail-closed: a new entity_type nobody classified is restricted rather than exposed.
    ELSE 'security'
  END
$$;

ALTER FUNCTION public.audit_domain_for(p_entity_type text, p_action text) OWNER TO postgres;

-- -------------------------------------------------------------------------------------------------
-- 3. Starting a recording
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text DEFAULT NULL::text, p_max_seconds integer DEFAULT 300, p_replace boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_gateway   RECORD;
    v_device    RECORD;
    v_gateway_id          uuid;
    v_device_id           uuid;
    v_device_sparkplug    text;
    v_subject_sparkplug   text;
    v_existing            RECORD;
    v_running             RECORD;
    v_job_id              uuid := gen_random_uuid();
    v_note                text := nullif(btrim(coalesce(p_note, '')), '');
    v_max_seconds         integer := least(greatest(coalesce(p_max_seconds, 300), 5), 7200);
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION
          'start_capture_job: recording the broker requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_subject_kind NOT IN ('gateway', 'device') THEN
        RAISE EXCEPTION 'start_capture_job: p_subject_kind must be ''gateway'' or ''device'', got %',
            coalesce(p_subject_kind, '<null>') USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_subject_kind = 'gateway' THEN
        SELECT g.id, g.sparkplug_id, g.sparkplug_group, g.is_archived, g.is_shadow
          INTO v_gateway
          FROM public.gateways g WHERE g.id = p_subject_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'start_capture_job: no gateway %', p_subject_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF v_gateway.is_archived THEN
            RAISE EXCEPTION
              'start_capture_job: gateway % is archived. An archived gateway publishes nothing, so '
              'the capture would run its full duration and produce an empty file.', p_subject_id
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF v_gateway.is_shadow THEN
            RAISE EXCEPTION
              'start_capture_job: % is the Playback gateway, which publishes only replays. Record the '
              'gateway a replay came from instead.', v_gateway.sparkplug_id
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_gateway_id        := v_gateway.id;
        v_subject_sparkplug := v_gateway.sparkplug_id;

    ELSE
        SELECT d.id, d.sparkplug_id, d.gateway_id, d.is_archived, d.shadow_of
          INTO v_device
          FROM public.devices d WHERE d.id = p_subject_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'start_capture_job: no device %', p_subject_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF v_device.is_archived THEN
            RAISE EXCEPTION 'start_capture_job: device % is archived.', p_subject_id
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF v_device.gateway_id IS NULL THEN
            -- A quarantined device can sit with no gateway: no edge node to record or ask to rebirth.
            RAISE EXCEPTION
              'start_capture_job: device % is not bound to a gateway, so there is no edge node to '
              'record from. Resolve its quarantine first.', p_subject_id
                USING ERRCODE = 'invalid_parameter_value';
        END IF;

        SELECT g.id, g.sparkplug_id, g.sparkplug_group, g.is_shadow
          INTO v_gateway
          FROM public.gateways g WHERE g.id = v_device.gateway_id;
        IF v_device.shadow_of IS NOT NULL OR v_gateway.is_shadow THEN
            RAISE EXCEPTION
              'start_capture_job: % is a replay lane on the Playback gateway, which publishes only '
              'replays. Record the device a replay came from instead.', v_device.sparkplug_id
                USING ERRCODE = 'invalid_parameter_value';
        END IF;

        v_gateway_id        := v_gateway.id;
        v_device_id         := v_device.id;
        v_device_sparkplug  := v_device.sparkplug_id;
        v_subject_sparkplug := v_device.sparkplug_id;
    END IF;

    -- The replace decision is the caller's to state; the refusal names the capture it protects, note
    -- included. Nothing is replaced until ingest_finalise_capture() swaps the rows.
    SELECT c.id, c.note, c.recorded_at INTO v_existing
      FROM public.captures c
     WHERE (p_subject_kind = 'gateway' AND c.subject_kind = 'gateway' AND c.gateway_id = v_gateway_id)
        OR (p_subject_kind = 'device'  AND c.subject_kind = 'device'  AND c.device_id  = v_device_id);

    IF FOUND AND NOT p_replace THEN
        RAISE EXCEPTION
          'start_capture_job: a capture of this subject already exists (recorded %). Recording '
          'again replaces it. Call with p_replace := true to confirm.',
          to_char(v_existing.recorded_at, 'DD Mon YYYY HH24:MI')
              || coalesce(' -- ' || v_existing.note, '')
            USING ERRCODE = 'unique_violation';
    END IF;

    -- Single-flight: the partial unique index enforces it; the lookup names the job in the way.
    SELECT j.id, j.status, j.subject_sparkplug_id INTO v_running
      FROM public.capture_jobs j
     WHERE j.status IN ('PENDING', 'RECORDING')
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION
          'start_capture_job: a capture of % is already %. One capture runs at a time on this '
          'stack; stop that one first.', v_running.subject_sparkplug_id, lower(v_running.status)
            USING ERRCODE = 'unique_violation';
    END IF;

    -- <subject>/<job id>.json: the recording never writes over the capture it may replace.
    INSERT INTO public.capture_jobs (
        id, subject_kind, gateway_id, device_id,
        sparkplug_group, edge_node_id, device_sparkplug_id,
        subject_sparkplug_id, storage_path,
        status, note, max_seconds, requested_by
    ) VALUES (
        v_job_id, p_subject_kind, v_gateway_id, v_device_id,
        v_gateway.sparkplug_group, v_gateway.sparkplug_id, v_device_sparkplug,
        v_subject_sparkplug, v_subject_sparkplug || '/' || v_job_id || '.json',
        'PENDING', v_note, v_max_seconds, auth.uid()
    );

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'capture_jobs', v_job_id, 'CAPTURE_STARTED', NULL,
        public.capture_subject_identity(p_subject_kind, v_gateway_id, v_device_id, v_subject_sparkplug)
          || jsonb_build_object('note', v_note, 'max_seconds', v_max_seconds,
                                'replaces_capture_id', v_existing.id),
        auth.uid(), public.audit_actor_source(), txid_current(), now()
    );

    RETURN v_job_id;
END;
$$;

ALTER FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) OWNER TO postgres;

COMMENT ON FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) IS
  'Queue a broker capture of one gateway or one device, recorded to <subject>/<job id>.json. The only '
  'way a capture_jobs row is created. Refuses without Administrator or Shopfloor_Manager, an archived '
  'subject, the Playback gateway and its replay lanes (0190), a second concurrent capture, and '
  'replacing a stored capture unless p_replace is true. Writes a CAPTURE_STARTED audit row naming '
  'the subject and any capture it would replace (0193).';

-- -------------------------------------------------------------------------------------------------
-- 4. Stopping a recording
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_capture_stop(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    c_stale_seconds CONSTANT integer := 120;
    v_job    public.capture_jobs;
    v_silent integer;
    v_stop   text;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION 'request_capture_stop: requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_job FROM public.capture_jobs WHERE id = p_job_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'request_capture_stop: no capture job %', p_job_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- A job that finished between the click and the call did what was asked: not an error.
    IF v_job.status NOT IN ('PENDING', 'RECORDING') THEN
        RETURN false;
    END IF;

    IF v_job.status = 'PENDING' THEN
        -- Never claimed: cancelled outright, so a daemon that is down cannot leave it blocking
        -- every capture.
        UPDATE public.capture_jobs
           SET status = 'CANCELLED', stop_requested = true, finished_at = now(),
               error = 'cancelled before the daemon claimed it'
         WHERE id = p_job_id;
        v_stop := 'cancelled before the daemon claimed it';
    ELSE
        -- The daemon reports elapsed_seconds every second while recording, so started_at plus it
        -- is when it last reported. Silent this long, the daemon is not going to settle the job.
        v_silent := floor(extract(epoch FROM now()
                      - (coalesce(v_job.started_at, v_job.created_at) + make_interval(secs => v_job.elapsed_seconds))));
        IF v_silent > c_stale_seconds THEN
            UPDATE public.capture_jobs
               SET status = 'CANCELLED', stop_requested = true, finished_at = now(),
                   error = format('stopped from the page after the ingestion daemon had not reported on '
                                  'this recording for %s seconds. Nothing from it was stored, and any '
                                  'earlier capture of the subject is unchanged.', v_silent)
             WHERE id = p_job_id;
            v_stop := format('cancelled here: the daemon had not reported for %s seconds', v_silent);
        ELSIF v_job.stop_requested THEN
            -- Asked already: nothing changes, so nothing more is recorded.
            RETURN true;
        ELSE
            UPDATE public.capture_jobs SET stop_requested = true WHERE id = p_job_id;
            v_stop := 'stop requested';
        END IF;
    END IF;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'capture_jobs', p_job_id, 'CAPTURE_STOPPED', NULL,
        public.capture_subject_identity(v_job.subject_kind, v_job.gateway_id, v_job.device_id,
                                        v_job.subject_sparkplug_id)
          || jsonb_build_object('status_before', v_job.status, 'stop', v_stop,
                                'elapsed_seconds', v_job.elapsed_seconds, 'messages', v_job.messages),
        auth.uid(), public.audit_actor_source(), txid_current(), now()
    );

    RETURN true;
END;
$$;

ALTER FUNCTION public.request_capture_stop(p_job_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.request_capture_stop(p_job_id uuid) IS
  'Stop a capture. A PENDING job is cancelled outright; a RECORDING one is flagged for the daemon to '
  'finish on its next progress tick, or, when the daemon has not reported on it for two minutes, '
  'cancelled here with nothing stored (0190). Each stop that changes the job writes a CAPTURE_STOPPED '
  'audit row (0193). False for a job already finished. Administrator or Shopfloor_Manager.';

COMMENT ON COLUMN public.capture_jobs.stop_requested IS
  'Set by request_capture_stop(); the daemon reads it on its next one-second progress tick and stores '
  'what it has recorded. A PENDING job is cancelled outright instead, and a RECORDING job the daemon '
  'has not reported on for two minutes is CANCELLED by request_capture_stop() itself (0190, 0193).';

-- -------------------------------------------------------------------------------------------------
-- 5. Storing an upload
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_uploaded_capture(p_subject_kind text, p_subject_id uuid, p_storage_path text, p_size_bytes bigint, p_message_count integer, p_manifest jsonb DEFAULT '{}'::jsonb, p_note text DEFAULT NULL::text, p_replace boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    c_min_message_bytes CONSTANT integer := 50;
    c_max_manifest_bytes CONSTANT integer := 65536;
    v_gateway_id  uuid;
    v_device_id   uuid;
    v_sparkplug   text;
    v_archived    boolean;
    v_shadow      boolean;
    v_upload      public.capture_uploads;
    v_existing    public.captures;
    v_size        bigint;
    v_manifest    jsonb;
    v_note        text := nullif(btrim(coalesce(p_note, '')), '');
    v_capture_id  uuid;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION 'register_uploaded_capture: requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_subject_kind = 'gateway' THEN
        SELECT g.id, g.sparkplug_id, g.is_archived, g.is_shadow
          INTO v_gateway_id, v_sparkplug, v_archived, v_shadow
          FROM public.gateways g WHERE g.id = p_subject_id;
    ELSIF p_subject_kind = 'device' THEN
        SELECT d.id, d.sparkplug_id, d.gateway_id, d.is_archived,
               d.shadow_of IS NOT NULL OR coalesce(g.is_shadow, false)
          INTO v_device_id, v_sparkplug, v_gateway_id, v_archived, v_shadow
          FROM public.devices d LEFT JOIN public.gateways g ON g.id = d.gateway_id
         WHERE d.id = p_subject_id;
    ELSE
        RAISE EXCEPTION 'register_uploaded_capture: p_subject_kind must be ''gateway'' or ''device'''
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_sparkplug IS NULL THEN
        RAISE EXCEPTION 'register_uploaded_capture: no % %', p_subject_kind, p_subject_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_archived THEN
        RAISE EXCEPTION 'register_uploaded_capture: % % is archived.', p_subject_kind, v_sparkplug
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_shadow THEN
        RAISE EXCEPTION 'register_uploaded_capture: % is the Playback gateway or one of its replay '
          'lanes, which publish only replays. File the capture against the gateway or device it was '
          'recorded from.', v_sparkplug
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The path is one begin_capture_upload() issued, for this subject, to this caller.
    SELECT * INTO v_upload FROM public.capture_uploads u WHERE u.storage_path = p_storage_path FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'register_uploaded_capture: no upload was begun for %. Call '
          'begin_capture_upload() first: it decides whether the upload may replace the stored '
          'capture, and issues the path to upload to.', coalesce(p_storage_path, '<null>')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_upload.subject_kind <> p_subject_kind
       OR v_upload.gateway_id IS DISTINCT FROM (CASE WHEN p_subject_kind = 'gateway' THEN v_gateway_id END)
       OR v_upload.device_id IS DISTINCT FROM v_device_id THEN
        RAISE EXCEPTION 'register_uploaded_capture: % was issued for another subject', p_storage_path
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_upload.created_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'register_uploaded_capture: % was issued to someone else', p_storage_path
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- A repeated call after a lost answer gets the capture it made, and records nothing more.
    IF v_upload.capture_id IS NOT NULL THEN
        RETURN v_upload.capture_id;
    END IF;
    IF v_upload.closed_at IS NOT NULL THEN
        RAISE EXCEPTION 'register_uploaded_capture: a later upload of this subject replaced this one. '
          'Upload the file again if it is the one to keep.'
            USING ERRCODE = 'unique_violation';
    END IF;
    IF v_upload.created_at <= now() - interval '1 hour' THEN
        RAISE EXCEPTION 'register_uploaded_capture: this upload began more than an hour ago and has '
          'expired. Upload the file again.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.capture_jobs j
         WHERE j.status IN ('PENDING', 'RECORDING')
           AND ((p_subject_kind = 'gateway' AND j.subject_kind = 'gateway' AND j.gateway_id = v_gateway_id)
             OR (p_subject_kind = 'device'  AND j.subject_kind = 'device'  AND j.device_id  = v_device_id))
    ) THEN
        RAISE EXCEPTION 'register_uploaded_capture: % is being recorded right now. Its finish would '
          'replace this upload, so it is not stored. Upload again when the recording has finished.',
          v_sparkplug
            USING ERRCODE = 'unique_violation';
    END IF;

    SELECT * INTO v_existing FROM public.captures c
     WHERE (p_subject_kind = 'gateway' AND c.subject_kind = 'gateway' AND c.gateway_id = v_gateway_id)
        OR (p_subject_kind = 'device'  AND c.subject_kind = 'device'  AND c.device_id  = v_device_id)
       FOR UPDATE;
    IF FOUND AND v_existing.id IS DISTINCT FROM v_upload.replaces_capture_id THEN
        RAISE EXCEPTION
          'register_uploaded_capture: another capture of this subject was stored after this upload '
          'began (recorded %). It is kept. Upload again to replace it.',
          to_char(v_existing.recorded_at, 'DD Mon YYYY HH24:MI') || coalesce(' -- ' || v_existing.note, '')
            USING ERRCODE = 'unique_violation';
    END IF;
    IF FOUND AND NOT coalesce(p_replace, false) THEN
        RAISE EXCEPTION
          'register_uploaded_capture: a capture of this subject already exists. Uploading replaces '
          'it. Call with p_replace := true to confirm.'
            USING ERRCODE = 'unique_violation';
    END IF;

    -- The object's size, as storage-api recorded it; the browser's is not used.
    v_size := public.capture_object_size(p_storage_path);
    IF v_size IS NULL THEN
        PERFORM public.raise_not_found(format(
          'register_uploaded_capture: there is no object at %s in broker-captures. Upload the file '
          'first.', p_storage_path));
    END IF;
    IF p_message_count IS NULL OR p_message_count < 1
       OR p_message_count::bigint > v_size / c_min_message_bytes THEN
        RAISE EXCEPTION 'register_uploaded_capture: a file of % bytes cannot hold % messages',
            v_size, coalesce(p_message_count::text, '<null>')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_manifest := public.capped_capture_manifest(coalesce(p_manifest, '{}'::jsonb));
    IF octet_length(v_manifest::text) > c_max_manifest_bytes THEN
        RAISE EXCEPTION 'register_uploaded_capture: the manifest is % bytes, and at most % are kept',
            octet_length(v_manifest::text), c_max_manifest_bytes
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The swap, in one transaction. The object the old row named is deleted by the caller after
    -- this commits, or by the ingestion daemon's sweep. The setting tells the deletion's audit row
    -- what replaced it.
    PERFORM set_config('aber.capture_replaced_by',
                       jsonb_build_object('reason', 'replaced by an upload', 'upload_id', v_upload.id)::text,
                       true);
    DELETE FROM public.captures c
     WHERE (p_subject_kind = 'gateway' AND c.subject_kind = 'gateway' AND c.gateway_id = v_gateway_id)
        OR (p_subject_kind = 'device'  AND c.subject_kind = 'device'  AND c.device_id  = v_device_id);
    PERFORM set_config('aber.capture_replaced_by', '', true);

    INSERT INTO public.captures (
        subject_kind, gateway_id, device_id, subject_sparkplug_id, storage_path,
        size_bytes, message_count, note, manifest, source, created_by
    ) VALUES (
        p_subject_kind, v_gateway_id, v_device_id, v_sparkplug, p_storage_path,
        v_size, p_message_count, v_note,
        v_manifest, 'uploaded', auth.uid()
    )
    RETURNING id INTO v_capture_id;

    UPDATE public.capture_uploads SET closed_at = now(), capture_id = v_capture_id WHERE id = v_upload.id;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'captures', v_capture_id, 'CAPTURE_UPLOADED', NULL,
        public.capture_subject_identity(p_subject_kind, v_gateway_id, v_device_id, v_sparkplug)
          || jsonb_build_object('storage_path', p_storage_path, 'size_bytes', v_size,
                                'message_count', p_message_count, 'note', v_note,
                                'replaced_capture_id', v_existing.id),
        auth.uid(), public.audit_actor_source(), txid_current(), now()
    );

    RETURN v_capture_id;
END;
$$;

ALTER FUNCTION public.register_uploaded_capture(p_subject_kind text, p_subject_id uuid, p_storage_path text, p_size_bytes bigint, p_message_count integer, p_manifest jsonb, p_note text, p_replace boolean) OWNER TO postgres;

COMMENT ON FUNCTION public.register_uploaded_capture(p_subject_kind text, p_subject_id uuid, p_storage_path text, p_size_bytes bigint, p_message_count integer, p_manifest jsonb, p_note text, p_replace boolean) IS
  'Store an uploaded capture as the subject''s capture. p_storage_path must be the open path '
  'begin_capture_upload() issued this caller for this subject. Refuses an archived or shadow subject, '
  'a subject being recorded, and a stored capture other than the one the upload began against. The '
  'size recorded is the object''s own (p_size_bytes is not used); a message count the file cannot '
  'hold and a manifest over 64 KiB are refused. Repoints the row in one transaction; the caller '
  'then deletes the replaced object (0190). Writes a CAPTURE_UPLOADED audit row, and the replaced '
  'capture''s CAPTURE_DELETED says an upload replaced it (0193).';

-- -------------------------------------------------------------------------------------------------
-- 6. Storing a recording
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb DEFAULT '{}'::jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job        public.capture_jobs;
    v_replaced   uuid;
    v_capture_id uuid;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_finalise_capture');

    SELECT * INTO v_job FROM public.capture_jobs WHERE id = p_job_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ingest_finalise_capture: no capture job %', p_job_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    -- The daemon retries this call; one whose answer was lost finds its own capture.
    IF v_job.status = 'COMPLETED' AND v_job.capture_id IS NOT NULL THEN
        RETURN v_job.capture_id;
    END IF;
    IF v_job.status <> 'RECORDING' THEN
        RAISE EXCEPTION 'ingest_finalise_capture: job % is %, not RECORDING', p_job_id, v_job.status
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The swap, in one transaction: the old row survived the whole recording, and its object is
    -- deleted by the daemon only after this commits. The setting tells the deletion's audit row
    -- what replaced it.
    PERFORM set_config('aber.capture_replaced_by',
                       jsonb_build_object('reason', 'replaced by a recording', 'capture_job_id', v_job.id)::text,
                       true);
    WITH gone AS (
        DELETE FROM public.captures c
         WHERE (v_job.subject_kind = 'gateway' AND c.subject_kind = 'gateway' AND c.gateway_id = v_job.gateway_id)
            OR (v_job.subject_kind = 'device'  AND c.subject_kind = 'device'  AND c.device_id  = v_job.device_id)
        RETURNING c.id
    )
    SELECT id INTO v_replaced FROM gone;
    PERFORM set_config('aber.capture_replaced_by', '', true);

    INSERT INTO public.captures (
        subject_kind, gateway_id, device_id, subject_sparkplug_id, storage_path,
        size_bytes, message_count, note, manifest, source, recorded_at, created_by
    ) VALUES (
        v_job.subject_kind, v_job.gateway_id, v_job.device_id,
        v_job.subject_sparkplug_id, v_job.storage_path,
        greatest(coalesce(p_size_bytes, 0), 0), greatest(coalesce(p_message_count, 0), 0),
        v_job.note,
        public.capped_capture_manifest(coalesce(p_manifest, '{}'::jsonb)),
        'recorded', coalesce(v_job.started_at, now()), v_job.requested_by
    )
    RETURNING id INTO v_capture_id;

    UPDATE public.capture_jobs
       SET status = 'COMPLETED', finished_at = now(), capture_id = v_capture_id,
           messages = greatest(coalesce(p_message_count, 0), 0),
           bytes    = greatest(coalesce(p_size_bytes, 0), 0)
     WHERE id = p_job_id;

    -- The daemon's act, naming the person who asked for the recording.
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'captures', v_capture_id, 'CAPTURE_RECORDED', NULL,
        public.capture_subject_identity(v_job.subject_kind, v_job.gateway_id, v_job.device_id,
                                        v_job.subject_sparkplug_id)
          || jsonb_build_object('storage_path', v_job.storage_path,
                                'size_bytes', greatest(coalesce(p_size_bytes, 0), 0),
                                'message_count', greatest(coalesce(p_message_count, 0), 0),
                                'note', v_job.note, 'capture_job_id', v_job.id,
                                'requested_by', v_job.requested_by,
                                'replaced_capture_id', v_replaced),
        auth.uid(), public.audit_actor_source(), txid_current(), now()
    );

    RETURN v_capture_id;
END;
$$;

ALTER FUNCTION public.ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb) OWNER TO postgres;

COMMENT ON FUNCTION public.ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb) IS
  'The ingestion daemon storing a finished recording: replaces the subject''s capture row with the '
  'job''s in one transaction and marks the job COMPLETED. A repeated call for a job it completed '
  'answers that capture (0190). Writes a CAPTURE_RECORDED audit row naming the job and the person '
  'who requested it, and the replaced capture''s CAPTURE_DELETED says a recording replaced it '
  '(0193). Ingestion principal only.';

-- -------------------------------------------------------------------------------------------------
-- 7. Every deletion of a capture is recorded
-- -------------------------------------------------------------------------------------------------
-- A person's delete, a replacement (the swaps above say which), and the cascade of a deleted
-- gateway or device: one row per capture. The subject's name is null in a cascade, because its row
-- is already gone; the sparkplug_id still names it.
CREATE OR REPLACE FUNCTION public.log_capture_deleted() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_how jsonb := nullif(current_setting('aber.capture_replaced_by', true), '')::jsonb;
BEGIN
    IF v_how IS NULL THEN
        v_how := jsonb_build_object('reason', CASE
            WHEN OLD.subject_kind = 'device'
                 AND NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.id = OLD.device_id)
              THEN 'deleted with its device'
            WHEN OLD.gateway_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.id = OLD.gateway_id)
              THEN 'deleted with its gateway'
            ELSE 'deleted'
        END);
    END IF;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'captures', OLD.id, 'CAPTURE_DELETED', NULL,
        public.capture_subject_identity(OLD.subject_kind, OLD.gateway_id, OLD.device_id,
                                        OLD.subject_sparkplug_id)
          || jsonb_build_object('storage_path', OLD.storage_path, 'size_bytes', OLD.size_bytes,
                                'message_count', OLD.message_count, 'note', OLD.note,
                                'source', OLD.source, 'recorded_at', OLD.recorded_at)
          || v_how,
        auth.uid(), public.audit_actor_source(), txid_current(), now()
    );
    RETURN OLD;
END;
$$;

ALTER FUNCTION public.log_capture_deleted() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.log_capture_deleted() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.log_capture_deleted() IS
  'AFTER DELETE on captures: writes a CAPTURE_DELETED audit row for each capture deleted, with the '
  'capture''s final properties and why it went: deleted, replaced by an upload or a recording (set '
  'by register_uploaded_capture() and ingest_finalise_capture() through aber.capture_replaced_by), '
  'or deleted with its gateway or device (0193).';

SELECT public.replay_trigger('public.captures', 'trg_captures_audit_delete', $ddl$
CREATE TRIGGER trg_captures_audit_delete AFTER DELETE ON public.captures FOR EACH ROW EXECUTE FUNCTION public.log_capture_deleted();
$ddl$);

COMMENT ON TABLE public.captures IS
  'The capture that EXISTS for a subject -- at most one per gateway and one per device, enforced by '
  'two partial unique indexes. Written by ingest_finalise_capture() for a recorded capture and by '
  'register_uploaded_capture() for one uploaded through the browser; both paths land here so that '
  'playback has a single way to name a capture. Distinct from capture_jobs, which records the ACT of '
  'recording and has no row at all for an uploaded file. Each capture stored, linked for download '
  'and deleted is in the Audit Trail (0193). See 0055''s header.';

-- -------------------------------------------------------------------------------------------------
-- 8. A download link is issued through the database
-- -------------------------------------------------------------------------------------------------
-- The page calls this, then signs a link for the path it answers. The bucket's own read policy is
-- unchanged, so a reader who goes to the Storage API directly is not recorded here.
CREATE OR REPLACE FUNCTION public.issue_capture_download(p_storage_path text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_capture public.captures;
BEGIN
    IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor']) THEN
        RAISE EXCEPTION 'issue_capture_download: downloading a capture requires Administrator, '
          'Shopfloor_Manager or Auditor'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_capture FROM public.captures c WHERE c.storage_path = p_storage_path;
    IF NOT FOUND THEN
        PERFORM public.raise_not_found(format(
          'issue_capture_download: no stored capture is at %s. It may have been deleted or replaced; '
          'reload the list.', coalesce(p_storage_path, '<null>')));
    END IF;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'captures', v_capture.id, 'CAPTURE_DOWNLOAD_ISSUED', NULL,
        public.capture_subject_identity(v_capture.subject_kind, v_capture.gateway_id,
                                        v_capture.device_id, v_capture.subject_sparkplug_id)
          || jsonb_build_object('storage_path', v_capture.storage_path,
                                'size_bytes', v_capture.size_bytes,
                                'message_count', v_capture.message_count,
                                'source', v_capture.source, 'recorded_at', v_capture.recorded_at),
        auth.uid(), public.audit_actor_source(), txid_current(), now()
    );

    RETURN v_capture.storage_path;
END;
$$;

ALTER FUNCTION public.issue_capture_download(p_storage_path text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.issue_capture_download(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.issue_capture_download(text) TO authenticated;

COMMENT ON FUNCTION public.issue_capture_download(p_storage_path text) IS
  'Record that a stored capture''s file is being downloaded, as a CAPTURE_DOWNLOAD_ISSUED audit row, '
  'and answer its path for the caller to sign a link for. Administrator, Shopfloor_Manager or '
  'Auditor, the roles the broker-captures bucket admits to read; 404 when no capture row names the '
  'path (0193).';

-- -------------------------------------------------------------------------------------------------
-- 9. Starting a playback
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb DEFAULT '{}'::jsonb, p_speed numeric DEFAULT 1.0) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_gateway  public.gateways;
    v_capture  public.captures;
    v_running  RECORD;
    v_key      text;
    v_target   text;
    v_job_id   uuid;
    v_lane     RECORD;
    v_origin   RECORD;
    v_named    text;
    v_map      jsonb := coalesce(p_device_map, '{}'::jsonb);
    v_speed    numeric := least(greatest(coalesce(p_speed, 1.0), 0.01), 60);
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION
          'start_playback_job: publishing a capture requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_capture FROM public.captures WHERE id = p_capture_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'start_playback_job: no capture %', p_capture_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT * INTO v_gateway FROM public.gateways WHERE id = p_target_gateway_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'start_playback_job: no gateway %', p_target_gateway_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- The target must be marked simulated: the historian records a replayed reading identically to
    -- an observed one, and `is_simulated` is the only thing that says otherwise. The BEFORE INSERT
    -- trigger playback_target_must_be_shadow() narrows this to the Playback gateway.
    IF NOT v_gateway.is_simulated THEN
        RAISE EXCEPTION
          'start_playback_job: gateway % is not marked simulated. Publishing a capture onto it '
          'would write synthetic telemetry that nothing downstream can tell from observed data. '
          'Choose the Playback gateway, the only gateway a capture can be played back onto.',
          v_gateway.name
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_gateway.is_archived THEN
        RAISE EXCEPTION 'start_playback_job: gateway % is archived.', v_gateway.name
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The target must hold a broker credential. Not `status = 'ONLINE'`: a playback target is
    -- OFFLINE until a playback runs. `gateway_has_broker_credential()`, not
    -- `gateway_holds_a_credential()`, which means "remote and enrolled" and excludes every host-run
    -- gateway.
    IF NOT public.gateway_has_broker_credential(v_gateway) THEN
        RAISE EXCEPTION
          'start_playback_job: gateway % holds no broker credential, so the playback worker cannot '
          'connect as it. Issue one from the Access Control page; the platform delivers the '
          'password to the worker within about a minute.', v_gateway.name
            USING ERRCODE = 'check_violation';
    END IF;

    -- The worker must hold the CURRENT password: the broker keeps one per gateway, so a re-issue
    -- replaces it, and until delivery the worker holds the previous one. A worker that has reported
    -- no observation at all is not listed by playback_stale_credentials() and is not refused.
    IF EXISTS (
        SELECT 1 FROM public.playback_stale_credentials() s
         WHERE s.sparkplug_id = v_gateway.sparkplug_id
    ) THEN
        RAISE EXCEPTION
          'start_playback_job: gateway % had its broker credential re-issued after the playback '
          'worker last picked one up, so the worker still holds the previous password and the '
          'broker would refuse it. Delivery takes about a minute; try again shortly.', v_gateway.name
            USING ERRCODE = 'check_violation';
    END IF;

    -- Every key is a recorded device's sparkplug_id and every value the sparkplug_id it is
    -- published as. Each target must be an active device of this gateway: publishing another
    -- gateway's device segment is exactly what `verify_gateway_binding()` quarantines. It must
    -- also be a replay lane (`shadow_of` set) and the lane of the device its key names. A replay
    -- writes readings into the history of the device it publishes as, so a real device, or the
    -- lane of some other device, is never a target.
    FOR v_key, v_target IN SELECT key, value FROM jsonb_each_text(v_map)
    LOOP
        SELECT d.name, d.shadow_of, o.name AS origin_name INTO v_lane
          FROM public.devices d
          LEFT JOIN public.devices o ON o.id = d.shadow_of
         WHERE d.sparkplug_id = v_target AND d.gateway_id = p_target_gateway_id
           AND NOT d.is_archived;
        IF NOT FOUND THEN
            RAISE EXCEPTION
              'start_playback_job: % maps to %, which is not an active device of gateway %.',
              v_key, v_target, v_gateway.name
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        SELECT o.id, o.name INTO v_origin FROM public.devices o WHERE o.sparkplug_id = v_key;
        v_named := coalesce(v_origin.name || ' (' || v_key || ')', v_key);

        IF v_lane.shadow_of IS NULL THEN
            RAISE EXCEPTION
              'start_playback_job: % maps to % (%), which is a real device and not a replay lane. A '
              'replay writes recorded readings into the history of the device it publishes as, so it '
              'may only publish as a lane. Prepare the replay lanes for this capture and map onto '
              'those.', v_named, v_lane.name, v_target
                USING ERRCODE = 'check_violation';
        END IF;

        IF v_origin.id IS DISTINCT FROM v_lane.shadow_of THEN
            RAISE EXCEPTION
              'start_playback_job: % maps to % (%), the replay lane of %, which is not the device the '
              'recording names. A lane replays only the device it stands in for.',
              v_named, v_lane.name, v_target, v_lane.origin_name
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    -- One playback per target, reported rather than left to the index.
    SELECT j.id, j.status INTO v_running
      FROM public.playback_jobs j
     WHERE j.target_gateway_id = p_target_gateway_id AND j.status IN ('PENDING', 'RUNNING')
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION
          'start_playback_job: a playback onto % is already %. Two publishers on one edge node '
          'interleave their sequence numbers, which the daemon reports as permanent message loss.',
          v_gateway.name, lower(v_running.status)
            USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO public.playback_jobs (
        capture_id, capture_storage_path, target_gateway_id, target_edge_node_id,
        sparkplug_group, device_map, speed, status, requested_by
    ) VALUES (
        v_capture.id, v_capture.storage_path, v_gateway.id, v_gateway.sparkplug_id,
        v_gateway.sparkplug_group, v_map, v_speed, 'PENDING', auth.uid()
    )
    RETURNING id INTO v_job_id;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'playback_jobs', v_job_id, 'PLAYBACK_STARTED', NULL,
        public.capture_subject_identity(v_capture.subject_kind, v_capture.gateway_id,
                                        v_capture.device_id, v_capture.subject_sparkplug_id)
          || jsonb_build_object('capture_id', v_capture.id,
                                'capture_storage_path', v_capture.storage_path,
                                'capture_recorded_at', v_capture.recorded_at,
                                'target_gateway_id', v_gateway.id,
                                'target_name', v_gateway.name,
                                'target_sparkplug_id', v_gateway.sparkplug_id,
                                'device_map', v_map, 'speed', v_speed),
        auth.uid(), public.audit_actor_source(), txid_current(), now()
    );

    RETURN v_job_id;
END;
$$;

ALTER FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) OWNER TO postgres;

COMMENT ON FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) IS
  'Queue a capture for publication onto the Playback gateway. The only way a playback_jobs row is '
  'created. Refuses a target that is not is_simulated, and the BEFORE INSERT trigger '
  'playback_target_must_be_shadow() refuses one that is not is_shadow, which only the seeded Playback '
  'gateway is. Refuses too a target holding no broker credential or whose credential the '
  'worker has not picked up since its re-issue, a device map naming a device that is not an active '
  'replay lane of the gateway and of the device its key names, and a second concurrent playback onto '
  'the same edge node. Writes a PLAYBACK_STARTED audit row naming the capture, its subject and the '
  'target (0193).';

-- -------------------------------------------------------------------------------------------------
-- 10. Stopping a playback
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_playback_stop(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job     public.playback_jobs;
    v_capture public.captures;
    v_subject jsonb;
    v_silent  integer;
    v_stop    text;
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

    IF v_job.status = 'PENDING' THEN
        -- Never claimed: cancelled outright, or a worker that is down leaves it PENDING for ever.
        UPDATE public.playback_jobs
           SET status = 'CANCELLED', stop_requested = true, finished_at = now(),
               error = 'cancelled before the worker claimed it'
         WHERE id = p_job_id;
        v_stop := 'cancelled before the worker claimed it';
    ELSE
        v_silent := floor(extract(epoch FROM now() - coalesce(v_job.progress_reported_at,
                                                               v_job.started_at, v_job.created_at)));
        -- A worker reports at least once a second while a job runs, so a minute of silence means it
        -- is not reading the flag. Ended here, so the target is free again.
        IF v_silent > 60 THEN
            UPDATE public.playback_jobs
               SET status = 'CANCELLED', stop_requested = true, finished_at = now(),
                   error = format('stopped here because the playback worker had not reported for %s '
                                  'seconds; it had reported %s message(s) published%s',
                                  v_silent, v_job.messages_sent,
                                  CASE WHEN v_job.messages_total > 0
                                       THEN format(' of %s', v_job.messages_total) ELSE '' END)
             WHERE id = p_job_id;
            v_stop := format('cancelled here: the worker had not reported for %s seconds', v_silent);
        ELSIF v_job.stop_requested THEN
            -- Asked already: nothing changes, so nothing more is recorded.
            RETURN true;
        ELSE
            UPDATE public.playback_jobs SET stop_requested = true WHERE id = p_job_id;
            v_stop := 'stop requested';
        END IF;
    END IF;

    -- The capture may have been deleted since; its path still names the subject.
    SELECT * INTO v_capture FROM public.captures WHERE id = v_job.capture_id;
    IF FOUND THEN
        v_subject := public.capture_subject_identity(v_capture.subject_kind, v_capture.gateway_id,
                                                     v_capture.device_id, v_capture.subject_sparkplug_id);
    ELSE
        v_subject := jsonb_build_object('sparkplug_id', split_part(v_job.capture_storage_path, '/', 1));
    END IF;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'playback_jobs', p_job_id, 'PLAYBACK_STOPPED', NULL,
        v_subject
          || jsonb_build_object('capture_id', v_job.capture_id,
                                'target_gateway_id', v_job.target_gateway_id,
                                'target_sparkplug_id', v_job.target_edge_node_id,
                                'status_before', v_job.status, 'stop', v_stop,
                                'messages_sent', v_job.messages_sent,
                                'messages_total', v_job.messages_total),
        auth.uid(), public.audit_actor_source(), txid_current(), now()
    );

    RETURN true;
END;
$$;

ALTER FUNCTION public.request_playback_stop(p_job_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.request_playback_stop(p_job_id uuid) IS 'Stop a playback. A PENDING job is cancelled outright. A RUNNING job gets stop_requested, which the worker reads within a second; one whose worker has not reported for more than a minute is ended here as CANCELLED, saying how much it had reported published, so a stalled worker cannot hold the target (0191). Each stop that changes the job writes a PLAYBACK_STOPPED audit row (0193). Returns false for a job already finished.';

-- -------------------------------------------------------------------------------------------------
-- 11. A playback's end ends its session in the platform
-- -------------------------------------------------------------------------------------------------
-- When the broker cuts the worker's session (a re-issued credential, through Dynamic Security) it
-- publishes no Will, and the worker cannot publish the NDEATH with a password that no longer works.
-- So the end of a RUNNING job makes the change an applied NDEATH makes: the Playback gateway
-- OFFLINE if it still reads ONLINE, and its lanes OFFLINE. The worker's session has ended before
-- it calls this. A newer playback's NBIRTH cannot be overwritten: the one-per-target index admits
-- no other PENDING or RUNNING job onto this gateway until this transaction commits, and a finish
-- for a job that already ended changes nothing.
CREATE OR REPLACE FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text DEFAULT NULL::text, p_messages_out_of_window integer DEFAULT 0) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job public.playback_jobs;
BEGIN
    PERFORM public.require_playback_caller('playback_finish');

    SELECT * INTO v_job FROM public.playback_jobs WHERE id = p_job_id FOR UPDATE;
    IF NOT FOUND OR v_job.status NOT IN ('PENDING', 'RUNNING') THEN
        RETURN;
    END IF;

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
     WHERE id = p_job_id;

    IF v_job.status = 'RUNNING' THEN
        UPDATE public.gateways g
           SET status = 'OFFLINE'
         WHERE g.id = v_job.target_gateway_id AND g.is_shadow AND g.status = 'ONLINE';

        UPDATE public.devices d
           SET status = 'OFFLINE'
          FROM public.gateways g
         WHERE g.id = v_job.target_gateway_id AND g.is_shadow
           AND d.gateway_id = g.id
           AND d.is_archived IS NOT TRUE
           AND d.status IS DISTINCT FROM 'OFFLINE';
    END IF;
END;
$$;

ALTER FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text, p_messages_out_of_window integer) OWNER TO postgres;

COMMENT ON FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text, p_messages_out_of_window integer) IS 'The playback worker recording the end of a job. Three outcomes, in this order: an error is FAILED; a job whose stop_requested flag was raised while it ran is CANCELLED; anything else is COMPLETED. The error outranks the flag because it is the half an operator can act on. Only a PENDING or RUNNING row is touched, so a job already cancelled before it was claimed keeps the status request_playback_stop() gave it. p_messages_out_of_window is recorded and not judged: the worker holds the plan and decides there, and a job whose every message would be discarded is reported here as an error. Ending a RUNNING job also sets its shadow target OFFLINE if it still reads ONLINE, and the target''s replay lanes OFFLINE, as an applied NDEATH does: a session the broker cut sends no Will (0193).';

-- -------------------------------------------------------------------------------------------------
-- 12. A playback's history outlives its target
-- -------------------------------------------------------------------------------------------------
-- What playback_jobs_target_gateway_id_fkey would do as ON DELETE RESTRICT, and the delete half of
-- 0067's archive rule. BEFORE DELETE, so it refuses before the key's CASCADE runs. No role is
-- exempt; the nightly purge skips such a gateway rather than meet this.
CREATE OR REPLACE FUNCTION public.refuse_deleting_a_playback_gateway() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_replays bigint;
BEGIN
    IF OLD.is_shadow AND NOT OLD.is_archived AND NOT EXISTS (
        SELECT 1 FROM public.gateways g
         WHERE g.is_shadow AND NOT g.is_archived AND g.id <> OLD.id
    ) THEN
        RAISE EXCEPTION
          'gateway % is the Playback gateway, and deleting it would leave broker playback with no '
          'edge node to publish as. It stays. It reads OFFLINE whenever no capture is playing, which '
          'is its resting state and not a fault.',
          OLD.name
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT count(*) INTO v_replays FROM public.playback_jobs p WHERE p.target_gateway_id = OLD.id;
    IF v_replays > 0 THEN
        RAISE EXCEPTION
          'gateway % cannot be deleted: % playback(s) were published as it, and deleting it would '
          'erase the record of them. Archive it instead; an archived gateway keeps its history.',
          OLD.name, v_replays
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN OLD;
END;
$$;

ALTER FUNCTION public.refuse_deleting_a_playback_gateway() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_deleting_a_playback_gateway() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.refuse_deleting_a_playback_gateway() IS
  'BEFORE DELETE on gateways, for every role: refuses deleting the last unarchived shadow gateway, as '
  'refuse_archiving_the_last_shadow_gateway() refuses archiving it, and deleting any gateway '
  'playback_jobs name, which is what ON DELETE RESTRICT on playback_jobs_target_gateway_id_fkey '
  'would do. A trigger rather than the key: 0001''s guard restores the key''s CASCADE on every boot '
  '(0193).';

SELECT public.replay_trigger('public.gateways', 'trg_gateways_keep_playback_history', $ddl$
CREATE TRIGGER trg_gateways_keep_playback_history BEFORE DELETE ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.refuse_deleting_a_playback_gateway();
$ddl$);

COMMENT ON TABLE public.playback_jobs IS
  'One row per playback attempted. At most one is PENDING or RUNNING per TARGET GATEWAY -- two '
  'publishers on one edge node interleave sequence numbers. Written only through the gates in 0056; '
  'there is no direct-write policy. Progress is pushed to the page by Realtime. A gateway these rows '
  'name cannot be deleted (trg_gateways_keep_playback_history), so the record of a replay outlives '
  'its capture and its target; starting and stopping one is in the Audit Trail (0193).';

-- The nightly purge, as 0002 states it, but for the gateway a playback names: deleting it would be
-- refused and abort the whole job, which is one transaction. It stays on the Archived Entities page.
SELECT public.ensure_cron_job(
  'purge_expired_archives',
  '30 3 * * *',
  $job$
    DELETE FROM public.devices
      WHERE is_archived AND auto_delete_at IS NOT NULL AND auto_delete_at <= NOW();
    DELETE FROM public.gateways g
      WHERE g.is_archived AND g.auto_delete_at IS NOT NULL AND g.auto_delete_at <= NOW()
        AND NOT EXISTS (SELECT 1 FROM public.playback_jobs p WHERE p.target_gateway_id = g.id);
    DELETE FROM public.cells
      WHERE is_archived AND auto_delete_at IS NOT NULL AND auto_delete_at <= NOW();
    DELETE FROM public.areas a
      WHERE a.is_archived AND a.auto_delete_at IS NOT NULL AND a.auto_delete_at <= NOW()
        AND NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.area_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.area_id = a.id);
  $job$
);

-- -------------------------------------------------------------------------------------------------
-- 13. ensure_shadow_devices() no longer sends an operator to restore the Playback gateway
-- -------------------------------------------------------------------------------------------------
-- It cannot be archived or deleted, so a stack without it lost it before 0193; the seed creates it
-- again on the next boot. Otherwise unchanged from 0190.
CREATE OR REPLACE FUNCTION public.ensure_shadow_devices(p_capture_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_capture   public.captures;
    v_gateway   public.gateways;
    v_wire_id   text;
    v_origin    public.devices;
    v_shadow_id uuid;
    v_map       jsonb := '{}'::jsonb;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION
          'ensure_shadow_devices: creating playback lanes requires Administrator or '
          'Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_capture FROM public.captures WHERE id = p_capture_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ensure_shadow_devices: no capture %', p_capture_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- The Playback gateway: the seed alone sets is_shadow, and an older second one loses to it.
    SELECT * INTO v_gateway FROM public.gateways
     WHERE is_shadow AND NOT is_archived
     ORDER BY created_at
     LIMIT 1;
    IF NOT FOUND THEN
        PERFORM public.raise_not_found(
          'ensure_shadow_devices: this stack has no Playback gateway, and a capture can be played '
          'back only there. If it is still missing, upgrade the release: the upgrade creates it '
          'again. No other gateway can be made one.');
    END IF;

    FOR v_wire_id IN
        SELECT jsonb_array_elements_text(coalesce(v_capture.manifest -> 'device_ids', '[]'::jsonb))
    LOOP
        SELECT * INTO v_origin FROM public.devices WHERE sparkplug_id = v_wire_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
              'ensure_shadow_devices: the capture records device %, which this stack does not '
              'know. A replay lane stands in for a device that exists here, so a capture from '
              'another site, or of a device since deleted, cannot be played back.', v_wire_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        -- A capture of a playback: replay onto the lane itself rather than shadow a shadow.
        IF v_origin.shadow_of IS NOT NULL THEN
            RAISE EXCEPTION
              'ensure_shadow_devices: % is itself a playback lane. Replay onto it directly rather '
              'than shadowing it.', v_origin.name
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT id INTO v_shadow_id FROM public.devices
         WHERE gateway_id = v_gateway.id AND shadow_of = v_origin.id;

        IF NOT FOUND THEN
            INSERT INTO public.devices (
                name, gateway_id, shadow_of, status, conformance_policy, description
            ) VALUES (
                left(v_origin.name, 96) || ' (replay)',
                v_gateway.id,
                v_origin.id,
                'OFFLINE',
                v_origin.conformance_policy,
                'Replays recordings of ' || v_origin.name || '. Not a machine: its readings are '
                'genuine but were observed elsewhere, at another time.'
            )
            RETURNING id INTO v_shadow_id;

            -- The original's schemas, so a replay is judged as the original is.
            INSERT INTO public.device_submodels (device_id, schema_id, submodel_key)
            SELECT v_shadow_id, ds.schema_id, ds.submodel_key
              FROM public.device_submodels ds
             WHERE ds.device_id = v_origin.id;
        END IF;

        v_map := v_map || jsonb_build_object(
            v_wire_id,
            (SELECT sparkplug_id FROM public.devices WHERE id = v_shadow_id)
        );
    END LOOP;

    IF v_map = '{}'::jsonb THEN
        IF v_capture.subject_kind = 'device' THEN
            PERFORM public.raise_not_found(format(
              'ensure_shadow_devices: capture %s of device %s holds none of that device''s messages, '
              'only its edge node''s, so there is nothing to replay. Record it again while the device '
              'is publishing.', p_capture_id, v_capture.subject_sparkplug_id));
        END IF;
        PERFORM public.raise_not_found(format(
          'ensure_shadow_devices: capture %s names no devices, so there is nothing to replay as. It '
          'holds only the gateway''s own node-level messages.', p_capture_id));
    END IF;

    RETURN v_map;
END;
$$;

ALTER FUNCTION public.ensure_shadow_devices(p_capture_id uuid) OWNER TO postgres;

-- -------------------------------------------------------------------------------------------------
-- Self-check: this file's own declarations
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn  text;
  v_act text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['captures', 'capture_jobs', 'playback_jobs'] LOOP
    IF public.audit_domain_for(v_fn, 'UPDATE') <> 'asset' THEN
      RAISE EXCEPTION '0193: audit_domain_for() does not file % in the asset lane', v_fn;
    END IF;
  END LOOP;

  FOR v_fn, v_act IN VALUES
      ('public.start_capture_job(text, uuid, text, integer, boolean)', 'CAPTURE_STARTED'),
      ('public.request_capture_stop(uuid)', 'CAPTURE_STOPPED'),
      ('public.register_uploaded_capture(text, uuid, text, bigint, integer, jsonb, text, boolean)', 'CAPTURE_UPLOADED'),
      ('public.ingest_finalise_capture(uuid, bigint, integer, jsonb)', 'CAPTURE_RECORDED'),
      ('public.log_capture_deleted()', 'CAPTURE_DELETED'),
      ('public.issue_capture_download(text)', 'CAPTURE_DOWNLOAD_ISSUED'),
      ('public.start_playback_job(uuid, uuid, jsonb, numeric)', 'PLAYBACK_STARTED'),
      ('public.request_playback_stop(uuid)', 'PLAYBACK_STOPPED') LOOP
    IF position('''' || v_act || '''' IN (SELECT prosrc FROM pg_proc WHERE oid = v_fn::regprocedure)) = 0 THEN
      RAISE EXCEPTION '0193: % does not write %', v_fn, v_act;
    END IF;
  END LOOP;

  IF position('how you obtain' IN (SELECT prosrc FROM pg_proc
                                     WHERE oid = 'public.start_playback_job(uuid, uuid, jsonb, numeric)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION '0193: start_playback_job() still says a credential is issued to obtain the worker''s password';
  END IF;
  IF position('Archived Entities' IN (SELECT prosrc FROM pg_proc
                                        WHERE oid = 'public.ensure_shadow_devices(uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION '0193: ensure_shadow_devices() still sends an operator to restore the Playback gateway';
  END IF;
  IF position('''OFFLINE''' IN (SELECT prosrc FROM pg_proc
                                  WHERE oid = 'public.playback_finish(uuid, integer, text, integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0193: playback_finish() does not end the target''s session';
  END IF;

  IF public.live_trigger_statement('public.captures', 'trg_captures_audit_delete') IS NULL THEN
    RAISE EXCEPTION '0193: captures has no trg_captures_audit_delete';
  END IF;
  IF public.live_trigger_statement('public.gateways', 'trg_gateways_keep_playback_history') IS NULL THEN
    RAISE EXCEPTION '0193: gateways has no trg_gateways_keep_playback_history';
  END IF;

  IF has_function_privilege('anon', 'public.issue_capture_download(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0193: anon may call issue_capture_download()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.issue_capture_download(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0193: authenticated may not call issue_capture_download(), which the Capture page calls';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.audit_actor_source()',
                              'public.capture_subject_identity(text, uuid, uuid, text)',
                              'public.log_capture_deleted()',
                              'public.refuse_deleting_a_playback_gateway()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0193: an API role may call %, which only the capture gates and triggers use', v_fn;
    END IF;
  END LOOP;

  IF to_regnamespace('cron') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'purge_expired_archives'
         AND command LIKE '%p.target_gateway_id = g.id%') THEN
    RAISE EXCEPTION '0193: purge_expired_archives does not skip a gateway a playback names, so the '
      'delete guard would abort the whole job';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
