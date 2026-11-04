-- 0228: The Audit Trail sorts events into classes in the database.
--
-- audit_event_class() decides which class an audit row is in: created, operational, configuration,
-- lifecycle or read. The dashboard drew a marker from rules of its own, which a filter on the server
-- could not apply; the rules are this function's now, and the dashboard draws the class it is given.
-- Read is new: a row that records access and changes nothing (a service's logs read, a credential
-- shown again, a capture's download link, a device exported) was drawn as a configuration change or
-- an operational one.
--
-- audit_trail_page() takes p_class text[] and p_counts boolean after p_changed_by. Each event carries
-- its class; with p_counts the answer gives each class, kind and action its events under every filter
-- but its own. A backup request's id also finds the backup it took. Computed, not stored: one partial
-- index per class lets the page and the counts read a class without reading the table.
--
-- A new argument is a new signature, so 0001 and 0168 declare the new form in place, as they did for
-- 0227, and this file drops the old one if 0001's sweep has not. On the first boot of an upgrade the
-- Audit Trail fails from 0001 until this file has declared the functions the new form calls. It
-- states every grant by name, since 0001's ACL section revokes from PUBLIC only.
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
-- 2. audit_trail_matching(): one class's rows under the Audit Trail's filters
-- -------------------------------------------------------------------------------------------------
-- What audit_trail_page() reads, once per class: the rows of p_class that the kinds, actions, ids,
-- window, people, search and cursor select, each with whether its entity is deleted. NULL is no
-- constraint for each list. A row's entity is deleted when its kind is one the purged rule can probe
-- and its id is none of p_live_ids. `device_nameplate` and `device_submodels` are keyed by their
-- device's id, so a device answers for them.
--
-- A SQL function with no SET clause, so the planner inlines it into each call: with the class a
-- constant, the class's index below holds every column it reads but the search's, and a call
-- without a search never touches the table.
CREATE OR REPLACE FUNCTION public.audit_trail_matching(
    p_class text, p_entity_type text[], p_action text[], p_entity_ids uuid[], p_since timestamp with time zone,
    p_until timestamp with time zone, p_changed_by uuid[], p_live_ids uuid[], p_pattern text, p_id_term bigint,
    p_also_ids uuid[], p_before_recorded_at timestamp with time zone, p_before_id bigint)
RETURNS TABLE (id bigint, recorded_at timestamp with time zone, entity_type text, action text, entity_id uuid,
               class text, is_purged boolean)
    LANGUAGE sql STABLE
    AS $$
  SELECT t.id, t.recorded_at, t.entity_type, t.action, t.entity_id, p_class,
         t.entity_type IN ('areas', 'cells', 'gateways', 'devices', 'schemas', 'device_nameplate', 'device_submodels')
         AND NOT t.entity_id = ANY (p_live_ids)
    FROM public.audit_trail t
   WHERE public.audit_event_class(t.action, t.entity_type, t.audit_domain, t.old_data, t.new_data) = p_class
     AND (p_entity_type IS NULL OR t.entity_type = ANY (p_entity_type))
     AND (p_action IS NULL OR t.action = ANY (p_action))
     -- An empty list of ids is a question about no entity, so it matches nothing.
     AND (p_entity_ids IS NULL OR t.entity_id = ANY (p_entity_ids))
     AND t.recorded_at >= p_since
     AND t.recorded_at <= p_until
     AND (p_changed_by IS NULL OR t.changed_by = ANY (p_changed_by))
     AND (p_before_id IS NULL OR (t.recorded_at, t.id) < (p_before_recorded_at, p_before_id))
     -- The id and the name the timeline draws, from either snapshot; the row's own id and its
     -- transaction's for a term of digits; and ids matched by something not in the row.
     AND (p_pattern IS NULL
          OR t.entity_id::text ILIKE p_pattern
          OR (p_id_term IS NOT NULL AND (t.id = p_id_term OR t.causation_id = p_id_term))
          OR t.entity_id = ANY (p_also_ids)
          OR EXISTS (SELECT 1
                       FROM unnest(ARRAY['name', 'sparkplug_id', 'schema_name',
                                         'label', 'key', 'role', 'stamp', 'origin']) AS f(field)
                      WHERE (t.new_data ->> f.field) ILIKE p_pattern
                         OR (t.old_data ->> f.field) ILIKE p_pattern))
$$;

ALTER FUNCTION public.audit_trail_matching(text, text[], text[], uuid[], timestamp with time zone,
                                           timestamp with time zone, uuid[], uuid[], text, bigint, uuid[],
                                           timestamp with time zone, bigint) OWNER TO postgres;

COMMENT ON FUNCTION public.audit_trail_matching(text, text[], text[], uuid[], timestamp with time zone,
                                                timestamp with time zone, uuid[], uuid[], text, bigint, uuid[],
                                                timestamp with time zone, bigint) IS
  'The rows of one class (audit_event_class()) that audit_trail_page()''s filters select, each with whether '
  'its entity is deleted (0228). SECURITY INVOKER, so audit_trail''s policies decide the rows. Unpinned on '
  'purpose: a SET clause stops the planner inlining it, and audit_trail_page() reads each class through its '
  'own index only once it is inlined. Every name in it is schema-qualified.';

-- -------------------------------------------------------------------------------------------------
-- 3. One index per class
-- -------------------------------------------------------------------------------------------------
-- Partial, on the class, so a query that names it reads only its rows, newest first, and needs
-- nothing from the table: the key is the trail's order, and the columns the filters, the policies
-- and the purged rule read are included. Built on each monthly partition, a new one included.
CREATE INDEX IF NOT EXISTS idx_audit_trail_class_created ON public.audit_trail (recorded_at DESC, id DESC)
  INCLUDE (audit_domain, entity_type, action, entity_id, changed_by)
  WHERE public.audit_event_class(action, entity_type, audit_domain, old_data, new_data) = 'created';
CREATE INDEX IF NOT EXISTS idx_audit_trail_class_operational ON public.audit_trail (recorded_at DESC, id DESC)
  INCLUDE (audit_domain, entity_type, action, entity_id, changed_by)
  WHERE public.audit_event_class(action, entity_type, audit_domain, old_data, new_data) = 'operational';
CREATE INDEX IF NOT EXISTS idx_audit_trail_class_configuration ON public.audit_trail (recorded_at DESC, id DESC)
  INCLUDE (audit_domain, entity_type, action, entity_id, changed_by)
  WHERE public.audit_event_class(action, entity_type, audit_domain, old_data, new_data) = 'configuration';
CREATE INDEX IF NOT EXISTS idx_audit_trail_class_lifecycle ON public.audit_trail (recorded_at DESC, id DESC)
  INCLUDE (audit_domain, entity_type, action, entity_id, changed_by)
  WHERE public.audit_event_class(action, entity_type, audit_domain, old_data, new_data) = 'lifecycle';
CREATE INDEX IF NOT EXISTS idx_audit_trail_class_read ON public.audit_trail (recorded_at DESC, id DESC)
  INCLUDE (audit_domain, entity_type, action, entity_id, changed_by)
  WHERE public.audit_event_class(action, entity_type, audit_domain, old_data, new_data) = 'read';

-- -------------------------------------------------------------------------------------------------
-- 4. audit_trail_page(): the form from before p_class and p_counts
-- -------------------------------------------------------------------------------------------------
-- 0001 and 0168 declare the new form. Guarded, so a boot with nothing to drop prints nothing.
DO $drop$
BEGIN
  IF to_regprocedure('public.audit_trail_page(integer, boolean, text[], text[], uuid[], timestamp with time zone, '
                     'timestamp with time zone, timestamp with time zone, bigint, text, uuid[])') IS NOT NULL THEN
    DROP FUNCTION public.audit_trail_page(integer, boolean, text[], text[], uuid[], timestamp with time zone,
                                          timestamp with time zone, timestamp with time zone, bigint, text, uuid[]);
  END IF;
END
$drop$;

-- -------------------------------------------------------------------------------------------------
-- 5. Who may call what
-- -------------------------------------------------------------------------------------------------
-- Every role that reads the Audit Trail runs all three; audit_trail's policies decide the rows.
REVOKE ALL ON FUNCTION public.audit_event_class(text, text, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_event_class(text, text, text, jsonb, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.audit_trail_matching(text, text[], text[], uuid[], timestamp with time zone,
                                                   timestamp with time zone, uuid[], uuid[], text, bigint, uuid[],
                                                   timestamp with time zone, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_trail_matching(text, text[], text[], uuid[], timestamp with time zone,
                                                      timestamp with time zone, uuid[], uuid[], text, bigint, uuid[],
                                                      timestamp with time zone, bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.audit_trail_page(integer, boolean, text[], text[], uuid[], timestamp with time zone,
                                               timestamp with time zone, timestamp with time zone, bigint, text,
                                               uuid[], text[], boolean) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.audit_trail_page(integer, boolean, text[], text[], uuid[], timestamp with time zone,
                                              timestamp with time zone, timestamp with time zone, bigint, text,
                                              uuid[], text[], boolean) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file, 0001 and 0168 did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_class    regprocedure := to_regprocedure('public.audit_event_class(text, text, text, jsonb, jsonb)');
  v_matching regprocedure := to_regprocedure(
    'public.audit_trail_matching(text, text[], text[], uuid[], timestamp with time zone, timestamp with time zone, '
    'uuid[], uuid[], text, bigint, uuid[], timestamp with time zone, bigint)');
  v_forms    text[];
  v_page     regprocedure;
  v_fn       regprocedure;
  v_arg      text;
  v_type     text;
  v_role     text;
  v_name     text;
BEGIN
  IF v_class IS NULL OR v_matching IS NULL THEN
    RAISE EXCEPTION '0228: audit_event_class() or audit_trail_matching() is missing';
  END IF;
  -- Inlinable: SQL, SECURITY INVOKER and no SET clause; the classifier IMMUTABLE as its indexes need.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                  WHERE p.oid = v_class AND l.lanname = 'sql' AND p.provolatile = 'i'
                    AND NOT p.prosecdef AND p.proconfig IS NULL) THEN
    RAISE EXCEPTION '0228: audit_event_class is not an IMMUTABLE SQL function without a SET clause, so it '
                    'would not inline and its indexes could not be built';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                  WHERE p.oid = v_matching AND l.lanname = 'sql' AND p.provolatile = 's'
                    AND NOT p.prosecdef AND p.proconfig IS NULL) THEN
    RAISE EXCEPTION '0228: audit_trail_matching is not a STABLE SQL function without a SET clause, so it '
                    'would not inline and its class would not be read from its index';
  END IF;

  SELECT array_agg(pg_get_function_identity_arguments(p.oid) ORDER BY p.oid) INTO v_forms
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'audit_trail_page';
  IF coalesce(array_length(v_forms, 1), 0) <> 1 THEN
    RAISE EXCEPTION '0228: audit_trail_page is declared % times, not once: %',
      coalesce(array_length(v_forms, 1), 0), coalesce(array_to_string(v_forms, ' | '), 'none');
  END IF;
  SELECT p.oid::regprocedure INTO v_page
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'audit_trail_page';
  -- By name, wherever each stands, so an argument added later passes.
  FOREACH v_arg IN ARRAY ARRAY['p_class:text[]', 'p_counts:boolean'] LOOP
    SELECT format_type(t.typ, NULL) INTO v_type
      FROM pg_proc p,
           unnest(p.proargnames, p.proargtypes::oid[]) AS t(name, typ)
     WHERE p.oid = v_page AND t.name = split_part(v_arg, ':', 1);
    IF v_type IS DISTINCT FROM split_part(v_arg, ':', 2) THEN
      RAISE EXCEPTION '0228: audit_trail_page takes % as %, not as %',
        split_part(v_arg, ':', 1), coalesce(v_type, 'nothing'), split_part(v_arg, ':', 2);
    END IF;
  END LOOP;
  -- Planned with its values on every call; SECURITY INVOKER, so the policies decide the rows.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_page AND NOT prosecdef
                    AND 'search_path=public' = ANY (proconfig)
                    AND 'plan_cache_mode=force_custom_plan' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0228: audit_trail_page is SECURITY DEFINER, or lacks its pinned search_path or '
                    'force_custom_plan';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[v_class, v_matching, v_page] LOOP
    FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
      IF NOT has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '0228: % cannot execute %; the Audit Trail reads through it', v_role, v_fn;
      END IF;
    END LOOP;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0228: anon may execute %', v_fn;
    END IF;
  END LOOP;

  -- Each class's index, valid on the table and naming its class.
  FOREACH v_name IN ARRAY ARRAY['created', 'operational', 'configuration', 'lifecycle', 'read'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'public.audit_trail'::regclass AND c.relname = 'idx_audit_trail_class_' || v_name
         AND i.indisvalid
         AND pg_get_expr(i.indpred, i.indrelid) LIKE '%audit_event_class(%= ''' || v_name || '''::text%') THEN
      RAISE EXCEPTION '0228: idx_audit_trail_class_% is missing, invalid, or not on its class', v_name;
    END IF;
  END LOOP;

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
