#!/usr/bin/env node
/**
 * Assert the broker's configuration starts on the pinned image and enforces the policy.
 *
 * Mosquitto's own parser is the only authority on what it accepts, so mosquitto.conf is started on
 * the tag the chart pins. A config that starts is not a config that is safe, so the check
 * then connects with no credentials and requires a refusal, and asserts BY DELIVERY that each role
 * in mosquitto/dynsec-roles.json confines its principal: a denied publish at QoS 0 exits 0 and the
 * broker says nothing, so exit status proves nothing.
 *
 * The document the broker boots on is written by the real boot reconcile
 * (scripts/mosquitto-dynsec-init.mjs) in the credential service's image, from the repository's
 * roles, the environment and a seeded stored document, so the reconcile of stored clients, the
 * hash transplant and a second idempotent run are exercised. The plugin's control API is then
 * driven through mosquitto_rr the way the credential service drives it: issue, re-issue, disable,
 * re-enable, with a live session held across the two that drop one. The TLS listener is checked
 * when a certificate can be produced.
 *
 * The chart's principal list is held to PLATFORM_PRINCIPALS from source, with or without Docker.
 * Everything else requires Docker, and skips with a clear message without it.
 *
 * Usage: node scripts/check-broker-config.mjs [--verbose]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, chmodSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { hashArgvForUsername } from './lib/mosquitto-credentials.mjs';
import {
  PLATFORM_PRINCIPALS, assertOk, clientFromPasswordEntry, isRefusal, issueWithControl, summariseInventory,
} from './lib/mosquitto-dynsec.mjs';
import { controlSender } from './lib/mosquitto-control.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');
const log = (m) => verbose && console.log(`       ${m}`);

const problems = [];
const ok = [];

/** The tag the chart pins, so this tests what actually runs -- never `latest`. */
function pinnedTag() {
  const values = readFileSync(join(REPO, 'deploy', 'helm', 'aber', 'values.yaml'), 'utf8');
  const m = values.match(/repository:\s*eclipse-mosquitto\s*\n\s*tag:\s*["']?([^\s"']+)/);
  if (!m) {
    throw new Error('could not find the eclipse-mosquitto image pin in values.yaml');
  }
  return m[1];
}

/** The tag the chart pins, read from values.yaml so this check runs the broker the stack runs. */
const TAG = pinnedTag();
const IMAGE = `eclipse-mosquitto:${TAG}`;
/** The credential service's image, built from the repository so the check runs the real reconcile. */
const CREDENTIAL_IMAGE = 'aber-gateway-credential:check';

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...opts });
}

// -------------------------------------------------------------------------------------------------
// The chart's principal list and PLATFORM_PRINCIPALS name the same set. `aber.mqttPrincipals`
// hands each principal's credential pair to the boot reconcile, which creates an account for each
// PLATFORM_PRINCIPALS entry: a name only in PLATFORM_PRINCIPALS stops the broker's boot
// ("MQTT_<NAME>_USER is empty"), and a name only in the chart gets no account. Read from source,
// so it runs without Docker.
// -------------------------------------------------------------------------------------------------
const HELPERS = 'deploy/helm/aber/templates/_helpers.tpl';
const PRINCIPALS_SOURCE = 'scripts/lib/mosquitto-dynsec.mjs';

/**
 * The names in `aber.mqttPrincipals`, split on single spaces as the chart's `splitList " "` splits
 * them; null when the define is missing or is not a literal list.
 */
function chartPrincipals(tpl) {
  const m = tpl.match(/\{\{-?\s*define\s+"aber\.mqttPrincipals"\s*-?\}\}([\s\S]*?)\{\{-?\s*end\s*-?\}\}/);
  return m && !m[1].includes('{{') ? m[1].trim().split(' ') : null;
}

/** Each principal named on one side only, with the side that names it. */
function principalMismatch(chart, platform) {
  return [
    ...platform.filter((p) => !chart.includes(p)).map((name) => ({ name, only: 'PLATFORM_PRINCIPALS' })),
    ...chart.filter((p) => !platform.includes(p)).map((name) => ({ name, only: 'aber.mqttPrincipals' })),
  ];
}

{
  // The comparison's controls, one name missing from each side: a comparison that stopped
  // reporting a mismatch would otherwise pass exactly as two agreeing lists do.
  const define = (list) => `{{- define "aber.mqttPrincipals" -}}\n${list}\n{{- end -}}`;
  const controls = JSON.stringify([
    principalMismatch(chartPrincipals(define('INGESTION I3X')), ['INGESTION', 'I3X', 'MONITOR']),
    principalMismatch(chartPrincipals(define('INGESTION I3X MONITOR')), ['INGESTION', 'I3X']),
  ]) === JSON.stringify([
    [{ name: 'MONITOR', only: 'PLATFORM_PRINCIPALS' }],
    [{ name: 'MONITOR', only: 'aber.mqttPrincipals' }],
  ]);
  const chart = chartPrincipals(readFileSync(join(REPO, HELPERS), 'utf8'));
  const malformed = (chart || []).filter((p) => !/^[A-Z][A-Z0-9_]*$/.test(p));

  if (!controls) {
    problems.push('the principal-list comparison no longer reports its own fixtures (one name missing from each side), so it proves nothing');
  } else if (!chart) {
    problems.push(`${HELPERS} has no literal \`aber.mqttPrincipals\` define for this check to read`);
  } else if (malformed.length) {
    problems.push(
      `aber.mqttPrincipals (${HELPERS}) holds ${malformed.map((p) => JSON.stringify(p)).join(', ')}; ` +
        'the chart splits the list on single spaces, so this renders a broken MQTT_<NAME>_USER name'
    );
  } else {
    const mismatch = principalMismatch(chart, PLATFORM_PRINCIPALS.map((p) => p.env));
    for (const { name, only } of mismatch) {
      problems.push(
        only === 'PLATFORM_PRINCIPALS'
          ? `${name} is in PLATFORM_PRINCIPALS (${PRINCIPALS_SOURCE}) and not in aber.mqttPrincipals ` +
            `(${HELPERS}): the broker's boot stops with "MQTT_${name}_USER is empty"`
          : `${name} is in aber.mqttPrincipals (${HELPERS}) and not in PLATFORM_PRINCIPALS ` +
            `(${PRINCIPALS_SOURCE}): the reconcile creates no broker account for it`
      );
    }
    if (!mismatch.length) {
      ok.push(`aber.mqttPrincipals and PLATFORM_PRINCIPALS name the same ${chart.length} principals`);
    }
  }
}

