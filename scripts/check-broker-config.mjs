#!/usr/bin/env node
/**
 * Assert the broker's own configuration starts on the version both targets pin, and serves safely.
 * Mosquitto's own parser is the only authority on what it accepts (2.0.x rejects a duplicate
 * `password_file`, 2.1.x accepts it, and nothing short of a stack boot would notice), so the config
 * is started on the pinned tag. A config that starts is not a config that is safe:
 * `allow_anonymous`/`password_file` are declared once in the global section, so this also connects
 * with no credentials and requires a refusal, and asserts mosquitto.acl confines each principal by
 * delivery. The TLS listener is checked when a certificate can be produced. Requires Docker, and
 * skips with a clear message without it.
 *
 * Usage: node scripts/check-broker-config.mjs [--verbose]
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
 * when asked, the same way the chart's initContainer does.
 */
function assemble({ withTls }) {
  let conf = readFileSync(join(REPO, 'mosquitto', 'mosquitto.conf'), 'utf8');
  if (withTls) {
    conf += '\n' + readFileSync(join(REPO, 'mosquitto', 'mosquitto-tls.conf'), 'utf8');
  }
  writeFileSync(join(cfg, 'mosquitto.conf'), conf);
  writeFileSync(join(cfg, 'mosquitto.acl'), readFileSync(join(REPO, 'mosquitto', 'mosquitto.acl'), 'utf8'));
}

/**
 * Start the broker on the composed config and return its log plus whether it reached "running". The
 * password file is built inside the container with mosquitto_passwd, then chowned to 1883 and chmod
 * 0600, as the chart's initContainer does; without the chown the broker fails with "Unable to open
 * pwfile".
 */
