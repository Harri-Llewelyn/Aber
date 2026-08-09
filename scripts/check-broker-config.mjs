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
import {
  readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, chmodSync,
} from 'node:fs';
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
/**
 * The principals mosquitto.acl actually names, provisioned into every test broker.
 *
 * `gwy999…` is not a real gateway and does not need to be: it exists so "a gateway cannot publish
 * under ANOTHER edge node" is testable. Without a second edge node that assertion cannot be made
 * at all, and it is the one that matters most -- it is the forgery `verify_gateway_binding()`
 * cannot detect, because a message published under a correctly bound device satisfies it.
 */
const GATEWAY_A = 'gwy100000000000400080000';
const GATEWAY_B = 'gwy999999999999999999999';
const ACCOUNTS = {
  factoryplus_ingestion: 'ing-secret',
  factoryplus_i3x: 'i3x-secret',
  factoryplus_monitor: 'mon-secret',
  [GATEWAY_A]: 'gw-a-secret',
  [GATEWAY_B]: 'gw-b-secret',
};

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
      // The real principals mosquitto.acl names, so section 4 can assert the confinement each one
      // is supposed to have. TWO gateways, because "cannot address another edge node" needs
      // another edge node to exist before it can be tested at all.
      Object.entries(ACCOUNTS)
        .map(([u, p]) => `mosquitto_passwd -b /mosquitto/config/password_file ${u} ${p} && `)
        .join('') +
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

      // A topic `probe` is ALLOWED to publish under mosquitto.acl's per-gateway pattern. This
      // assertion is about authentication, not authorisation -- but at QoS 0 a denied publish
      // still exits 0 (the broker drops it silently and tells the client nothing), so a topic the
      // ACL refuses would have made this check pass while proving nothing. Authorisation is
      // asserted properly in section 4, by whether a message is DELIVERED.
      const authed = docker([
        'run', '--rm', '--network', `container:${r.name}`, IMAGE,
        'mosquitto_pub', '-h', '127.0.0.1', '-p', '1883', '-u', 'probe', '-P', 'probe-secret',
        '-t', 'spBv1.0/FactoryPlus/DDATA/probe/dev1', '-m', 'x'
      ]);
      if (authed.status === 0) {
        ok.push('1883 accepts a client with valid credentials');
      } else {
        problems.push(
          `a client WITH valid credentials was refused on 1883: ${(authed.stderr || '').trim()}`
        );
      }
    }

    // -------------------------------------------------------------------------------------------
    // 4. mosquitto.acl CONFINES EACH PRINCIPAL. Asserted by DELIVERY, not by exit status.
    //
    // A denied publish at QoS 0 exits 0: the broker drops the message and says nothing, by design.
    // So every assertion here works the only way that is meaningful -- publish as one principal,
    // subscribe as one permitted to read the whole tree, and ask whether the message ARRIVED.
    //
    // This is the check that would notice the shared `readwrite spBv1.0/#` account coming back,
    // in any form: a new principal, a widened rule, or an ACL file that failed to load at all
    // (mosquitto WARNS and continues on a missing acl_file rather than refusing to start, which is
    // exactly the failure a config-parse check cannot see).
    // -------------------------------------------------------------------------------------------
    if (r.running) {
      /**
       * Publish as one client, read as another, and report whether the payload ARRIVED.
       *
       * MATCHES THE PAYLOAD, not "did the subscriber print anything". `mosquitto_sub -W` writes
       * `Timed out` to stderr when the window closes empty, and the capture is 2>&1 -- so a
       * truthiness test on the file treats a DROPPED message as a delivered one and every negative
       * assertion here passes vacuously. That is exactly what this function got wrong first time,
       * and it would have made the whole section report success while asserting nothing.
       */
      const MARKER = 'FP-ACL-PROBE';
      const delivers = (pubUser, topic, subUser = 'factoryplus_ingestion', subTopic = 'spBv1.0/#') => {
        const out = `/tmp/acl-${Date.now()}.txt`;
        docker(['exec', '-d', r.name, 'sh', '-c',
          `mosquitto_sub -u ${subUser} -P ${ACCOUNTS[subUser]} -t '${subTopic}' -C 1 -W 5 > ${out} 2>&1`]);
        docker(['exec', r.name, 'sleep', '2']);
        docker(['exec', r.name, 'mosquitto_pub', '-u', pubUser, '-P', ACCOUNTS[pubUser],
          '-t', topic, '-m', MARKER]);
        docker(['exec', r.name, 'sleep', '4']);
        return (docker(['exec', r.name, 'cat', out]).stdout || '').includes(MARKER);
      };

      const expect = (label, got, wanted) => {
        if (got === wanted) ok.push(label);
        else problems.push(
          `${label} -- expected the message to be ${wanted ? 'DELIVERED' : 'DROPPED'}, but it was ${got ? 'delivered' : 'dropped'}`
        );
      };

      expect(
        'a gateway may publish under its OWN edge node',
        (delivers(GATEWAY_A, `spBv1.0/FactoryPlus/DDATA/${GATEWAY_A}/dev1`)),
        true
      );
      expect(
        'a gateway may NOT publish under another edge node (the forgery gateway binding cannot catch)',
        (delivers(GATEWAY_A, `spBv1.0/FactoryPlus/DDATA/${GATEWAY_B}/dev1`)),
        false
      );
      expect(
        'the ingestion principal may NOT publish DDATA',
        (delivers('factoryplus_ingestion', `spBv1.0/FactoryPlus/DDATA/${GATEWAY_A}/dev1`)),
        false
      );
      expect(
        'the ingestion principal may NOT publish DBIRTH',
        (delivers('factoryplus_ingestion', `spBv1.0/FactoryPlus/DBIRTH/${GATEWAY_A}/dev1`)),
        false
      );
      expect(
        'the ingestion principal MAY publish a rebirth NCMD (alias recovery depends on it)',
        (delivers('factoryplus_ingestion', `spBv1.0/FactoryPlus/NCMD/${GATEWAY_A}`)),
        true
      );
      expect(
        'the i3X principal may publish NOTHING (it refuses writes in code; the broker agrees)',
        (delivers('factoryplus_i3x', `spBv1.0/FactoryPlus/NCMD/${GATEWAY_A}`)),
        false
      );
      expect(
        'the monitoring principal may publish NOTHING',
        (delivers('factoryplus_monitor', `spBv1.0/FactoryPlus/DDATA/${GATEWAY_A}/dev1`)),
        false
      );
      // A gateway's own NCMD must reach it through the WILDCARD subscription both the simulator
      // flow and validate.py use. 2.0.20 grants `spBv1.0/+/NCMD/+` (QoS 0, not 128) even for a
      // client confined by `pattern` and filters per message at delivery instead -- so those
      // subscriptions did NOT need narrowing. If a future version starts refusing the SUBACK
      // instead, rebirth recovery breaks silently and this is what says so.
      expect(
        'a gateway receives its own NCMD through a wildcard subscription',
        (delivers('factoryplus_ingestion', `spBv1.0/FactoryPlus/NCMD/${GATEWAY_A}`,
          GATEWAY_A, 'spBv1.0/+/NCMD/+')),
        true
      );
      expect(
        'a gateway does NOT receive another edge node\'s NCMD through that same subscription',
        (delivers('factoryplus_ingestion', `spBv1.0/FactoryPlus/NCMD/${GATEWAY_B}`,
          GATEWAY_A, 'spBv1.0/+/NCMD/+')),
        false
      );

      // $SYS is reachable only by the monitoring account, and it is load-bearing: the broker's own
      // probes authenticate as it, so losing this rule leaves the pod permanently NotReady.
      const sysRead = (user) => docker(['exec', r.name, 'mosquitto_sub', '-u', user,
        '-P', ACCOUNTS[user], '-t', '$SYS/broker/version', '-C', '1', '-W', '4']);
      if ((sysRead('factoryplus_monitor').stdout || '').includes('mosquitto version')) {
        ok.push('the monitoring principal can read $SYS (the health probes depend on it)');
      } else {
        problems.push('the monitoring principal CANNOT read $SYS -- every readiness probe will fail and no workload waiting on the broker will start');
      }
      if ((sysRead(GATEWAY_A).stdout || '').includes('mosquitto version')) {
        problems.push('a gateway credential can read $SYS; `topic read $SYS/#` must be scoped to the monitoring user');
      } else {
        ok.push('a gateway credential cannot read $SYS');
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

      // THE KEY MUST BE READABLE BY UID 1883, AND OPENSSL 3 DOES NOT MAKE IT SO.
      //
      // `openssl req -keyout` writes the private key 0600 owned by whoever ran it (OpenSSL 1.x used
      // 0644; 3.x tightened it). These files are bind-mounted into the broker container, mosquitto
      // drops to uid 1883, and a bind mount carries the HOST's ownership -- so the broker cannot
      // read its own key and exits 1 with three lines of raw OpenSSL text naming neither the file
      // nor the cause:
      //
      //     Error: Unable to load server key file "/mosquitto/certs/tls.key". Check keyfile.
      //     OpenSSL Error[0]: error:8000000D:system library::Permission denied
      //
      // which reads as a malformed key, not as a permission on the host side.
      //
      // THIS CANNOT BE CAUGHT ON DOCKER DESKTOP. Windows and macOS bind mounts go through a
      // virtualised filesystem that presents every file as world-readable and ignores host uid
      // entirely, so this check passes locally on any machine and fails on every Linux CI runner --
      // the most expensive shape of environment difference, because the local result is not merely
      // unrepresentative, it is the opposite.
      //
      // Widening to 0644 is safe HERE and nowhere else: this is a throwaway self-signed key, valid
      // one day, minted in a temp directory that is deleted in `finally`, for a broker that is
      // killed at the end of this function. The chart does not do this -- there the key arrives as a
      // projected Secret whose mode Kubernetes sets, which is why nothing in the deployment path has
      // the same problem.
      chmodSync(join(certs, 'tls.key'), 0o644);
      chmodSync(join(certs, 'tls.crt'), 0o644);
      chmodSync(join(certs, 'ca.crt'), 0o644);
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
