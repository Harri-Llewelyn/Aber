-- 0299: A metric can carry more than one semantic id.
--
-- A concept often has several published identifiers: an OPC UA ExpandedNodeId, an ECLASS IRDI, an IEC CDD
-- IRDI, and the element id a submodel template assigns. `metric_catalog.semantic_id` holds one of them,
-- so a site that implements a template naming the same quantity another way had to overwrite the id the
-- metric was named from, and lose its provenance. AAS V3 states the equivalence in the metamodel:
-- `HasSemantics` carries `semanticId` and `supplementalSemanticIds`, further References to the same
-- concept. This file stores them.
--
--   * metric_semantic_ids: one row per supplemental id of a metric. `semantic_id` keeps its meaning on
--     the catalogue row, for the REST API and for i3X; these are further ids for the same concept. Each
--     row has its own type (the three `semantic_id_type` admits), an optional `source` saying where the
--     equivalence comes from, and when it was added and by whom. A metric carries at most ten, and none
--     that is its own id. The primary key is (metric_id, semantic_id), so one id is listed once for a
--     metric; the same id may be supplemental to several metrics.
--   * Two triggers keep it consistent. enforce_metric_semantic_id() refuses a row for a metric that has
--     no id of its own (AAS refuses supplemental ids without a semanticId), a row equal to the metric's
--     own id, an eleventh row, and a change to which metric or which id a row is. And
--     enforce_metric_own_semantic_id() refuses to clear a metric's own id while it carries others, or to
--     make one of them its own.
--   * Row security follows metric_catalog: every signed-in role reads, and only an Administrator behind
--     the second factor writes. anon is revoked by name. The audit trigger files each add and remove
--     as it files the catalogue's own changes, in the same lane, under the metric's id.
--   * metric_semantic_id_crosswalk answers "which metric did we map to this concept?" across both: a row
--     for each id a metric carries, as its own (`primary`) or as a further one (`supplemental`).
--
-- Reasoning: supabase/README.md, "A metric can carry more than one semantic id (0299)". Idempotent.
--
-- Redefines public.audit_domain_for: 0232 files the catalogue's metrics in the asset lane, a table every
--   signed-in role reads and an Administrator writes. 0299 files metric_semantic_ids there too, since the
--   same people write it and the same roles read it, and carries 0232's other arms unchanged
-- Redefines public.audit_trail_action_kinds: 0249 lists the Audit Trail's acts by kind. 0299 lists INSERT,
--   UPDATE and DELETE on metric_semantic_ids beside the catalogue's, and carries 0249's rows unchanged

-- -------------------------------------------------------------------------------------------------
-- 1. The table
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.metric_semantic_ids (
    metric_id uuid NOT NULL,
    semantic_id text NOT NULL,
    semantic_id_type text NOT NULL,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT metric_semantic_ids_pkey PRIMARY KEY (metric_id, semantic_id),
    CONSTRAINT metric_semantic_ids_metric_id_fkey FOREIGN KEY (metric_id)
        REFERENCES public.metric_catalog(id) ON DELETE CASCADE,
    CONSTRAINT metric_semantic_ids_type_valid
        CHECK ((semantic_id_type = ANY (ARRAY['IRI'::text, 'IRDI'::text, 'ExpandedNodeId'::text]))),
    CONSTRAINT metric_semantic_ids_id_valid
        CHECK (((semantic_id = btrim(semantic_id)) AND (char_length(semantic_id) >= 1) AND (char_length(semantic_id) <= 2000))),
    CONSTRAINT metric_semantic_ids_source_valid
        CHECK (((source IS NULL) OR ((source = btrim(source)) AND (char_length(source) >= 1) AND (char_length(source) <= 500))))
);

ALTER TABLE public.metric_semantic_ids OWNER TO postgres;
ALTER TABLE public.metric_semantic_ids ENABLE ROW LEVEL SECURITY;

-- The crosswalk: which metric carries this id. The key serves the other direction.
CREATE INDEX IF NOT EXISTS idx_metric_semantic_ids_semantic_id
    ON public.metric_semantic_ids USING btree (semantic_id);

