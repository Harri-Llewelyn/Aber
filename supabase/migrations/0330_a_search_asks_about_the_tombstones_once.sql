-- 0330: A search asks about the tombstones once, and can limit each kind.
--
-- retired_entities' read policy (0001) called has_authority() for each tombstone, at about 0.1 ms, and
-- every search reads them all. One kind could also fill find_entities()' answer, so the search bar read
-- each other kind apart.
--
--   * Four read policies ask in a sub-select, which runs once for a statement: retired_entities',
--     captures', backups' and machine_principals'. Each answer is the same. 0001 still declares the
--     per-row form and creates it only where the policy is missing (STATED_LATER); this file states each.
--   * find_entities() takes p_per_kind, the most rows of one kind, so one call answers the search bar.
--     NULL is no such limit and the answer it was.
--
-- A new argument is a new signature. 0321 declares the two-argument form on every boot, so this file
-- drops that one on every boot: PostgREST calls by argument names and could not choose between two.
--
-- Redefines public.find_entities: it takes p_per_kind, and without it answers as 0321's.
--
-- Reasoning: supabase/README.md, "A search asks about the tombstones once, and can limit each kind (0330)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Four policies ask once for the statement
-- -------------------------------------------------------------------------------------------------
-- In pg_dump's form, one statement per line and one table per transaction, as 0177.
BEGIN;
SELECT public.replay_policy('public.backups', 'backups_select_administrator', $ddl$
CREATE POLICY backups_select_administrator ON public.backups FOR SELECT TO authenticated USING (( SELECT public.has_role(ARRAY['Administrator'::text]) AS has_role));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.captures', 'captures_select_privileged', $ddl$
CREATE POLICY captures_select_privileged ON public.captures FOR SELECT TO authenticated USING (( SELECT public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]) AS has_role));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.machine_principals', 'machine_principals_select_admin_or_auditor', $ddl$
CREATE POLICY machine_principals_select_admin_or_auditor ON public.machine_principals FOR SELECT TO authenticated USING (( SELECT public.has_role(ARRAY['Administrator'::text, 'Auditor'::text]) AS has_role));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.retired_entities', 'retired_entities_select_privileged', $ddl$
CREATE POLICY retired_entities_select_privileged ON public.retired_entities FOR SELECT TO authenticated USING (( SELECT public.has_authority(ARRAY['archive:manage'::text, 'audit_trail:read'::text]) AS has_authority));
$ddl$);
COMMIT;

-- -------------------------------------------------------------------------------------------------
-- 2. The search, with a limit of each kind
-- -------------------------------------------------------------------------------------------------
-- One transaction, so no call finds the two forms at once, or neither, for longer than 0321 left them.
-- The match is 0321's. A kind's places go by rank, then what is in service (the three states are in that
-- order by their letters), then by name, a shorter one first so that Press 2 is before Press 10, which is
-- how the dashboard orders them. The states decide the order of the whole answer too, for a total that
-- stops short, but only under p_per_kind: without it the order is 0321's.
BEGIN;
DROP FUNCTION IF EXISTS public.find_entities(text, integer);

CREATE OR REPLACE FUNCTION public.find_entities(p_query text, p_limit integer DEFAULT 200, p_per_kind integer DEFAULT NULL)
RETURNS SETOF public.entity_directory
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT f.kind, f.id, f.name, f.description, f.state, f.variant, f.second_ids, f.area_id, f.cell_id,
         f.gateway_id, f.device_id, f.page_id
    FROM (
      SELECT e.*, m.rank,
             row_number() OVER (PARTITION BY e.kind
                                ORDER BY m.rank, e.state, length(e.name), e.name, e.id) AS place
        FROM (SELECT lower(btrim(p_query, E' \t\r\n')) AS text) q
        CROSS JOIN public.entity_directory e
        CROSS JOIN LATERAL (
          SELECT lower(E'\n' || e.id || E'\n' || array_to_string(e.second_ids, E'\n') || E'\n') AS ids,
                 lower(e.name) AS name
          OFFSET 0
        ) t
        CROSS JOIN LATERAL (
          SELECT CASE
                   WHEN strpos(t.ids, E'\n' || q.text || E'\n') > 0 THEN 0
                   WHEN t.name = q.text THEN 1
                   WHEN length(q.text) >= 8 AND strpos(t.ids, E'\n' || q.text) > 0 THEN 2
                   WHEN strpos(t.name, q.text) > 0 THEN 3
                 END AS rank
          OFFSET 0
        ) m
       WHERE q.text <> '' AND m.rank IS NOT NULL
    ) f
   WHERE p_per_kind IS NULL OR f.place <= greatest(p_per_kind, 1)
   ORDER BY f.rank, CASE WHEN p_per_kind IS NOT NULL THEN f.state END, f.name, f.kind, f.id, f.state
   LIMIT least(greatest(coalesce(p_limit, 200), 1), 500);
$$;

ALTER FUNCTION public.find_entities(text, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.find_entities(text, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.find_entities(text, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.find_entities(text, integer, integer) IS
  'The rows of entity_directory one text names, for "what is this id?": a whole id (the key or any of '
  'second_ids), the start of one from 8 characters, or any part of a name, whatever the case. A whole id '
  'comes first, then a whole name, then the rest. At most p_limit rows, 200 by default and never more than '
  '500; blank text answers none. With p_per_kind, at most that many rows of each kind, the best first: among '
  'equals what is in service, then by name, a shorter one first. SECURITY INVOKER: the rows the caller may '
  'read (0321, 0330).';
COMMIT;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_find   regprocedure := to_regprocedure('public.find_entities(text, integer, integer)');
  v_policy text;
  v_said   text;
  v_role   text;
BEGIN
  -- A call that is not in a sub-select runs for each row.
  FOREACH v_policy IN ARRAY ARRAY['backups backups_select_administrator', 'captures captures_select_privileged',
                                  'machine_principals machine_principals_select_admin_or_auditor',
                                  'retired_entities retired_entities_select_privileged'] LOOP
    v_said := coalesce(public.live_policy_statement(('public.' || split_part(v_policy, ' ', 1))::regclass,
                                                    split_part(v_policy, ' ', 2)::name), '');
    IF position('( SELECT public.has_' IN v_said) = 0 OR v_said ~ '(?<!SELECT )public\.has_' THEN
      RAISE EXCEPTION '0330: % does not ask once for the statement: %', v_policy, coalesce(nullif(v_said, ''), 'missing');
    END IF;
  END LOOP;

  IF to_regprocedure('public.find_entities(text, integer)') IS NOT NULL THEN
    RAISE EXCEPTION '0330: the two-argument find_entities() stands beside the new one, and a call naming neither p_per_kind could be either''s';
  END IF;
  IF v_find IS NULL OR NOT EXISTS (SELECT 1 FROM pg_proc
                                    WHERE oid = v_find AND pronargdefaults = 2
                                      AND proargnames[1:3] = ARRAY['p_query', 'p_limit', 'p_per_kind']) THEN
    RAISE EXCEPTION '0330: find_entities() does not take p_query alone, with p_limit and p_per_kind as the caller likes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE oid = v_find AND (prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=public'])) THEN
    RAISE EXCEPTION '0330: find_entities() is SECURITY DEFINER, or its search_path is not pinned to public';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_find, 'EXECUTE') THEN
      RAISE EXCEPTION '0330: % may call find_entities()', v_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', v_find, 'EXECUTE') THEN
    RAISE EXCEPTION '0330: a signed-in caller may not call find_entities(); the Entities page and the search bar do';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
