-- 0200: The column comments say what the code does.
--
-- Six comments described behaviour the code does not have: a device's and a gateway's description
-- "read by nothing" (i3X serves both), a flow hash "computed by its bootstrap at enrolment" (the
-- heartbeat reports it), a broker root "hand-distributed" into every trust store (it follows the
-- trust bundle), a cell description shown as a help tip on the Site Map (it is a field in the
-- cell's panel), and an area purge skip that 0199's refusals leave no row to reach. Two values
-- kept only for clients, device_schemas.source and publish_schema_version()'s schema_ids_rebound,
-- are marked deprecated. COMMENT ON only: no row, privilege or object changes.
--
-- Reasoning: supabase/README.md, "The column comments say what the code does (0200)". Idempotent.

COMMENT ON COLUMN public.devices.description IS
  'Optional operator note: free text that carries no semantics. The dashboard shows it, and i3X '
  'serves it as the device object''s metadata.description; nothing acts on it. Typed '
  'identification belongs in device_nameplate (0200).';

COMMENT ON COLUMN public.gateways.description IS
  'Optional operator note: free text that carries no semantics. The dashboard shows it, and i3X '
  'serves it as the gateway object''s metadata.description; nothing acts on it (0200).';

COMMENT ON COLUMN public.gateways.flow_hash IS
  'SHA-256 of the flow this appliance last deployed, as its heartbeat reports it: ingestion writes '
  'the Flow_Hash metric on every node-level message that carries one. On the appliance, flow-sync '
  'records the digest on each deploy. Answers "which flow is on that gateway" without a shell on '
  'it. It does NOT detect local edits: an operator who changes the flow in the Node-RED editor '
  'keeps reporting the hash of what was deployed, because the appliance has no way to hash its own '
  'running flow without the admin API and a credential to call it with. '
  'forge_appliance_flow_sha256 is where such an edit shows (0200).';

COMMENT ON COLUMN public.gateways.cert_expires_at IS
  'notAfter of the broker root this appliance trusts, reported by the appliance itself. Enrolment '
  'hands the appliance the root; after that it installs the roots in the trust bundle on the '
  'platform playbook''s main at every convergence, hourly and after boot. A gateway whose root '
  'expires before the platform''s has not converged since the root was re-issued. Reported, not '
  'observed: it is what the appliance HAS, which is the question (0200).';

COMMENT ON COLUMN public.cells.description IS
  'Free text about the cell. The Cells page shows it under the name and in the drawer, the Site '
  'Map as a field in the cell''s panel, and i3X serves it as the cell object''s '
  'metadata.description. Not a topic segment (0200).';

COMMENT ON COLUMN public.areas.auto_delete_at IS
  'When the purge_expired_archives job may delete the row; NULL is permanent retention. The purge '
  'skips an area a device or gateway still names, which only an Area-Wide one does. 0199 refuses '
  'archiving an area while anything is Area-Wide in it, and making anything Area-Wide in an '
  'archived area, so the skip is a guard no row reaches (0200).';

-- Two values kept only for clients that read them, now deprecated: removed no sooner than 1.7.0.
COMMENT ON VIEW public.device_schemas IS
  'Every schema attached to a device, one row per (device, schema): its device_submodels rows. '
  '`source` is always ''device_submodels''. It is deprecated in 1.6.0 and removed no sooner than '
  '1.7.0, so a client should stop selecting it (0200).';

COMMENT ON FUNCTION public.publish_schema_version(draft_schema_id uuid) IS
  'Activates a draft version, archives its parent, and atomically repoints every device_submodels '
  'row from the parent to it. `schema_ids_rebound` is always 0: the devices.schema_id column it '
  'counted was removed in 1.3.0. It is deprecated in 1.6.0 and removed no sooner than 1.7.0; '
  '`devices_rebound` is the count to read (0200).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider. Each comment is read back as the boot left it here; a
-- later file that restates one runs after this check.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_column record;
  v_comment text;
BEGIN
  FOR v_column IN
    SELECT * FROM (VALUES
      ('devices', 'description'),
      ('gateways', 'description'),
      ('gateways', 'flow_hash'),
      ('gateways', 'cert_expires_at'),
      ('cells', 'description'),
      ('areas', 'auto_delete_at')
    ) AS t(table_name, column_name)
  LOOP
    SELECT col_description(a.attrelid, a.attnum) INTO v_comment
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = format('public.%I', v_column.table_name)::regclass
       AND a.attname = v_column.column_name
       AND NOT a.attisdropped;
    IF v_comment IS NULL OR position('(0200)' IN v_comment) = 0 THEN
      RAISE EXCEPTION '0200: %.% does not carry this file''s comment', v_column.table_name, v_column.column_name;
    END IF;
  END LOOP;
  IF position('(0200)' IN coalesce(obj_description('public.device_schemas'::regclass, 'pg_class'), '')) = 0 THEN
    RAISE EXCEPTION '0200: the device_schemas view does not carry this file''s comment';
  END IF;
  IF position('(0200)' IN coalesce(obj_description(
       'public.publish_schema_version(uuid)'::regprocedure, 'pg_proc'), '')) = 0 THEN
    RAISE EXCEPTION '0200: publish_schema_version() does not carry this file''s comment';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
