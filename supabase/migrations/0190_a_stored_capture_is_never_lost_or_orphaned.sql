-- 0190: A stored capture is never lost, never orphaned, and never taken on trust.
--
-- Until this file each subject had one object, `<subject>/capture.json`, and both ways of replacing
-- it wrote the object first and the row second. A re-recording whose finalise failed, or an upload
-- the replace check then refused, left the old row describing a new file. Deleting a subject
-- cascaded its row away and left the object in the bucket for ever.
--
--   * Every new capture goes to a path of its own: `<subject>/<job id>.json` for a recording,
--     `<subject>/<upload id>.json` for an upload. The row is repointed in one transaction, and only
--     then is the object it replaced deleted. Rows written before keep `<subject>/capture.json`.
--   * An upload starts with begin_capture_upload(), which decides `replace` and refuses a subject
--     being recorded before anything is written, and issues the path. The bucket admits a person's
--     write only to a path issued to them and still open (storage-policies.sql).
--   * register_uploaded_capture() reads the object's real size from storage.objects, bounds the
--     message count by it, caps the manifest, and refuses a capture whose replacement changed.
--   * An object no row, running job, open upload or running playback claims is unclaimed. People
--     and the ingestion daemon may delete only unclaimed objects; the daemon deletes the one a
--     finalise replaced, and sweeps the rest after an hour. Bytes leave the bucket only through the
--     Storage API: a DELETE on storage.objects in SQL leaves them in the backend.
--   * The capture gates refuse the Playback gateway and its replay lanes as subjects.
--   * ingest_report_capture_progress() tells the daemon whether to go on, stop, or drop a job that
--     ended elsewhere or whose subject was deleted; ingest_capture_progress() stays for a daemon of
--     the previous release. request_capture_stop() ends a recording whose progress went stale.
--
-- Reasoning: supabase/README.md, "A stored capture is never lost or orphaned (0190)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Uploads begun and not yet registered
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.capture_uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_kind text NOT NULL,
    gateway_id uuid,
    device_id uuid,
    subject_sparkplug_id text NOT NULL,
    storage_path text NOT NULL,
    replaces_capture_id uuid,
    capture_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT capture_uploads_pkey PRIMARY KEY (id),
    CONSTRAINT capture_uploads_storage_path_key UNIQUE (storage_path),
    CONSTRAINT capture_uploads_subject_kind_valid CHECK (subject_kind = ANY (ARRAY['gateway'::text, 'device'::text])),
    CONSTRAINT capture_uploads_subject_is_coherent CHECK (
        (subject_kind = 'gateway' AND gateway_id IS NOT NULL AND device_id IS NULL)
     OR (subject_kind = 'device' AND device_id IS NOT NULL)),
    CONSTRAINT capture_uploads_gateway_id_fkey FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE,
    CONSTRAINT capture_uploads_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE,
    CONSTRAINT capture_uploads_replaces_capture_id_fkey FOREIGN KEY (replaces_capture_id) REFERENCES public.captures(id) ON DELETE SET NULL,
    CONSTRAINT capture_uploads_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE SET NULL
);

ALTER TABLE public.capture_uploads OWNER TO postgres;
ALTER TABLE public.capture_uploads ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS capture_uploads_gateway_id_idx ON public.capture_uploads USING btree (gateway_id);
CREATE INDEX IF NOT EXISTS capture_uploads_device_id_idx ON public.capture_uploads USING btree (device_id);

COMMENT ON TABLE public.capture_uploads IS
  'One row per capture upload begun (0190): the path begin_capture_upload() issued, the capture it '
  'may replace, and who began it. Open for an hour, until registered or superseded by a later upload '
  'of the same subject; an open row is the only thing that admits a person''s write to '
  'broker-captures. RLS on with no policy and nothing granted to an API role: written and read '
  'through the capture gates alone.';
COMMENT ON COLUMN public.capture_uploads.replaces_capture_id IS
  'The capture stored for the subject when the upload began. register_uploaded_capture() refuses if '
  'the stored capture is another by then.';
COMMENT ON COLUMN public.capture_uploads.closed_at IS
  'When the upload was registered (capture_id set) or superseded. NULL while open.';

