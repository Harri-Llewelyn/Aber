#!/usr/bin/env node
/**
 * Rotate broker accounts whose gateway no longer exists.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS CANNOT BE A MIGRATION, WHICH IS THE WHOLE REASON IT IS A SCRIPT.
 *
 * `0063` fixed revocation for gateways the platform still knows about: archiving or deleting one
 * now rotates its broker credential, because the gate finally asks a question a virtual gateway can
 * answer. Nothing in SQL can reach the accounts left behind BEFORE that, and not for want of
 * trying -- the row that would have fired the trigger is gone, and the database has no way to learn
 * that an account exists at the broker. Only the password file knows, and only the host can read
 * it.
 *
 * Measured on the stack this was written against: 17 accounts, 5 live gateways, 3 platform
 * services -- and nine `gwy…` accounts belonging to gateways deleted long ago. `0040`'s header
 * predicted four of them and called them harmless:
 *
 *     "So four accounts remain in the password file with no row behind them. They are harmless --
 *      mosquitto.acl confines each to spBv1.0/+/+/%u/# … and SQL could not remove them anyway."
 *
 * The confinement claim is true and is why this is housekeeping rather than an incident. What has
 * changed is that "SQL could not remove them anyway" was the end of the sentence, and this is the
 * rest of it.
 *
 * ---------------------------------------------------------------------------------------------
 * IT ROTATES; IT DOES NOT DELETE. Same design as `0038`, for the same reason: the credential
 * service is add-only by construction, and a delete verb would turn "can mint a confined account"
 * into "can stop the entire fleet publishing". So each stray account is re-provisioned with a
 * password the service generates and nobody records, and the response is discarded.
 *
 * THROUGH THE DATABASE, NOT STRAIGHT AT THE SERVICE. `revoke_gateway_credential()` is granted to
 * `service_role`, pulls the revoke secret out of the vault, and posts through the edge function --
 * the one path the Kubernetes NetworkPolicy admits to the credential sidecar. Calling the service
 * directly from a host script would mean holding that secret here and opening a second edge into
 * credential issuance, which is exactly what that function exists to avoid.
 *
 * ---------------------------------------------------------------------------------------------
 * DRY RUN BY DEFAULT. It lists what it would rotate and changes nothing until `--yes`. A password
 * rotation is irreversible -- the replacement is never recorded anywhere -- so an operator who has
 * mis-identified an account (a gateway mid-provision, a stack pointed at the wrong broker) gets to
 * find out before rather than after.
 *
 * Usage:
 *   node scripts/revoke-orphaned-broker-accounts.mjs                 # list, change nothing
 *   node scripts/revoke-orphaned-broker-accounts.mjs --yes           # rotate them
 *   node scripts/revoke-orphaned-broker-accounts.mjs --target=k8s    # read the Secret, not the file
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const target = (args.find((a) => a.startsWith('--target=')) || '--target=compose').split('=')[1];

const SUPABASE_URL = (process.env.SUPABASE_URL || 'http://localhost:54321').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/**
 * CHECKED IN main(), NOT AT MODULE SCOPE, and that is not a style preference.
 *
 * `parseAccounts()` and `strays()` are the safety-critical halves of this script -- they decide
 * which accounts get rotated irreversibly -- and they are pure, so they can be tested without a
 * stack. A module that calls `process.exit(1)` while being imported cannot be tested at all, which
 * is how the filter that protects `factoryplus_ingestion` would end up covered by nothing.
 */
function requireServiceKey() {
  if (SERVICE_KEY) return;
  console.error(
    'SUPABASE_SERVICE_ROLE_KEY is not set. This reads the gateway inventory through PostgREST and\n' +
    'calls revoke_gateway_credential(), which is granted to service_role alone.'
  );
  process.exit(1);
}

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  'X-ACS-Cymru-Actor': 'service',
};