/**
 * Without Docker only the principal-list check has run: its result decides the exit status, and the
 * broker is reported as not verified.
 */
function skipBroker(reason, hint = '') {
  for (const line of ok) console.log(`  ok   ${line}`);
  console.log(`  skip   broker config check: ${reason}`);
  if (problems.length) {
    console.error('\nBroker configuration is broken:\n');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`\nThe broker config was NOT verified.${hint}`);
  process.exit(0);
}

if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) {
  skipBroker('no Docker daemon available', ' Run this where Docker is available.');
}

if (docker(['image', 'inspect', IMAGE]).status !== 0) {
  log(`pulling ${IMAGE}`);
  if (docker(['pull', IMAGE], { stdio: 'inherit' }).status !== 0) {
    skipBroker(`could not pull ${IMAGE}`);
  }
}

const work = mkdtempSync(join(tmpdir(), 'fp-broker-'));
const cfg = join(work, 'cfg');
const dynsecDir = join(work, 'dynsec');
const brokenDir = join(work, 'broken');
for (const d of [cfg, dynsecDir, brokenDir]) mkdirSync(d, { recursive: true });

/**
 * The principals of the test broker. GATEWAY_A is the platform's validator gateway and arrives
 * from the environment; GATEWAY_B and `probe` are clients already in the stored document the
 * reconcile starts from; GATEWAY_C is issued over the control API. GATEWAY_B is not a real
 * gateway: it exists so "a gateway cannot publish under another edge node" is testable, the
 * forgery `verify_gateway_binding()` cannot detect. `probe` matches no role and must reach nothing.
 */
const GATEWAY_A = 'gwy100000000000400080000';
const GATEWAY_B = 'gwy999999999999999999999';
const GATEWAY_C = 'gwy2a71a14de1b04971bfbb5';
const ADMIN = 'dynsec-admin';

/**
 * The username each PLATFORM_PRINCIPALS entry boots with, so the reconcile below runs on the list
 * it reads: `aber_<env>` in lower case, or GATEWAY_A for the gateway principal (role: null). The
 * delivery assertions name these accounts.
 */
const PRINCIPAL_USERS = Object.fromEntries(
  PLATFORM_PRINCIPALS.map(({ env, role }) => [env, role === null ? GATEWAY_A : `aber_${env.toLowerCase()}`])
);
if (new Set(Object.values(PRINCIPAL_USERS)).size !== PLATFORM_PRINCIPALS.length) {
  throw new Error('two PLATFORM_PRINCIPALS entries map to one test account here; give each its own username');
}

const ACCOUNTS = {
  [ADMIN]: 'admin-secret-for-the-check-0001',
  ...Object.fromEntries(Object.values(PRINCIPAL_USERS).map((user) => [user, `${user}-secret-0001`])),
  [GATEWAY_B]: 'gateway-b-secret-0001',
  probe: 'probe-secret-00000001',
};

/**
 * The Sparkplug primary host id this check reconciles against, and a second one it never grants.
 * `OTHER` is what makes the grant's narrowness testable: the daemon must be unable to announce the
 * death of a host application that is not it (issue #149).
 */
const PRIMARY_HOST_ID = 'Check-Site';
const OTHER_HOST_ID = 'Someone-Else';

/**
 * The Directory prefix this check reconciles against, and it is DELIBERATELY NOT the chart's
 * default. The grant is derived from this value at reconcile time rather than written into
 * dynsec-roles.json, so a prefix that happened to match the repository's old literal would pass
 * whether or not the derivation ran at all.
 */
const DIRECTORY_PREFIX = 'Check-Site/Directory/v1';
const DIRECTORY_DOC = `${DIRECTORY_PREFIX}/device`;
const DIRECTORY_FILTER = `${DIRECTORY_PREFIX}/#`;
const EXPECTED_CLIENTS = Object.keys(ACCOUNTS).sort();

const INIT_ENV = {
  DYNSEC_FILE: '/out/dynamic-security.json',
  DYNSEC_POLICY_FILE: '/policy/dynsec-roles.json',
  // Every principal is required, so a pair the reconcile cannot use stops this boot.
  DYNSEC_REQUIRED_PRINCIPALS: Object.keys(PRINCIPAL_USERS).join(' '),
  MQTT_DYNSEC_ADMIN_USER: ADMIN,
  MQTT_DYNSEC_ADMIN_PASSWORD: ACCOUNTS[ADMIN],
  ...Object.fromEntries(Object.entries(PRINCIPAL_USERS).flatMap(([env, user]) => [
    [`MQTT_${env}_USER`, user],
    [`MQTT_${env}_PASSWORD`, ACCOUNTS[user]],
  ])),
  // Required by the reconcile, which derives the primary host's write grant from it rather than
  // reading it out of the roles file. A literal here, not the chart's value: the point of the
  // assertions below is that the grant is exactly this one topic.
  PRIMARY_HOST_ID: PRIMARY_HOST_ID,
  // Derived by the chart from the site group; the reconcile grants `<prefix>/#` from it.
  DIRECTORY_MQTT_TOPIC_PREFIX: DIRECTORY_PREFIX,
};

