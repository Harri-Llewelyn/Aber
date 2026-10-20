-- 0195: A capture is downloaded only through the audited call.
--
-- Since 0193 the Capture page calls issue_capture_download(), which writes CAPTURE_DOWNLOAD_ISSUED,
-- and signs a link for the path it answers. The bucket did not require it: its read policy admitted
-- Administrator, Shopfloor_Manager and Auditor to every object in broker-captures, so any of them
-- could sign a link or fetch a capture through the Storage API with their own token, and nothing
-- was recorded.
--
--   * issue_capture_download() also records a grant in capture_downloads: the caller, the path,
--     the capture and when. It deletes the caller's grants that have closed at the same time.
--   * is_open_capture_download() answers whether the caller holds a grant for a path issued within
--     the last 60 seconds. The broker-captures read policy (storage-policies.sql, applied after the
--     migrations) admits a person to a stored capture's file by it alone, so signing a link or
--     reading the file is possible only in the minute after the call that records it.
--
-- Reasoning: supabase/README.md, "A capture is downloaded only through the audited call (0195)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The grants a download opens
-- -------------------------------------------------------------------------------------------------
-- One row per caller and path; a second download of the same file within the minute refreshes it.
-- A grant goes with its capture, so a deleted or replaced capture's grants close at once.
CREATE TABLE IF NOT EXISTS public.capture_downloads (
    created_by uuid NOT NULL,
    storage_path text NOT NULL,
    capture_id uuid NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capture_downloads_pkey PRIMARY KEY (created_by, storage_path),
    CONSTRAINT capture_downloads_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE CASCADE
);

ALTER TABLE public.capture_downloads OWNER TO postgres;
ALTER TABLE public.capture_downloads ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS capture_downloads_capture_id_idx ON public.capture_downloads USING btree (capture_id);

COMMENT ON TABLE public.capture_downloads IS
  'One row per capture download issued (0195): who issue_capture_download() answered, the path and '
  'the capture it named, and when. Open for 60 seconds; an open row is the only thing that admits a '
  'person to read a stored capture''s file in broker-captures. RLS on with no policy and nothing '
  'granted to an API role: written by issue_capture_download() and read by '
  'is_open_capture_download() alone.';
COMMENT ON COLUMN public.capture_downloads.issued_at IS
  'When the download was issued. The grant is open until 60 seconds after it; the caller''s next '
  'download deletes it once closed.';

-- Written and read by the two functions below alone.
REVOKE ALL ON TABLE public.capture_downloads FROM PUBLIC, anon, authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 2. Whether the caller may read a capture's file now
-- -------------------------------------------------------------------------------------------------
-- The broker-captures read policy calls this as the caller, so authenticated executes it. It
-- answers only for the caller's own grants.
CREATE OR REPLACE FUNCTION public.is_open_capture_download(p_name text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.capture_downloads d
         WHERE d.created_by = auth.uid()
           AND d.storage_path = p_name
           AND d.issued_at > now() - interval '60 seconds'
    );
END;
$$;

ALTER FUNCTION public.is_open_capture_download(p_name text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_open_capture_download(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.is_open_capture_download(text) TO authenticated;

COMMENT ON FUNCTION public.is_open_capture_download(p_name text) IS
  'True when issue_capture_download() answered this path to the caller within the last 60 seconds. '
  'The broker-captures read policy admits a person to a stored capture''s file by it, so nobody '
  'signs a link to a capture or reads one without a CAPTURE_DOWNLOAD_ISSUED row (0195).';

-- -------------------------------------------------------------------------------------------------
-- 3. A download opens the grant it records
-- -------------------------------------------------------------------------------------------------
-- 0193's, and it now records the grant beside the audit row. The page signs the link straight
-- after this answers.
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

    -- The caller's closed grants go first, so the table holds at most a minute of each person's.
    DELETE FROM public.capture_downloads d
     WHERE d.created_by = auth.uid()
       AND NOT public.is_open_capture_download(d.storage_path);
    INSERT INTO public.capture_downloads (created_by, storage_path, capture_id, issued_at)
    VALUES (auth.uid(), v_capture.storage_path, v_capture.id, now())
    ON CONFLICT (created_by, storage_path) DO UPDATE
       SET capture_id = EXCLUDED.capture_id, issued_at = EXCLUDED.issued_at;

    RETURN v_capture.storage_path;
END;
$$;

ALTER FUNCTION public.issue_capture_download(p_storage_path text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.issue_capture_download(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.issue_capture_download(text) TO authenticated;

COMMENT ON FUNCTION public.issue_capture_download(p_storage_path text) IS
  'Record that a stored capture''s file is being downloaded, as a CAPTURE_DOWNLOAD_ISSUED audit row, '
  'open a 60-second grant for the caller to read it (capture_downloads), and answer its path for '
  'the caller to sign a link for. The broker-captures bucket admits a person to a stored capture''s '
  'file only through that grant. Administrator, Shopfloor_Manager or Auditor; 404 when no capture '
  'row names the path (0193, 0195).';

-- -------------------------------------------------------------------------------------------------
-- Self-check: this file's own declarations
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_role text;
  v_src  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.capture_downloads'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '0195: capture_downloads does not have row-level security on';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'public.capture_downloads', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION '0195: % holds a privilege on capture_downloads, which only issue_capture_download() writes', v_role;
    END IF;
  END LOOP;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.issue_capture_download(text)'::regprocedure;
  IF position('''CAPTURE_DOWNLOAD_ISSUED''' IN v_src) = 0
     OR position('INSERT INTO public.capture_downloads' IN v_src) = 0 THEN
    RAISE EXCEPTION '0195: issue_capture_download() does not both write CAPTURE_DOWNLOAD_ISSUED and '
      'open the grant the bucket admits a download by';
  END IF;

  FOREACH v_src IN ARRAY ARRAY['public.issue_capture_download(text)', 'public.is_open_capture_download(text)'] LOOP
    IF has_function_privilege('anon', v_src, 'EXECUTE') THEN
      RAISE EXCEPTION '0195: anon may execute %', v_src;
    END IF;
    IF NOT has_function_privilege('authenticated', v_src, 'EXECUTE') THEN
      RAISE EXCEPTION '0195: authenticated may not execute %, which the Capture page or the '
        'broker-captures read policy calls', v_src;
    END IF;
  END LOOP;

  -- "May this caller" answers are plpgsql, so no plan folds the caller check away.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
              WHERE p.oid = 'public.is_open_capture_download(text)'::regprocedure
                AND (l.lanname <> 'plpgsql' OR NOT p.prosecdef)) THEN
    RAISE EXCEPTION '0195: is_open_capture_download() is not a SECURITY DEFINER plpgsql function';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
