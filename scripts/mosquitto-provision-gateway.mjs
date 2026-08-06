#!/usr/bin/env node
/**
 * Issue a Mosquitto credential for one gateway.
 *
 * WHY A GATEWAY NEEDS ITS OWN CREDENTIAL. `mosquitto.acl` confines each client to
 * `spBv1.0/+/+/%u/#`, where `%u` is the connecting username. That rule only constrains anything
 * if a gateway's username IS its `sparkplug_id` -- a gateway sharing the platform-wide
 * `factoryplus` account is a trusted principal and is confined by nothing at the broker tier.
 *
 * So: one account per gateway, named after the id it is allowed to publish under.
 *
 * Usage:
 *   node scripts/mosquitto-provision-gateway.mjs <sparkplug_id> [password]
 *   node scripts/mosquitto-provision-gateway.mjs --target=k8s <sparkplug_id> [password]
 *
 * With no password one is generated and printed. It is printed EXACTLY ONCE -- mosquitto_passwd
 * stores a hash and there is no way to read it back, which is the point.
 *
 * ------------------------------------------------------------------------------------------------
 * TWO BACKENDS, ONE SCRIPT, because the ACL reasoning above must live in one place.
 *
 *   --target=compose (default)
 *     `docker exec` into the broker, `mosquitto_passwd -b` into the volume, `kill -HUP 1`.
 *
 *   --target=k8s
 *     The Secret is the source of truth: read it, add the account, patch it back, THEN force the
 *     reload rather than waiting for it. See the M1 note on `reload()` below for why the forcing
 *     is the whole point.
 * ------------------------------------------------------------------------------------------------
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const GATEWAY_ID_PATTERN = /^gwy[0-9a-f]{21}$/;

// --- Compose backend -------------------------------------------------------------------------
const CONTAINER = process.env.MOSQUITTO_CONTAINER || 'factoryplus_mosquitto';
const PASSWORD_FILE = '/mosquitto/config/password_file';

// --- Kubernetes backend ----------------------------------------------------------------------
const NAMESPACE = process.env.FACTORYPLUS_NAMESPACE || 'factoryplus';
const SECRET_NAME = process.env.MOSQUITTO_SECRET || 'mosquitto-passwords';
const SECRET_KEY = 'password_file';
const DEPLOYMENT = process.env.MOSQUITTO_DEPLOYMENT || 'mosquitto';

const args = process.argv.slice(2);
let target = 'compose';
const positional = [];
for (const arg of args) {
  if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
  else if (arg === '-h' || arg === '--help') target = 'help';
  else positional.push(arg);
}
const [sparkplugId, suppliedPassword] = positional;

const usage = () => {
  console.error('Usage: node scripts/mosquitto-provision-gateway.mjs [--target=compose|k8s] <sparkplug_id> [password]');
  process.exit(2);
};

if (target === 'help' || !sparkplugId) usage();
if (target !== 'compose' && target !== 'k8s') {
  console.error(`Unknown --target='${target}'. Expected 'compose' or 'k8s'.`);
  process.exit(2);
}

// Refuse anything that is not a gateway id. A username that does not match a real edge-node
// segment produces an account the ACL confines to a subtree nothing will ever publish to --
// which fails silently at 3am rather than here.
if (!GATEWAY_ID_PATTERN.test(sparkplugId)) {
  console.error(
    `'${sparkplugId}' is not a gateway sparkplug_id ("gwy" followed by 21 lowercase hex ` +
    'characters). Copy it from the gateway\'s page in the dashboard.'
  );
  process.exit(2);
}

// 32 bytes of base64url. Long enough that the credential is not the weak link, and free of
// shell-hostile characters so it can be pasted into a gateway config without quoting games.
const password = suppliedPassword || randomBytes(24).toString('base64url');

const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts });

// =================================================================================================
// Compose
// =================================================================================================
function provisionCompose() {
  try {
    run('docker', ['exec', CONTAINER, 'mosquitto_passwd', '-b', PASSWORD_FILE, sparkplugId, password], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    // Reload rather than restart: a restart drops every connected gateway, and this is an
    // additive change that the running broker can absorb.
    run('docker', ['exec', CONTAINER, 'sh', '-c', 'kill -HUP 1'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch (err) {
    console.error(`Failed to provision '${sparkplugId}': ${err.message}`);
    console.error(`Is the '${CONTAINER}' container running? (docker compose up -d mosquitto)`);
    process.exit(1);
  }
}

// =================================================================================================
// Kubernetes
// =================================================================================================

/**
 * The single running broker pod, or null.
 *
 * `{.items[*]...}` rather than `{.items[0]...}`: the indexed form makes kubectl fail with a
 * multi-line jsonpath template dump when the list is empty, which is the NORMAL case here (no
 * cluster, wrong namespace, broker not up) and buries the legible message this script prints
 * instead. The star form yields an empty string.
 *
 * stderr is captured rather than inherited for the same reason -- this call is an expected-may-fail
 * probe, not an operation whose failure the operator needs to read.
 */
