-- 0229: The Audit Trail knows which kinds each action is written for.
--
-- audit_trail_action_kinds() is the declared map: one row per action, kind and the classes
-- audit_event_class() can put such a row in. The Audit Trail's filters read it, mirrored in
-- frontend/src/constants.js (AUDIT_TRAIL_ACTION_KINDS, mirror check 43): choosing kinds hides the
-- actions none of them can have, choosing actions hides the kinds none of them apply to, and
-- choosing classes hides the actions none of them can hold. Nothing else in the database reads it.
--
-- A writer that records a new action, or an action on a new kind, adds its rows here and to the
-- mirror. test_the_audit_trail_knows_which_kinds_each_action_is_written_for.py holds the map to
-- the trail's writers, read from the catalog, and each row's classes to audit_event_class().
--
-- Reasoning: supabase/README.md, "The Audit Trail knows which kinds each action is written for (0229)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The map
-- -------------------------------------------------------------------------------------------------
-- Kinds are the stored entity_type, the table a row is about. Classes are audit_event_class()'s
-- answers for the pair: one where its action or lane decides, and operational, configuration and
-- lifecycle where the snapshots do.
CREATE OR REPLACE FUNCTION public.audit_trail_action_kinds()
RETURNS TABLE (action text, entity_type text, classes text[])
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'public'
    AS $$
  SELECT m.action, k.kind, m.classes
    FROM (VALUES
      -- The audit trigger, on every table it is attached to.
      ('INSERT', ARRAY['areas', 'cells', 'devices', 'gateways', 'metric_catalog', 'schemas', 'device_nameplate'],
                 ARRAY['created']),
      ('INSERT', ARRAY['device_submodels', 'system_settings', 'service_principals', 'broker_accounts'],
                 ARRAY['configuration']),
      ('UPDATE', ARRAY['areas', 'cells', 'devices', 'gateways', 'metric_catalog', 'schemas', 'device_nameplate'],
                 ARRAY['operational', 'configuration', 'lifecycle']),
      ('UPDATE', ARRAY['device_submodels', 'system_settings'], ARRAY['configuration']),
      ('DELETE', ARRAY['areas', 'cells', 'devices', 'gateways', 'metric_catalog', 'schemas', 'device_nameplate'],
                 ARRAY['lifecycle']),
      ('DELETE', ARRAY['device_submodels', 'system_settings', 'broker_accounts'], ARRAY['configuration']),
      -- The plant and the model.
      ('SCHEMA_REJECTION', ARRAY['devices'], ARRAY['configuration']),
      ('PROPOSAL_APPLIED', ARRAY['areas', 'cells', 'devices', 'device_nameplate', 'gateways', 'schemas'],
                           ARRAY['operational', 'configuration', 'lifecycle']),
      ('PROPOSAL_EXPIRED', ARRAY['change_proposals'], ARRAY['operational', 'configuration', 'lifecycle']),
      ('EXPORTED', ARRAY['devices'], ARRAY['read']),
      ('FLOW_DEPLOYED', ARRAY['gateways'], ARRAY['operational', 'configuration', 'lifecycle']),
      ('CREDENTIAL_ISSUED', ARRAY['gateways'], ARRAY['operational', 'configuration', 'lifecycle']),
      ('CREDENTIAL_SHOWN', ARRAY['gateways'], ARRAY['read']),
      -- Capture and playback.
      ('CAPTURE_STARTED', ARRAY['capture_jobs'], ARRAY['created']),
      ('CAPTURE_STOPPED', ARRAY['capture_jobs'], ARRAY['operational']),
      ('CAPTURE_RECORDED', ARRAY['captures'], ARRAY['created']),
      ('CAPTURE_UPLOADED', ARRAY['captures'], ARRAY['created']),
      ('CAPTURE_DOWNLOAD_ISSUED', ARRAY['captures'], ARRAY['read']),
      ('CAPTURE_DELETED', ARRAY['captures'], ARRAY['lifecycle']),
      ('PLAYBACK_STARTED', ARRAY['playback_jobs'], ARRAY['created']),
      ('PLAYBACK_STOPPED', ARRAY['playback_jobs'], ARRAY['operational']),
      -- People and access, in the person's lane.
      ('PERSON_ADDED', ARRAY['user_roles'], ARRAY['configuration']),
      ('ROLE_GRANTED', ARRAY['user_roles'], ARRAY['configuration']),
      ('ROLE_REVOKED', ARRAY['user_roles'], ARRAY['configuration']),
      ('ACCESS_REMOVED', ARRAY['user_roles'], ARRAY['configuration']),
      ('ACCESS_RESTORED', ARRAY['user_roles'], ARRAY['configuration']),
      ('PASSWORD_SET', ARRAY['user_roles'], ARRAY['configuration']),
      ('DISPLAY_NAME_CHANGED', ARRAY['user_roles'], ARRAY['configuration']),
      ('EMAIL_CHANGED', ARRAY['user_roles'], ARRAY['configuration']),
      ('SESSIONS_ENDED', ARRAY['user_roles'], ARRAY['configuration']),
      ('MFA_RESET', ARRAY['user_roles'], ARRAY['configuration']),
      ('APP_APPROVED', ARRAY['user_roles'], ARRAY['configuration']),
      ('APP_APPROVAL_REVOKED', ARRAY['user_roles'], ARRAY['configuration']),
      -- Apps, in the app's lane.
      ('APP_REGISTERED', ARRAY['oauth_clients'], ARRAY['configuration']),
      ('APP_REMOVED', ARRAY['oauth_clients'], ARRAY['configuration']),
      ('APP_RESTORED', ARRAY['oauth_clients'], ARRAY['configuration']),
      -- Machine identities and credentials.
      ('PRINCIPAL_REVOKED', ARRAY['service_principals'], ARRAY['configuration']),
      ('PRINCIPAL_REINSTATED', ARRAY['service_principals'], ARRAY['configuration']),
      ('PRINCIPAL_DESCRIBED', ARRAY['service_principals'], ARRAY['configuration']),
      ('TOKEN_MINTED', ARRAY['service_principals'], ARRAY['configuration']),
      ('TOKEN_REVOKED', ARRAY['service_principals'], ARRAY['configuration']),
      -- Backups: the request, then the backup it took.
      ('BACKUP_REQUESTED', ARRAY['backup_jobs'], ARRAY['configuration']),
      ('BACKUP_CANCELLED', ARRAY['backup_jobs'], ARRAY['configuration']),
      ('BACKUP_FAILED', ARRAY['backup_jobs'], ARRAY['configuration']),
      ('BACKUP_TAKEN', ARRAY['backups'], ARRAY['configuration']),
      ('BACKUP_RELEASED', ARRAY['backups'], ARRAY['configuration']),
      ('BACKUP_PRUNED', ARRAY['backups'], ARRAY['configuration']),
      -- The System page.
      ('SERVICE_LOGS_READ', ARRAY['service_logs'], ARRAY['read'])
    ) AS m(action, kinds, classes)
   CROSS JOIN LATERAL unnest(m.kinds) AS k(kind)
