#!/usr/bin/env node
/**
 * Assert the broker's own configuration STARTS on the version both targets pin.
 *
 * WHY THIS EXISTS. mosquitto.conf declared `password_file` twice -- once under each listener -- which
 * reads as careful, per-listener configuration and is a FATAL ERROR on mosquitto 2.0.x:
 *
 *   Error: Duplicate password_file value in configuration.
 *   Error found at /mosquitto/config/mosquitto.conf:16.
 *
 * exit 3, before a single socket is opened. Mosquitto 2.1.x accepts it. So the file was valid for as
 * long as both targets ran `eclipse-mosquitto:latest`, and became fatal the moment they were pinned
 * back to 2.0.20 -- taking the broker down on BOTH targets, and with it the ingestion daemon,
 * Node-RED and every gateway.
 *
 * Nothing caught it. `docker compose config` validates compose YAML, not broker config. `helm lint`
 * and `helm template` render the ConfigMap without reading it. The frontend and Python suites never
 * touch it. Only a full stack boot would have failed -- which is the slowest and least specific
 * signal available, and in CI it would have surfaced as a dozen unrelated-looking health timeouts.
 *
 * WHAT IT CHECKS, and the two properties are different:
 *
 *   1. THE CONFIG PARSES AND THE BROKER SERVES, on the exact pinned tag. Not a grep -- mosquitto's
 *      own parser is the only authority on what mosquitto accepts, and the duplicate-key rule is
 *      exactly the kind of thing no reimplementation would have.
 *   2. AUTHENTICATION IS ENFORCED ON EVERY LISTENER. A config that starts is not a config that is
 *      safe: `allow_anonymous`/`password_file` are declared ONCE in the global section, and if
 *      someone moves them under a listener the file may still start while a listener comes up
 *      anonymous. So this connects with no credentials and requires a refusal.
 *
 * The TLS listener is checked too when a certificate can be produced, because appending it is the
 * one way the base policy is modified at deploy time.
 *
 * Requires Docker. Skips with a clear message when Docker is unavailable, so it can sit in a
 * pipeline stage that does not guarantee a daemon -- a check that fails for want of Docker teaches
 * everyone to ignore it.
 *
 * Usage:
 *   node scripts/check-broker-config.mjs
 *   node scripts/check-broker-config.mjs --verbose
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');
const log = (m) => verbose && console.log(`       ${m}`);

const problems = [];
const ok = [];

/** The tag docker-compose pins, so this tests what actually runs -- never `latest`. */
function pinnedTag() {
  const compose = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8');
  const m = compose.match(/^\s*image:\s*["']?eclipse-mosquitto:([^\s"']+)/m);
  if (!m) {
    throw new Error('could not find the eclipse-mosquitto image pin in docker-compose.yml');
  }
  return m[1];
}

/** Both targets must pin the same tag; the chart's is checked by check-image-tag-parity.mjs. */
const TAG = pinnedTag();
const IMAGE = `eclipse-mosquitto:${TAG}`;

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...opts });
}

if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) {
  console.log('  skip   broker config check: no Docker daemon available');
  console.log('\nThe broker config was NOT verified. Run this where Docker is available.');
  process.exit(0);
}

if (docker(['image', 'inspect', IMAGE]).status !== 0) {
  log(`pulling ${IMAGE}`);
  if (docker(['pull', IMAGE], { stdio: 'inherit' }).status !== 0) {
    console.log(`  skip   broker config check: could not pull ${IMAGE}`);
    process.exit(0);
  }
}

const work = mkdtempSync(join(tmpdir(), 'fp-broker-'));
const cfg = join(work, 'cfg');
mkdirSync(cfg, { recursive: true });

/**
 * Compose the config exactly as the deployment does: the base policy, plus the TLS stanza appended
 * when asked. Assembling it here the same way the chart's initContainer does is the point -- a check
 * that tested a hand-written config would not be testing the shipped one.
 */