-- Written and read by the gates alone.
REVOKE ALL ON TABLE public.capture_uploads FROM PUBLIC, anon, authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 2. Which objects a path names, and who may write or delete one
-- -------------------------------------------------------------------------------------------------
-- An upload path still open for writing: issued to this caller within the hour, not registered or
-- superseded. The broker-captures INSERT and UPDATE policies admit a person's write by it.
CREATE OR REPLACE FUNCTION public.is_open_capture_upload(p_name text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.capture_uploads u
         WHERE u.storage_path = p_name
           AND u.closed_at IS NULL
           AND u.created_at > now() - interval '1 hour'
           AND u.created_by = auth.uid()
    );
END;
$$;

ALTER FUNCTION public.is_open_capture_upload(p_name text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_open_capture_upload(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.is_open_capture_upload(text) TO authenticated;

COMMENT ON FUNCTION public.is_open_capture_upload(p_name text) IS
  'True when begin_capture_upload() issued this path to the caller within the hour and it is not yet '
  'registered or superseded. The broker-captures write policies admit a person''s upload by it, so '
  'nobody writes a path the capture gates did not issue them (0190).';

-- Nothing claims the object: no capture row, no recording in flight, no upload open within the
-- last two hours (an hour past its own window, so a register in flight is never undercut), and no
-- playback queued or running from it. Answered only to a caller who could read those rows.
CREATE OR REPLACE FUNCTION public.is_unclaimed_capture_object(p_name text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    IF NOT (public.is_ingestion_caller()
            OR public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor'])
            OR (SELECT r.rolbypassrls FROM pg_catalog.pg_roles r
                 WHERE r.rolname = coalesce(nullif(current_setting('role', true), 'none'), session_user)))
    THEN
        RETURN false;
    END IF;

    RETURN NOT EXISTS (SELECT 1 FROM public.captures c WHERE c.storage_path = p_name)
       AND NOT EXISTS (SELECT 1 FROM public.capture_jobs j
                        WHERE j.storage_path = p_name AND j.status IN ('PENDING', 'RECORDING'))
       AND NOT EXISTS (SELECT 1 FROM public.capture_uploads u
                        WHERE u.storage_path = p_name AND u.closed_at IS NULL
                          AND u.created_at > now() - interval '2 hours')
       AND NOT EXISTS (SELECT 1 FROM public.playback_jobs p
                        WHERE p.capture_storage_path = p_name AND p.status IN ('PENDING', 'RUNNING'));
END;
$$;

ALTER FUNCTION public.is_unclaimed_capture_object(p_name text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_unclaimed_capture_object(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.is_unclaimed_capture_object(text) TO authenticated;

COMMENT ON FUNCTION public.is_unclaimed_capture_object(p_name text) IS
  'True when no capture row, no PENDING or RECORDING capture job, no upload open within two hours and '
  'no PENDING or RUNNING playback names this broker-captures path, asked by a caller who could read '
  'those rows (the ingestion daemon, Administrator, Shopfloor_Manager, Auditor, or a role RLS does '
  'not apply to); false for anyone else. The bucket''s DELETE policy admits only such an object, so '
  'a stored capture''s file cannot be deleted while its row stands (0190).';

-- The size storage-api recorded for an object, or NULL when there is none. storage.objects is
-- storage-api's, created by its own migrations, so it is reached by name at run time.
CREATE OR REPLACE FUNCTION public.capture_object_size(p_name text) RETURNS bigint
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_size bigint;
BEGIN
    IF to_regclass('storage.objects') IS NULL THEN
        RETURN NULL;
    END IF;
    EXECUTE 'SELECT coalesce((o.metadata ->> ''size'')::bigint, 0) FROM storage.objects o '
            'WHERE o.bucket_id = ''broker-captures'' AND o.name = $1'
       INTO v_size USING p_name;
    RETURN v_size;
END;
$$;

ALTER FUNCTION public.capture_object_size(p_name text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.capture_object_size(text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.capture_object_size(p_name text) IS
  'The size storage-api recorded for a broker-captures object, or NULL when there is no such object. '
  'Called by register_uploaded_capture() so the size it records is the object''s, not the browser''s '
  '(0190). No API role may call it.';

-- The unclaimed objects the daemon may delete through the Storage API: under one subject's folder
-- right after a finalise, or anywhere once untouched for p_min_age_seconds.
CREATE OR REPLACE FUNCTION public.ingest_unclaimed_capture_objects(p_subject text DEFAULT NULL::text, p_min_age_seconds integer DEFAULT 3600) RETURNS text[]
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_names text[];
BEGIN
    PERFORM public.require_ingestion_caller('ingest_unclaimed_capture_objects');

    IF to_regclass('storage.objects') IS NULL THEN
        RETURN '{}'::text[];
    END IF;
    EXECUTE 'SELECT coalesce(array_agg(n.name ORDER BY n.name), ''{}''::text[]) FROM ('
            '  SELECT o.name FROM storage.objects o'
            '   WHERE o.bucket_id = ''broker-captures'''
            '     AND ($1::text IS NULL OR split_part(o.name, ''/'', 1) = $1)'
            '     AND coalesce(o.updated_at, o.created_at) <= now() - make_interval(secs => greatest($2, 0))'
            '     AND public.is_unclaimed_capture_object(o.name)'
            '   ORDER BY o.name LIMIT 500) n'
       INTO v_names USING p_subject, p_min_age_seconds;
    RETURN v_names;
END;
$$;

ALTER FUNCTION public.ingest_unclaimed_capture_objects(p_subject text, p_min_age_seconds integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ingest_unclaimed_capture_objects(text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ingest_unclaimed_capture_objects(text, integer) TO authenticated;

COMMENT ON FUNCTION public.ingest_unclaimed_capture_objects(p_subject text, p_min_age_seconds integer) IS
  'Up to 500 broker-captures objects nothing claims (is_unclaimed_capture_object), under one subject''s '
  'folder when p_subject is given, untouched for at least p_min_age_seconds. The ingestion daemon '
  'deletes them through the Storage API: the object a finalise replaced, at once, and every other '
  'once an hour has passed, which also clears what deleted subjects left before 0190. Ingestion '
  'principal only.';

-- -------------------------------------------------------------------------------------------------
-- 3. An upload begins on the server
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.begin_capture_upload(p_subject_kind text, p_subject_id uuid, p_replace boolean DEFAULT false, p_expected_capture_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_gateway_id  uuid;
    v_device_id   uuid;
    v_sparkplug   text;
    v_archived    boolean;
    v_shadow      boolean;
    v_existing    public.captures;
    v_upload_id   uuid := gen_random_uuid();
    v_path        text;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION 'begin_capture_upload: requires Administrator or Shopfloor_Manager'
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
        RAISE EXCEPTION 'begin_capture_upload: p_subject_kind must be ''gateway'' or ''device'''
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_sparkplug IS NULL THEN
        RAISE EXCEPTION 'begin_capture_upload: no % %', p_subject_kind, p_subject_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_archived THEN
        RAISE EXCEPTION 'begin_capture_upload: % % is archived. Restore it before storing a capture of it.',
            p_subject_kind, v_sparkplug
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_shadow THEN
        RAISE EXCEPTION 'begin_capture_upload: % is the Playback gateway or one of its replay lanes, '
          'which publish only replays. File the capture against the gateway or device it was '
          'recorded from.', v_sparkplug
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- A recording's finish replaces the stored capture, so it would replace this upload unasked.
    IF EXISTS (
        SELECT 1 FROM public.capture_jobs j
         WHERE j.status IN ('PENDING', 'RECORDING')
           AND ((p_subject_kind = 'gateway' AND j.subject_kind = 'gateway' AND j.gateway_id = v_gateway_id)
             OR (p_subject_kind = 'device'  AND j.subject_kind = 'device'  AND j.device_id  = v_device_id))
    ) THEN
        RAISE EXCEPTION 'begin_capture_upload: % is being recorded right now. Upload when the recording '
          'has finished, or stop it first.', v_sparkplug
            USING ERRCODE = 'unique_violation';
    END IF;

    SELECT * INTO v_existing FROM public.captures c
     WHERE (p_subject_kind = 'gateway' AND c.subject_kind = 'gateway' AND c.gateway_id = v_gateway_id)
        OR (p_subject_kind = 'device'  AND c.subject_kind = 'device'  AND c.device_id  = v_device_id);

    IF FOUND AND NOT coalesce(p_replace, false) THEN
        RAISE EXCEPTION
          'begin_capture_upload: a capture of this subject already exists (recorded %). Uploading '
          'replaces it. Call with p_replace := true to confirm.',
          to_char(v_existing.recorded_at, 'DD Mon YYYY HH24:MI') || coalesce(' -- ' || v_existing.note, '')
            USING ERRCODE = 'unique_violation';
    END IF;
    IF FOUND AND p_expected_capture_id IS NOT NULL AND p_expected_capture_id <> v_existing.id THEN
        RAISE EXCEPTION
          'begin_capture_upload: the stored capture of this subject changed after you chose to replace '
          'it. It is now the one recorded %. Look at it before replacing it.',
          to_char(v_existing.recorded_at, 'DD Mon YYYY HH24:MI') || coalesce(' -- ' || v_existing.note, '')
            USING ERRCODE = 'unique_violation';
    END IF;

    -- One open upload per subject: a later one supersedes it, and its object becomes unclaimed.
    UPDATE public.capture_uploads u SET closed_at = now()
     WHERE u.closed_at IS NULL
       AND ((p_subject_kind = 'gateway' AND u.subject_kind = 'gateway' AND u.gateway_id = v_gateway_id)
         OR (p_subject_kind = 'device'  AND u.subject_kind = 'device'  AND u.device_id  = v_device_id));
    DELETE FROM public.capture_uploads u WHERE u.created_at < now() - interval '7 days';

    v_path := v_sparkplug || '/' || v_upload_id || '.json';
    INSERT INTO public.capture_uploads (
        id, subject_kind, gateway_id, device_id, subject_sparkplug_id, storage_path,
        replaces_capture_id, created_by
    ) VALUES (
        v_upload_id, p_subject_kind,
        CASE WHEN p_subject_kind = 'gateway' THEN v_gateway_id END, v_device_id,
        v_sparkplug, v_path, v_existing.id, auth.uid()
    );

    RETURN jsonb_build_object(
        'upload_id', v_upload_id,
        'storage_path', v_path,
        'replaces_capture_id', v_existing.id,
        'replaces_storage_path', v_existing.storage_path
    );
END;
$$;

ALTER FUNCTION public.begin_capture_upload(p_subject_kind text, p_subject_id uuid, p_replace boolean, p_expected_capture_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.begin_capture_upload(text, uuid, boolean, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.begin_capture_upload(text, uuid, boolean, uuid) TO authenticated;

COMMENT ON FUNCTION public.begin_capture_upload(p_subject_kind text, p_subject_id uuid, p_replace boolean, p_expected_capture_id uuid) IS
  'Begin uploading a capture of one gateway or device, before any byte is written: refuses without '
  'Administrator or Shopfloor_Manager, an archived subject, the Playback gateway and its lanes, a '
  'subject being recorded, and replacing a stored capture unless p_replace is true (and, given '
  'p_expected_capture_id, unless the stored capture is still that one). Issues '
  '<subject>/<upload id>.json, open to this caller for an hour, and returns it with the capture it '
  'replaces and that capture''s path, which the caller deletes once register_uploaded_capture() has '
  'succeeded (0190).';

-- -------------------------------------------------------------------------------------------------
-- 4. Registering an upload checks it against the object and the subject
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
    -- A repeated call after a lost answer gets the capture it made.
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
    -- this commits, or by the ingestion daemon's sweep.
    DELETE FROM public.captures c
     WHERE (p_subject_kind = 'gateway' AND c.subject_kind = 'gateway' AND c.gateway_id = v_gateway_id)
        OR (p_subject_kind = 'device'  AND c.subject_kind = 'device'  AND c.device_id  = v_device_id);

    INSERT INTO public.captures (
        subject_kind, gateway_id, device_id, subject_sparkplug_id, storage_path,
        size_bytes, message_count, note, manifest, source, created_by
    ) VALUES (
        p_subject_kind, v_gateway_id, v_device_id, v_sparkplug, p_storage_path,
        v_size, p_message_count,
        nullif(btrim(coalesce(p_note, '')), ''),
        v_manifest, 'uploaded', auth.uid()
    )
    RETURNING id INTO v_capture_id;

    UPDATE public.capture_uploads SET closed_at = now(), capture_id = v_capture_id WHERE id = v_upload.id;

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
  'then deletes the replaced object (0190).';

-- -------------------------------------------------------------------------------------------------
-- 5. A recording gets a path of its own, and the Playback gateway is not a subject
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
        'PENDING', nullif(btrim(coalesce(p_note, '')), ''),
        least(greatest(coalesce(p_max_seconds, 300), 5), 7200),
        auth.uid()
    );

    RETURN v_job_id;
END;
$$;

ALTER FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) OWNER TO postgres;

COMMENT ON FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) IS
  'Queue a broker capture of one gateway or one device, recorded to <subject>/<job id>.json. The only '
  'way a capture_jobs row is created. Refuses without Administrator or Shopfloor_Manager, an archived '
  'subject, the Playback gateway and its replay lanes (0190), a second concurrent capture, and '
  'replacing a stored capture unless p_replace is true.';

-- -------------------------------------------------------------------------------------------------
-- 6. Finalise repoints the row, and a repeated call is answered
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb DEFAULT '{}'::jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job        public.capture_jobs;
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
    -- deleted by the daemon only after this commits.
    DELETE FROM public.captures c
     WHERE (v_job.subject_kind = 'gateway' AND c.subject_kind = 'gateway' AND c.gateway_id = v_job.gateway_id)
        OR (v_job.subject_kind = 'device'  AND c.subject_kind = 'device'  AND c.device_id  = v_job.device_id);

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

    RETURN v_capture_id;
END;
$$;

ALTER FUNCTION public.ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb) OWNER TO postgres;

-- -------------------------------------------------------------------------------------------------
-- 7. Progress says whether the job is still there
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_report_capture_progress(p_job_id uuid, p_messages bigint, p_bytes bigint, p_elapsed_seconds integer, p_birth_captured boolean DEFAULT false) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_stop boolean;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_report_capture_progress');

    UPDATE public.capture_jobs
       SET messages        = greatest(coalesce(p_messages, 0), 0),
           bytes           = greatest(coalesce(p_bytes, 0), 0),
           elapsed_seconds = greatest(coalesce(p_elapsed_seconds, 0), 0),
           -- Once true, always true: a birth arrives once, near the start.
           birth_captured  = capture_jobs.birth_captured OR coalesce(p_birth_captured, false)
     WHERE id = p_job_id AND status = 'RECORDING'
    RETURNING stop_requested INTO v_stop;

    IF FOUND THEN
        RETURN CASE WHEN v_stop THEN 'stop' ELSE 'continue' END;
    END IF;
    IF EXISTS (SELECT 1 FROM public.capture_jobs WHERE id = p_job_id) THEN
        RETURN 'ended';
    END IF;
    RETURN 'gone';
END;
$$;

ALTER FUNCTION public.ingest_report_capture_progress(p_job_id uuid, p_messages bigint, p_bytes bigint, p_elapsed_seconds integer, p_birth_captured boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ingest_report_capture_progress(uuid, bigint, bigint, integer, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ingest_report_capture_progress(uuid, bigint, bigint, integer, boolean) TO authenticated;

COMMENT ON FUNCTION public.ingest_report_capture_progress(p_job_id uuid, p_messages bigint, p_bytes bigint, p_elapsed_seconds integer, p_birth_captured boolean) IS
  'The ingestion daemon''s progress report for a RECORDING capture job. Answers continue, stop (an '
  'operator asked), ended (the job is no longer RECORDING: cancelled or swept) or gone (no such job: '
  'its subject was deleted). ingest_capture_progress() answers true for the last three alike and '
  'stays for a daemon of the previous release (0190). Ingestion principal only.';

-- -------------------------------------------------------------------------------------------------
-- 8. Stop ends a recording whose progress went stale
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_capture_stop(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    c_stale_seconds CONSTANT integer := 120;
    v_job    public.capture_jobs;
    v_silent integer;
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

    -- A job the daemon never claimed is cancelled outright, so a daemon that is down cannot leave
    -- it blocking every capture.
    IF v_job.status = 'PENDING' THEN
        UPDATE public.capture_jobs
           SET status = 'CANCELLED', stop_requested = true, finished_at = now(),
               error = 'cancelled before the daemon claimed it'
         WHERE id = p_job_id;
        RETURN true;
    END IF;

    -- The daemon reports elapsed_seconds every second while recording, so started_at plus it is
    -- when it last reported. Silent this long, the daemon is not going to settle the job itself.
    v_silent := floor(extract(epoch FROM now()
                  - (coalesce(v_job.started_at, v_job.created_at) + make_interval(secs => v_job.elapsed_seconds))));
    IF v_silent > c_stale_seconds THEN
        UPDATE public.capture_jobs
           SET status = 'CANCELLED', stop_requested = true, finished_at = now(),
               error = format('stopped from the page after the ingestion daemon had not reported on '
                              'this recording for %s seconds. Nothing from it was stored, and any '
                              'earlier capture of the subject is unchanged.', v_silent)
         WHERE id = p_job_id;
        RETURN true;
    END IF;

    UPDATE public.capture_jobs SET stop_requested = true WHERE id = p_job_id;
    RETURN true;
END;
$$;

ALTER FUNCTION public.request_capture_stop(p_job_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.request_capture_stop(p_job_id uuid) IS
  'Stop a capture. A PENDING job is cancelled outright; a RECORDING one is flagged for the daemon to '
  'finish on its next progress tick, or, when the daemon has not reported on it for two minutes, '
  'cancelled here with nothing stored (0190). False for a job already finished. Administrator or '
  'Shopfloor_Manager.';

-- -------------------------------------------------------------------------------------------------
-- 9. A swept job says whether it ever started
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_reconcile_capture_jobs() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_n integer;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_reconcile_capture_jobs');

    -- PENDING too: a job queued while the daemon was down would otherwise record from an arbitrary
    -- later moment.
    WITH swept AS (
        UPDATE public.capture_jobs
           SET status = 'FAILED', finished_at = now(),
               error = CASE WHEN status = 'PENDING'
                            THEN 'the job never started: the ingestion daemon restarted before it '
                                 'began recording, so nothing was recorded'
                            ELSE 'the ingestion daemon restarted while this job was recording; the '
                                 'recording did not survive'
                       END
         WHERE status IN ('PENDING', 'RECORDING')
        RETURNING 1
    )
    SELECT count(*) INTO v_n FROM swept;

    RETURN v_n;
END;
$$;

ALTER FUNCTION public.ingest_reconcile_capture_jobs() OWNER TO postgres;

-- -------------------------------------------------------------------------------------------------
-- 10. ensure_shadow_devices() says why a capture has nothing to replay
-- -------------------------------------------------------------------------------------------------
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
          'ensure_shadow_devices: this stack has no playback gateway. The platform seeds one; if it '
          'was archived, restore it from Archived Entities. No other gateway can be made one.');
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
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_role text;
  v_fn   text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.capture_uploads'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '0190: capture_uploads does not have row-level security on';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'public.capture_uploads', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION '0190: % holds a privilege on capture_uploads, which only the capture gates touch', v_role;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
      'public.begin_capture_upload(text, uuid, boolean, uuid)',
      'public.is_open_capture_upload(text)',
      'public.is_unclaimed_capture_object(text)',
      'public.ingest_unclaimed_capture_objects(text, integer)',
      'public.ingest_report_capture_progress(uuid, bigint, bigint, integer, boolean)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0190: anon may execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0190: authenticated may not execute %, which a capture gate or storage policy calls', v_fn;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, 'public.capture_object_size(text)', 'EXECUTE') THEN
      RAISE EXCEPTION '0190: % may execute capture_object_size(), which only the gates call', v_role;
    END IF;
  END LOOP;

  -- "May this caller" answers are plpgsql, so no plan folds the caller check away.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
              WHERE p.oid IN ('public.is_open_capture_upload(text)'::regprocedure,
                              'public.is_unclaimed_capture_object(text)'::regprocedure)
                AND l.lanname <> 'plpgsql') THEN
    RAISE EXCEPTION '0190: a broker-captures predicate is not plpgsql';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