/**
 * The principals mosquitto.acl names, provisioned into every test broker. `gwy999…` is not a real
 * gateway: it exists so "a gateway cannot publish under another edge node" is testable, the forgery
 * `verify_gateway_binding()` cannot detect.
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
      // The real principals mosquitto.acl names, so section 4 can assert each one's confinement.
      // Two gateways, because "cannot address another edge node" needs another edge node.
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
  // 1. The base policy starts on the pinned version.
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

    // 2. Anonymous access is refused. The security options are global so no listener can come up
    // anonymous, and this is what notices if they are moved back under a listener.
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

      // A topic `probe` is allowed to publish under the ACL's per-gateway pattern: this assertion
      // is about authentication, and at QoS 0 a denied publish still exits 0. Authorisation is
      // asserted in section 4, by delivery.
      const authed = docker([
        'run', '--rm', '--network', `container:${r.name}`, IMAGE,
        'mosquitto_pub', '-h', '127.0.0.1', '-p', '1883', '-u', 'probe', '-P', 'probe-secret',
        '-t', 'spBv1.0/ACS-Cymru/DDATA/probe/dev1', '-m', 'x'
      ]);
      if (authed.status === 0) {
        ok.push('1883 accepts a client with valid credentials');
      } else {
        problems.push(
          `a client WITH valid credentials was refused on 1883: ${(authed.stderr || '').trim()}`
        );
      }
    }

    // 4. mosquitto.acl confines each principal, asserted by delivery, not exit status: a denied
    // publish at QoS 0 exits 0 and the broker says nothing. Publish as one principal, subscribe as
    // one permitted to read the whole tree, and ask whether the message arrived. This is what would
    // notice a shared `readwrite spBv1.0/#` account coming back in any form, including an ACL file
    // that failed to load (mosquitto warns and continues).
    if (r.running) {
      /**
       * Publish as one client, read as another, and report whether the payload arrived. Matches the
       * payload, not whether the subscriber printed anything: `mosquitto_sub -W` writes `Timed out`
       * to stderr when the window closes empty, so a truthiness test would treat a dropped message
       * as delivered.
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
        (delivers(GATEWAY_A, `spBv1.0/ACS-Cymru/DDATA/${GATEWAY_A}/dev1`)),
        true
      );
      expect(
        'a gateway may NOT publish under another edge node (the forgery gateway binding cannot catch)',
        (delivers(GATEWAY_A, `spBv1.0/ACS-Cymru/DDATA/${GATEWAY_B}/dev1`)),
        false
      );
      expect(
        'the ingestion principal may NOT publish DDATA',
        (delivers('factoryplus_ingestion', `spBv1.0/ACS-Cymru/DDATA/${GATEWAY_A}/dev1`)),
        false
      );
      expect(
        'the ingestion principal may NOT publish DBIRTH',
        (delivers('factoryplus_ingestion', `spBv1.0/ACS-Cymru/DBIRTH/${GATEWAY_A}/dev1`)),
        false
      );
      expect(
        'the ingestion principal MAY publish a rebirth NCMD (alias recovery depends on it)',
        (delivers('factoryplus_ingestion', `spBv1.0/ACS-Cymru/NCMD/${GATEWAY_A}`)),
        true
      );
      expect(
        'the i3X principal may publish NOTHING (it refuses writes in code; the broker agrees)',
        (delivers('factoryplus_i3x', `spBv1.0/ACS-Cymru/NCMD/${GATEWAY_A}`)),
        false
      );
      expect(
        'the monitoring principal may publish NOTHING',
        (delivers('factoryplus_monitor', `spBv1.0/ACS-Cymru/DDATA/${GATEWAY_A}/dev1`)),
        false
      );
      // A gateway's own NCMD must reach it through the wildcard subscription the simulator flow and
      // validate.py use. 2.0.20 grants `spBv1.0/+/NCMD/+` even for a client confined by `pattern`
      // and filters per message at delivery; if a future version refuses the SUBACK instead,
      // rebirth recovery breaks silently.
      expect(
        'a gateway receives its own NCMD through a wildcard subscription',
        (delivers('factoryplus_ingestion', `spBv1.0/ACS-Cymru/NCMD/${GATEWAY_A}`,
          GATEWAY_A, 'spBv1.0/+/NCMD/+')),
        true
      );
      expect(
        'a gateway does NOT receive another edge node\'s NCMD through that same subscription',
        (delivers('factoryplus_ingestion', `spBv1.0/ACS-Cymru/NCMD/${GATEWAY_B}`,
          GATEWAY_A, 'spBv1.0/+/NCMD/+')),
        false
      );

      // The Directory topic (ingestion/directory_publish.py): one document holding the whole
      // address space, published outside `spBv1.0/`. A topic has no caller, so the ACL is the
      // entire access control. The negative assertion is the load-bearing half: a gateway must not
      // be able to enumerate the site, and reading is silent.
      expect(
        'the ingestion principal MAY publish the Directory (it is the only writer)',
        (delivers('factoryplus_ingestion', 'ACS-Cymru/Directory/v1/device',
          'factoryplus_ingestion', 'ACS-Cymru/Directory/#')),
        true
      );
      expect(
        'a gateway may NOT read the Directory (it would enumerate every asset on the site)',
        (delivers('factoryplus_ingestion', 'ACS-Cymru/Directory/v1/device',
          GATEWAY_A, 'ACS-Cymru/Directory/#')),
        false
      );

      // The Unified Namespace (ingestion/uns_publish.py): every reading in the clear under uns/.
      // The same two halves, for the same reason: the daemon is the only writer, and a gateway
      // reading the tree would read every machine's telemetry with one credential.
      expect(
        'the ingestion principal MAY publish the Unified Namespace (it is the only writer)',
        (delivers('factoryplus_ingestion', 'uns/ACS-Cymru/Site/Area/Cell/dev1/Speed',
          'factoryplus_ingestion', 'uns/#')),
        true
      );
      expect(
        'a gateway may NOT read the Unified Namespace (one credential would read the whole plant)',
        (delivers('factoryplus_ingestion', 'uns/ACS-Cymru/Site/Area/Cell/dev1/Speed',
          GATEWAY_A, 'uns/#')),
        false
      );
      expect(
        'a gateway may NOT publish into the Unified Namespace (only decoded, verified readings belong there)',
        (delivers(GATEWAY_A, `uns/ACS-Cymru/Site/Area/Cell/${GATEWAY_A}/Speed`,
          'factoryplus_ingestion', 'uns/#')),
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

  // 3. The base policy plus the appended TLS stanza starts, and serves TLS. This is the composition
  // the chart deploys, and the one a security option added to mosquitto-tls.conf would break.
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

      // The key must be readable by uid 1883, and OpenSSL 3 writes it 0600 owned by whoever ran it.
      // A bind mount carries the host's ownership, so the broker exits with "Unable to load server
      // key file", which reads as a malformed key. This cannot be caught on Docker Desktop, whose
      // bind mounts present every file as world-readable. Widening to 0644 is safe here only: a
      // throwaway key in a temp directory for a broker killed at the end of this function; the
      // chart's key arrives as a projected Secret.
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

  // 5. The shipped certificate generator produces a chain the broker serves and a client verifies.
  // Section 3 uses a self-signed leaf, which is its own CA; `scripts/mosquitto-tls-init.mjs` issues
  // a selfSigned -> CA -> leaf chain and a gateway verifies against the root. Three properties: the
  // issued leaf is served on 8883 and verifies against the issued root; an anonymous client is
  // refused on 8883 as on 1883; and re-running the generator does not mint a new root, asserted by
  // fingerprint, since the root is distributed by hand to every appliance.
  {
    const TLS_INIT_IMAGE = 'acs-cymru-mosquitto-tls-init:check';
    const build = docker(['build', '-q', '-t', TLS_INIT_IMAGE, join(REPO, 'mosquitto', 'tls-init')]);

    if (build.status !== 0) {
      problems.push(
        `could not build mosquitto/tls-init/Dockerfile: ${(build.stderr || '').trim().slice(0, 300)}`
      );
    } else {
      const certs = join(work, 'issued');
      mkdirSync(certs, { recursive: true });

      /** Run the real generator against `certs`, exactly as the compose service does. */
      const generate = (extraArgs = []) => docker([
        'run', '--rm',
        '-v', `${certs}:/mosquitto/certs`,
        '-v', `${join(REPO, 'scripts', 'mosquitto-tls-init.mjs')}:/s.mjs:ro`,
        TLS_INIT_IMAGE,
        'node', '/s.mjs', ...extraArgs,
      ]);

      const first = generate();
      if (first.status !== 0) {
        problems.push(
          `scripts/mosquitto-tls-init.mjs failed: ${(first.stderr || first.stdout || '').trim().slice(0, 400)}`
        );
      } else {
        ok.push('mosquitto-tls-init issues a CA and a broker leaf');
        log(first.stdout.trim().split('\n').slice(-1)[0]);

        // (c) Idempotency, by fingerprint. Read inside the image, because the host is not
        // guaranteed to have openssl -- that is the whole reason this image exists.
        const fingerprint = () => docker([
          'run', '--rm', '-v', `${certs}:/c:ro`, TLS_INIT_IMAGE,
          'openssl', 'x509', '-in', '/c/ca.crt', '-noout', '-fingerprint', '-sha256',
        ]).stdout.trim();

        const before = fingerprint();
        const second = generate();
        const after = fingerprint();

        if (second.status !== 0) {
          problems.push('a second mosquitto-tls-init run failed; it must be idempotent');
        } else if (!before || before !== after) {
          problems.push(
            'RE-RUNNING mosquitto-tls-init MINTED A NEW ROOT. Every physical gateway trusts the '
            + 'previous one by hand-distributed copy, so this would take the whole fleet offline '
            + 'on the next `docker compose up` while the stack reported itself healthy.'
          );
        } else {
          ok.push('re-running mosquitto-tls-init reuses the existing root (fingerprint unchanged)');
        }

        // (a) + (b): the broker serves the issued leaf, and TLS does not relax authentication. The
        // generator chowns the key to uid 1883 itself, so this also exercises the ownership logic
        // the real deployment depends on.
        const r = startBroker({ withTls: true, certsDir: certs, ports: ['28884:8883'] });
        started.push(r.name);

        if (!r.running) {
          const err = (r.log.match(/^.*Error.*$/gim) || []).slice(0, 3).join('\n         ');
          problems.push(
            'the broker does NOT start on certificates issued by mosquitto-tls-init:\n         '
            + (err || r.log.slice(0, 300))
          );
        } else {
          const verified = docker([
            'run', '--rm', '--network', `container:${r.name}`,
            '-v', `${certs}:/c:ro`, IMAGE,
            'mosquitto_pub', '--cafile', '/c/ca.crt', '-h', 'localhost', '-p', '8883',
            '-u', 'probe', '-P', 'probe-secret', '-t', 'probe/tls', '-m', 'x',
          ]);
          if (verified.status === 0) {
            ok.push('8883 serves the issued leaf and a client verifies it against the issued root');
          } else {
            problems.push(
              `a client could not verify the issued chain on 8883: ${(verified.stderr || '').trim()}`
            );
          }

          const anonTls = docker([
            'run', '--rm', '--network', `container:${r.name}`,
            '-v', `${certs}:/c:ro`, IMAGE,
            'mosquitto_pub', '--cafile', '/c/ca.crt', '-h', 'localhost', '-p', '8883',
            '-t', 'probe/anon-tls', '-m', 'x',
          ]);
          if (/not authorised|Connection Refused/i.test(anonTls.stderr + anonTls.stdout)) {
            ok.push('8883 refuses an unauthenticated client (TLS does not relax authentication)');
          } else {
            problems.push(
              'AN UNAUTHENTICATED CLIENT WAS ACCEPTED ON 8883. The security options must stay in '
              + 'mosquitto.conf\'s GLOBAL section so the TLS listener inherits them; a copy under '
              + 'the 8883 stanza is also a fatal duplicate on 2.0.x.'
            );
          }
        }
      }
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