/**
 * Run the real reconcile in the credential service's image, as the chart does before the broker
 * starts. `outDir` holds the stored document and is where the reconciled one lands.
 */
function runInit({ outDir = dynsecDir } = {}) {
  const args = ['run', '--rm'];
  for (const [k, v] of Object.entries(INIT_ENV)) args.push('-e', `${k}=${v}`);
  args.push(
    '-v', `${outDir}:/out`,
    '-v', `${join(REPO, 'scripts')}:/scripts:ro`,
    '-v', `${join(REPO, 'mosquitto', 'dynsec-roles.json')}:/policy/dynsec-roles.json:ro`,
    CREDENTIAL_IMAGE, 'sh', '-c', 'exec node /scripts/mosquitto-dynsec-init.mjs',
  );
  return docker(args);
}

/**
 * One client as the stored document holds it: hashed by the image's own mosquitto_passwd, the way
 * the reconcile and the credential service hash, and transplanted into the plugin's fields.
 */
function storedClient(username, roles) {
  const r = docker(['run', '--rm', CREDENTIAL_IMAGE, '/bin/sh', ...hashArgvForUsername(username, ACCOUNTS[username])]);
  if (r.status !== 0) throw new Error(`mosquitto_passwd failed for '${username}': ${(r.stderr || '').trim()}`);
  return clientFromPasswordEntry(r.stdout.trim(), roles);
}

/**
 * The written document, read through a container. On a Linux host the reconcile has chowned it to
 * uid 1883 at 0600, which is exactly right for the broker and unreadable for whoever runs this.
 */
function readDocument(dir = dynsecDir) {
  const r = docker(['run', '--rm', '-v', `${dir}:/out:ro`, IMAGE, 'cat', '/out/dynamic-security.json']);
  if (r.status !== 0) throw new Error(`could not read the written document: ${(r.stderr || '').trim()}`);
  return JSON.parse(r.stdout);
}

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
}

/**
 * Start the broker on the composed config and the reconciled document, and return its log plus
 * whether it reached "running". The document is COPIED into the container rather than mounted:
 * the plugin rewrites it on every change, and each broker here must start from the same one. It
 * is chowned to 1883 at 0600 as the chart does; the plugin warns on anything wider.
 */
function startBroker({ withTls, certsDir }) {
  assemble({ withTls });
  const name = `fp-broker-check-${Date.now()}`;
  // NO PUBLISHED PORT. Every client below joins this container's network namespace with
  // `--network container:<name>` or runs under `docker exec`, so nothing on the host connects to
  // the broker. A published port only collides: two runs at once, and the second dies with
  // "Bind for 0.0.0.0:21883 failed", which reads as the config failing to start.
  const args = ['run', '-d', '--name', name];
  args.push('-v', `${cfg}:/cfgsrc:ro`, '-v', `${dynsecDir}:/dynsrc:ro`);
  if (certsDir) args.push('-v', `${certsDir}:/mosquitto/certs:ro`);
  args.push(
    IMAGE,
    'sh',
    '-c',
    'cp /cfgsrc/mosquitto.conf /mosquitto/config/mosquitto.conf && ' +
      'mkdir -p /mosquitto/data && ' +
      'cp /dynsrc/dynamic-security.json /mosquitto/data/dynamic-security.json && ' +
      'chown 1883:1883 /mosquitto/data /mosquitto/data/dynamic-security.json && ' +
      'chmod 0600 /mosquitto/data/dynamic-security.json && ' +
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
  // The reconcile and the certificate generator chown what they write to uid 1883, so on a Linux
  // host the temp directory is emptied from a container before the host removes it.
  docker(['run', '--rm', '-v', `${work}:/w`, IMAGE, 'sh', '-c', 'rm -rf /w/*']);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not worth failing over */
  }
}

const startFailure = (r) => (r.log.match(/^.*Error.*$/gim) || []).slice(0, 3).join('\n         ') || r.log.slice(0, 300);
const refusedConnect = (result) => /not authorised|Connection Refused/i.test(result.stderr + result.stdout);