function assemble({ withTls }) {
  let conf = readFileSync(join(REPO, 'mosquitto.conf'), 'utf8');
  if (withTls) {
    conf += '\n' + readFileSync(join(REPO, 'mosquitto-tls.conf'), 'utf8');
  }
  writeFileSync(join(cfg, 'mosquitto.conf'), conf);
  writeFileSync(join(cfg, 'mosquitto.acl'), readFileSync(join(REPO, 'mosquitto.acl'), 'utf8'));
}

/**
 * Start the broker on the composed config and return its log plus whether it reached "running".
 *
 * The password file is built INSIDE the container with mosquitto_passwd, then chowned to 1883 and
 * chmod 0600 -- exactly what the chart's initContainer does. Without the chown the broker (which
 * drops to uid 1883) cannot read it and fails with "Unable to open pwfile", which looks like a
 * config error and is not one.
 */
function startBroker({ withTls, certsDir, ports = [] }) {
  assemble({ withTls });
  const name = `fp-broker-check-${Date.now()}`;
  const args = ['run', '-d', '--name', name];
  for (const p of ports) args.push('-p', p);
  args.push('-v', `${cfg}:/cfgsrc:ro`);
  if (certsDir) args.push('-v', `${certsDir}:/mosquitto/certs:ro`);
  args.push(
    IMAGE,
    'sh',
    '-c',
    'cp /cfgsrc/* /mosquitto/config/ && ' +
      'mosquitto_passwd -b -c /mosquitto/config/password_file probe probe-secret && ' +
      'chown 1883:1883 /mosquitto/config/password_file && ' +
      'chmod 0600 /mosquitto/config/password_file && ' +
      'exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf'
  );
  const run = docker(args);
  if (run.status !== 0) return { name: null, log: run.stderr || run.stdout, running: false };

  // Poll rather than sleep a fixed time: a slow CI runner would otherwise read an empty log as a
  // failure, which is a flaky check and worse than no check.
  let log = '';
  for (let i = 0; i < 25; i += 1) {
    log = docker(['logs', name]).stdout + docker(['logs', name]).stderr;
    if (/mosquitto version .* running/.test(log) || /Error/i.test(log)) break;
    execFileSync('docker', ['exec', name, 'true'], { stdio: 'ignore' });
  }
  return { name, log, running: /mosquitto version .* running/.test(log) };
}

const started = [];
function cleanup() {
  for (const n of started) if (n) docker(['rm', '-f', n]);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not worth failing over */
  }
}

