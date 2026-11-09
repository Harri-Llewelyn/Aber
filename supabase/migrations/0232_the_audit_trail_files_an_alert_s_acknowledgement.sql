-- 0232: The Audit Trail files an alert's acknowledgement as an operational act.
--
-- 0231's acknowledge_alert() and withdraw_alert_acknowledgement() write ALERT_ACKNOWLEDGED and
-- ALERT_ACKNOWLEDGEMENT_WITHDRAWN rows. This file gives them their lane, their class and their
-- place in the Audit Trail's map of kinds.
--
--   * audit_domain_for() files `platform_alerts` in the asset lane: an Operator, a Shopfloor
--     Manager or an Administrator acknowledges, and the asset lane's readers are the roles that
--     read the Audit Trail beside them. A machine identity's alert is acknowledged in that
--     identity's lane, `service_principals`, which stays in the security lane: only an
--     Administrator may read the alert, so only an Administrator and an Auditor read the act.
--   * audit_event_class() answers operational for both actions, before the security lane's rule,
--     so an acknowledgement is one class wherever it is filed. The class indexes were built with
--     the rules before; they are rebuilt when a row they could hold wrongly exists.
--   * audit_trail_action_kinds() lists both actions on both kinds.
--   * An automation's acts (0256, 0257) are filed in the asset lane under `automations`, and
--     classed by their action: a creation is created, a change configuration, enabling or
--     disabling operational, a deletion lifecycle. They are rules for a table every role reads and
--     an Administrator or a Shopfloor Manager writes, as `metric_catalog` is.
--
-- Each function is redeclared whole, unchanged but for these lines: 0001, 0168, 0193, 0228 and
-- 0229 replay first on every boot, and the last declaration stands.
--
-- Reasoning: supabase/README.md, "The Audit Trail files an alert's acknowledgement (0232)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The lane
-- -------------------------------------------------------------------------------------------------
-- Unchanged from 0193 but for `platform_alerts` and `automations` in the asset list.
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
    -- The capture and playback acts are a Manager's, on tables the same three roles read. An
    -- alert's acknowledgement is an Operator's, a Manager's or an Administrator's. An automation is
    -- written by a Manager or an Administrator, and read by every role.
    WHEN p_entity_type IN ('areas', 'cells', 'devices', 'gateways', 'links',
                           'schemas', 'device_nameplate', 'device_submodels', 'change_proposals',
                           'cell_links', 'gateway_links', 'device_links',
                           'metric_catalog', 'captures', 'capture_jobs', 'playback_jobs',
                           'platform_alerts', 'automations')
      THEN 'asset'

    -- Fail-closed: a new entity_type nobody classified is restricted rather than exposed.
    ELSE 'security'
  END
$$;

ALTER FUNCTION public.audit_domain_for(p_entity_type text, p_action text) OWNER TO postgres;