function brokerPod() {
  try {
    const names = run(
      'kubectl',
      [
        '-n', NAMESPACE, 'get', 'pods',
        '-l', 'app.kubernetes.io/component=mosquitto',
        '--field-selector=status.phase=Running',
        '-o', 'jsonpath={.items[*].metadata.name}',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    return names.split(/\s+/).filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

/**
 * Hash the new account by running mosquitto_passwd INSIDE the broker pod, against a scratch copy.
 *
 * The hash must be produced by a compatible mosquitto_passwd, and the broker's own image is the one
 * implementation guaranteed to match the broker reading it. Hashing on the operator's laptop would
 * work only if they happened to have a compatible mosquitto installed at a compatible version.
 */
function hashedEntry(pod) {
  const script = [
    'set -e',
    'tmp=$(mktemp)',
    // -c: this scratch file holds ONE account. The real merge happens in the Secret, below.
    `mosquitto_passwd -b -c "$tmp" '${sparkplugId}' '${password}'`,
    'cat "$tmp"',
    'rm -f "$tmp"',
  ].join('; ');
  return run('kubectl', ['-n', NAMESPACE, 'exec', pod, '-c', 'mosquitto', '--', '/bin/sh', '-c', script]).trim();
}

/** Current Secret contents, or '' when the Secret or key does not exist yet. */
function readSecret() {
  try {
    const b64 = run('kubectl', [
      '-n', NAMESPACE, 'get', 'secret', SECRET_NAME,
      '-o', `jsonpath={.data.${SECRET_KEY}}`,
    ]).trim();
    return b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
  } catch {
    return '';
  }
}

/**
 * Replace this gateway's line and write the Secret back.
 *
 * PATCHED, NOT RE-CREATED: `kubectl create secret --dry-run | apply` would drop any other key, and
 * re-provisioning an existing gateway must REPLACE its line rather than append a second one --
 * Mosquitto reads the first match, so a duplicate would silently pin the old password.
 */
function writeSecret(contents) {
  const b64 = Buffer.from(contents, 'utf8').toString('base64');
  const patch = JSON.stringify({ data: { [SECRET_KEY]: b64 } });
  try {
    run('kubectl', ['-n', NAMESPACE, 'patch', 'secret', SECRET_NAME, '--type=merge', '-p', patch]);
  } catch {
    // First provision against a chart that did not create the Secret (or a hand-rolled install).
    run('kubectl', [
      '-n', NAMESPACE, 'create', 'secret', 'generic', SECRET_NAME,
      `--from-literal=${SECRET_KEY}=${contents}`,
    ]);
  }
}

/**
 * M1 -- FORCE THE RELOAD, DO NOT WAIT FOR IT.
 *
 * A kubelet refreshes a projected Secret volume on its own sync period, not on write: 60-90 seconds
 * in practice. The chart runs a sidecar that notices the change and SIGHUPs the broker, but that
 * only closes the SECOND half of the delay -- the kubelet's sync is not something a sidecar can
 * shorten.
 *
 * So for the ~90s after a `kubectl patch`, a freshly provisioned gateway is refused, and nothing
 * distinguishes "not synced yet" from "wrong password". An engineer commissioning a gateway will
 * retype the credential, re-run this script, and conclude the tooling is broken well before the
 * file lands. Hence: apply it to the running broker immediately.
 *
 * ORDER MATTERS. The Secret is patched FIRST and this runs second: the Secret is the source of
 * truth, and a pod rescheduled between the two steps must come back with the credential. Forcing
 * the reload is an ACCELERATION of a change already committed, never a substitute for it.
 *
 * Two paths, and the script says which one it took:
 *   1. exec + SIGHUP  -- immediate and NON-DISRUPTIVE; Mosquitto re-reads the password and ACL
 *                        files in place and keeps every connected gateway.
 *   2. rollout restart -- the fallback when exec is unavailable (a restricted kubeconfig, or no
 *                        Running pod). THIS DROPS EVERY CONNECTED GATEWAY, so it is never the
 *                        preference and must be reported when used.
 */
function reload(pod) {
  if (pod) {
    try {
      const script = [
        'set -e',
        // Merge into the file the broker is actually reading, so the change applies before the
        // kubelet catches up. The sidecar will converge on the same content afterwards.
        `mosquitto_passwd -b ${PASSWORD_FILE} '${sparkplugId}' '${password}'`,
        `chown 1883:1883 ${PASSWORD_FILE}`,
        `chmod 0600 ${PASSWORD_FILE}`,
        // The broker is not PID 1 in the pod (the pause container is), so resolve it by name.
        'pid=$(pidof mosquitto)',
        'kill -HUP $pid',
      ].join('; ');
      run('kubectl', [
        '-n', NAMESPACE, 'exec', pod, '-c', 'credential-reload', '--', '/bin/sh', '-c', script,
      ]);
      return { method: 'exec+SIGHUP', disruptive: false };
    } catch (err) {
      console.error(`  exec reload failed (${err.message.trim().split('\n')[0]}); falling back to a rollout restart.`);
    }
  }

  try {
    run('kubectl', ['-n', NAMESPACE, 'rollout', 'restart', `deployment/${DEPLOYMENT}`], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    return { method: 'rollout restart', disruptive: true };
  } catch (err) {
    console.error(`  rollout restart failed: ${err.message.trim().split('\n')[0]}`);
    return { method: 'none', disruptive: false };
  }
}

function provisionK8s() {
  let pod;
  try {
    pod = brokerPod();
  } catch {
    pod = null;
  }
  if (!pod) {
    console.error(
      `No Running mosquitto pod found in namespace '${NAMESPACE}'.\n` +
      'The credential cannot be hashed without one -- mosquitto_passwd has to come from the ' +
      "broker's own image so the hash format matches what the broker will read.\n" +
      `  kubectl -n ${NAMESPACE} get pods -l app.kubernetes.io/component=mosquitto`
    );
    process.exit(1);
  }

  let entry;
  try {
    entry = hashedEntry(pod);
  } catch (err) {
    console.error(`Failed to hash the credential in pod '${pod}': ${err.message}`);
    process.exit(1);
  }
  if (!entry.startsWith(`${sparkplugId}:`)) {
    console.error(`Unexpected mosquitto_passwd output; refusing to write it:\n  ${entry}`);
    process.exit(1);
  }

  // Replace an existing line for this gateway rather than appending -- see writeSecret().
  const existing = readSecret();
  const kept = existing
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith(`${sparkplugId}:`));
  const replaced = kept.length !== existing.split('\n').filter((l) => l.trim()).length;
  const contents = `${[...kept, entry].join('\n')}\n`;

  try {
    writeSecret(contents);
  } catch (err) {
    console.error(`Failed to write Secret '${SECRET_NAME}' in namespace '${NAMESPACE}': ${err.message}`);
    process.exit(1);
  }
  console.log(
    `${replaced ? 'Replaced' : 'Added'} '${sparkplugId}' in Secret ${NAMESPACE}/${SECRET_NAME} ` +
    `(${kept.length + 1} gateway account(s) total).`
  );

  const { method, disruptive } = reload(pod);
  if (method === 'none') {
    console.error(
      '\nThe Secret was written but the running broker could not be reloaded. The credential will ' +
      'still take effect once the kubelet syncs the projected volume (60-90s) and the ' +
      'credential-reload sidecar picks it up.'
    );
  } else {
    console.log(`Applied to the running broker via ${method}.`);
    if (disruptive) {
      console.log(
        '  NOTE: a rollout restart DROPS EVERY CONNECTED GATEWAY. They will reconnect, but any ' +
        'in-flight Sparkplug session is re-established from a fresh birth.'
      );
    }
  }
}

if (target === 'compose') provisionCompose();
else provisionK8s();

console.log(`\nProvisioned MQTT credential for gateway ${sparkplugId}\n`);
console.log(`  username: ${sparkplugId}`);
console.log(`  password: ${password}`);
console.log(
  '\nThis password is not recoverable -- mosquitto_passwd stores only a hash. Record it now.'
);
console.log(
  `This account may publish and subscribe ONLY beneath spBv1.0/+/+/${sparkplugId}/#.\n`
);