COMMENT ON TABLE public.metric_semantic_ids IS
  'The further semantic ids of a metric: published identifiers of the same concept beside the one '
  'metric_catalog.semantic_id holds, exported as the Property''s supplementalSemanticIds. At most ten a '
  'metric, none equal to its own id, and only on a metric that has one. Every signed-in role reads it; '
  'an Administrator behind the second factor writes it, and each add and remove is an Audit Trail row '
  'under the metric''s id (0299).';
COMMENT ON COLUMN public.metric_semantic_ids.metric_id IS
  'The metric, deleted with it. Fixed once the row exists (0299).';
COMMENT ON COLUMN public.metric_semantic_ids.semantic_id IS
  'The identifier: 1 to 2,000 characters with no space at either end. Fixed once the row exists, so a '
  'wrong one is removed and the right one added (0299).';
COMMENT ON COLUMN public.metric_semantic_ids.semantic_id_type IS
  'Which kind of AAS Reference semantic_id is, as metric_catalog.semantic_id_type says it: IRI, IRDI or '
  'ExpandedNodeId. All three export as an ExternalReference with one GlobalReference key (0299).';
COMMENT ON COLUMN public.metric_semantic_ids.source IS
  'Where the equivalence comes from, in the writer''s words: a standard and its edition, or the '
  'template that names the concept this way. NULL when not said; at most 500 characters (0299).';
COMMENT ON COLUMN public.metric_semantic_ids.created_at IS
  'When the id was added. Set by the database, whatever the writer sends (0299).';
COMMENT ON COLUMN public.metric_semantic_ids.created_by IS
  'The person whose session added it, as auth.uid() answers. NULL for a write with no session, such as '
  'a migration; the Audit Trail row names the actor in every case (0299).';

-- -------------------------------------------------------------------------------------------------
-- 2. The rules
-- -------------------------------------------------------------------------------------------------
-- A row of metric_semantic_ids. The foreign key states a metric that is missing better than this does,
-- so that case passes. The advisory lock makes two inserts for one metric take turns, so the limit
-- holds under concurrent writers.
CREATE OR REPLACE FUNCTION public.enforce_metric_semantic_id() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  c_max CONSTANT integer := 10;
  v_name  text;
  v_own   text;
  v_count integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.metric_id IS DISTINCT FROM OLD.metric_id OR NEW.semantic_id IS DISTINCT FROM OLD.semantic_id THEN
      RAISE EXCEPTION 'A supplemental semantic id belongs to one metric and is fixed once saved. Remove it and add the one you mean.'
            USING ERRCODE = '23514';
    END IF;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    RETURN NEW;
  END IF;

  NEW.created_at := now();
  NEW.created_by := auth.uid();

  SELECT m.name, nullif(m.semantic_id, '') INTO v_name, v_own
    FROM public.metric_catalog m WHERE m.id = NEW.metric_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v_own IS NULL THEN
    RAISE EXCEPTION '% has no semantic id of its own, so it cannot carry others beside it. Give it one first.', v_name
          USING ERRCODE = '23514';
  END IF;
  IF NEW.semantic_id = v_own THEN
    RAISE EXCEPTION '% is already the semantic id of %. A further id names the same concept another way.', NEW.semantic_id, v_name
          USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('metric_semantic_ids:' || NEW.metric_id::text, 0));
  SELECT count(*) INTO v_count FROM public.metric_semantic_ids s WHERE s.metric_id = NEW.metric_id;
  IF v_count >= c_max THEN
    RAISE EXCEPTION '% already carries % further semantic ids, the most a metric may. Remove one first.', v_name, c_max
          USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.enforce_metric_semantic_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_metric_semantic_id() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_metric_semantic_id() IS 'Trigger function on metric_semantic_ids: stamps who added a row and when, and refuses a row for a metric with no semantic id of its own, a row equal to the metric''s own id, an eleventh row for one metric, and a change to which metric or which id a row is (0299).';

