-- 0319: The comments say who a change names and which identities are seeded.
--
-- audit_trail.actor_source said changed_by is NULL for every machine-originated write, and a machine
-- identity's row names it. user_roles said three machine identities are seeded, and
-- machine_principals that three have no row there: there are four, since 0181. machine_principals
-- left out its second writer, and audit_trail listed three of the kinds it records. COMMENT ON only:
-- no row, privilege or object changes.
--
-- Reasoning: supabase/README.md, "The comments say who a change names and which identities are
-- seeded (0319)". Idempotent.

COMMENT ON COLUMN public.audit_trail.actor_source IS
  'What kind of actor made the change: user (a person) | ingestion (Service_Ingestor) | service (any '
  'other machine identity, or the platform itself) | migration (the database owner''s session with no '
  'token: a migration, or a scheduled job). changed_by names the account, a person''s or a machine '
  'identity''s. It is NULL where no account acted (the owner''s session, service_role) and where the '
  'function that wrote the row pins it NULL (0319).';

COMMENT ON TABLE public.audit_trail IS
  'Append-only audit of every attributed change. entity_type says what kind of thing a row is about '
  'and entity_id which one: docs/architecture.md, How Aber identifies things, lists the words. The '
  'asset lane holds the plant and what describes it, the security lane access, credentials and '
  'settings. Range-partitioned by month on recorded_at (0079) so retention is DETACH rather than '
  'DELETE. Rows are written only by log_audit_trail_event() and its named siblings; UPDATE and DELETE '
  'are refused for every role that is not an owner (0319).';

COMMENT ON TABLE public.user_roles IS
  'Role assignment per person. A machine principal, an auth.users row that cannot sign in, holds no '
  'role: refuse_role_for_machine_principal() refuses one, and has_authority() resolves its grants '
  'through principal_permissions. Four are seeded. Three with telemetry:read: '
  'b0000000-0000-4000-8000-000000000001, the Read-only API client, which an MCP client, i3X Explorer '
  'or a script authenticates as; b0000000-0000-4000-8000-000000000002, Service_Ingestor, the identity '
  'the ingestion daemon authenticates as; and b0000000-0000-4000-8000-000000000003, Service_Playback, '
  'the identity the playback worker authenticates as. One with no grant: '
  'b0000000-0000-4000-8000-000000000004, Service_ReleaseCheck, the identity the release check '
  'authenticates as. The three services write through SECURITY DEFINER gates that check which of them '
  'is calling (0319).';

COMMENT ON TABLE public.machine_principals IS
  'The name and purpose an Administrator gave a machine identity when creating it from the Access '
  'Control page. One row per runtime-created principal; the four identities a migration pinned have no '
  'row and are named by the dashboard''s own registry. Inserted only by create_machine_principal(), in '
  'the same transaction as the auth.users row it describes, and changed only by '
  'describe_machine_principal() (0319).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider. Each comment is read back as the boot left it here; a
-- later file that restates one runs after this check. Drift check 565 holds the seeded identities
-- the two tables' comments count to the seed.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['audit_trail', 'user_roles', 'machine_principals'] LOOP
    IF position('(0319)' IN coalesce(obj_description(format('public.%I', v_table)::regclass, 'pg_class'), '')) = 0 THEN
      RAISE EXCEPTION '0319: % does not carry this file''s comment', v_table;
    END IF;
  END LOOP;
  IF position('(0319)' IN coalesce((
       SELECT col_description(a.attrelid, a.attnum)
         FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = 'public.audit_trail'::regclass
          AND a.attname = 'actor_source' AND NOT a.attisdropped), '')) = 0 THEN
    RAISE EXCEPTION '0319: audit_trail.actor_source does not carry this file''s comment';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
