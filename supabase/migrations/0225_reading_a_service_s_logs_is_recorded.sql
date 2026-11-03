-- 0225: Reading a service's logs is recorded in the Audit Trail.
--
-- The System page's Logs tab reads a service's recent lines from the log store through the
-- service-logs function, Administrator only. The lines carry failed sign-ins, addresses and emails,
-- so a read is recorded: record_service_logs_read() writes one SERVICE_LOGS_READ row naming the
-- Administrator and the read's service, level, text filter and range, as the function was asked
-- for them.
--
-- The function decides when a row is due, never the caller: one is written when the parameters
-- differ from those of the caller's last recorded read, so a refresh or a poll writes nothing and
-- a direct API call with new parameters still does. The last read is looked for among the caller's
-- rows of the last 24 hours, in the security lane, which the partitions and idx_audit_trail_domain
-- keep to a small read; a read repeated a day after its row writes another.
--
-- The entity type is `service_logs`, which audit_domain_for() files in the security lane, as it
-- files every type it does not name: an Administrator and an Auditor read the rows. The entity id
-- is derived from the service's name, so every read of one service is one lane. No CHECK lists the
-- actions or the entity types, so none is changed.
--
-- Reasoning: supabase/README.md, "Reading a service's logs is recorded (0225)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Recording a read
-- -------------------------------------------------------------------------------------------------
-- The levels and ranges are service-logs' (logs.ts), and the filter's limit too; mirror check 40
-- holds the three lists together with the dashboard's.
CREATE OR REPLACE FUNCTION public.record_service_logs_read(p_service text, p_level text, p_filter text,
                                                           p_range text)
RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_read jsonb;
  v_last jsonb;
  v_id   bigint;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to record a read of the service logs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_service IS NULL OR char_length(p_service) NOT BETWEEN 1 AND 128 OR p_service ~ '[\x01-\x1f\x7f]' THEN
    RAISE EXCEPTION 'a service is named in 1-128 characters on one line'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_level IS NULL OR NOT p_level = ANY (ARRAY['any', 'error', 'warning', 'info', 'debug']) THEN
    RAISE EXCEPTION 'the level is any, error, warning, info or debug, not %', coalesce(quote_literal(p_level), 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_range IS NULL OR NOT p_range = ANY (ARRAY['15m', '1h', '6h', '24h', '7d']) THEN
    RAISE EXCEPTION 'the range is 15m, 1h, 6h, 24h or 7d, not %', coalesce(quote_literal(p_range), 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF char_length(coalesce(p_filter, '')) > 200 THEN
    RAISE EXCEPTION 'the filter is at most 200 characters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- `name` is the service, so the Audit Trail names the lane as it names every other.
  v_read := jsonb_build_object('name', p_service, 'level', p_level, 'filter', nullif(p_filter, ''),
                               'range', p_range);

  -- One read at a time per person, so two identical requests that arrive together write one row.
  PERFORM pg_advisory_xact_lock(hashtextextended('record_service_logs_read:' || v_uid::text, 0));

  SELECT a.new_data INTO v_last
    FROM public.audit_trail a
   WHERE a.audit_domain = 'security'
     AND a.recorded_at > now() - interval '24 hours'
     AND a.entity_type = 'service_logs'
     AND a.action = 'SERVICE_LOGS_READ'
     AND a.changed_by = v_uid
   ORDER BY a.recorded_at DESC, a.id DESC
   LIMIT 1;

  IF v_last = v_read THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.audit_trail (
      entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
      causation_id, recorded_at
  ) VALUES (
      'service_logs', md5('service_logs:' || p_service)::uuid, 'SERVICE_LOGS_READ', NULL, v_read,
      v_uid, public.audit_actor_source(), txid_current(), now()
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

ALTER FUNCTION public.record_service_logs_read(p_service text, p_level text, p_filter text, p_range text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_service_logs_read(text, text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_service_logs_read(text, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.record_service_logs_read(p_service text, p_level text, p_filter text, p_range text) IS
  'Administrator only. Records that the service-logs function read a service''s log lines: one '
  'SERVICE_LOGS_READ row in the service_logs lane of the security domain, with the service (as '
  'name), the level, the text filter and the range key, and the Administrator in changed_by. '
  'Writes nothing and returns NULL when those are the caller''s last recorded read of the last 24 '
  'hours, so a refresh is not recorded twice; otherwise returns the row''s id. Refuses a level, a '
  'range, a service name or a filter outside the function''s rule (22023). The entity id is the '
  'md5 of service_logs: and the service, one lane per service (0225).';

COMMENT ON FUNCTION public.audit_actor_source() IS
  'The actor_source a function writing its own audit_trail row records: user for a person, '
  'ingestion for the ingestion principal, service for any other machine identity, migration for '
  'the owner''s session with no token. log_audit_trail_event()''s ladder without the X-Aber-Actor '
  'header (0193). Called by the capture and playback gates, by log_display_name_change() (0203), '
  'by end_person_sessions() and record_person_email_change() (0207), by end_my_session() and '
  'end_my_other_sessions() (0211), by end_person_session() (0212), by '
  'record_broker_account_created() and record_broker_account_deleted() (0218), and by '
  'record_service_logs_read() (0225).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  f      text := 'public.record_service_logs_read(text, text, text, text)';
  v_role text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f::regprocedure
                  AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0225: % is not SECURITY DEFINER with its search_path pinned', f;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(v_role, f, 'EXECUTE') THEN
      RAISE EXCEPTION '0225: % may execute %', v_role, f;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION '0225: authenticated may not execute %; the service-logs function calls it', f;
  END IF;

  -- The lane: readable by an Administrator and an Auditor, never by a Shopfloor_Manager.
  IF public.audit_domain_for('service_logs', 'SERVICE_LOGS_READ') <> 'security' THEN
    RAISE EXCEPTION '0225: audit_domain_for() files service_logs in the % lane; it must be security',
      public.audit_domain_for('service_logs', 'SERVICE_LOGS_READ');
  END IF;

  -- A request with no person behind it is refused before anything is written.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.record_service_logs_read('ingestion', 'any', '', '1h');
    RAISE EXCEPTION '0225: record_service_logs_read() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$check$;