-- -------------------------------------------------------------------------------------------------
-- 2. The class
-- -------------------------------------------------------------------------------------------------
-- Unchanged from 0228 but for the acknowledgements' rule and the automations' four, after the reads
-- and before the security lane's. IMMUTABLE and with no SET clause, as the class indexes need: see 0228.
CREATE OR REPLACE FUNCTION public.audit_event_class(p_action text, p_entity_type text, p_audit_domain text,
                                                    p_old_data jsonb, p_new_data jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE
    WHEN p_action IN ('SERVICE_LOGS_READ', 'CREDENTIAL_SHOWN', 'CAPTURE_DOWNLOAD_ISSUED', 'EXPORTED')
      THEN 'read'
    -- An alert acknowledged or its acknowledgement withdrawn, in either lane.
    WHEN p_action IN ('ALERT_ACKNOWLEDGED', 'ALERT_ACKNOWLEDGEMENT_WITHDRAWN')
      THEN 'operational'
    -- An automation: written, changed, switched on or off, or deleted, whatever its snapshots say.
    WHEN p_action = 'AUTOMATION_CREATED'
      THEN 'created'
    WHEN p_action = 'AUTOMATION_CHANGED'
      THEN 'configuration'
    WHEN p_action IN ('AUTOMATION_ENABLED', 'AUTOMATION_DISABLED')
      THEN 'operational'
    WHEN p_action = 'AUTOMATION_DELETED'
      THEN 'lifecycle'
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
  'Read is a row that records access and changes nothing, decided before the security lane''s rule, and '
  'an alert''s acknowledgement and its withdrawal are operational in either lane (0232). '
  'Unpinned on purpose: a SET clause stops the planner inlining it, and the class indexes on audit_trail '
  'are built on it. It reads no table and calls only built-in operators. A change to its rules rebuilds '
  'those indexes in the same file.';

-- The new rule changes the class of one kind of row only: an acknowledgement in the security lane,
-- which the rules before called configuration. An index entry can disagree with the rules only for
-- such a row written while 0228's declaration stood, on a boot between that file and this one. So
-- the five indexes are rebuilt, each a statement of its own, only while such rows exist; a site
-- with none, every fresh install included, rebuilds nothing.
SELECT EXISTS (SELECT 1 FROM public.audit_trail
                WHERE audit_domain = 'security'
                  AND action IN ('ALERT_ACKNOWLEDGED', 'ALERT_ACKNOWLEDGEMENT_WITHDRAWN'))
       AS aber_0232_rebuild_class_indexes
\gset
\if :aber_0232_rebuild_class_indexes
REINDEX INDEX public.idx_audit_trail_class_created;
REINDEX INDEX public.idx_audit_trail_class_operational;
REINDEX INDEX public.idx_audit_trail_class_configuration;
REINDEX INDEX public.idx_audit_trail_class_lifecycle;
REINDEX INDEX public.idx_audit_trail_class_read;
\endif

-- -------------------------------------------------------------------------------------------------
-- 3. The map of kinds
-- -------------------------------------------------------------------------------------------------
-- Unchanged from 0229 but for the two actions, after the System page's.
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
      ('ALERT_ACKNOWLEDGEMENT_WITHDRAWN', ARRAY['platform_alerts', 'service_principals'], ARRAY['operational'])
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
  v_lane   text;
  v_action text;
  v_name   text;
BEGIN
  FOR v_kind, v_lane IN VALUES ('platform_alerts', 'asset'), ('service_principals', 'security') LOOP
    IF public.audit_domain_for(v_kind, 'ALERT_ACKNOWLEDGED') <> v_lane THEN
      RAISE EXCEPTION '0232: audit_domain_for() files % in the % lane; it must be %',
        v_kind, public.audit_domain_for(v_kind, 'ALERT_ACKNOWLEDGED'), v_lane;
    END IF;
    FOREACH v_action IN ARRAY ARRAY['ALERT_ACKNOWLEDGED', 'ALERT_ACKNOWLEDGEMENT_WITHDRAWN'] LOOP
      IF public.audit_event_class(v_action, v_kind, v_lane, '{"name": "x"}', '{"name": "x", "reason": "other"}')
           <> 'operational' THEN
        RAISE EXCEPTION '0232: audit_event_class() does not answer operational for % on %', v_action, v_kind;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.audit_trail_action_kinds() m
                      WHERE m.action = v_action AND m.entity_type = v_kind AND m.classes = ARRAY['operational']) THEN
        RAISE EXCEPTION '0232: audit_trail_action_kinds() does not list % on % as operational', v_action, v_kind;
      END IF;
    END LOOP;
  END LOOP;

  -- Still inlinable, so the class indexes stay usable: see 0228.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                  WHERE p.oid = 'public.audit_event_class(text, text, text, jsonb, jsonb)'::regprocedure
                    AND l.lanname = 'sql' AND p.provolatile = 'i' AND NOT p.prosecdef AND p.proconfig IS NULL) THEN
    RAISE EXCEPTION '0232: audit_event_class is not an IMMUTABLE SQL function without a SET clause';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['created', 'operational', 'configuration', 'lifecycle', 'read'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                    WHERE i.indrelid = 'public.audit_trail'::regclass
                      AND c.relname = 'idx_audit_trail_class_' || v_name AND i.indisvalid) THEN
      RAISE EXCEPTION '0232: idx_audit_trail_class_% is missing or invalid', v_name;
    END IF;
  END LOOP;
  -- The rules before still answer as they did.
  IF public.audit_event_class('UPDATE', 'system_settings', 'security', '{}', '{}') <> 'configuration'
     OR public.audit_event_class('SERVICE_LOGS_READ', 'service_logs', 'security', NULL, '{"name": "x"}') <> 'read'
     OR public.audit_event_class('UPDATE', 'devices', 'asset', '{"status": "a"}', '{"status": "b"}') <> 'operational' THEN
    RAISE EXCEPTION '0232: audit_event_class answers one of 0228''s rules differently';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
