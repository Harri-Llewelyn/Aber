#!/usr/bin/env node
/**
 * Write the broker's Dynamic Security document before the broker starts.
 *
 * Runs on both targets in the credential service's image (node plus the broker's own
 * mosquitto_passwd): the mosquitto-init service on Compose, the assemble-config initContainer on
 * Kubernetes. It reconciles the stored document with the repository's roles and the platform
 * principals from the environment, imports a legacy password file when there is no document yet,
 * and refuses to write anything that would lose a client. mosquitto/README.md states the rules;
 * scripts/lib/mosquitto-dynsec.mjs implements them.
 *
 * Environment:
 *   DYNSEC_FILE                  where the document lives (default /mosquitto/data/dynamic-security.json)
 *   DYNSEC_POLICY_FILE           the roles (default /policy/dynsec-roles.json)
 *   LEGACY_PASSWORD_FILE         imported when DYNSEC_FILE does not exist (default none)
 *   DYNSEC_REQUIRED_PRINCIPALS   space-separated env names that must carry a password; MONITOR is
 *                                always required
 *   MQTT_DYNSEC_ADMIN_USER / MQTT_DYNSEC_ADMIN_PASSWORD   the credential service's account, required
 *   MQTT_<NAME>_USER / MQTT_<NAME>_PASSWORD               one pair per PLATFORM_PRINCIPALS entry
 *   MQTT_BROKER_UID              the owner of the written file (default 1883)
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { CredentialError, hashArgvForUsername, isGatewayId } from './lib/mosquitto-credentials.mjs';
import {
  ADMIN_ROLE,
  DYNSEC_FILE,
  PLATFORM_PRINCIPALS,
  clientFromPasswordEntry,
  importPasswordFile,
  reconcile,
  rolesFor,
} from './lib/mosquitto-dynsec.mjs';

const log = (...args) => console.log('[mosquitto-dynsec-init]', ...args);
const fail = (message) => {
  console.error(`[mosquitto-dynsec-init] ${message}`);
  process.exit(1);
};

const FILE = process.env.DYNSEC_FILE || DYNSEC_FILE;
const POLICY_FILE = process.env.DYNSEC_POLICY_FILE || '/policy/dynsec-roles.json';
const LEGACY_FILE = process.env.LEGACY_PASSWORD_FILE || '';
const BROKER_UID = Number.parseInt(process.env.MQTT_BROKER_UID || '1883', 10);
const REQUIRED = new Set(['MONITOR', ...(process.env.DYNSEC_REQUIRED_PRINCIPALS || '').split(/\s+/).filter(Boolean)]);

/**
 * Hash one password with the broker's own tool. Not a reimplementation: the hash has to be read by
 * the mosquitto that verifies it, and mosquitto_passwd is the one implementation guaranteed to
 * match. The password never touches the shell as text (the argv passes it positionally), and the
 * broker's PBKDF2 parameters are whatever the tool writes.
 */
