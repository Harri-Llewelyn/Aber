-- 0241: The Audit Trail files a suppression window's acts.
--
-- 0240's three writers record SUPPRESSION_WINDOW_SCHEDULED, SUPPRESSION_WINDOW_CHANGED,
-- SUPPRESSION_WINDOW_ENDED and SUPPRESSION_WINDOW_CANCELLED in the lane of the window's subject: a
-- device, a gateway or a cell. Those lanes are the asset lane's already, and the classifier's rules
-- for a named act on an asset row already class them, so audit_domain_for() and
-- audit_event_class() are unchanged. This file gives the four actions their place in the Audit
-- Trail's map of kinds.
--
-- audit_trail_action_kinds() is redeclared whole, unchanged but for those rows: 0229 and 0232
-- replay first on every boot, and the last declaration stands.
--
-- Reasoning: supabase/README.md, "The Audit Trail files a suppression window's acts (0241)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The map of kinds
-- -------------------------------------------------------------------------------------------------
-- Unchanged from 0232 but for the four actions, after the acknowledgements.
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
      ('SERVICE_LOGS_READ', ARRAY['service_logs'], ARRAY['read']),
      -- Alerts, in the alert's lane, or a machine identity's alert in the identity's.
      ('ALERT_ACKNOWLEDGED', ARRAY['platform_alerts', 'service_principals'], ARRAY['operational']),
      ('ALERT_ACKNOWLEDGEMENT_WITHDRAWN', ARRAY['platform_alerts', 'service_principals'], ARRAY['operational']),
      -- A suppression window's acts, in its subject's lane. Named acts on an asset row, so the
      -- snapshots decide the class.
      ('SUPPRESSION_WINDOW_SCHEDULED', ARRAY['devices', 'gateways', 'cells'], ARRAY['operational', 'configuration', 'lifecycle']),
      ('SUPPRESSION_WINDOW_CHANGED', ARRAY['devices', 'gateways', 'cells'], ARRAY['operational', 'configuration', 'lifecycle']),
      ('SUPPRESSION_WINDOW_ENDED', ARRAY['devices', 'gateways', 'cells'], ARRAY['operational', 'configuration', 'lifecycle']),
      ('SUPPRESSION_WINDOW_CANCELLED', ARRAY['devices', 'gateways', 'cells'], ARRAY['operational', 'configuration', 'lifecycle'])
    ) AS m(action, kinds, classes)
   CROSS JOIN LATERAL unnest(m.kinds) AS k(kind)
$$;

ALTER FUNCTION public.audit_trail_action_kinds() OWNER TO postgres;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_kind   text;
  v_action text;
BEGIN
  FOREACH v_kind IN ARRAY ARRAY['devices', 'gateways', 'cells'] LOOP
    IF public.audit_domain_for(v_kind, 'SUPPRESSION_WINDOW_SCHEDULED') <> 'asset' THEN
      RAISE EXCEPTION '0241: audit_domain_for() files % outside the asset lane', v_kind;
    END IF;
    FOREACH v_action IN ARRAY ARRAY['SUPPRESSION_WINDOW_SCHEDULED', 'SUPPRESSION_WINDOW_CHANGED',
                                    'SUPPRESSION_WINDOW_ENDED', 'SUPPRESSION_WINDOW_CANCELLED'] LOOP
      -- A window's own snapshot carries no configuration field and no flag, so it is operational.
      IF public.audit_event_class(v_action, v_kind, 'asset', '{"name": "x", "reason": "a"}',
                                  '{"name": "x", "reason": "b"}') <> 'operational' THEN
        RAISE EXCEPTION '0241: audit_event_class() does not answer operational for % on %', v_action, v_kind;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.audit_trail_action_kinds() m
                      WHERE m.action = v_action AND m.entity_type = v_kind
                        AND m.classes = ARRAY['operational', 'configuration', 'lifecycle']) THEN
        RAISE EXCEPTION '0241: audit_trail_action_kinds() does not list % on %', v_action, v_kind;
      END IF;
    END LOOP;
  END LOOP;
  -- The acknowledgements, 0232's last rows, are still there.
  IF NOT EXISTS (SELECT 1 FROM public.audit_trail_action_kinds() m
                  WHERE m.action = 'ALERT_ACKNOWLEDGEMENT_WITHDRAWN' AND m.entity_type = 'service_principals') THEN
    RAISE EXCEPTION '0241: audit_trail_action_kinds() lost 0232''s rows';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.audit_trail_action_kinds()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.audit_trail_action_kinds()', 'EXECUTE') THEN
    RAISE EXCEPTION '0241: authenticated may not execute audit_trail_action_kinds(), or anon may';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
