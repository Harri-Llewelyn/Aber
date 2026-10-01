-- Counts that must be identical either side of a backup and restore.
--
-- Emitted as `key=value` lines, one per row, so the rehearsal can diff two runs of this file with
-- `diff` rather than by parsing a table. Run with `psql -tA` -- the workflow does.
--
-- WHY A DIFF AND NOT A THRESHOLD. "devices > 0" passes for a restore that recovered one device out
-- of four hundred. The only assertion worth making is that the number did not move, and the only
-- way to make it is to record what it was before.
--
-- WHY audit_trail IS COUNTED PER PARTITION AS WELL AS IN TOTAL (0079). A partitioned table can
-- come back with every row present and every row in the DEFAULT partition -- which is a correct
-- row count over a table whose retention no longer works, because retiring a month by DETACH would
-- silently leave those rows behind. pg_dump writes `COPY public.audit_trail`, so rows are
-- re-routed by the live partition constraints on the way in; if the restored database has lost the
-- monthly partitions, they all land in the default and this is the line that says so.

SELECT 'cells='          || count(*) FROM public.cells;
SELECT 'gateways='       || count(*) FROM public.gateways;
SELECT 'devices='        || count(*) FROM public.devices;
-- Minus the backup's own rows: the backup is an audited act (0101), so the request lands in the
-- trail before the dump is taken and the service's reconcile of the job the dump carries as
-- RUNNING lands after the restore. Neither is data the restore was asked to bring back.
SELECT 'audit_trail=' || count(*) FROM public.audit_trail
 WHERE entity_type NOT IN ('backup_jobs', 'backups');
SELECT 'audit_trail_default=' || count(*) FROM public.audit_trail_default;
SELECT 'audit_trail_partitions=' || count(*)
  FROM pg_inherits WHERE inhparent = 'public.audit_trail'::regclass;
SELECT 'schemas='        || count(*) FROM public.schemas;
SELECT 'system_settings='|| count(*) FROM public.system_settings;
SELECT 'roles='          || count(*) FROM public.roles;
SELECT 'user_roles='     || count(*) FROM public.user_roles;
SELECT 'auth_users='     || count(*) FROM auth.users;
SELECT 'storage_buckets='|| count(*) FROM storage.buckets;
SELECT 'storage_objects='|| count(*) FROM storage.objects;
SELECT 'vault_secrets='  || count(*) FROM vault.secrets;
