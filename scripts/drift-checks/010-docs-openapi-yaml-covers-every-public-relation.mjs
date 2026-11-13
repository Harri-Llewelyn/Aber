import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { edgeFunctionNames, fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 10. docs/openapi.yaml covers every public relation and every edge function. The spec is the
// only externally facing contract this project publishes.
//
// Regex, not a YAML parse: this runs before `npm install`. Both sides are read with narrow
// patterns: `CREATE TABLE/VIEW public.x` out of the migrations, and 2-space-indented `/path:`
// keys out of the spec.
// -------------------------------------------------------------------------------------------------
export default function check() {
  // Relations that are deliberately NOT part of the published contract, each for a stated reason.
  // An exclusion needs a justification here; the point of the check is that nothing falls out
  // quietly, and an unexplained name in this list is indistinguishable from an oversight.
  const NOT_PUBLISHED = {
    directory_liveness_probe:
      'one row holding the in-flight pg_net request id for the Prometheus liveness probe (0054). ' +
      'RLS on with no policy and the anon/authenticated grants revoked -- infrastructure, and a ' +
      'writable request-id table would let a caller redirect where the probe reads liveness from',
    directory_figures_probe:
      'one row holding the in-flight pg_net request id for refresh_directory_figures() (0223), as ' +
      'directory_liveness_probe holds liveness\'s. RLS on with no policy and nothing granted to ' +
      'anon/authenticated; the System page reads the figures from directory_figures',
    gateway_revocation_requests:
      'the in-flight pg_net request id behind each archived gateway\'s revocation stamp (0158). RLS ' +
      'on with no policy, nothing granted to anon/authenticated, and service_role may only read it: ' +
      'revoke_gateway_credential() writes it and the revocation sweep deletes it',
    forge_sweep_lease:
      'one row saying which forge-sweep pass may run (0156). RLS on with no policy, nothing granted ' +
      'to anon/authenticated, and service_role may only read it: it moves through three service_role ' +
      'RPCs that forge-sweep calls, and a browser has no reason to see which pass is running',
    notification_dispatch_lease:
      'one row saying which notification-dispatch pass may run (0247), as forge_sweep_lease does for ' +
      'the forge. RLS on with no policy and nothing granted to an API role: it moves through three ' +
      'RPCs that notification-dispatch calls as service_role',
    schema_bootstrap:
      'one row recording whether db-init reached the end of the migration chain on this boot ' +
      '(0072). RLS on with no policy and the anon/authenticated grants revoked -- it is bootstrap ' +
      'state read by psql, and the only readers are db-init and the e2e-validate Job init ' +
      'container, both of which connect as postgres rather than over PostgREST',
    physical_backup_runs:
      "the platform database's own pgBackRest runs (0173), written by the backup sidecar as the " +
      'superuser. RLS on, nothing granted to anon/authenticated/service_role, and only pg_monitor may ' +
      'read it, for the exporter; the Backups page reads platform_backup_state(), Administrator-only',
    physical_backup_schedule:
      "one row holding the hour and weekday the platform database's backup sidecar started with (0173). " +
      'RLS on with no policy and nothing granted to an API role; read through platform_backup_state()',
    backup_service_report:
      "one row holding the backup volume's free and total bytes and the schedule, as the backup service " +
      'last reported them (0179). RLS on with no policy and nothing granted to an API role; written by ' +
      'the backup_report() gate and read through backup_summary(), Administrator-only',
    capture_uploads:
      'the capture uploads begun and not yet registered (0190). RLS on with no policy and nothing granted to an ' +
      'API role: begin_capture_upload() writes it, register_uploaded_capture() closes it, and the broker-captures ' +
      'policies read it through is_open_capture_upload() and is_unclaimed_capture_object()',
    capture_downloads:
      'the capture downloads issued within the last minute (0195). RLS on with no policy and nothing granted to an ' +
      'API role: issue_capture_download() writes it, and the broker-captures read policy reads it through ' +
      'is_open_capture_download()',
    roles: 'RBAC internals — managed by migrations and Studio, not an app-facing endpoint',
    permissions: 'RBAC internals',
    role_permissions: 'RBAC internals',
    user_roles: 'RBAC internals — read server-side by the two userinfo functions, never by a client',
    access_removals:
      'RBAC internals (0166): the role an Administrator removed with a person\'s access, kept for '
      + 'restoring it. RLS on with no policy and nothing granted to anon/authenticated; the People '
      + 'tab reads it through list_people(), which is Administrator-only',
    principal_permissions:
      'RBAC internals — the machine-side twin of role_permissions (0080). A browser reads it only '
      + 'through list_machine_principals(), which is Administrator-only and returns permission '
      + 'NAMES rather than the join, for the same reason user_roles is not published: the tables '
      + 'that decide who is who are read server-side, never by a client',
    webhook_endpoints:
      'migration-managed with NO write RLS policy by design; a writable endpoint table is an SSRF primitive',
    gateway_enrollment_tokens:
      'RLS on with NO policy and the anon/authenticated grants revoked — reachable only by '
      + 'service_role, i.e. only by the enroll-gateway function. Publishing a path for it would '
      + 'document an endpoint that answers 401 to every caller a reader could actually be',
  platform_health:
      'Platform condition counts -- stale gateways, stuck enrolments, quarantine depth -- '
      + 'granted to `grafana_reader` alone and revoked from anon/authenticated by 0029. It exists '
      + 'so an alert rule can read a COUNT without the dashboard reader being granted the asset '
      + 'inventory it would otherwise derive one from; the browser gets the same facts through '
      + 'its own RLS-checked queries',
  storage_footprint:
      'Byte counts and chunk horizons for both databases, granted to `grafana_reader` alone and '
      + 'revoked from anon/authenticated by 0027. It is read by the Grafana `supabase` datasource '
      + 'over a direct connection, never over PostgREST, so a documented path would answer 403 to '
      + 'every caller the OpenAPI spec describes',
  gateway_health:
      'Per-gateway identity, heartbeat freshness and the appliance health 0035 records, granted '
      + 'to `grafana_reader` alone and revoked from anon/authenticated by 0036 -- the third view '
      + 'in the same arrangement as platform_health and storage_footprint above. It backs the '
      + 'Gateway Fleet Health dashboard and the certificate-expiry alert rule over a direct '
      + 'connection, never over PostgREST. The browser reads the same facts from `gateways` and '
      + '`gateway_status` with RLS applied, which is why publishing a second, RLS-free path to '
      + 'them would be a downgrade rather than a convenience',
  audit_trail_partition_health:
      'Partition counts and default-partition depth for the audit table (0079), granted to '
      + '`grafana_reader` alone and revoked from anon/authenticated -- the same arrangement as '
      + 'platform_health and storage_footprint above. It is read by the Grafana `supabase` '
      + 'datasource over a direct connection so an alert can see that the monthly partition job '
      + 'has stopped, and it counts audit rows: a published path would be a way to size the '
      + 'security lane without holding audit_trail:read',
  backup_health:
      'How long since the platform backup last succeeded (0144), granted to `grafana_reader` alone '
      + 'and revoked from anon/authenticated -- the same arrangement as the views above. It reads '
      + 'backup_jobs as its owner so the Backup Stale rule can see it; the Backups page reads the '
      + 'table itself, under the Administrator-only RLS a published path would bypass',
  backup_offsite_health:
      'How long the newest backup has gone without an off-site copy (0151), granted to '
      + '`grafana_reader` alone and revoked from anon/authenticated, like backup_health above. It '
      + 'reads backups, the destination settings and the vault through an owner-run function so '
      + 'the Off-site Backup Stale rule can see a number and nothing behind it',
  service_token_health:
      'Every live machine-identity token with its warn point (0204), granted to `grafana_reader` '
      + 'alone and revoked from anon/authenticated, like backup_health above. It reads the '
      + 'TOKEN_MINTED audit rows through an owner-run function so the Service Token Expiring rule '
      + 'needs no privilege on audit_trail; the Access Control page reads those rows itself, under '
      + 'the security lane\'s RLS',
  audit_trail_default:
      'The DEFAULT partition of audit_trail (0079), which exists so that a lapsed partition '
      + 'job degrades instead of refusing every audit write -- and therefore every asset write, '
      + 'since the audit INSERT is a trigger on cells/gateways/devices. Not an endpoint in its '
      + 'own right: readers use the parent, where the RLS policies are, and 0079 revokes every '
      + 'application-role privilege on partitions precisely so that this name is unreachable',
  one_shot_migrations:
      'The ledger for migrations that must run EXACTLY ONCE rather than on every boot like the '
      + 'rest of the chain (0040). RLS on with no policy at all and the anon/authenticated grants '
      + 'revoked, so nothing outside a migration can see it -- and a published path would invite '
      + 'a caller to delete a row, which is how you get a one-shot migration to run a second time '
      + 'and re-delete assets an operator has since provisioned on purpose',
  };

  const spec = read('docs/openapi.yaml');
  // Path keys are the only 2-space-indented lines beginning with a slash. Deeper indentation is a
  // parameter or a schema, and `servers:` entries are list items ("  - url:").
  const specPaths = new Set(
    [...spec.matchAll(/^ {2}(\/[^\s:]*):/gm)].map((m) => m[1])
  );

  let migrationSql = '';
  for (const f of readdirSync(join(REPO, 'supabase/migrations'))) {
    if (f.endsWith('.sql')) {
      migrationSql += readFileSync(join(REPO, 'supabase/migrations', f), 'utf8') + '\n';
    }
  }
  const relations = new Set(
    [...migrationSql.matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FOREIGN\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.([a-z0-9_]+)/gi
    )].map((m) => m[1].toLowerCase())
  );

  const undocumented = [...relations]
    .filter((r) => !(r in NOT_PUBLISHED))
    .filter((r) => !specPaths.has(`/rest/v1/${r}`))
    .sort();

  // The reverse direction matters just as much: a path for a relation that no longer exists is a
  // contract promising an endpoint that 404s.
  const phantom = [...specPaths]
    .filter((p) => p.startsWith('/rest/v1/') && !p.startsWith('/rest/v1/rpc/'))
    .map((p) => p.slice('/rest/v1/'.length))
    .filter((r) => !relations.has(r))
    .sort();

  // Same source as check 5: what is ROUTABLE, not what is on disk. An unrouted directory has no
  // URL, so requiring an OpenAPI path for it would demand documenting an endpoint that 404s.
  const functions = edgeFunctionNames();
  const undocumentedFns = functions.filter((f) => !specPaths.has(`/functions/v1/${f}`));

  if (undocumented.length) {
    fail(
      `docs/openapi.yaml has no path for public relation(s): ${undocumented.join(', ')}. ` +
        `Add /rest/v1/<name>, or list it in NOT_PUBLISHED with a reason.`
    );
  }
  if (phantom.length) {
    fail(`docs/openapi.yaml documents /rest/v1/ path(s) with no such relation: ${phantom.join(', ')}`);
  }
  if (undocumentedFns.length) {
    fail(`docs/openapi.yaml has no path for edge function(s): ${undocumentedFns.join(', ')}`);
  }
  if (!undocumented.length && !phantom.length && !undocumentedFns.length) {
    const published = relations.size - Object.keys(NOT_PUBLISHED).filter((r) => relations.has(r)).length;
    pass(
      `openapi.yaml covers all ${published} published relations and all ${functions.length} edge functions`
    );
  }
}
