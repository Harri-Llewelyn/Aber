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
 *
 * With no password one is generated and printed. It is printed EXACTLY ONCE -- mosquitto_passwd
 * stores a hash and there is no way to read it back, which is the point.
 *
 * The credential is written into the `mosquitto_data` volume via `docker compose exec`, so the
 * broker picks it up without a rebuild. Mosquitto reloads its password and ACL files on SIGHUP.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const GATEWAY_ID_PATTERN = /^gwy[0-9a-f]{21}$/;
const CONTAINER = process.env.MOSQUITTO_CONTAINER || 'factoryplus_mosquitto';
const PASSWORD_FILE = '/mosquitto/config/password_file';

const [, , sparkplugId, suppliedPassword] = process.argv;

if (!sparkplugId) {
  console.error('Usage: node scripts/mosquitto-provision-gateway.mjs <sparkplug_id> [password]');
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

try {
  execFileSync(
    'docker',
    ['exec', CONTAINER, 'mosquitto_passwd', '-b', PASSWORD_FILE, sparkplugId, password],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );

  // Reload rather than restart: a restart drops every connected gateway, and this is an
  // additive change that the running broker can absorb.
  execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', 'kill -HUP 1'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
} catch (err) {
  console.error(`Failed to provision '${sparkplugId}': ${err.message}`);
  console.error(`Is the '${CONTAINER}' container running? (docker compose up -d mosquitto)`);
  process.exit(1);
}

console.log(`\nProvisioned MQTT credential for gateway ${sparkplugId}\n`);
console.log(`  username: ${sparkplugId}`);
console.log(`  password: ${password}`);
console.log(
  '\nThis password is not recoverable -- mosquitto_passwd stores only a hash. Record it now.'
);
console.log(
  `This account may publish and subscribe ONLY beneath spBv1.0/+/+/${sparkplugId}/#.\n`
);