async function rest(pathname, init = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1${pathname}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${pathname} -> ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

/**
 * The broker's account list, read the way `mosquitto-provision-gateway.mjs` writes it.
 *
 * DELIBERATELY THE SAME TWO MECHANISMS and no third: on Compose the password file inside the
 * container, on Kubernetes the Secret the sidecar mounts. A script that invented its own way to
 * find the accounts would be a second definition of "what accounts exist" to keep in step.
 */
function brokerAccounts() {
  if (target === 'k8s') {
    const encoded = execFileSync('kubectl', [
      '-n', process.env.ACS_CYMRU_NAMESPACE || 'acs-cymru',
      'get', 'secret', process.env.MOSQUITTO_SECRET || 'mosquitto-passwords',
      '-o', 'jsonpath={.data.password_file}',
    ], { encoding: 'utf8' });
    return parseAccounts(Buffer.from(encoded, 'base64').toString('utf8'));
  }
  return parseAccounts(execFileSync('docker', [
    'exec', process.env.MOSQUITTO_CONTAINER || 'acs-cymru_mosquitto',
    'cat', '/mosquitto/config/password_file',
  ], { encoding: 'utf8' }));
}

/**
 * GATEWAY ACCOUNTS ONLY, and the filter is the safety property of this whole script.
 *
 * `factoryplus_ingestion`, `factoryplus_i3x` and `factoryplus_monitor` are platform services with
 * no `gateways` row and no prospect of one, so a sweep keyed on "has no gateway row" would rotate
 * the ingestion daemon's own credential and stop the stack ingesting anything -- from the script
 * whose subject is tidying up. Only `gwy` + 21 hex characters is considered, which is the shape
 * `gateways.sparkplug_id` generates and the same pattern `revoke_gateway_credential()` validates.
 */
export function parseAccounts(passwordFile) {
  return passwordFile
    .split('\n')
    .map((line) => line.split(':')[0].trim())
    .filter((name) => /^gwy[0-9a-f]{21}$/.test(name));
}

/** Accounts at the broker that no gateway row claims. Pure, so the decision is testable. */
export function strays(accounts, liveSparkplugIds) {
  const live = new Set(liveSparkplugIds);
  return accounts.filter((a) => !live.has(a));
}

async function main() {
  requireServiceKey();
  const accounts = brokerAccounts();
  // EVERY gateway row, archived included. An archived gateway still has a row, so `0063`'s trigger
  // and the pg_cron sweep own its credential -- rotating it from here would be a second mechanism
  // acting on the same account, and the two would race over `credential_revoked_at`.
  const gateways = await rest('/gateways?select=sparkplug_id');
  const orphans = strays(accounts, gateways.map((g) => g.sparkplug_id));

  console.log(
    `${accounts.length} gateway account(s) at the broker, ${gateways.length} gateway row(s), ` +
    `${orphans.length} orphaned.`
  );

  if (orphans.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  console.log('\nOrphaned accounts -- a credential exists for a gateway that does not:\n');
  for (const id of orphans) console.log(`  ${id}`);

  if (!apply) {
    console.log(
      '\nDRY RUN. Nothing was changed. Re-run with --yes to rotate each of these to a password\n' +
      'the credential service generates and nobody records, which is how this platform revokes.\n' +
      'The accounts remain in the password file as inert hashes -- see 0038 for why revocation is\n' +
      'a rotation and not a deletion.'
    );
    return;
  }

  let asked = 0;
  const refused = [];
  for (const id of orphans) {
    try {
      // Returns false when the credential service is not configured -- an unconfigured stack
      // should say so rather than report a revocation that never left the database.
      const queued = await rest('/rpc/revoke_gateway_credential', {
        method: 'POST',
        body: JSON.stringify({ p_sparkplug_id: id }),
      });
      if (queued) { asked += 1; console.log(`  asked: ${id}`); }
      else refused.push({ id, reason: 'revoke_gateway_credential() returned false -- service not configured' });
    } catch (err) {
      refused.push({ id, reason: err.message });
    }
  }

  console.log(
    `\n${asked} rotation(s) queued. ASKED, NOT DONE: net.http_post is asynchronous, so this is a\n` +
    'request rather than a receipt. Confirm with the broker itself --\n' +
    '  docker compose logs mosquitto | grep -i reload\n' +
    'or by attempting a connection with a password you hold.'
  );

  if (refused.length > 0) {
    console.error(
      `\n${refused.length} account(s) could not be asked:\n` +
      refused.map((r) => `  ${r.id}: ${r.reason}`).join('\n')
    );
    process.exitCode = 1;
  }
}

// Importable for its pure halves without running the sweep -- see requireServiceKey(). The test
// suite imports this file; a bare `main()` here would run a rotation from `node --test`.
if (process.argv[1]?.endsWith('revoke-orphaned-broker-accounts.mjs')) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