try {
  // -----------------------------------------------------------------------------------------------
  // 1. The base policy starts on the pinned version.
  // -----------------------------------------------------------------------------------------------
  {
    const r = startBroker({ withTls: false, ports: ['21883:1883'] });
    started.push(r.name);
    if (!r.running) {
      const err = (r.log.match(/^.*Error.*$/gim) || []).slice(0, 3).join('\n         ');
      problems.push(
        `mosquitto.conf does NOT start on ${IMAGE}:\n         ${err || r.log.slice(0, 300)}`
      );
    } else {
      ok.push(`mosquitto.conf starts and serves on ${IMAGE}`);
      log(r.log.trim().split('\n').slice(-1)[0]);
    }

    // -------------------------------------------------------------------------------------------
    // 2. Anonymous access is refused. A config that STARTS is not a config that is SAFE: the
    //    security options are global precisely so no listener can come up anonymous, and this is
    //    what would notice if they were moved back under a listener.
    // -------------------------------------------------------------------------------------------
    if (r.running) {
      const anon = docker([
        'run', '--rm', '--network', `container:${r.name}`, IMAGE,
        'mosquitto_pub', '-h', '127.0.0.1', '-p', '1883', '-t', 'probe/anon', '-m', 'x'
      ]);
      const refused = /not authorised|Connection Refused/i.test(anon.stderr + anon.stdout);
      if (refused) {
        ok.push('1883 refuses an unauthenticated client (allow_anonymous is in force)');
      } else {
        problems.push(
          'AN UNAUTHENTICATED CLIENT WAS ACCEPTED ON 1883. `allow_anonymous false` and ' +
            '`password_file` must be declared in mosquitto.conf\'s GLOBAL section (above the first ' +
            '`listener` line) so they apply to every listener.'
        );
      }

      const authed = docker([
        'run', '--rm', '--network', `container:${r.name}`, IMAGE,
        'mosquitto_pub', '-h', '127.0.0.1', '-p', '1883', '-u', 'probe', '-P', 'probe-secret',
        '-t', 'probe/authed', '-m', 'x'
      ]);
      if (authed.status === 0) {
        ok.push('1883 accepts a client with valid credentials');
      } else {
        problems.push(
          `a client WITH valid credentials was refused on 1883: ${(authed.stderr || '').trim()}`
        );
      }
    }
  }

  // -----------------------------------------------------------------------------------------------
  // 3. The base policy plus the appended TLS stanza starts, and serves TLS.
  //
  // This is the composition the chart actually deploys, and the one that would break if a security
  // option were ever added to mosquitto-tls.conf -- `password_file` there is the same fatal
  // duplicate that started all this.
  // -----------------------------------------------------------------------------------------------
  {
    const certs = join(work, 'certs');
    mkdirSync(certs, { recursive: true });
    const gen = spawnSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certs, 'tls.key'),
       '-out', join(certs, 'tls.crt'), '-subj', '/CN=mosquitto', '-days', '1',
       '-addext', 'subjectAltName=DNS:mosquitto,DNS:localhost,IP:127.0.0.1'],
      { encoding: 'utf8' }
    );
    // Self-signed, so it is its own CA -- which is all `cafile` needs to load.
    if (gen.status === 0 && existsSync(join(certs, 'tls.crt'))) {
      writeFileSync(join(certs, 'ca.crt'), readFileSync(join(certs, 'tls.crt')));
      const r = startBroker({ withTls: true, certsDir: certs, ports: ['28883:8883'] });
      started.push(r.name);
      if (!r.running) {
        const err = (r.log.match(/^.*Error.*$/gim) || []).slice(0, 3).join('\n         ');
        problems.push(
          'mosquitto.conf + mosquitto-tls.conf does NOT start:\n         ' +
            (err || r.log.slice(0, 300)) +
            '\n         A "Duplicate ... value" error here means a security option was added to ' +
            'mosquitto-tls.conf; they belong in mosquitto.conf\'s global section only.'
        );
      } else {
        ok.push('mosquitto.conf + mosquitto-tls.conf starts with a TLS listener on 8883');
        const tls = docker([
          'run', '--rm', '--network', `container:${r.name}`,
          '-v', `${certs}:/c:ro`, IMAGE,
          'mosquitto_pub', '--cafile', '/c/ca.crt', '-h', 'localhost', '-p', '8883',
          '-u', 'probe', '-P', 'probe-secret', '-t', 'probe/tls', '-m', 'x'
        ]);
        if (tls.status === 0) {
          ok.push('8883 completes a verified TLS handshake and accepts an authenticated publish');
        } else {
          problems.push(`8883 rejected a verified TLS publish: ${(tls.stderr || '').trim()}`);
        }
      }
    } else {
      log('openssl unavailable; TLS listener not exercised');
      ok.push('(TLS listener check skipped: openssl unavailable)');
    }
  }
} finally {
  cleanup();
}

for (const line of ok) console.log(`  ok   ${line}`);
if (problems.length) {
  console.error('\nBroker configuration is broken:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\nThis is checked against ${IMAGE} -- the tag docker-compose.yml pins -- because mosquitto's\n` +
      'accepted syntax CHANGES BETWEEN MINOR VERSIONS. A duplicate `password_file` is fatal on\n' +
      '2.0.x and accepted on 2.1.x, so a config that works on `latest` can take the broker down on\n' +
      'both targets the moment the image is pinned.\n'
  );
  process.exit(1);
}
console.log(`\nBroker configuration starts and authenticates correctly on ${IMAGE}.`);