SELECT public.replay_trigger('public.metric_semantic_ids', 'trg_metric_semantic_ids_rules', $ddl$
CREATE TRIGGER trg_metric_semantic_ids_rules BEFORE INSERT OR UPDATE ON public.metric_semantic_ids FOR EACH ROW EXECUTE FUNCTION public.enforce_metric_semantic_id();
$ddl$);

-- A change to a metric's own id, which the rows beside it depend on: it cannot be cleared while they
-- exist, and it cannot become one of them.
CREATE OR REPLACE FUNCTION public.enforce_metric_own_semantic_id() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_count integer;
BEGIN
  IF NEW.semantic_id IS NOT DISTINCT FROM OLD.semantic_id THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO v_count FROM public.metric_semantic_ids s WHERE s.metric_id = NEW.id;
  IF v_count = 0 THEN
    RETURN NEW;
  END IF;
  IF nullif(NEW.semantic_id, '') IS NULL THEN
    RAISE EXCEPTION '% carries % further semantic ids, which need an id of its own beside them. Remove them first, or keep its own id.', NEW.name, v_count
          USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.metric_semantic_ids s WHERE s.metric_id = NEW.id AND s.semantic_id = NEW.semantic_id) THEN
    RAISE EXCEPTION '% is already one of the further semantic ids of %. Remove it from that list first, then make it the metric''s own id.', NEW.semantic_id, NEW.name
          USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.enforce_metric_own_semantic_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_metric_own_semantic_id() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_metric_own_semantic_id() IS 'Trigger function on metric_catalog, for an UPDATE of semantic_id: refuses to clear a metric''s own id while metric_semantic_ids holds further ids for it, and to make one of them its own (0299).';

