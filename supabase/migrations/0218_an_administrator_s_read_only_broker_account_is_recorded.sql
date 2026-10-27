-- 0218: An Administrator's read-only broker account is recorded in the Audit Trail.
--
-- Access Control › Broker accounts creates an account holding the broker's `subscriber` role, and
-- deletes one, through the broker-subscriber function and the credential service. The broker holds
-- the account and what it is for, in the plugin's textname and textdescription; nothing here
-- stores either. These two functions write the record of each act, attributed to the
-- Administrator:
--
--   * record_broker_account_created() writes one INSERT row once the broker has made the account:
--     its name, description, MQTT username and role.
--   * record_broker_account_deleted() writes one DELETE row once the broker has deleted it: the
--     name and description the broker held, and the MQTT username.
--
-- Both are Administrator only and refuse a username outside the subscriber scheme ("sub" and 21
-- lowercase hex characters); creation holds the name (1-80 characters) and description (1-500)
-- to the rule the credential service holds them to. The entity type is `broker_accounts`, which
-- audit_domain_for() files in the security lane, as it files every type it does not name. The
-- entity id is the username's 21 hex characters padded with zeros, so both rows of one account
-- share it. No CHECK lists the actions or the entity types, so none is changed.
--
-- Reasoning: supabase/README.md, "An Administrator's read-only broker account is recorded (0218)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Creating one
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_broker_account_created(p_username text, p_name text, p_description text)
RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_name        text := btrim(coalesce(p_name, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_id          bigint;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to record a read-only broker account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_username IS NULL OR p_username !~ '^sub[0-9a-f]{21}$' THEN
    RAISE EXCEPTION '% is not a read-only broker account ("sub" and 21 lowercase hex characters)',
      coalesce(quote_literal(p_username), 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 80 OR v_name ~ '[\x01-\x1f\x7f]' THEN
    RAISE EXCEPTION 'the account''s name must be 1-80 characters on one line'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF char_length(v_description) NOT BETWEEN 1 AND 500 OR v_description ~ '[\x01-\x1f\x7f]' THEN
    RAISE EXCEPTION 'the account''s description must be 1-500 characters on one line'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.audit_trail (
      entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
      causation_id, recorded_at
  ) VALUES (
      'broker_accounts', rpad(substr(p_username, 4), 32, '0')::uuid, 'INSERT', NULL,
      jsonb_build_object('name', v_name, 'description', v_description,
                         'mqtt_username', p_username, 'role', 'subscriber'),
      auth.uid(), public.audit_actor_source(), txid_current(), now()
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

ALTER FUNCTION public.record_broker_account_created(p_username text, p_name text, p_description text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_broker_account_created(text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_broker_account_created(text, text, text) TO authenticated;

COMMENT ON FUNCTION public.record_broker_account_created(p_username text, p_name text, p_description text) IS
  'Administrator only. Records that the broker-subscriber function made a read-only broker account '
  '(the subscriber role alone): one INSERT row in the broker_accounts lane of the security domain, '
  'with the name, description, MQTT username and role, and the Administrator in changed_by. Never '
  'a password. Refuses a username outside the subscriber scheme (sub and 21 lowercase hex '
  'characters), and a name or description that is empty, longer than 80 or 500 characters, or not '
  'on one line (22023). The entity id is the username''s hex padded with zeros (0218).';

-- -------------------------------------------------------------------------------------------------
-- 2. Deleting one
-- -------------------------------------------------------------------------------------------------
-- The name and description are what the broker held at the delete, NULL where it held none: an
-- account in the scheme may have been made by hand without them.
CREATE OR REPLACE FUNCTION public.record_broker_account_deleted(p_username text, p_name text DEFAULT NULL,
                                                               p_description text DEFAULT NULL)
RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_id bigint;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to record a read-only broker account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_username IS NULL OR p_username !~ '^sub[0-9a-f]{21}$' THEN
    RAISE EXCEPTION '% is not a read-only broker account ("sub" and 21 lowercase hex characters)',
      coalesce(quote_literal(p_username), 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.audit_trail (
      entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
      causation_id, recorded_at
  ) VALUES (
      'broker_accounts', rpad(substr(p_username, 4), 32, '0')::uuid, 'DELETE',
      jsonb_build_object('name', nullif(btrim(p_name), ''), 'description', nullif(btrim(p_description), ''),
                         'mqtt_username', p_username),
      NULL,
      auth.uid(), public.audit_actor_source(), txid_current(), now()
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

ALTER FUNCTION public.record_broker_account_deleted(p_username text, p_name text, p_description text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_broker_account_deleted(text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_broker_account_deleted(text, text, text) TO authenticated;

COMMENT ON FUNCTION public.record_broker_account_deleted(p_username text, p_name text, p_description text) IS
  'Administrator only. Records that the broker-subscriber function deleted a read-only broker '
  'account: one DELETE row in the broker_accounts lane of the security domain, with the name and '
  'description the broker held (NULL where it held none) and the MQTT username, and the '
  'Administrator in changed_by. Refuses a username outside the subscriber scheme (22023). The '
  'entity id is the one record_broker_account_created() wrote for that username (0218).';

COMMENT ON FUNCTION public.audit_actor_source() IS
  'The actor_source a function writing its own audit_trail row records: user for a person, '
  'ingestion for the ingestion principal, service for any other machine identity, migration for '
  'the owner''s session with no token. log_audit_trail_event()''s ladder without the X-Aber-Actor '
  'header (0193). Called by the capture and playback gates, by log_display_name_change() (0203), '
  'by end_person_sessions() and record_person_email_change() (0207), by end_my_session() and '
  'end_my_other_sessions() (0211), by end_person_session() (0212), and by '
  'record_broker_account_created() and record_broker_account_deleted() (0218).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_role text;
  f      text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.record_broker_account_created(text, text, text)',
                           'public.record_broker_account_deleted(text, text, text)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f::regprocedure
                    AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0218: % is not SECURITY DEFINER with its search_path pinned', f;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
      IF has_function_privilege(v_role, f, 'EXECUTE') THEN
        RAISE EXCEPTION '0218: % may execute %', v_role, f;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0218: authenticated may not execute %; the broker-subscriber function calls it', f;
    END IF;
  END LOOP;

  -- The lane: readable by an Administrator and an Auditor, never by a Shopfloor_Manager.
  IF public.audit_domain_for('broker_accounts', 'INSERT') <> 'security'
     OR public.audit_domain_for('broker_accounts', 'DELETE') <> 'security' THEN
    RAISE EXCEPTION '0218: audit_domain_for() files broker_accounts in the % lane; it must be security',
      public.audit_domain_for('broker_accounts', 'INSERT');
  END IF;

  -- A request with no person behind it is refused before anything is written.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.record_broker_account_created('sub000000000000000000000', 'check', 'check');
    RAISE EXCEPTION '0218: record_broker_account_created() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.record_broker_account_deleted('sub000000000000000000000');
    RAISE EXCEPTION '0218: record_broker_account_deleted() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$check$;
