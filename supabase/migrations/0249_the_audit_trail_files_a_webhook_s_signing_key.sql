-- 0249: The Audit Trail files the webhook's signing key as a configuration change.
--
-- 0248's issue_notification_signing_key() writes a SIGNING_KEY_ISSUED row in the webhook's own lane,
-- `notification_channels`, on the first issue and on every rotation. This file gives it its place in
-- the Audit Trail's map of kinds.
--
--   * The lane needs no rule: audit_domain_for() files a kind it does not name in the security lane,
--     whose readers are an Administrator and an Auditor, as it files `service_logs`.
--   * The class needs no rule either: audit_event_class() answers configuration for the security
--     lane, so the class indexes are unchanged and nothing is rebuilt.
--   * audit_trail_action_kinds() lists the action on its kind, redeclared whole from 0232, unchanged
--     but for that line, 0241's four suppression window rows and the five automation rows (0256, 0257):
--     0229, 0232 and 0241 replay first on every boot, and the last declaration stands.
--
-- Reasoning: supabase/README.md, "The Audit Trail files a webhook's signing key (0249)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The map of kinds
-- -------------------------------------------------------------------------------------------------
-- Unchanged from 0232 but for 0241's suppression window rows, the automation rows and the signing
-- key, after the alerts.
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
      ('SUPPRESSION_WINDOW_CANCELLED', ARRAY['devices', 'gateways', 'cells'], ARRAY['operational', 'configuration', 'lifecycle']),
      -- An automation's acts, in its own lane (0232 files the lane and the classes). Each is one row
      -- per automation, naming who did it.
      ('AUTOMATION_CREATED', ARRAY['automations'], ARRAY['created']),
      ('AUTOMATION_CHANGED', ARRAY['automations'], ARRAY['configuration']),
      ('AUTOMATION_ENABLED', ARRAY['automations'], ARRAY['operational']),
      ('AUTOMATION_DISABLED', ARRAY['automations'], ARRAY['operational']),
      ('AUTOMATION_DELETED', ARRAY['automations'], ARRAY['lifecycle']),
      -- The webhook's signing key, issued or rotated, in the webhook's lane.
      ('SIGNING_KEY_ISSUED', ARRAY['notification_channels'], ARRAY['configuration'])
    ) AS m(action, kinds, classes)
   CROSS JOIN LATERAL unnest(m.kinds) AS k(kind)
$$;

ALTER FUNCTION public.audit_trail_action_kinds() OWNER TO postgres;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
BEGIN
  IF public.audit_domain_for('notification_channels', 'SIGNING_KEY_ISSUED') <> 'security' THEN
    RAISE EXCEPTION '0249: audit_domain_for() files notification_channels in the % lane; it must be security',
      public.audit_domain_for('notification_channels', 'SIGNING_KEY_ISSUED');
  END IF;
  IF public.audit_event_class('SIGNING_KEY_ISSUED', 'notification_channels', 'security', NULL,
                              '{"name": "Webhook", "replaced": false}') <> 'configuration' THEN
    RAISE EXCEPTION '0249: audit_event_class() does not answer configuration for SIGNING_KEY_ISSUED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_trail_action_kinds() m
                  WHERE m.action = 'SIGNING_KEY_ISSUED' AND m.entity_type = 'notification_channels'
                    AND m.classes = ARRAY['configuration']) THEN
    RAISE EXCEPTION '0249: audit_trail_action_kinds() does not list SIGNING_KEY_ISSUED on notification_channels';
  END IF;
  -- An automation's acts are filed in the asset lane, each in the class its action has.
  IF public.audit_domain_for('automations', 'AUTOMATION_CREATED') <> 'asset' THEN
    RAISE EXCEPTION '0249: audit_domain_for() files automations in the % lane; it must be asset',
      public.audit_domain_for('automations', 'AUTOMATION_CREATED');
  END IF;
  IF (SELECT array_agg(public.audit_event_class(a, 'automations', 'asset', '{"name": "x"}', '{"name": "y"}') ORDER BY a)
        FROM unnest(ARRAY['AUTOMATION_CHANGED', 'AUTOMATION_CREATED', 'AUTOMATION_DELETED', 'AUTOMATION_DISABLED',
                          'AUTOMATION_ENABLED']) a)
     <> ARRAY['configuration', 'created', 'lifecycle', 'operational', 'operational'] THEN
    RAISE EXCEPTION '0249: audit_event_class() does not class the automations'' acts as created, configuration, operational and lifecycle';
  END IF;
  IF (SELECT count(*) FROM public.audit_trail_action_kinds() m
       WHERE m.entity_type = 'automations' AND starts_with(m.action, 'AUTOMATION_')) < 5 THEN
    RAISE EXCEPTION '0249: audit_trail_action_kinds() does not list the five automation acts';
  END IF;
  -- 0232's rows are all still there.
  IF NOT EXISTS (SELECT 1 FROM public.audit_trail_action_kinds() m
                  WHERE m.action = 'ALERT_ACKNOWLEDGED' AND m.entity_type = 'service_principals') THEN
    RAISE EXCEPTION '0249: audit_trail_action_kinds() lost 0232''s rows';
  END IF;
  -- And so are 0241's, which this declaration replaces.
  IF NOT EXISTS (SELECT 1 FROM public.audit_trail_action_kinds() m
                  WHERE m.action = 'SUPPRESSION_WINDOW_CANCELLED' AND m.entity_type = 'cells') THEN
    RAISE EXCEPTION '0249: audit_trail_action_kinds() lost 0241''s rows';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
