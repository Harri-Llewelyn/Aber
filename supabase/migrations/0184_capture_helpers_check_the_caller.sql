-- 0184: The capture and playback helpers answer only a caller who could read the job.
--
-- is_active_capture_object(), is_active_playback_capture() and playback_stale_credentials() are
-- SECURITY DEFINER and executable by authenticated, and none of them looked at its caller. So an
-- Operator, who can read no row of capture_jobs, playback_jobs or playback_worker_status, could ask
-- which object is being recorded or replayed right now, and when playback credentials were issued.
--
-- The grants stay: the broker-captures storage policies call the two predicates as the caller, and
-- the ingestion daemon and the playback worker are authenticated principals. Each body now answers
-- false, or returns no rows, unless the caller could read the job row: its machine principal, a
-- role the tables' RLS admits, or a role RLS does not apply to. Each storage policy ANDs the
-- predicate with that same machine principal's check, so no policy's outcome changes. Signatures,
-- return types and grants are 0001's; the bodies move to plpgsql, as a "may this caller" answer must.

-- -------------------------------------------------------------------------------------------------
-- The capture the ingestion daemon is recording
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_active_capture_object(p_name text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    -- The daemon, capture_jobs' readers, or a role RLS does not apply to (service_role, the
    -- owner). `role` is the role PostgREST and storage-api set; a direct session leaves it 'none'.
    IF public.is_ingestion_caller()
       OR public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor'])
       OR (SELECT r.rolbypassrls FROM pg_catalog.pg_roles r
            WHERE r.rolname = coalesce(nullif(current_setting('role', true), 'none'), session_user))
    THEN
        RETURN EXISTS (
            SELECT 1 FROM public.capture_jobs j
             WHERE j.status = 'RECORDING' AND j.storage_path = p_name
        );
    END IF;
    RETURN false;
END;
$$;

ALTER FUNCTION public.is_active_capture_object(p_name text) OWNER TO postgres;

COMMENT ON FUNCTION public.is_active_capture_object(p_name text) IS 'True when a storage object path is the destination of a capture job that is RECORDING right now, asked by a caller who could read that job: the ingestion daemon, a role capture_jobs'' RLS admits, or one RLS does not apply to. False for anyone else (0184). Confines the ingestion daemon''s authority over broker-captures to the single file it is producing: with no capture in flight the daemon can reach nothing in the bucket at all.';

-- -------------------------------------------------------------------------------------------------
-- The capture the playback worker is publishing
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_active_playback_capture(p_name text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    -- The worker, playback_jobs' readers, or a role RLS does not apply to, as
    -- is_active_capture_object() decides it.
    IF public.is_playback_caller()
       OR public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor'])
       OR (SELECT r.rolbypassrls FROM pg_catalog.pg_roles r
            WHERE r.rolname = coalesce(nullif(current_setting('role', true), 'none'), session_user))
    THEN
        RETURN EXISTS (
            SELECT 1 FROM public.playback_jobs j
             WHERE j.status = 'RUNNING' AND j.capture_storage_path = p_name
        );
    END IF;
    RETURN false;
END;
$$;

ALTER FUNCTION public.is_active_playback_capture(p_name text) OWNER TO postgres;

COMMENT ON FUNCTION public.is_active_playback_capture(p_name text) IS 'True when a storage object is the capture of a playback job that is RUNNING right now, asked by a caller who could read that job: the playback worker, a role playback_jobs'' RLS admits, or one RLS does not apply to. False for anyone else (0184). Confines the playback worker''s read of broker-captures to the single file it is publishing: with no playback in flight the worker can reach nothing in the bucket at all.';

-- -------------------------------------------------------------------------------------------------
-- The credentials the playback worker holds that have been re-issued since
-- -------------------------------------------------------------------------------------------------
-- No rows for a caller playback_jobs' RLS refuses, as the table would show it none. The Start
-- Playback dialog and start_playback_job() both ask as an Administrator or Shopfloor_Manager.
CREATE OR REPLACE FUNCTION public.playback_stale_credentials() RETURNS TABLE(sparkplug_id text, observed_at timestamp with time zone, issued_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    -- playback_jobs' readers, or a role RLS does not apply to, as is_active_capture_object()
    -- decides it.
    IF public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor'])
       OR (SELECT r.rolbypassrls FROM pg_catalog.pg_roles r
            WHERE r.rolname = coalesce(nullif(current_setting('role', true), 'none'), session_user))
    THEN
        RETURN QUERY
        SELECT g.sparkplug_id,
               (w.credential_observed_at->>g.sparkplug_id)::timestamptz,
               i.last_issued
          FROM public.playback_worker_status w
          CROSS JOIN LATERAL unnest(w.held_edge_nodes) AS held(node)
          JOIN public.gateways g ON g.sparkplug_id = held.node
          -- The three predicates gateway_has_broker_credential() uses: the trail is partitioned
          -- with no index on (entity_id, action), and this runs over the held nodes alone.
          JOIN LATERAL (
                SELECT max(dt.recorded_at) AS last_issued
                  FROM public.audit_trail dt
                 WHERE dt.entity_type = 'gateways'
                   AND dt.entity_id   = g.id
                   AND dt.action      = 'CREDENTIAL_ISSUED'
               ) i ON true
         WHERE i.last_issued IS NOT NULL
           -- `<`, not IS DISTINCT FROM: a missing observation is unknown, and NULL < x is not true.
           AND (w.credential_observed_at->>g.sparkplug_id)::timestamptz < i.last_issued;
    END IF;
END;
$$;

ALTER FUNCTION public.playback_stale_credentials() OWNER TO postgres;

COMMENT ON FUNCTION public.playback_stale_credentials() IS 'The gateways the playback worker reports holding a credential for whose credential has been re-issued since the worker last observed it (#217) -- so it is holding the previous password and a playback onto it would fail at CONNACK. SECURITY DEFINER so the dialog needs no privilege on audit_trail; no rows for a caller playback_jobs'' RLS refuses (0184). A gateway with no observation is absent from this result, not stale: that is what a worker from the previous release reports.';

-- -------------------------------------------------------------------------------------------------
-- Self-check: each body asks about its caller before it answers.
-- -------------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_fn   text;
  v_lang text;
  v_src  text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.is_active_capture_object(text)',
                              'public.is_active_playback_capture(text)',
                              'public.playback_stale_credentials()'] LOOP
    SELECT l.lanname, p.prosrc INTO v_lang, v_src
      FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_fn::regprocedure;
    IF v_lang <> 'plpgsql' OR position('has_role' IN v_src) = 0 THEN
      RAISE EXCEPTION '0184: % answers without asking who is calling', v_fn;
    END IF;
  END LOOP;
END
$$;
