-- 0330: A search asks about the tombstones once.
--
-- retired_entities' read policy (0001) called has_authority() bare, so the planner ran it for each tombstone,
-- at about 0.1 ms, and every search of entity_directory reads them all. captures', backups' and
-- machine_principals', which the view reads too, called has_role() so.
--
-- Each is stated here with its call in a sub-select, which runs once for a statement, as 0177 and 0204 stated
-- theirs. Each answer is the same. 0001 still declares the per-row form and creates it only where the policy
-- is missing (STATED_LATER).
--
-- Reasoning: supabase/README.md, "A search asks about the tombstones once (0330)".
-- Idempotent.

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
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_policy text;
  v_said   text;
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
END
$check$;
