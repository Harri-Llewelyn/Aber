-- 0331: The Audit Trail's search finds every id.
--
-- audit_trail_matching() (0228) compared a search with the entity's id and with eight fields of either
-- snapshot, so a semantic id, the id a device publishes under and a capture's file found nothing, though a
-- drawer shows each and entity_directory (0321) lists it.
--
--   * It reads semantic_id, reported_identity and storage_path too, in either snapshot. A row of
--     metric_semantic_ids is filed under its metric and holds its semantic_id, so it is found by it.
--   * It finds a metric by a further semantic id the metric has, which no row of the metric's own holds.
--   * The fields are read as one text and compared once, not one at a time, so eleven of them take less time
--     than eight did: nothing is indexed for it. Every other condition is 0228's.
--
-- Redefines public.audit_trail_matching: it reads three fields more, and finds a metric by a further id of it.
--
-- Reasoning: supabase/README.md, "The Audit Trail's search finds every id (0331)".
-- Idempotent.

-- A SQL function with no SET clause, so the planner inlines it into each call, as 0228's is.
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
     -- The row's own id and its transaction's for a term of digits; ids matched by something not in the
     -- row; a metric, by a further semantic id it has, which is in no row of the metric's own; and what
     -- the timeline draws and the further ids entity_directory lists, from either snapshot. Those are one
     -- text, compared once: each comparison folds a term and a value to one case, which is the cost of a
     -- search. The unit separator keeps a term from matching across two values.
     AND (p_pattern IS NULL
          OR t.entity_id::text ILIKE p_pattern
          OR (p_id_term IS NOT NULL AND (t.id = p_id_term OR t.causation_id = p_id_term))
          OR t.entity_id = ANY (p_also_ids)
          OR t.entity_id IN (SELECT s.metric_id FROM public.metric_semantic_ids s
                              WHERE s.semantic_id ILIKE p_pattern)
          OR lower(concat_ws(E'\x1f',
               t.new_data ->> 'name', t.old_data ->> 'name',
               t.new_data ->> 'sparkplug_id', t.old_data ->> 'sparkplug_id',
               t.new_data ->> 'schema_name', t.old_data ->> 'schema_name',
               t.new_data ->> 'label', t.old_data ->> 'label',
               t.new_data ->> 'key', t.old_data ->> 'key',
               t.new_data ->> 'role', t.old_data ->> 'role',
               t.new_data ->> 'stamp', t.old_data ->> 'stamp',
               t.new_data ->> 'origin', t.old_data ->> 'origin',
               t.new_data ->> 'semantic_id', t.old_data ->> 'semantic_id',
               t.new_data ->> 'reported_identity', t.old_data ->> 'reported_identity',
               t.new_data ->> 'storage_path', t.old_data ->> 'storage_path')) LIKE lower(p_pattern))
$$;

ALTER FUNCTION public.audit_trail_matching(text, text[], text[], uuid[], timestamp with time zone,
                                           timestamp with time zone, uuid[], uuid[], text, bigint, uuid[],
                                           timestamp with time zone, bigint) OWNER TO postgres;

COMMENT ON FUNCTION public.audit_trail_matching(text, text[], text[], uuid[], timestamp with time zone,
                                           timestamp with time zone, uuid[], uuid[], text, bigint, uuid[],
                                           timestamp with time zone, bigint) IS
  'The rows of one class (audit_event_class()) that audit_trail_page()''s filters select, each with whether '
  'its entity is deleted (0228). A search matches the entity''s id, the fields the timeline names a lane by, '
  'the further ids entity_directory lists, in either snapshot, and a metric by a further semantic id of it '
  '(0331). SECURITY INVOKER, so audit_trail''s policies decide the rows. Unpinned on purpose: a SET clause '
  'stops the planner inlining it, and audit_trail_page() reads each class through its own index only once it '
  'is inlined. Every name in it is schema-qualified.';

REVOKE ALL ON FUNCTION public.audit_trail_matching(text, text[], text[], uuid[], timestamp with time zone,
                                           timestamp with time zone, uuid[], uuid[], text, bigint, uuid[],
                                           timestamp with time zone, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_trail_matching(text, text[], text[], uuid[], timestamp with time zone,
                                           timestamp with time zone, uuid[], uuid[], text, bigint, uuid[],
                                           timestamp with time zone, bigint) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_matching regprocedure := to_regprocedure(
    'public.audit_trail_matching(text, text[], text[], uuid[], timestamp with time zone, timestamp with time zone, '
    'uuid[], uuid[], text, bigint, uuid[], timestamp with time zone, bigint)');
  v_field    text;
  v_role     text;
BEGIN
  IF v_matching IS NULL THEN
    RAISE EXCEPTION '0331: audit_trail_matching() is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                  WHERE p.oid = v_matching AND l.lanname = 'sql' AND p.provolatile = 's'
                    AND NOT p.prosecdef AND p.proconfig IS NULL) THEN
    RAISE EXCEPTION '0331: audit_trail_matching is not a STABLE SQL function without a SET clause, so it would not '
                    'inline and its class would not be read from its index';
  END IF;
  -- Each field in both snapshots: an INSERT has only the new one and a DELETE only the old.
  FOREACH v_field IN ARRAY ARRAY['name', 'sparkplug_id', 'schema_name', 'label', 'key', 'role', 'stamp', 'origin',
                                 'semantic_id', 'reported_identity', 'storage_path'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = v_matching
                      AND position(format('t.new_data ->> %L', v_field) IN p.prosrc) > 0
                      AND position(format('t.old_data ->> %L', v_field) IN p.prosrc) > 0) THEN
      RAISE EXCEPTION '0331: the Audit Trail''s search does not read % in both snapshots', v_field;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = v_matching AND position('public.metric_semantic_ids' IN p.prosrc) > 0) THEN
    RAISE EXCEPTION '0331: the Audit Trail''s search does not find a metric by a further semantic id';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF NOT has_function_privilege(v_role, v_matching, 'EXECUTE') THEN
      RAISE EXCEPTION '0331: % cannot execute %; the Audit Trail reads through it', v_role, v_matching;
    END IF;
    IF NOT has_table_privilege(v_role, 'public.metric_semantic_ids', 'SELECT') THEN
      RAISE EXCEPTION '0331: % cannot read metric_semantic_ids, which the search reads as its caller', v_role;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', v_matching, 'EXECUTE') THEN
    RAISE EXCEPTION '0331: anon may execute %', v_matching;
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
