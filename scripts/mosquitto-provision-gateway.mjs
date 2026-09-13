#!/usr/bin/env node
/**
 * Issue a Mosquitto credential for one gateway, from a shell.
 *
 * The dashboard and the enrolment bundle are the ordinary paths; this is the break-glass one, for
 * a stack whose credential service is down or whose only Administrator cannot sign in. It sends
 * the same commands the service sends (scripts/lib/mosquitto-dynsec.mjs, issueWithControl) to the
 * broker's Dynamic Security plugin, through `mosquitto_rr` inside the broker pod, so the
 * account it issues is the account the service would have issued: its own role, confined to
 * `spBv1.0/+/+/<sparkplug_id>/#`, plus the shared gateway role.
 *
 * Usage:
 *   node scripts/mosquitto-provision-gateway.mjs <sparkplug_id> [password]
 *
 * With no password one is generated and printed. It is printed EXACTLY ONCE: the plugin stores a
 * hash and there is no way to read it back. The plugin's admin credential comes from
 * MQTT_DYNSEC_ADMIN_USER / MQTT_DYNSEC_ADMIN_PASSWORD, from the environment or the release Secret.
 *
 * Nothing here records the issue in the database. A gateway issued this way reads "No platform
 * record" on the Access Control page beside a live broker account, which is the honest state.
 */
import { execFileSync } from 'node:child_process';

import {
  GATEWAY_ID_PATTERN,
  assertSafePassword,
  generatePassword,
} from './lib/mosquitto-credentials.mjs';
import { issueWithControl } from './lib/mosquitto-dynsec.mjs';
import { controlSender } from './lib/mosquitto-control.mjs';
import { NAMESPACE, missingCredentialAdvice, stackCredentials } from './lib/stack-credentials.mjs';


const args = process.argv.slice(2);
let help = false;
const positional = [];
for (const arg of args) {
  if (arg === '-h' || arg === '--help') help = true;
  else positional.push(arg);
}
const [sparkplugId, suppliedPassword] = positional;

const usage = () => {
  console.error('Usage: node scripts/mosquitto-provision-gateway.mjs <sparkplug_id> [password]');
  process.exit(2);
};

if (help || !sparkplugId) usage();

// Refuse anything that is not a gateway id. A username that does not match a real edge-node
// segment produces an account confined to a subtree nothing will ever publish to -- which fails
// silently at 3am rather than here.
if (!GATEWAY_ID_PATTERN.test(sparkplugId)) {
  console.error(
    `'${sparkplugId}' is not a gateway sparkplug_id ("gwy" followed by 21 lowercase hex ` +
    'characters). Copy it from the gateway\'s page in the dashboard.'
  );
  process.exit(2);
}

const password = suppliedPassword || generatePassword();
try {
  assertSafePassword(password);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

/** The admin pair, from the environment or the release Secret. */
function adminCredential() {
  const env = stackCredentials(['MQTT_DYNSEC_ADMIN_USER', 'MQTT_DYNSEC_ADMIN_PASSWORD']);
  if (!env.MQTT_DYNSEC_ADMIN_PASSWORD) {
    console.error(missingCredentialAdvice('MQTT_DYNSEC_ADMIN_PASSWORD'));
    process.exit(2);
  }
  return { username: env.MQTT_DYNSEC_ADMIN_USER || 'dynsec-admin', password: env.MQTT_DYNSEC_ADMIN_PASSWORD };
}

const run = (cmd, argv) =>
  execFileSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();

/**
 * The single running broker pod, or null. `{.items[*]...}` rather than `{.items[0]...}`: the
 * indexed form makes kubectl fail with a multi-line template dump when the list is empty.
 */
function brokerPod() {
  try {
    const names = run('kubectl', [
      '-n', NAMESPACE, 'get', 'pods',
      '-l', 'app.kubernetes.io/component=mosquitto',
      '--field-selector=status.phase=Running',
      '-o', 'jsonpath={.items[*].metadata.name}',
    ]);
    return names.split(/\s+/).filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

/** Where `mosquitto_rr` runs: inside the broker pod, dialling its own loopback. */
function execPrefix() {
  const pod = brokerPod();
  if (!pod) {
    console.error(
      `No Running mosquitto pod found in namespace '${NAMESPACE}'.\n` +
      `  kubectl -n ${NAMESPACE} get pods -l app.kubernetes.io/component=mosquitto`
    );
    process.exit(1);
  }
  return ['kubectl', '-n', NAMESPACE, 'exec', pod, '-c', 'mosquitto', '--'];
}

const admin = adminCredential();
const send = controlSender(
  { host: '127.0.0.1', port: 1883, username: admin.username, password: admin.password },
  execPrefix(),
);

let replaced;
try {
  ({ replaced } = issueWithControl(send, sparkplugId, password));
} catch (err) {
  console.error(`Failed to issue '${sparkplugId}': ${err.message}`);
  process.exit(1);
}

console.log(`\n${replaced ? 'Re-issued' : 'Issued'} MQTT credential for gateway ${sparkplugId}\n`);
console.log(`  username: ${sparkplugId}`);
console.log(`  password: ${password}`);
console.log(
  '\nThis password is not recoverable -- the broker stores only a hash. Record it now.'
);
console.log(
  `This account may publish and subscribe ONLY beneath spBv1.0/+/+/${sparkplugId}/#.\n` +
  'It is applied to the running broker already; nothing needs reloading.\n'
);