$$;

ALTER FUNCTION public.audit_trail_action_kinds() OWNER TO postgres;

COMMENT ON FUNCTION public.audit_trail_action_kinds() IS
  'Which kinds each Audit Trail action is written for, and the classes audit_event_class() can put such a '
  'row in (0229). Mirrored in frontend/src/constants.js as AUDIT_TRAIL_ACTION_KINDS, which the Audit '
  'Trail''s filters narrow by. A writer that records a new action, or an action on a new kind, adds it here.';

-- -------------------------------------------------------------------------------------------------
-- 2. Who may call it
-- -------------------------------------------------------------------------------------------------
-- A list of names, readable by anyone who reads the Audit Trail.
REVOKE ALL ON FUNCTION public.audit_trail_action_kinds() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_trail_action_kinds() TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_map  regprocedure := to_regprocedure('public.audit_trail_action_kinds()');
  v_role text;
  v_bad  text;
BEGIN
  IF v_map IS NULL THEN
    RAISE EXCEPTION '0229: audit_trail_action_kinds() is missing';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF NOT has_function_privilege(v_role, v_map, 'EXECUTE') THEN
      RAISE EXCEPTION '0229: % cannot execute audit_trail_action_kinds', v_role;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', v_map, 'EXECUTE') THEN
    RAISE EXCEPTION '0229: anon may execute audit_trail_action_kinds';
  END IF;
  -- One row per action and kind, each with classes audit_event_class() answers.
  SELECT string_agg(DISTINCT m.action || ' on ' || m.entity_type, ', ') INTO v_bad
    FROM public.audit_trail_action_kinds() m
   WHERE cardinality(m.classes) = 0
      OR NOT m.classes <@ ARRAY['created', 'operational', 'configuration', 'lifecycle', 'read']
      OR (SELECT count(*) FROM public.audit_trail_action_kinds() o
           WHERE o.action = m.action AND o.entity_type = m.entity_type) > 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '0229: audit_trail_action_kinds() lists % twice, or with no class it knows', v_bad;
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