function hashed(username, password, roles) {
  let argv;
  try {
    argv = hashArgvForUsername(username, password);
  } catch (err) {
    fail(err instanceof CredentialError ? `'${username}': ${err.message}` : err.message);
  }
  const out = execFileSync('/bin/sh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const line = out.trim();
  if (!line.startsWith(`${username}:`)) fail(`mosquitto_passwd produced a line for a different account: ${line.slice(0, 80)}`);
  return clientFromPasswordEntry(line, roles);
}

function main() {
  let policy;
  try {
    policy = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));
  } catch (err) {
    fail(`cannot read the roles at ${POLICY_FILE}: ${err.message}`);
  }

  // The managed clients: the admin, then each platform principal with a password.
  const adminUser = process.env.MQTT_DYNSEC_ADMIN_USER || 'dynsec-admin';
  const adminPassword = process.env.MQTT_DYNSEC_ADMIN_PASSWORD || '';
  if (!adminPassword) {
    fail('MQTT_DYNSEC_ADMIN_PASSWORD is empty. The credential service authenticates as this account; '
      + 'without it no gateway can be issued or revoked. Run: node scripts/setup.mjs');
  }
  const managed = [hashed(adminUser, adminPassword, [ADMIN_ROLE])];
  const platformRoles = new Map();

  for (const { env, role } of PLATFORM_PRINCIPALS) {
    const username = process.env[`MQTT_${env}_USER`] || '';
    const password = process.env[`MQTT_${env}_PASSWORD`] || '';
    if (!username) fail(`MQTT_${env}_USER is empty`);
    if (role === null && !isGatewayId(username)) {
      fail(`MQTT_${env}_USER is '${username}', which is not a gateway sparkplug_id. It must be 'gwy' plus 21 `
        + 'lowercase hex characters: the broker confines the account to spBv1.0/+/+/<username>/# and '
        + 'verify_gateway_binding() requires that segment to be the gateway row\'s generated id.');
    }
    platformRoles.set(username, role);
    if (!password) {
      if (REQUIRED.has(env)) {
        fail(`MQTT_${env}_PASSWORD is empty. `
          + (env === 'MONITOR'
            ? 'The broker\'s own health probes authenticate as this account; without it the broker never reports healthy and nothing that waits on it starts.'
            : 'The broker runs allow_anonymous false, so an empty credential fails as CONNACK 5 with no useful log line at either end. Run: node scripts/setup.mjs'));
      }
      log(`MQTT_${env}_PASSWORD is empty; not creating an account for '${username}'.`);
      continue;
    }
    managed.push(hashed(username, password, rolesFor(role, username).map((r) => r.rolename)));
  }

  // The stored document, or a legacy password file, or nothing.
  let existing = null;
  let imported = null;
  if (existsSync(FILE)) {
    try {
      existing = JSON.parse(readFileSync(FILE, 'utf8'));
    } catch (err) {
      fail(`${FILE} exists and cannot be parsed (${err.message}). Refusing to overwrite the fleet's `
        + 'credentials; repair or move the file by hand.');
    }
    log(`reconciling ${FILE} (${(existing.clients || []).length} client(s) stored)`);
  } else if (LEGACY_FILE && existsSync(LEGACY_FILE)) {
    const result = importPasswordFile(readFileSync(LEGACY_FILE, 'utf8'), platformRoles);
    existing = { clients: result.clients, roles: [], groups: [] };
    imported = result;
    log(`no ${FILE}; importing ${result.clients.length} account(s) from ${LEGACY_FILE}`);
    if (result.unassigned.length) {
      log(`imported with NO ROLE (they authenticate and reach nothing): ${result.unassigned.join(', ')}`);
    }
    if (result.malformed.length) {
      log(`NOT imported, malformed: ${result.malformed.join(', ')}`);
    }
  } else {
    log(`no ${FILE}; starting from the policy and the environment`);
  }

  let config;
  let report;
  try {
    ({ config, report } = reconcile(existing, policy, managed));
  } catch (err) {
    fail(err.message);
  }

  // Atomic: written beside the document and renamed, so the broker can never open a half-written
  // file. Owned by the broker's uid at 0600, because the plugin rewrites it on every change and
  // warns on anything world-readable.
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, '\t')}\n`, { mode: 0o600 });
  try {
    chownSync(tmp, BROKER_UID, BROKER_UID);
    chownSync(dirname(FILE), BROKER_UID, BROKER_UID);
  } catch (err) {
    log(`could not chown to uid ${BROKER_UID}: ${err.message}`);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, FILE);

  if (imported) {
    try {
      renameSync(LEGACY_FILE, `${LEGACY_FILE}.imported`);
      log(`renamed ${LEGACY_FILE} to ${LEGACY_FILE}.imported`);
    } catch (err) {
      log(`imported, but could not rename ${LEGACY_FILE}: ${err.message}`);
    }
  }

  log(
    `wrote ${FILE}: ${config.clients.length} client(s), ${config.roles.length} role(s); `
    + `${report.managed.length} managed, ${report.gateways.length} gateway(s) kept`
    + (report.unmanaged.length ? `, unmanaged kept as-is: ${report.unmanaged.join(', ')}` : ''),
  );
}

main();
