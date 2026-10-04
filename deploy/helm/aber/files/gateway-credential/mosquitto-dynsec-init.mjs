#!/usr/bin/env node
// Writes the broker's Dynamic Security document before the broker starts, as its assemble-config
// initContainer on the credential service's image (node plus the broker's own mosquitto_passwd). It
// reconciles the stored document with the repository's roles and the platform principals from the
// environment, and refuses to write anything that would lose a client. mosquitto/README.md states
// the rules; lib/mosquitto-dynsec.mjs implements them.
//
// Environment:
//   DYNSEC_FILE                  the document (default /mosquitto/data/dynamic-security.json)
//   DYNSEC_POLICY_FILE           the roles (default /policy/dynsec-roles.json)
//   PRIMARY_HOST_ID              required; the ingestion role is granted write on spBv1.0/STATE/<id>
//   DIRECTORY_MQTT_TOPIC_PREFIX  required; the ingestion role is granted <prefix>/#
//   DYNSEC_REQUIRED_PRINCIPALS   space-separated env names that must carry a password; MONITOR always
//   MQTT_DYNSEC_ADMIN_USER / MQTT_DYNSEC_ADMIN_PASSWORD   the credential service's account, required
//   MQTT_<NAME>_USER / MQTT_<NAME>_PASSWORD               one pair per PLATFORM_PRINCIPALS entry
//   MQTT_BROKER_UID              the owner of the written file (default 1883)
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
  directoryTopicFilter,
  primaryHostStateTopic,
  reconcile,
  rolesFor,
  withDirectoryGrant,
  withPrimaryHostGrant,
} from './lib/mosquitto-dynsec.mjs';

const log = (...args) => console.log('[mosquitto-dynsec-init]', ...args);
const fail = (message) => {
  console.error(`[mosquitto-dynsec-init] ${message}`);
  process.exit(1);
};

const FILE = process.env.DYNSEC_FILE || DYNSEC_FILE;
const POLICY_FILE = process.env.DYNSEC_POLICY_FILE || '/policy/dynsec-roles.json';
const BROKER_UID = Number.parseInt(process.env.MQTT_BROKER_UID || '1883', 10);
const REQUIRED = new Set(['MONITOR', ...(process.env.DYNSEC_REQUIRED_PRINCIPALS || '').split(/\s+/).filter(Boolean)]);

// Hashed by the broker's own mosquitto_passwd, the one implementation guaranteed to match the
// mosquitto that verifies it. The password rides argv positionally and never touches the shell as
// text; the PBKDF2 parameters are whatever the tool writes.
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

  // The primary host's write grant: one literal topic derived from the deployment's host id, not a
  // line in the roles file. Required, because the daemon refuses to start without the same value.
  const primaryHostId = (process.env.PRIMARY_HOST_ID || '').trim();
  if (!primaryHostId) {
    fail('PRIMARY_HOST_ID is empty. It names the Sparkplug primary host application whose STATE '
      + 'every gateway watches, and the ingestion daemon refuses to start without it, so a broker '
      + 'reconciled without the matching write grant would leave that daemon unable to publish. '
      + 'Set ingestion.primaryHostId in the chart values.');
  }
  try {
    policy = withPrimaryHostGrant(policy, primaryHostId);
  } catch (err) {
    fail(`PRIMARY_HOST_ID: ${err.message}`);
  }
  log(`primary host '${primaryHostId}': granting the ingestion role write on ${primaryHostStateTopic(primaryHostId)}`);

  // The Directory subtree, for the same reason: the chart renders one prefix for this reconcile and
  // for the daemon that publishes into it, since a mismatch at QoS 0 is silent. Required rather than
  // defaulted, so a chart that stopped passing it fails here.
  const directoryPrefix = (process.env.DIRECTORY_MQTT_TOPIC_PREFIX || '').trim();
  if (!directoryPrefix) {
    fail('DIRECTORY_MQTT_TOPIC_PREFIX is empty. It names the subtree the ingestion daemon writes '
      + 'the Directory to, and the broker grant is derived from it, so a reconcile without it '
      + 'leaves the only writer of the Directory unable to publish -- silently, at QoS 0. It is '
      + 'derived from ingestion.sparkplugGroup unless the chart values name it.');
  }
  try {
    policy = withDirectoryGrant(policy, directoryPrefix);
  } catch (err) {
    fail(`DIRECTORY_MQTT_TOPIC_PREFIX: ${err.message}`);
  }
  log(`directory: granting the ingestion role ${directoryTopicFilter(directoryPrefix)}`);

  const adminUser = process.env.MQTT_DYNSEC_ADMIN_USER || 'dynsec-admin';
  const adminPassword = process.env.MQTT_DYNSEC_ADMIN_PASSWORD || '';
  if (!adminPassword) {
    fail('MQTT_DYNSEC_ADMIN_PASSWORD is empty. The credential service authenticates as this account; '
      + 'without it no gateway can be issued or revoked. Run: node scripts/setup.mjs');
  }
  // The managed clients: the admin, then each platform principal that has a password.
  const managed = [hashed(adminUser, adminPassword, [ADMIN_ROLE])];

  for (const { env, role } of PLATFORM_PRINCIPALS) {
    const username = process.env[`MQTT_${env}_USER`] || '';
    const password = process.env[`MQTT_${env}_PASSWORD`] || '';
    if (!username) fail(`MQTT_${env}_USER is empty`);
    if (role === null && !isGatewayId(username)) {
      fail(`MQTT_${env}_USER is '${username}', which is not a gateway sparkplug_id. It must be 'gwy' plus 21 `
        + 'lowercase hex characters: the broker confines the account to spBv1.0/+/+/<username>/# and '
        + 'verify_gateway_binding() requires that segment to be the gateway row\'s generated id.');
    }
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

  // The stored document, or nothing.
  let existing = null;
  if (existsSync(FILE)) {
    try {
      existing = JSON.parse(readFileSync(FILE, 'utf8'));
    } catch (err) {
      fail(`${FILE} exists and cannot be parsed (${err.message}). Refusing to overwrite the fleet's `
        + 'credentials; repair or move the file by hand.');
    }
    log(`reconciling ${FILE} (${(existing.clients || []).length} client(s) stored)`);
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

  // Atomic: written beside the document and renamed, so the broker never opens a half-written file.
  // Owned by the broker's uid at 0600, because the plugin rewrites it on every change and warns on
  // anything world-readable.
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

  log(
    `wrote ${FILE}: ${config.clients.length} client(s), ${config.roles.length} role(s); `
    + `${report.managed.length} managed, ${report.gateways.length} gateway(s) kept`
    + (report.unmanaged.length ? `, unmanaged kept as-is: ${report.unmanaged.join(', ')}` : ''),
  );
}

main();