SELECT public.replay_trigger('public.metric_catalog', 'trg_metric_catalog_own_semantic_id', $ddl$
CREATE TRIGGER trg_metric_catalog_own_semantic_id BEFORE UPDATE OF semantic_id ON public.metric_catalog FOR EACH ROW EXECUTE FUNCTION public.enforce_metric_own_semantic_id();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 3. Who reads, and who writes
-- -------------------------------------------------------------------------------------------------
-- As metric_catalog: every signed-in role reads, and an Administrator behind the second factor writes.
-- authenticated gets the four row privileges and not TRUNCATE, which row security does not govern.
-- anon is revoked by name.
REVOKE ALL ON TABLE public.metric_semantic_ids FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.metric_semantic_ids TO authenticated;
GRANT ALL ON TABLE public.metric_semantic_ids TO service_role;

SELECT public.replay_policy('public.metric_semantic_ids', 'metric_semantic_ids_select_authenticated', $ddl$
CREATE POLICY metric_semantic_ids_select_authenticated ON public.metric_semantic_ids FOR SELECT TO authenticated USING (true);
$ddl$);
SELECT public.replay_policy('public.metric_semantic_ids', 'metric_semantic_ids_insert_privileged', $ddl$
CREATE POLICY metric_semantic_ids_insert_privileged ON public.metric_semantic_ids FOR INSERT TO authenticated WITH CHECK ((public.has_role(ARRAY['Administrator'::text]) AND ( SELECT public.require_mfa() AS require_mfa)));
$ddl$);
SELECT public.replay_policy('public.metric_semantic_ids', 'metric_semantic_ids_update_privileged', $ddl$
CREATE POLICY metric_semantic_ids_update_privileged ON public.metric_semantic_ids FOR UPDATE TO authenticated USING ((public.has_role(ARRAY['Administrator'::text]) AND ( SELECT public.require_mfa() AS require_mfa))) WITH CHECK ((public.has_role(ARRAY['Administrator'::text]) AND ( SELECT public.require_mfa() AS require_mfa)));
$ddl$);
SELECT public.replay_policy('public.metric_semantic_ids', 'metric_semantic_ids_delete_privileged', $ddl$
CREATE POLICY metric_semantic_ids_delete_privileged ON public.metric_semantic_ids FOR DELETE TO authenticated USING ((public.has_role(ARRAY['Administrator'::text]) AND ( SELECT public.require_mfa() AS require_mfa)));
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 4. The Audit Trail
-- -------------------------------------------------------------------------------------------------
-- The entity is the metric, as a nameplate and a schema attachment are the device: a metric's own
-- changes and its further ids' share one lane.
SELECT public.replay_trigger('public.metric_semantic_ids', 'trg_metric_semantic_ids_audit_trail', $ddl$
CREATE TRIGGER trg_metric_semantic_ids_audit_trail AFTER INSERT OR DELETE OR UPDATE ON public.metric_semantic_ids FOR EACH ROW EXECUTE FUNCTION public.log_audit_trail_event('metric_id');
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 5. The crosswalk
-- -------------------------------------------------------------------------------------------------
-- One row for each id a metric carries: `primary` for the one metric_catalog.semantic_id holds,
-- `supplemental` for a further one, with the equivalence's source. The caller's own policies apply,
-- and a derived metric, which has no id, has no row.
CREATE OR REPLACE VIEW public.metric_semantic_id_crosswalk WITH (security_invoker='true') AS
 SELECT m.semantic_id,
    m.semantic_id_type,
    m.id AS metric_id,
    m.name AS metric_name,
    m.deprecated,
    'primary'::text AS held_as,
    NULL::text AS source
   FROM public.metric_catalog m
  WHERE ((m.semantic_id IS NOT NULL) AND (m.semantic_id <> ''::text))
UNION ALL
 SELECT s.semantic_id,
    s.semantic_id_type,
    m.id AS metric_id,
    m.name AS metric_name,
    m.deprecated,
    'supplemental'::text AS held_as,
    s.source
   FROM (public.metric_semantic_ids s
     JOIN public.metric_catalog m ON ((m.id = s.metric_id)));

ALTER VIEW public.metric_semantic_id_crosswalk OWNER TO postgres;
REVOKE ALL ON TABLE public.metric_semantic_id_crosswalk FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.metric_semantic_id_crosswalk TO authenticated, service_role;

COMMENT ON VIEW public.metric_semantic_id_crosswalk IS 'Which metric carries a semantic id: a row for each id a metric has, `primary` for the one metric_catalog.semantic_id holds and `supplemental` for a further one in metric_semantic_ids, with that row''s source. Filter by semantic_id. A caller''s own row security applies, and a metric with no id has no row (0299).';

-- -------------------------------------------------------------------------------------------------
-- 6. The Audit Trail's lane and its map of kinds
-- -------------------------------------------------------------------------------------------------
-- Each function is redeclared whole, unchanged but for metric_semantic_ids: 0001, 0168, 0193 and 0232
-- (the lane), and 0229, 0232, 0241 and 0249 (the map) replay first on every boot, and the last
-- declaration stands. audit_event_class() needs no rule: an INSERT is created, a DELETE lifecycle, and an
-- UPDATE the class its snapshots give, as for the catalogue, so the class indexes are unchanged and
-- nothing is rebuilt.
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
    -- written by a Manager or an Administrator, and read by every role. An export of readings is a
    -- Manager's or an Administrator's, and an Auditor reads it with them. A metric's further semantic ids are
    -- written by the catalogue's writers, so they are filed beside it.
    WHEN p_entity_type IN ('areas', 'cells', 'devices', 'gateways', 'links',
                           'schemas', 'device_nameplate', 'device_submodels', 'change_proposals',
                           'cell_links', 'gateway_links', 'device_links',
                           'metric_catalog', 'metric_semantic_ids', 'captures', 'capture_jobs', 'playback_jobs',
                           'platform_alerts', 'automations', 'telemetry')
      THEN 'asset'

    -- Fail-closed: a new entity_type nobody classified is restricted rather than exposed.
    ELSE 'security'
  END
$$;

ALTER FUNCTION public.audit_domain_for(p_entity_type text, p_action text) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.audit_trail_action_kinds()
RETURNS TABLE (action text, entity_type text, classes text[])
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'public'
    AS $$
  SELECT m.action, k.kind, m.classes
    FROM (VALUES
      -- The audit trigger, on every table it is attached to.
      ('INSERT', ARRAY['areas', 'cells', 'devices', 'gateways', 'metric_catalog', 'metric_semantic_ids', 'schemas', 'device_nameplate'],
                 ARRAY['created']),
      ('INSERT', ARRAY['device_submodels', 'system_settings', 'service_principals', 'broker_accounts'],
                 ARRAY['configuration']),
      ('UPDATE', ARRAY['areas', 'cells', 'devices', 'gateways', 'metric_catalog', 'metric_semantic_ids', 'schemas', 'device_nameplate'],
                 ARRAY['operational', 'configuration', 'lifecycle']),
      ('UPDATE', ARRAY['device_submodels', 'system_settings'], ARRAY['configuration']),
      ('DELETE', ARRAY['areas', 'cells', 'devices', 'gateways', 'metric_catalog', 'metric_semantic_ids', 'schemas', 'device_nameplate'],
                 ARRAY['lifecycle']),
      ('DELETE', ARRAY['device_submodels', 'system_settings', 'broker_accounts'], ARRAY['configuration']),
      -- The plant and the model.
      ('SCHEMA_REJECTION', ARRAY['devices'], ARRAY['configuration']),
      ('PROPOSAL_APPLIED', ARRAY['areas', 'cells', 'devices', 'device_nameplate', 'gateways', 'schemas'],
                           ARRAY['operational', 'configuration', 'lifecycle']),
      ('PROPOSAL_EXPIRED', ARRAY['change_proposals'], ARRAY['operational', 'configuration', 'lifecycle']),
      ('EXPORTED', ARRAY['devices'], ARRAY['read']),
      -- Readings exported from History (0279): one row an export, in the one lane for readings.
      ('TELEMETRY_EXPORTED', ARRAY['telemetry'], ARRAY['read']),
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
-- 7. Self-check
-- -------------------------------------------------------------------------------------------------
-- Of the shapes, and of what the classifiers say about the new kind and about the arms this file
-- carried over. No row is read, since a row a writer saves while this runs is the triggers' to judge.
DO $check$
DECLARE
  v_name text;
  v_def  text;
BEGIN
  IF to_regclass('public.metric_semantic_ids') IS NULL OR to_regclass('public.metric_semantic_id_crosswalk') IS NULL THEN
    RAISE EXCEPTION '0299: metric_semantic_ids or its crosswalk is missing';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.metric_semantic_ids'::regclass) THEN
    RAISE EXCEPTION '0299: metric_semantic_ids has no row security';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['metric_semantic_ids_select_authenticated', 'metric_semantic_ids_insert_privileged',
                                'metric_semantic_ids_update_privileged', 'metric_semantic_ids_delete_privileged'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = 'public.metric_semantic_ids'::regclass AND p.polname = v_name) THEN
      RAISE EXCEPTION '0299: the policy % is missing', v_name;
    END IF;
  END LOOP;

  SELECT pg_get_triggerdef(t.oid) INTO v_def FROM pg_trigger t
   WHERE t.tgrelid = 'public.metric_semantic_ids'::regclass AND t.tgname = 'trg_metric_semantic_ids_rules';
  IF v_def IS NULL OR position('BEFORE INSERT OR UPDATE' IN v_def) = 0 THEN
    RAISE EXCEPTION '0299: trg_metric_semantic_ids_rules is not BEFORE INSERT OR UPDATE (found %)', v_def;
  END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_def FROM pg_trigger t
   WHERE t.tgrelid = 'public.metric_semantic_ids'::regclass AND t.tgname = 'trg_metric_semantic_ids_audit_trail';
  IF v_def IS NULL OR position('log_audit_trail_event(''metric_id'')' IN v_def) = 0 THEN
    RAISE EXCEPTION '0299: the audit trigger on metric_semantic_ids does not name the metric as its entity (found %)', v_def;
  END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_def FROM pg_trigger t
   WHERE t.tgrelid = 'public.metric_catalog'::regclass AND t.tgname = 'trg_metric_catalog_own_semantic_id';
  IF v_def IS NULL OR position('BEFORE UPDATE OF semantic_id' IN v_def) = 0 THEN
    RAISE EXCEPTION '0299: trg_metric_catalog_own_semantic_id is not BEFORE UPDATE OF semantic_id (found %)', v_def;
  END IF;

  IF has_table_privilege('anon', 'public.metric_semantic_ids', 'SELECT')
     OR has_table_privilege('anon', 'public.metric_semantic_id_crosswalk', 'SELECT')
     OR has_table_privilege('authenticated', 'public.metric_semantic_ids', 'TRUNCATE')
     OR has_function_privilege('anon', 'public.enforce_metric_semantic_id()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_metric_own_semantic_id()', 'EXECUTE') THEN
    RAISE EXCEPTION '0299: a browser-facing role holds a privilege it should not';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.metric_semantic_id_crosswalk', 'SELECT') THEN
    RAISE EXCEPTION '0299: authenticated cannot read the crosswalk';
  END IF;

  -- The new kind, in the asset lane, and every arm of the lane and the map this file carried over.
  IF public.audit_domain_for('metric_semantic_ids', 'INSERT') <> 'asset' THEN
    RAISE EXCEPTION '0299: audit_domain_for() files metric_semantic_ids in the % lane; it must be asset',
      public.audit_domain_for('metric_semantic_ids', 'INSERT');
  END IF;
  IF public.audit_event_class('INSERT', 'metric_semantic_ids', 'asset', NULL, '{"semantic_id": "x"}') <> 'created'
     OR public.audit_event_class('DELETE', 'metric_semantic_ids', 'asset', '{"semantic_id": "x"}', NULL) <> 'lifecycle' THEN
    RAISE EXCEPTION '0299: audit_event_class() does not class an add as created and a remove as lifecycle';
  END IF;
  IF (SELECT count(*) FROM public.audit_trail_action_kinds() m
       WHERE m.entity_type = 'metric_semantic_ids' AND m.action IN ('INSERT', 'UPDATE', 'DELETE')) <> 3 THEN
    RAISE EXCEPTION '0299: audit_trail_action_kinds() does not list INSERT, UPDATE and DELETE on metric_semantic_ids once each';
  END IF;
  IF public.audit_domain_for('metric_catalog', 'UPDATE') <> 'asset'
     OR public.audit_domain_for('device_submodels', 'INSERT') <> 'asset'
     OR public.audit_domain_for('captures', 'CAPTURE_RECORDED') <> 'asset'
     OR public.audit_domain_for('platform_alerts', 'ALERT_ACKNOWLEDGED') <> 'asset'
     OR public.audit_domain_for('automations', 'AUTOMATION_CREATED') <> 'asset'
     OR public.audit_domain_for('telemetry', 'TELEMETRY_EXPORTED') <> 'asset'
     OR public.audit_domain_for('user_roles', 'ROLE_GRANTED') <> 'security'
     OR public.audit_domain_for('system_settings', 'UPDATE') <> 'security'
     OR public.audit_domain_for('notification_channels', 'SIGNING_KEY_ISSUED') <> 'security' THEN
    RAISE EXCEPTION '0299: audit_domain_for() files a kind of an earlier file in another lane';
  END IF;
  FOR v_name IN SELECT unnest(ARRAY['SIGNING_KEY_ISSUED', 'AUTOMATION_DELETED', 'TELEMETRY_EXPORTED',
                                    'SUPPRESSION_WINDOW_CANCELLED', 'ALERT_ACKNOWLEDGEMENT_WITHDRAWN',
                                    'CAPTURE_DELETED', 'SERVICE_LOGS_READ', 'BACKUP_PRUNED', 'PROPOSAL_EXPIRED']) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.audit_trail_action_kinds() m WHERE m.action = v_name) THEN
      RAISE EXCEPTION '0299: audit_trail_action_kinds() lost %', v_name;
    END IF;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
