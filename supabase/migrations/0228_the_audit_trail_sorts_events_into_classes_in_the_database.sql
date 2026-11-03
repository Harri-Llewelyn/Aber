-- 0228: The Audit Trail sorts events into classes in the database.
--
-- audit_event_class() decides which class an audit row is in: created, operational, configuration,
-- lifecycle or read. The dashboard drew a marker from rules of its own, which a filter on the server
-- could not apply; the rules are this function's now, and the dashboard draws the class it is given.
-- Read is new: a row that records access and changes nothing (a service's logs read, a credential
-- shown again, a capture's download link, a device exported) was drawn as a configuration change or
-- an operational one.
--
-- Reasoning: supabase/README.md, "The Audit Trail sorts events into classes in the database (0228)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. audit_event_class(): which class an audit row is in
-- -------------------------------------------------------------------------------------------------
-- The first rule that matches decides. Reads come before the security lane's rule, which would call
-- every read in that lane configuration. An UPDATE, or a named act on an asset row, is decided by
-- what its snapshots say: a flag that rose to true is lifecycle, a configuration field that changed
-- is configuration, and anything else is operational. With one snapshot, a field it holds that is
-- neither null nor '' counts as changed. test-harness/fixtures/audit-event-classes.json holds it.
--
-- IMMUTABLE and with no SET clause, so the planner inlines it: the five class indexes below are
-- built on it and a query that names a class matches them. A change to these rules is a new file
-- that redeclares it and rebuilds those indexes (REINDEX), since an index keeps the class it was
-- built with.
CREATE OR REPLACE FUNCTION public.audit_event_class(p_action text, p_entity_type text, p_audit_domain text,
                                                    p_old_data jsonb, p_new_data jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE
    WHEN p_action IN ('SERVICE_LOGS_READ', 'CREDENTIAL_SHOWN', 'CAPTURE_DOWNLOAD_ISSUED', 'EXPORTED')
      THEN 'read'
    WHEN p_audit_domain = 'security'
      THEN 'configuration'
    WHEN p_action IN ('SCHEMA_REJECTION', 'TOKEN_MINTED', 'TOKEN_REVOKED', 'ROLE_GRANTED', 'ROLE_REVOKED')
      THEN 'configuration'
    -- The capture lane: a start makes the row its lane is about, a deletion ends it.
    WHEN p_action IN ('CAPTURE_STARTED', 'CAPTURE_RECORDED', 'CAPTURE_UPLOADED', 'PLAYBACK_STARTED')
      THEN 'created'
    WHEN p_action = 'CAPTURE_DELETED'
      THEN 'lifecycle'
    WHEN p_action IN ('CAPTURE_STOPPED', 'PLAYBACK_STOPPED')
      THEN 'operational'
    -- A schema attached to or detached from a device, whatever its verb.
    WHEN p_entity_type = 'device_submodels'
      THEN 'configuration'
    WHEN p_action = 'DELETE'
      THEN 'lifecycle'
    WHEN p_action = 'INSERT'
      THEN 'created'
    -- Archived, quarantined, or a metric deprecated: the flag is true now and was not before.
    WHEN (p_new_data -> 'is_archived') = 'true' AND (p_old_data -> 'is_archived') IS DISTINCT FROM 'true'
      OR (p_new_data -> 'is_quarantined') = 'true' AND (p_old_data -> 'is_quarantined') IS DISTINCT FROM 'true'
      OR (p_new_data -> 'deprecated') = 'true' AND (p_old_data -> 'deprecated') IS DISTINCT FROM 'true'
      THEN 'lifecycle'
    -- A configuration field changed. A missing field and a JSON null are the same value.
    WHEN CASE
           WHEN jsonb_typeof(p_old_data) IN ('object', 'array') AND jsonb_typeof(p_new_data) IN ('object', 'array') THEN
                nullif(p_old_data -> 'schema_id', 'null') IS DISTINCT FROM nullif(p_new_data -> 'schema_id', 'null')
             OR nullif(p_old_data -> 'asset_config', 'null') IS DISTINCT FROM nullif(p_new_data -> 'asset_config', 'null')
             OR nullif(p_old_data -> 'connection_method', 'null') IS DISTINCT FROM nullif(p_new_data -> 'connection_method', 'null')
             OR nullif(p_old_data -> 'grafana_url', 'null') IS DISTINCT FROM nullif(p_new_data -> 'grafana_url', 'null')
             OR nullif(p_old_data -> 'access_url', 'null') IS DISTINCT FROM nullif(p_new_data -> 'access_url', 'null')
           WHEN jsonb_typeof(p_new_data) IN ('object', 'array') THEN
                coalesce((p_new_data -> 'schema_id') NOT IN ('null', '""'), false)
             OR coalesce((p_new_data -> 'asset_config') NOT IN ('null', '""'), false)
             OR coalesce((p_new_data -> 'connection_method') NOT IN ('null', '""'), false)
             OR coalesce((p_new_data -> 'grafana_url') NOT IN ('null', '""'), false)
             OR coalesce((p_new_data -> 'access_url') NOT IN ('null', '""'), false)
           WHEN jsonb_typeof(p_old_data) IN ('object', 'array') THEN
                coalesce((p_old_data -> 'schema_id') NOT IN ('null', '""'), false)
             OR coalesce((p_old_data -> 'asset_config') NOT IN ('null', '""'), false)
             OR coalesce((p_old_data -> 'connection_method') NOT IN ('null', '""'), false)
             OR coalesce((p_old_data -> 'grafana_url') NOT IN ('null', '""'), false)
             OR coalesce((p_old_data -> 'access_url') NOT IN ('null', '""'), false)
           ELSE false
         END
      THEN 'configuration'
    ELSE 'operational'
  END
$$;

ALTER FUNCTION public.audit_event_class(text, text, text, jsonb, jsonb) OWNER TO postgres;

COMMENT ON FUNCTION public.audit_event_class(text, text, text, jsonb, jsonb) IS
  'Which class an audit_trail row is in: created, operational, configuration, lifecycle or read (0228). '
  'Read is a row that records access and changes nothing, decided before the security lane''s rule. '
  'Unpinned on purpose: a SET clause stops the planner inlining it, and the class indexes on audit_trail '
  'are built on it. It reads no table and calls only built-in operators. A change to its rules rebuilds '
  'those indexes in the same file.';

-- -------------------------------------------------------------------------------------------------
-- 2. Who may call it
-- -------------------------------------------------------------------------------------------------
-- The Audit Trail's readers run it inside their own queries; it reads nothing.
REVOKE ALL ON FUNCTION public.audit_event_class(text, text, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_event_class(text, text, text, jsonb, jsonb) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_class regprocedure := to_regprocedure('public.audit_event_class(text, text, text, jsonb, jsonb)');
  v_role text;
BEGIN
  IF v_class IS NULL THEN
    RAISE EXCEPTION '0228: audit_event_class(text, text, text, jsonb, jsonb) is missing';
  END IF;
  -- Inlinable: SQL, IMMUTABLE, SECURITY INVOKER and no SET clause.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                  WHERE p.oid = v_class AND l.lanname = 'sql' AND p.provolatile = 'i'
                    AND NOT p.prosecdef AND p.proconfig IS NULL) THEN
    RAISE EXCEPTION '0228: audit_event_class is not an IMMUTABLE SQL function without a SET clause, so it '
                    'would not inline and the class indexes could not be built on it';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF NOT has_function_privilege(v_role, v_class, 'EXECUTE') THEN
      RAISE EXCEPTION '0228: % cannot execute audit_event_class', v_role;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', v_class, 'EXECUTE') THEN
    RAISE EXCEPTION '0228: anon may execute audit_event_class';
  END IF;
  -- One answer per rule that decides before the snapshots, and one that reads them.
  IF public.audit_event_class('SERVICE_LOGS_READ', 'service_logs', 'security', NULL, '{"name": "x"}') <> 'read'
     OR public.audit_event_class('UPDATE', 'system_settings', 'security', '{}', '{}') <> 'configuration'
     OR public.audit_event_class('CAPTURE_STARTED', 'capture_jobs', 'asset', NULL, '{}') <> 'created'
     OR public.audit_event_class('DELETE', 'devices', 'asset', '{}', NULL) <> 'lifecycle'
     OR public.audit_event_class('UPDATE', 'devices', 'asset', '{"status": "a"}', '{"status": "b"}') <> 'operational' THEN
    RAISE EXCEPTION '0228: audit_event_class answers one of its own rules wrongly';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
