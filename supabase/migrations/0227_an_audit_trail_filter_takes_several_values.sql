-- 0227: An Audit Trail filter takes several values.
--
-- audit_trail_page() takes p_entity_type text[], p_action text[] and p_changed_by uuid[], in the
-- places the single text, text and uuid were. Each list keeps the rows that match any of its
-- values, and the three are combined with AND, as before. NULL or an empty list is no constraint,
-- and a one-element list is the single value it holds, so a filter on one kind, one action or one
-- person returns what it did. The keyset paging, total_matching, purged_assets, the purged rule,
-- the search and transaction_rows are unchanged.
--
-- A changed argument type is a new signature, so 0001 and 0168 declare the list form in place, as
-- they declared 0222's eleventh argument, and this file holds no third copy of the body. On the
-- first boot of an upgrade, 0001 creates the list form beside the single-value one and its sweep
-- of stale overloads drops the old form at the end of the same file; this file drops it too if it
-- is still there. It states the grants by name, since 0001's ACL section revokes from PUBLIC only.
--
-- Reasoning: supabase/README.md, "An Audit Trail filter takes several values (0227)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The single-value form, from before this file
-- -------------------------------------------------------------------------------------------------
-- Guarded, so a boot with nothing to drop prints nothing.
DO $drop$
BEGIN
  IF to_regprocedure('public.audit_trail_page(integer, boolean, text, text, uuid[], timestamp with time zone, '
                     'timestamp with time zone, timestamp with time zone, bigint, text, uuid)') IS NOT NULL THEN
    DROP FUNCTION public.audit_trail_page(integer, boolean, text, text, uuid[], timestamp with time zone,
                                          timestamp with time zone, timestamp with time zone, bigint, text, uuid);
  END IF;
END
$drop$;

-- -------------------------------------------------------------------------------------------------
-- 2. Who may call the list form
-- -------------------------------------------------------------------------------------------------
-- Every role that reads the Audit Trail calls it; audit_trail's policies decide the rows.
REVOKE ALL ON FUNCTION public.audit_trail_page(integer, boolean, text[], text[], uuid[], timestamp with time zone,
                                               timestamp with time zone, timestamp with time zone, bigint, text,
                                               uuid[]) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.audit_trail_page(integer, boolean, text[], text[], uuid[], timestamp with time zone,
                                              timestamp with time zone, timestamp with time zone, bigint, text,
                                              uuid[]) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file, 0001 and 0168 did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_forms text[];
  v_page regprocedure;
  v_arg text;
  v_type text;
  v_role text;
BEGIN
  SELECT array_agg(pg_get_function_identity_arguments(p.oid) ORDER BY p.oid) INTO v_forms
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'audit_trail_page';
  IF coalesce(array_length(v_forms, 1), 0) <> 1 THEN
    RAISE EXCEPTION '0227: audit_trail_page is declared % times, not once: %',
      coalesce(array_length(v_forms, 1), 0), coalesce(array_to_string(v_forms, ' | '), 'none');
  END IF;
  SELECT p.oid::regprocedure INTO v_page
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'audit_trail_page';

  -- Each list argument by its name, wherever it stands, so an argument added later passes.
  FOREACH v_arg IN ARRAY ARRAY['p_entity_type:text[]', 'p_action:text[]', 'p_changed_by:uuid[]'] LOOP
    SELECT format_type(t.typ, NULL) INTO v_type
      FROM pg_proc p,
           unnest(p.proargnames, p.proargtypes::oid[]) AS t(name, typ)
     WHERE p.oid = v_page AND t.name = split_part(v_arg, ':', 1);
    IF v_type IS DISTINCT FROM split_part(v_arg, ':', 2) THEN
      RAISE EXCEPTION '0227: audit_trail_page takes % as %, not as %',
        split_part(v_arg, ':', 1), coalesce(v_type, 'nothing'), split_part(v_arg, ':', 2);
    END IF;
  END LOOP;

  -- SECURITY INVOKER: the table's policies decide which rows a filter can reach.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_page) THEN
    RAISE EXCEPTION '0227: audit_trail_page is SECURITY DEFINER, so it would read past audit_trail''s RLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_page AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0227: audit_trail_page has no pinned search_path';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF NOT has_function_privilege(v_role, v_page, 'EXECUTE') THEN
      RAISE EXCEPTION '0227: % cannot execute audit_trail_page; the Audit Trail reads through it', v_role;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', v_page, 'EXECUTE') THEN
    RAISE EXCEPTION '0227: anon may execute audit_trail_page';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
