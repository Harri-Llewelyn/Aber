#!/usr/bin/env node
/**
 * Disable broker accounts whose gateway no longer exists.
 *
 * Archiving or deleting a gateway revokes its broker account through a trigger on `gateways`
 * (0038, 0063). An account whose row was deleted BEFORE that path worked has no row to fire a
 * trigger from, and the database has no way to learn the account exists. The broker knows: this
 * reads its client list and compares it with the `gateways` table.
 *
 * IT DISABLES; IT DOES NOT DELETE. Same as the trigger: `disableClient` drops a live session and
 * refuses the next CONNECT, and the account stays listed as disabled on the Access Control page,
 * which is the record of what happened. Deleting a client is a decision an operator takes by hand
 * with `mosquitto_ctrl`.
 *
 * THROUGH THE DATABASE, NOT STRAIGHT AT THE BROKER. `revoke_gateway_credential()` is granted to
 * `service_role`, pulls the revoke secret out of the vault, and posts through the edge function --
 * the one path the Kubernetes NetworkPolicy admits to the credential service. Calling the plugin
 * directly from here would need the admin credential on the host and would be a second way to
 * change the broker's accounts.
 *
 * DRY RUN BY DEFAULT. It lists what it would disable and changes nothing until `--yes`.
 *
 * Usage:
 *   node scripts/revoke-orphaned-broker-accounts.mjs                 # list, change nothing
 *   node scripts/revoke-orphaned-broker-accounts.mjs --yes           # disable them
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and MQTT_DYNSEC_ADMIN_USER /
 * MQTT_DYNSEC_ADMIN_PASSWORD (read from the release Secret when unset).
 */
import { execFileSync } from 'node:child_process';
import { NAMESPACE, missingCredentialAdvice, stackCredentials } from './lib/stack-credentials.mjs';

import { GATEWAY_ID_PATTERN } from './lib/mosquitto-credentials.mjs';
import { assertOk, summariseInventory } from './lib/mosquitto-dynsec.mjs';
import { controlSender } from './lib/mosquitto-control.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--yes');

const SUPABASE_URL = (process.env.SUPABASE_URL || 'http://localhost:54321').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/**
 * CHECKED IN main(), NOT AT MODULE SCOPE. `parseAccounts()` and `strays()` decide which accounts
 * get disabled and are pure, so they are tested without a stack; a module that exits while being
 * imported cannot be tested at all.
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

function adminCredential() {
  const env = stackCredentials(['MQTT_DYNSEC_ADMIN_USER', 'MQTT_DYNSEC_ADMIN_PASSWORD']);
  if (!env.MQTT_DYNSEC_ADMIN_PASSWORD) {
    console.error(missingCredentialAdvice('MQTT_DYNSEC_ADMIN_PASSWORD'));
    process.exit(1);
  }
  return { username: env.MQTT_DYNSEC_ADMIN_USER || 'dynsec-admin', password: env.MQTT_DYNSEC_ADMIN_PASSWORD };
}

/**
 * The broker's client list, read from the plugin the same way the service reads it, inside the
 * broker pod.
 */
function brokerClients() {
  const pod = execFileSync('kubectl', [
    '-n', NAMESPACE, 'get', 'pods',
    '-l', 'app.kubernetes.io/component=mosquitto', '--field-selector=status.phase=Running',
    '-o', 'jsonpath={.items[*].metadata.name}',
  ], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean)[0];
  if (!pod) throw new Error('no Running mosquitto pod');
  const prefix = ['kubectl', '-n', NAMESPACE, 'exec', pod, '-c', 'mosquitto', '--'];
  const admin = adminCredential();
  const send = controlSender({ host: '127.0.0.1', port: 1883, username: admin.username, password: admin.password }, prefix);
  const clients = assertOk(send({ command: 'listClients', verbose: true }));
  return summariseInventory(clients, null).clients;
}

/**
 * GATEWAY ACCOUNTS THAT ARE STILL ENABLED, and the filter is the safety property of this script.
 *
 * `factoryplus_ingestion`, `factoryplus_i3x`, `factoryplus_monitor` and the plugin's admin are
 * platform accounts with no `gateways` row and no prospect of one, so a sweep keyed on "has no
 * gateway row" would disable the ingestion daemon's own credential and stop the stack ingesting
 * anything. Only `gwy` plus 21 hex characters is considered, which is the shape
 * `gateways.sparkplug_id` generates and the same pattern `revoke_gateway_credential()` validates.
 * An account already disabled is done with, and is not listed again on every run.
 */
export function parseAccounts(clients) {
  return (clients || [])
    .filter((c) => c && typeof c.username === 'string' && GATEWAY_ID_PATTERN.test(c.username))
    .filter((c) => c.disabled !== true)
    .map((c) => c.username);
}

/** Accounts at the broker that no gateway row claims. Pure, so the decision is testable. */
export function strays(accounts, liveSparkplugIds) {
  const live = new Set(liveSparkplugIds);
  return accounts.filter((a) => !live.has(a));
}

async function main() {
  requireServiceKey();
  const accounts = parseAccounts(brokerClients());
  // EVERY gateway row, archived included. An archived gateway still has a row, so the trigger and
  // the pg_cron sweep own its credential -- disabling it from here would be a second mechanism
  // acting on the same account, and the two would race over `credential_revoked_at`.
  const gateways = await rest('/gateways?select=sparkplug_id');
  const orphans = strays(accounts, gateways.map((g) => g.sparkplug_id));

  console.log(
    `${accounts.length} enabled gateway account(s) at the broker, ${gateways.length} gateway row(s), ` +
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
      '\nDRY RUN. Nothing was changed. Re-run with --yes to disable each of these at the broker.\n' +
      'A disabled account drops its live session, refuses the next CONNECT, and stays listed as\n' +
      'disabled on the Access Control page.'
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
    `\n${asked} revocation(s) queued. ASKED, NOT DONE: net.http_post is asynchronous, so this is a\n` +
    'request rather than a receipt. Confirm on the Access Control page, which reads the broker.'
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
// suite imports this file; a bare `main()` here would run a revocation from `node --test`.
if (process.argv[1]?.endsWith('revoke-orphaned-broker-accounts.mjs')) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