try {
  // 0. The boot reconcile writes the document the broker will start on. This is the real script in
  // the real image, so the reconcile of a stored document, the transplant of mosquitto_passwd's hash
  // and the file's ownership are what the deployment will do, not a model of it.
  {
    const build = docker(['build', '-q', '-t', CREDENTIAL_IMAGE, join(REPO, 'gateway-credential')]);
    if (build.status !== 0) {
      throw new Error(`could not build gateway-credential/Dockerfile: ${(build.stderr || '').trim().slice(0, 300)}`);
    }

    // The stored document every boot after the first starts from. GATEWAY_B holds only the shared
    // role, so the reconcile must add its own; `probe` holds none and must be kept as it is.
    const stored = {
      clients: [storedClient(GATEWAY_B, ['gateway']), storedClient('probe', [])],
      roles: [],
      groups: [],
    };
    writeFileSync(join(dynsecDir, 'dynamic-security.json'), JSON.stringify(stored, null, '\t'));
    const first = runInit();
    if (first.status !== 0) {
      throw new Error(`scripts/mosquitto-dynsec-init.mjs failed on first boot:\n         ${(first.stderr || first.stdout || '').trim().slice(0, 600)}`);
    }
    log((first.stdout.trim().split('\n').slice(-1)[0] || '').trim());

    const doc = readDocument();
    const names = doc.clients.map((c) => c.username).sort();
    if (JSON.stringify(names) === JSON.stringify(EXPECTED_CLIENTS)) {
      ok.push('the reconcile writes the admin, every platform principal and every stored client');
    } else {
      problems.push(`the reconciled document holds ${names.join(', ')}; expected ${EXPECTED_CLIENTS.join(', ')}`);
    }
    const rolesOf = (u) => (doc.clients.find((c) => c.username === u)?.roles || []).map((r) => r.rolename).sort();
    if (JSON.stringify(rolesOf(GATEWAY_B)) === JSON.stringify(['gateway', `gateway-${GATEWAY_B}`].sort())) {
      ok.push('a stored gateway client is given its own role beside the shared one, once each');
    } else {
      problems.push(`stored gateway ${GATEWAY_B} holds roles ${rolesOf(GATEWAY_B).join(', ') || '(none)'}`);
    }
    if (rolesOf('probe').length === 0) {
      ok.push('a stored client matching no principal is kept with no role');
    } else {
      problems.push(`stored client 'probe' was given roles ${rolesOf('probe').join(', ')}`);
    }
    if (doc.clients.every((c) => typeof c.salt === 'string' && Number.isInteger(c.iterations))) {
      ok.push('every stored client is a PBKDF2 hash with its salt and iterations, never a password');
    } else {
      problems.push('a stored client lacks salt or iterations, so its password field is not a mosquitto_passwd hash');
    }
    if (doc.defaultACLAccess?.publishClientReceive === false && doc.defaultACLAccess?.subscribe === false) {
      ok.push('the document denies by default (defaultACLAccess receive and subscribe are false)');
    } else {
      problems.push('defaultACLAccess must deny receive and subscribe; mosquitto_ctrl init writes receive: true and that is rejected here');
    }

    // The second boot replays onto the document the first wrote: nothing is lost or duplicated.
    const second = runInit();
    const again = second.status === 0 ? readDocument() : null;
    if (again && JSON.stringify(again.clients.map((c) => c.username).sort()) === JSON.stringify(EXPECTED_CLIENTS)) {
      ok.push('a second boot reconciles the existing document without losing or duplicating a client');
    } else {
      problems.push(`a second boot ${second.status === 0 ? 'changed the client set' : `failed: ${(second.stderr || '').trim().slice(0, 300)}`}`);
    }

    // A document that exists and cannot be parsed is the fleet's credentials in an unknown state;
    // the reconcile must refuse rather than write a fresh one over it.
    writeFileSync(join(brokenDir, 'dynamic-security.json'), '{ this is not json');
    const broken = runInit({ outDir: brokenDir });
    if (broken.status !== 0 && /cannot be parsed/.test(broken.stderr + broken.stdout)) {
      ok.push('the reconcile refuses to overwrite a document it cannot parse');
    } else {
      problems.push('the reconcile OVERWROTE an unparseable document; it must refuse and name the file');
    }
  }

  // 1. The base policy starts on the pinned version.
  {
    const r = startBroker({ withTls: false });
    started.push(r.name);
    if (!r.running) {
      problems.push(`mosquitto.conf does NOT start on ${IMAGE}:\n         ${startFailure(r)}`);
    } else {
      ok.push(`mosquitto.conf starts and serves on ${IMAGE}`);
      log(r.log.trim().split('\n').slice(-1)[0]);
      if (/world readable/i.test(r.log)) {
        problems.push('the plugin warned that its document is world readable; it must be written 0600 owned by uid 1883');
      } else {
        ok.push('the plugin loads its document without a permissions warning');
      }
    }

    // 2. Anonymous access is refused. The security options are global so no listener can come up
    // anonymous, and this is what notices if they are moved back under a listener.
    if (r.running) {
      const anon = docker([
        'run', '--rm', '--network', `container:${r.name}`, IMAGE,
        'mosquitto_pub', '-h', '127.0.0.1', '-p', '1883', '-t', 'probe/anon', '-m', 'x'
      ]);
      if (refusedConnect(anon)) {
        ok.push('1883 refuses an unauthenticated client (allow_anonymous is in force)');
      } else {
        problems.push(
          'AN UNAUTHENTICATED CLIENT WAS ACCEPTED ON 1883. `allow_anonymous false` and the ' +
            '`plugin` lines must be declared in mosquitto.conf\'s GLOBAL section (above the first ' +
            '`listener` line) so they apply to every listener.'
        );
      }

      // Authentication only: `probe` holds no role, and at QoS 0 a denied publish still exits 0.
      // Authorisation is asserted in section 4, by delivery.
      const authed = docker([
        'run', '--rm', '--network', `container:${r.name}`, IMAGE,
        'mosquitto_pub', '-h', '127.0.0.1', '-p', '1883', '-u', 'probe', '-P', ACCOUNTS.probe,
        '-t', 'spBv1.0/Aber/DDATA/probe/dev1', '-m', 'x'
      ]);
      if (authed.status === 0) {
        ok.push('1883 accepts a stored client whose hash mosquitto_passwd wrote');
      } else {
        problems.push(
          `a client WITH valid credentials was refused on 1883: ${(authed.stderr || '').trim()}`
        );
      }
    }

    // 4. The roles confine each principal, asserted by delivery, not exit status. Publish as one
    // principal, subscribe as one permitted to read the whole tree, and ask whether the message
    // arrived. This is what would notice a shared `spBv1.0/#` grant coming back in any form.
    if (r.running) {
      /**
       * Publish as one client, read as another, and report whether the payload arrived. Matches the
       * payload, not whether the subscriber printed anything: `mosquitto_sub -W` writes `Timed out`
       * to stderr when the window closes empty, so a truthiness test would treat a dropped message
       * as delivered.
       */
      const MARKER = 'FP-ACL-PROBE';
      const delivers = (pubUser, topic, subUser = 'aber_ingestion', subTopic = 'spBv1.0/#') => {
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
        (delivers(GATEWAY_A, `spBv1.0/Aber/DDATA/${GATEWAY_A}/dev1`)),
        true
      );
      expect(
        'a gateway may NOT publish under another edge node (the forgery gateway binding cannot catch)',
        (delivers(GATEWAY_A, `spBv1.0/Aber/DDATA/${GATEWAY_B}/dev1`)),
        false
      );
      expect(
        'a stored gateway client is confined exactly as an issued one',
        (delivers(GATEWAY_B, `spBv1.0/Aber/DDATA/${GATEWAY_B}/dev1`)),
        true
      );
      expect(
        'a stored client with no role authenticates and reaches nothing (publish)',
        (delivers('probe', 'spBv1.0/Aber/DDATA/probe/dev1')),
        false
      );
      expect(
        'a stored client with no role authenticates and reaches nothing (subscribe)',
        (delivers('aber_ingestion', `spBv1.0/Aber/NCMD/${GATEWAY_A}`, 'probe', 'spBv1.0/#')),
        false
      );
      expect(
        'the ingestion principal may NOT publish DDATA',
        (delivers('aber_ingestion', `spBv1.0/Aber/DDATA/${GATEWAY_A}/dev1`)),
        false
      );
      expect(
        'the ingestion principal may NOT publish DBIRTH',
        (delivers('aber_ingestion', `spBv1.0/Aber/DBIRTH/${GATEWAY_A}/dev1`)),
        false
      );
      expect(
        'the ingestion principal MAY publish a rebirth NCMD (alias recovery depends on it)',
        (delivers('aber_ingestion', `spBv1.0/Aber/NCMD/${GATEWAY_A}`)),
        true
      );
      expect(
        'the i3X principal may publish NOTHING (it refuses writes in code; the broker agrees)',
        (delivers('aber_i3x', `spBv1.0/Aber/NCMD/${GATEWAY_A}`)),
        false
      );
      expect(
        'the monitoring principal may publish NOTHING',
        (delivers('aber_monitor', `spBv1.0/Aber/DDATA/${GATEWAY_A}/dev1`)),
        false
      );
      expect(
        'the plugin\'s admin reads NOTHING under spBv1.0 (it speaks to the plugin and nothing else)',
        (delivers('aber_ingestion', `spBv1.0/Aber/NCMD/${GATEWAY_A}`, ADMIN, 'spBv1.0/#')),
        false
      );
      // A gateway's own NCMD must reach it through the wildcard subscription the simulator flow and
      // validate.py use. The shared `gateway` role grants the subscription across spBv1.0/ and the
      // per-gateway role decides delivery per message; if a future version refuses the SUBACK
      // instead, rebirth recovery breaks silently.
      expect(
        'a gateway receives its own NCMD through a wildcard subscription',
        (delivers('aber_ingestion', `spBv1.0/Aber/NCMD/${GATEWAY_A}`,
          GATEWAY_A, 'spBv1.0/+/NCMD/+')),
        true
      );
      expect(
        'a gateway does NOT receive another edge node\'s NCMD through that same subscription',
        (delivers('aber_ingestion', `spBv1.0/Aber/NCMD/${GATEWAY_B}`,
          GATEWAY_A, 'spBv1.0/+/NCMD/+')),
        false
      );

      // The Directory topic (ingestion/directory_publish.py): one document holding the whole
      // address space, published outside `spBv1.0/`. A topic has no caller, so the role is the
      // entire access control. The negative assertion is the load-bearing half: a gateway must not
      // be able to enumerate the site, and reading is silent.
      expect(
        'the ingestion principal MAY publish the Directory (it is the only writer)',
        (delivers('aber_ingestion', DIRECTORY_DOC,
          'aber_ingestion', DIRECTORY_FILTER)),
        true
      );
      expect(
        'a gateway may NOT read the Directory (it would enumerate every asset on the site)',
        (delivers('aber_ingestion', DIRECTORY_DOC,
          GATEWAY_A, DIRECTORY_FILTER)),
        false
      );
      // The i3X server reads the Directory over PostgREST, so its role holds no grant here
      // (issue #297). An unused grant only ever widens what arrives, so nothing else in this
      // check would notice it coming back.
      expect(
        'the i3X principal may NOT read the Directory (it reads it from the database)',
        (delivers('aber_ingestion', DIRECTORY_DOC,
          'aber_i3x', DIRECTORY_FILTER)),
        false
      );

      // The Unified Namespace (ingestion/uns_publish.py): every reading in the clear under uns/.
      // The same two halves, for the same reason: the daemon is the only writer, and a gateway
      // reading the tree would read every machine's telemetry with one credential.
      expect(
        'the ingestion principal MAY publish the Unified Namespace (it is the only writer)',
        (delivers('aber_ingestion', 'uns/Aber/Site/Area/Cell/dev1/Speed',
          'aber_ingestion', 'uns/#')),
        true
      );
      expect(
        'a gateway may NOT read the Unified Namespace (one credential would read the whole plant)',
        (delivers('aber_ingestion', 'uns/Aber/Site/Area/Cell/dev1/Speed',
          GATEWAY_A, 'uns/#')),
        false
      );
      expect(
        'a gateway may NOT publish into the Unified Namespace (only decoded, verified readings belong there)',
        (delivers(GATEWAY_A, `uns/Aber/Site/Area/Cell/${GATEWAY_A}/Speed`,
          'aber_ingestion', 'uns/#')),
        false
      );

      // The Sparkplug primary-host STATE (ingestion/primary_host.py). The roles have granted every
      // gateway READ of this subtree from the beginning; until issue #149 nothing was allowed to
      // write it, so every gateway watched a permanently empty topic and a compliant third-party
      // one fell back to whatever its vendor chose. All four assertions matter:
      //
      //   * the daemon can write its OWN host id -- without this the birth certificate is refused
      //     and the topic stays empty, which is the original fault;
      //   * a gateway can READ it, which is the entire point of publishing it;
      //   * the daemon canNOT write ANOTHER host id -- the grant is one literal topic, so this
      //     principal cannot announce the death of a host application that is not it;
      //   * a gateway canNOT write its own, because a birth certificate anyone can forge tells an
      //     edge node its consumer is alive when it is not, which is worse than no STATE at all.
      const stateTopic = `spBv1.0/STATE/${PRIMARY_HOST_ID}`;
      expect(
        'the ingestion principal MAY publish its own primary-host STATE',
        (delivers('aber_ingestion', stateTopic, 'aber_ingestion', 'spBv1.0/STATE/#')),
        true
      );
      expect(
        'a gateway RECEIVES the primary-host STATE (this is what the read grant was always for)',
        (delivers('aber_ingestion', stateTopic, GATEWAY_A, 'spBv1.0/STATE/#')),
        true
      );
      expect(
        'the ingestion principal may NOT publish STATE for another host id (the grant is one literal topic)',
        (delivers('aber_ingestion', `spBv1.0/STATE/${OTHER_HOST_ID}`,
          'aber_ingestion', 'spBv1.0/STATE/#')),
        false
      );
      expect(
        'a gateway may NOT publish a primary-host STATE (a forgeable birth certificate is worse than none)',
        (delivers(GATEWAY_A, stateTopic, 'aber_ingestion', 'spBv1.0/STATE/#')),
        false
      );

      // $SYS is reachable only by the monitoring account, and it is load-bearing: the broker's own
      // probes authenticate as it, so losing this rule leaves the pod permanently NotReady.
      const sysRead = (user) => docker(['exec', r.name, 'mosquitto_sub', '-u', user,
        '-P', ACCOUNTS[user], '-t', '$SYS/broker/version', '-C', '1', '-W', '4']);
      if ((sysRead('aber_monitor').stdout || '').includes('mosquitto version')) {
        ok.push('the monitoring principal can read $SYS (the health probes depend on it)');
      } else {
        problems.push('the monitoring principal CANNOT read $SYS -- every readiness probe will fail and no workload waiting on the broker will start');
      }
      if ((sysRead(GATEWAY_A).stdout || '').includes('mosquitto version')) {
        problems.push('a gateway credential can read $SYS; the `$SYS/#` grant belongs to the monitor role alone');
      } else {
        ok.push('a gateway credential cannot read $SYS');
      }
      if ((sysRead(ADMIN).stdout || '').includes('mosquitto version')) {
        problems.push('the plugin\'s admin can read $SYS; its role must grant $CONTROL/dynamic-security/# and nothing else');
      } else {
        ok.push('the plugin\'s admin cannot read $SYS');
      }

      // 6. The control API, driven as the credential service drives it: mosquitto_rr, one command
      // per request. Run inside the broker container the way the operator CLI and the orphan
      // sweep run it.
      const send = controlSender(
        { host: '127.0.0.1', port: 1883, username: ADMIN, password: ACCOUNTS[ADMIN] },
        ['docker', 'exec', r.name],
      );
      const inventory = () => summariseInventory(
        assertOk(send({ command: 'listClients', verbose: true })),
        assertOk(send({ command: 'listRoles', verbose: true })),
      );

      let listed;
      try {
        listed = inventory();
      } catch (err) {
        problems.push(`the control API did not answer the admin: ${err.message}`);
      }
      if (listed) {
        const usernames = listed.clients.map((c) => c.username).sort();
        if (JSON.stringify(usernames) === JSON.stringify(EXPECTED_CLIENTS)) {
          ok.push('listClients returns the reconciled accounts (the Access Control page reads this)');
        } else {
          problems.push(`listClients returned ${usernames.join(', ')}`);
        }
        const text = JSON.stringify(listed);
        if (!/salt|iterations/.test(text) && !text.includes(ACCOUNTS[ADMIN])) {
          ok.push('the inventory summary carries roles and state and no hash material');
        } else {
          problems.push('summariseInventory leaked salt, iterations or a password into the summary');
        }
        if (listed.roles.some((role) => role.rolename === 'gateway' && role.acls.length > 0)) {
          ok.push('listRoles returns each role with its ACLs');
        } else {
          problems.push('listRoles verbose did not return the gateway role with ACLs');
        }
      }

      // Issue, as the service does; then re-issue with a new password, as a rotation does.
      const passwordC1 = 'gateway-c-secret-0001';
      const passwordC2 = 'gateway-c-secret-0002';
      const pubAsC = (password) => docker(['exec', r.name, 'mosquitto_pub', '-u', GATEWAY_C, '-P', password,
        '-t', `spBv1.0/Aber/DDATA/${GATEWAY_C}/dev1`, '-m', 'x']);
      let issued;
      try {
        issued = issueWithControl(send, GATEWAY_C, passwordC1);
      } catch (err) {
        problems.push(`issuing ${GATEWAY_C} over the control API failed: ${err.message}`);
      }
      if (issued) {
        if (issued.replaced === false) ok.push('issuing a new gateway creates its role and client');
        else problems.push('issuing a gateway that did not exist reported replaced: true');
        ACCOUNTS[GATEWAY_C] = passwordC1;
        expect(
          'an issued gateway may publish under its own edge node, with no reload',
          (delivers(GATEWAY_C, `spBv1.0/Aber/DDATA/${GATEWAY_C}/dev1`)),
          true
        );
        expect(
          'an issued gateway may NOT publish under another edge node',
          (delivers(GATEWAY_C, `spBv1.0/Aber/DDATA/${GATEWAY_A}/dev1`)),
          false
        );

        // A re-issue drops the live session as well, and the mint dialog promises an operator
        // exactly that (issue #291). Nothing here asserted it: the block below checks the next
        // CONNECT and the live-session test further down is written for disableClient, so a
        // broker bump could change this silently while the dialog went on making the promise.
        //
        // THE POSITIVE CONTROL IS LOAD-BEARING. A subscriber that never really attached would
        // also "exit", and would prove nothing; a message delivered to it first is what makes the
        // session observed rather than assumed.
        //
        // The window is 60s rather than the 20s below because this assertion reads the subscriber's
        // exit as the re-issue's doing: a window that closed on its own would look identical, and
        // the re-issue happens ~7s in. `stillUp` refuses that reading outright.
        const rotated = '/tmp/rotated.txt';
        docker(['exec', '-d', r.name, 'sh', '-c',
          `mosquitto_sub -u ${GATEWAY_C} -P ${passwordC1} -t 'spBv1.0/+/NCMD/+' -W 60 > ${rotated} 2>&1; echo EXIT:$? >> ${rotated}`]);
        docker(['exec', r.name, 'sleep', '2']);
        docker(['exec', r.name, 'mosquitto_pub',
          '-u', 'aber_ingestion', '-P', ACCOUNTS.aber_ingestion,
          '-t', `spBv1.0/Aber/NCMD/${GATEWAY_C}`, '-m', MARKER]);
        docker(['exec', r.name, 'sleep', '2']);
        const beforeRotation = docker(['exec', r.name, 'cat', rotated]).stdout || '';
        const sessionWasLive = beforeRotation.includes(MARKER);
        const stillUp = !beforeRotation.includes('EXIT:');

        let reissued;
        try {
          reissued = issueWithControl(send, GATEWAY_C, passwordC2);
        } catch (err) {
          problems.push(`re-issuing ${GATEWAY_C} failed: ${err.message}`);
        }
        if (reissued) {
          if (reissued.replaced === true) ok.push('re-issuing an existing gateway reports replaced: true');
          else problems.push('re-issuing an existing gateway reported replaced: false');

          docker(['exec', r.name, 'sleep', '3']);
          if (!sessionWasLive || !stillUp) {
            problems.push(
              !sessionWasLive
                ? 'the positive control never reached the subscriber, so nothing here proves what '
                  + 'a re-issue does to a live session'
                : 'the subscriber had already exited before the re-issue, so its exit says nothing '
                  + 'about what the re-issue did'
            );
          } else if ((docker(['exec', r.name, 'cat', rotated]).stdout || '').includes('EXIT:')) {
            ok.push('setClientPassword drops the live session (the subscriber exited)');
          } else {
            problems.push(
              'a re-issue did NOT drop the live session; the mint dialog tells an operator it does'
            );
          }

          if (refusedConnect(pubAsC(passwordC1))) {
            ok.push('after a re-issue the previous password is refused');
          } else {
            problems.push('after a re-issue the PREVIOUS password still authenticates');
          }
          if (pubAsC(passwordC2).status === 0) {
            ok.push('after a re-issue the new password authenticates');
          } else {
            problems.push('after a re-issue the new password is refused');
          }
          ACCOUNTS[GATEWAY_C] = passwordC2;
        }

        // Revocation is disableClient, and its whole point is that a LIVE session is dropped. A
        // subscriber is left connected with a 20-second window; if it is still there 5 seconds
        // after the disable, the revocation did not reach the session.
        const kicked = '/tmp/kicked.txt';
        docker(['exec', '-d', r.name, 'sh', '-c',
          `mosquitto_sub -u ${GATEWAY_C} -P ${ACCOUNTS[GATEWAY_C]} -t 'spBv1.0/+/NCMD/+' -W 20 > ${kicked} 2>&1; echo EXIT:$? >> ${kicked}`]);
        docker(['exec', r.name, 'sleep', '2']);
        let disabled;
        try {
          assertOk(send({ command: 'disableClient', username: GATEWAY_C }));
          disabled = true;
        } catch (err) {
          problems.push(`disableClient ${GATEWAY_C} failed: ${err.message}`);
        }
        if (disabled) {
          docker(['exec', r.name, 'sleep', '3']);
          if ((docker(['exec', r.name, 'cat', kicked]).stdout || '').includes('EXIT:')) {
            ok.push('disableClient drops the live session (the subscriber exited)');
          } else {
            problems.push('disableClient did NOT drop the live session; a revoked gateway would stay connected');
          }
          if (refusedConnect(pubAsC(ACCOUNTS[GATEWAY_C]))) {
            ok.push('a disabled client is refused on its next CONNECT');
          } else {
            problems.push('a DISABLED client was accepted on CONNECT');
          }
          const state = inventory().clients.find((c) => c.username === GATEWAY_C);
          if (state?.disabled === true) {
            ok.push('listClients reports the disabled account as disabled (what the page shows)');
          } else {
            problems.push('listClients did not report the disabled account as disabled');
          }
          try {
            assertOk(send({ command: 'enableClient', username: GATEWAY_C }));
            if (pubAsC(ACCOUNTS[GATEWAY_C]).status === 0) {
              ok.push('enableClient re-admits the account (what a re-issue after revocation does)');
            } else {
              problems.push('enableClient did not re-admit the account');
            }
          } catch (err) {
            problems.push(`enableClient ${GATEWAY_C} failed: ${err.message}`);
          }
        }
      }

      // The refusal the service turns into `existed: false`.
      const unknown = send({ command: 'disableClient', username: 'gwy000000000000000000000' });
      if (isRefusal(unknown, 'not found')) {
        ok.push('disabling an account that does not exist is refused with "not found"');
      } else {
        problems.push(`disabling an unknown account answered ${JSON.stringify(unknown).slice(0, 120)}`);
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
      const r = startBroker({ withTls: true, certsDir: certs });
      started.push(r.name);
      if (!r.running) {
        problems.push(
          'mosquitto.conf + mosquitto-tls.conf does NOT start:\n         ' + startFailure(r) +
            '\n         A "Duplicate ... value" error here means a security option was added to ' +
            'mosquitto-tls.conf; they belong in mosquitto.conf\'s global section only.'
        );
      } else {
        ok.push('mosquitto.conf + mosquitto-tls.conf starts with a TLS listener on 8883');
        const tls = docker([
          'run', '--rm', '--network', `container:${r.name}`,
          '-v', `${certs}:/c:ro`, IMAGE,
          'mosquitto_pub', '--cafile', '/c/ca.crt', '-h', 'localhost', '-p', '8883',
          '-u', GATEWAY_A, '-P', ACCOUNTS[GATEWAY_A],
          '-t', `spBv1.0/Aber/DDATA/${GATEWAY_A}/tls`, '-m', 'x'
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
    const TLS_INIT_IMAGE = 'aber-mosquitto-tls-init:check';
    const build = docker(['build', '-q', '-t', TLS_INIT_IMAGE, join(REPO, 'mosquitto', 'tls-init')]);

    if (build.status !== 0) {
      problems.push(
        `could not build mosquitto/tls-init/Dockerfile: ${(build.stderr || '').trim().slice(0, 300)}`
      );
    } else {
      const certs = join(work, 'issued');
      mkdirSync(certs, { recursive: true });

      /** Run the real generator against `certs`, exactly as the broker init did. */
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
            'RE-RUNNING mosquitto-tls-init MINTED A NEW ROOT. Every Remote gateway trusts the '
            + 'previous one by hand-distributed copy, so this would take the whole fleet offline '
            + 'on the next broker start while the stack reported itself healthy.'
          );
        } else {
          ok.push('re-running mosquitto-tls-init reuses the existing root (fingerprint unchanged)');
        }

        // (a) + (b): the broker serves the issued leaf, and TLS does not relax authentication. The
        // generator chowns the key to uid 1883 itself, so this also exercises the ownership logic
        // the real deployment depends on.
        const r = startBroker({ withTls: true, certsDir: certs });
        started.push(r.name);

        if (!r.running) {
          problems.push(
            'the broker does NOT start on certificates issued by mosquitto-tls-init:\n         ' + startFailure(r)
          );
        } else {
          const verified = docker([
            'run', '--rm', '--network', `container:${r.name}`,
            '-v', `${certs}:/c:ro`, IMAGE,
            'mosquitto_pub', '--cafile', '/c/ca.crt', '-h', 'localhost', '-p', '8883',
            '-u', GATEWAY_A, '-P', ACCOUNTS[GATEWAY_A],
            '-t', `spBv1.0/Aber/DDATA/${GATEWAY_A}/tls`, '-m', 'x',
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
          if (refusedConnect(anonTls)) {
            ok.push('8883 refuses an unauthenticated client (TLS does not relax authentication)');
          } else {
            problems.push(
              'AN UNAUTHENTICATED CLIENT WAS ACCEPTED ON 8883. The security options must stay in '
              + 'mosquitto.conf\'s GLOBAL section so the TLS listener inherits them; a `plugin` line '
              + 'under a listener is refused outright on 2.0.x.'
            );
          }
        }
      }
    }
  }

  // 7. Nothing in the repository deletes a role. Measured on 2.0.22: deleteRole on a role a client
  // holds took the broker down (mosquitto/README.md). The reconcile regenerates orphaned gateway
  // roles instead, and every caller of the control API must keep to that.
  {
    const forbidden = new RegExp('command[\'"]?\\s*:\\s*[\'"]delete' + 'Role');
    const roots = ['scripts', 'supabase/functions', 'deploy', 'gateway-credential', 'ingestion', 'frontend/src'];
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(p);
        } else if (/\.(mjs|js|jsx|ts|tsx|py|sh|ya?ml|tpl)$/.test(entry.name) && forbidden.test(readFileSync(p, 'utf8'))) {
          offenders.push(p.slice(REPO.length + 1));
        }
      }
    };
    for (const root of roots) {
      const dir = join(REPO, root);
      if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
    }
    if (offenders.length === 0) {
      ok.push('no repository script issues deleteRole to the plugin');
    } else {
      problems.push(`deleteRole is issued by ${offenders.join(', ')}; a role a client holds cannot be deleted safely on 2.0.x`);
    }
  }
} catch (err) {
  problems.push(err.message);
} finally {
  cleanup();
}

for (const line of ok) console.log(`  ok   ${line}`);
if (problems.length) {
  console.error('\nBroker configuration is broken:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\nThis is checked against ${IMAGE} -- the tag the chart pins -- because mosquitto's\n` +
      'accepted syntax and the plugin\'s behaviour CHANGE BETWEEN MINOR VERSIONS. A config that works\n' +
      'on `latest` can take the broker down the moment the image is pinned, and the\n' +
      'plugin\'s treatment of `%u`, of a deleted role and of a disabled session is measured, not\n' +
      'assumed (mosquitto/README.md).\n'
  );
  process.exit(1);
}
console.log(`\nBroker configuration starts, authenticates and confines every principal on ${IMAGE}.`);
