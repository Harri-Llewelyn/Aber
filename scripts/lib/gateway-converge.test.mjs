/**
 * What `aber-gateway-converge` does with the state an enrolled appliance holds.
 *
 *     node --test scripts/lib/gateway-converge.test.mjs
 *
 * THE SUBJECT IS A SHELL SCRIPT, not a module beside this one, which makes this the only file in
 * this directory without a sibling. It earns the place: the script runs unattended on every
 * appliance every hour and nothing else exercises it, its refusals are the difference between a
 * fleet that converges and one that silently does not, and the record it leaves is what the forge
 * shows an operator. `ansible-pull` is stubbed, so what is asserted is the decision -- which tag,
 * from which file, with which variables, and what was written afterwards -- and never Ansible.
 *
 * SKIPPED WITHOUT `jq`, which the script reads and writes its JSON with and which the appliance
 * gets from the platform playbook's base role. CI's runner has it; a Windows development box does
 * not. The skip is loud rather than a green tick over nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'forge', 'gateway-platform', 'roles', 'converge', 'files', 'aber-gateway-converge');

/** Every tool the script itself invokes. A missing one is a skipped suite, never a failure. */
const MISSING = ['bash', 'jq', 'python3', 'git'].filter(
  (tool) => spawnSync(tool, ['--version'], { stdio: 'ignore' }).status !== 0,
);
// `openssl version`, not `--version`: OpenSSL 3 refuses the long form.
if (spawnSync('openssl', ['version'], { stdio: 'ignore' }).status !== 0) MISSING.push('openssl');
const SKIP = MISSING.length
  ? `needs ${MISSING.join(', ')} on PATH; the platform playbook's base role installs them on an appliance`
  : false;

/** Where the shim below hands anything but `s_client` on to. */
const OPENSSL = SKIP ? null : spawnSync('bash', ['-c', 'command -v openssl'], { encoding: 'utf8' }).stdout.trim();

/** Forward slashes throughout: these become environment variables a shell reads. */
const posix = (p) => p.replace(/\\/g, '/');

/** A self-signed root. EC because one is made per fixture and an RSA keygen is not free. */
function root(dir, name, days = 3650) {
  execFileSync(
    'openssl',
    ['req', '-x509', '-batch', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-keyout', `${dir}/${name}.key`, '-out', `${dir}/${name}.crt`, '-days', String(days)],
    { stdio: 'ignore' },
  );
  return readFileSync(`${dir}/${name}.crt`, 'utf8');
}

/** The pin for a PEM, computed the way the one-liner's stage 0 does. */
function pinOf(path) {
  return execFileSync(
    'bash',
    ['-c', `openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform DER `
      + '| openssl dgst -sha256 -binary | base64 | tr -d "\\n"', 'sh', path],
    { encoding: 'utf8' },
  ).trim();
}

/**
 * A stand-in for the platform repository, which the script clones `main` of to read the published
 * roots. A local path rather than the forge's `ssh://`: the clone is real, so what is asserted is
 * that the script reads `trust/ca-bundle.pem` off `main` and what it does with what it finds.
 */
function platformRepository(dir, bundle) {
  const repo = `${dir}/platform.git`;
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(`${repo}/site.yml`, '- hosts: localhost\n');
  if (bundle !== null) {
    mkdirSync(`${repo}/trust`, { recursive: true });
    writeFileSync(`${repo}/trust/ca-bundle.pem`, bundle);
  }
  git('add', '-A');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=Test', 'commit', '-q', '-m', 'seed');
  return repo;
}

/**
 * An appliance's state directory, as `bootstrap.mjs` leaves it. `pointer` is the platform.yml the
 * puller's checkout carries; null means a repository that has none yet. Anything set to null is
 * left out, which is how the absent-file refusals are reached.
 *
 * `bundle` is what `main` of the platform repository carries as `trust/ca-bundle.pem`; null, the
 * default, is a platform published before the bundle existed. `installedCa` is what enrolment left
 * in /data/certs/ca.crt.
 */
function appliance({
  key = 'PRIVATE KEY', knownHosts = 'forge ssh-ed25519 AAAA', repository, pointer, custom,
  bundle = null, installedCa = 'the root enrolment installed\n',
} = {}) {
  const state = posix(mkdtempSync(join(tmpdir(), 'aber-converge-')));
  const gitops = `${state}/data/gitops`;
  mkdirSync(gitops, { recursive: true });
  mkdirSync(`${state}/data/certs`, { recursive: true });
  // The compose project the platform playbook lays down, which the restart below runs from.
  mkdirSync(`${state}/opt`, { recursive: true });

  if (key !== null) writeFileSync(`${gitops}/id_ed25519`, key);
  if (knownHosts !== null) writeFileSync(`${gitops}/known_hosts`, knownHosts);
  if (installedCa !== null) writeFileSync(`${state}/data/certs/ca.crt`, installedCa);
  // The two addresses install_trust() reads out of it, beside the secret it must not read.
  writeFileSync(
    `${state}/data/gateway.env`,
    "export GATEWAY_MQTT_HOST='mqtt.plant.example'\nexport GATEWAY_MQTT_TLS_PORT='8883'\n"
      + "export NODERED_CREDENTIAL_SECRET='not-for-a-child-process'\n",
  );

  const platformUrl = SKIP ? '' : posix(platformRepository(state, bundle));
  if (repository !== null) {
    writeFileSync(`${gitops}/repository.json`, JSON.stringify({
      ssh_url: 'ssh://git@forge:22/gateways/gateway-gwy1.git',
      branch: 'main',
      platform_ssh_url: platformUrl,
      platform_tag: 'v0.0.9',
      ...repository,
    }, null, 2));
  }
  if (pointer || custom) mkdirSync(`${gitops}/repo`, { recursive: true });
  if (pointer) writeFileSync(`${gitops}/repo/platform.yml`, pointer);
  if (custom) {
    writeFileSync(`${gitops}/repo/custom.yml`, custom);
    // A real repository, because the script records the revision it ran the playbook from and
    // `rev-parse` in a directory that is not one would report nothing.
    const git = (...args) => execFileSync('git', args, { cwd: `${gitops}/repo`, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@example.invalid', '-c', 'user.name=Test', 'commit', '-q', '--allow-empty', '-m', 'seed');
  }
  return { state, gitops, platformUrl };
}

/**
 * Run the script with a stubbed `ansible-pull` first on PATH. The stub records its own argv one
 * argument per line, so an argument carrying a space is still one line's worth of value, and exits
 * with `exit`.
 */
function converge({ state, gitops }, { exit = 0, customExit = 0, connects = true } = {}) {
  const bin = `${state}/bin`;
  mkdirSync(bin, { recursive: true });

  /**
   * `openssl` as the script finds it, except that `s_client` never leaves the box: the guard it
   * exists for is a connection to a live broker, which a unit test has none of. Everything else --
   * parsing a block, computing the pin, reading the expiry -- is the real binary, so the values
   * asserted below are the ones an appliance would write.
   */
  writeFileSync(
    `${bin}/openssl`,
    `#!/bin/sh\nif [ "$1" = "s_client" ]; then exit ${connects ? 0 : 1}; fi\n`
      + `exec '${OPENSSL}' "$@"\n`,
    { mode: 0o755 },
  );
  // The restart the new root needs, recorded rather than performed.
  writeFileSync(
    `${bin}/docker`,
    `#!/bin/sh\n: > '${state}/docker.argv'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${state}/docker.argv'; done\n`,
    { mode: 0o755 },
  );

  /** A stub recording its working directory and its argv, one argument per line, then exiting. */
  const stub = (name, code) => {
    writeFileSync(
      `${bin}/${name}`,
      `#!/bin/sh\npwd > '${state}/${name}.cwd'\n: > '${state}/${name}.argv'\n`
        + `for a in "$@"; do printf '%s\\n' "$a" >> '${state}/${name}.argv'; done\nexit ${code}\n`,
      { mode: 0o755 },
    );
  };
  stub('ansible-pull', exit);
  stub('ansible-playbook', customExit);

  const run = spawnSync('bash', [posix(SCRIPT)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ABER_STATE_DIR: state,
      ABER_DATA_DIR: `${state}/data`,
      ABER_COMPOSE_DIR: `${state}/opt`,
    },
  });

  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const lines = (p) => { const t = read(p); return t === null ? null : t.trimEnd().split('\n'); };
  const converged = `${gitops}/converged.json`;
  return {
    status: run.status,
    output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
    argv: lines(`${state}/ansible-pull.argv`),
    customArgv: lines(`${state}/ansible-playbook.argv`),
    customCwd: read(`${state}/ansible-playbook.cwd`)?.trim() ?? null,
    record: existsSync(converged) ? JSON.parse(readFileSync(converged, 'utf8')) : null,
    caFile: read(`${state}/data/certs/ca.crt`),
    caJson: (() => { const t = read(`${state}/data/certs/ca.json`); return t === null ? null : JSON.parse(t); })(),
    dockerArgv: lines(`${state}/docker.argv`),
  };
}

/** The value a stub was given for a named flag. */
const flag = (argv, name) => argv[argv.indexOf(name) + 1];

/** Every value for a flag that is passed more than once, in order. */
const flags = (argv, name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));

test('refuses when the deploy key is absent, naming the file', { skip: SKIP }, () => {
  const result = converge(appliance({ key: null }));
  assert.equal(result.status, 1);
  assert.match(result.output, /REFUSING/);
  assert.match(result.output, /id_ed25519/);
  assert.equal(result.argv, null, 'nothing should have been pulled');
});

test('refuses when the forge host key is absent', { skip: SKIP }, () => {
  const result = converge(appliance({ knownHosts: null }));
  assert.equal(result.status, 1);
  assert.match(result.output, /known_hosts/);
  assert.equal(result.argv, null);
});

test('refuses when the platform named no repository at enrolment', { skip: SKIP }, () => {
  // An appliance enrolled against a deployment with no platform repository. It keeps publishing;
  // it has nothing to converge to, and the message says to re-enrol rather than sitting quiet.
  const result = converge(appliance({ repository: { platform_ssh_url: null } }));
  assert.equal(result.status, 1);
  assert.match(result.output, /platform_ssh_url/);
  assert.match(result.output, /Re-enrol/i);
  assert.equal(result.argv, null);
});

test('refuses and records when no file names a tag', { skip: SKIP }, () => {
  const result = converge(appliance({ repository: { platform_tag: null } }));
  assert.equal(result.status, 1);
  assert.equal(result.argv, null);
  // RECORDED, not merely logged: the puller pushes this to the appliance branch, so an appliance
  // that cannot converge says so in the forge rather than only in its own journal.
  assert.equal(result.record.outcome, 'refused');
  assert.match(result.record.detail, /no platform tag/);
});

test("converges to the tag the gateway's own platform.yml names", { skip: SKIP }, () => {
  const state = appliance({ pointer: 'platform:\n  tag: v1.2.3\n' });
  const result = converge(state);

  assert.equal(result.status, 0);
  assert.equal(flag(result.argv, '--checkout'), 'v1.2.3');
  assert.equal(flag(result.argv, '--url'), state.platformUrl, 'the URL enrolment recorded, verbatim');
  assert.equal(flag(result.argv, '--directory'), `${state.state}/platform`);
  assert.ok(result.argv.includes('--purge'), '--purge is what makes a re-run a clean checkout');
  assert.ok(result.argv.includes('site.yml'));

  assert.equal(result.record.outcome, 'converged');
  assert.equal(result.record.tag, 'v1.2.3');
  assert.match(result.record.converged_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("falls back to the tag enrolment recorded when the pointer names none", { skip: SKIP }, () => {
  // The window before the puller's first fetch: repository.json is the only file holding a tag.
  const result = converge(appliance({ pointer: 'platform:\n  vars:\n    chrony_servers: []\n' }));
  assert.equal(result.status, 0);
  assert.equal(flag(result.argv, '--checkout'), 'v0.0.9');
  assert.equal(result.record.tag, 'v0.0.9');
});

test('hands the platform.yml vars to ansible-pull as extra vars', { skip: SKIP }, () => {
  const result = converge(appliance({
    pointer: 'platform:\n  tag: v1.2.3\n  vars:\n    chrony_servers:\n      - "server ntp.plant.example iburst"\n',
  }));
  assert.equal(result.status, 0);
  const extra = JSON.parse(flag(result.argv, '--extra-vars'));
  assert.deepEqual(extra, { chrony_servers: ['server ntp.plant.example iburst'] });
});

test('an empty object is passed when the pointer declares no vars', { skip: SKIP }, () => {
  const result = converge(appliance({ pointer: 'platform:\n  tag: v1.2.3\n' }));
  assert.deepEqual(JSON.parse(flag(result.argv, '--extra-vars')), {});
});

test("records a failure with ansible-pull's exit code, and exits with it", { skip: SKIP }, () => {
  const result = converge(appliance({ pointer: 'platform:\n  tag: v1.2.3\n' }), { exit: 4 });
  assert.equal(result.status, 4, "the timer's unit status is how a failing convergence is noticed");
  assert.equal(result.record.outcome, 'failed');
  assert.equal(result.record.tag, 'v1.2.3');
  assert.match(result.record.detail, /exited 4/);
});

test('a malformed platform.yml falls back rather than aborting', { skip: SKIP }, () => {
  // The pointer is changed by pull request, so it can arrive unparseable. An appliance that
  // stopped converging over a typo in one gateway's file would need a visit to fix it.
  const result = converge(appliance({ pointer: 'platform: [this is not a mapping\n' }));
  assert.equal(result.status, 0);
  assert.equal(flag(result.argv, '--checkout'), 'v0.0.9');
  // The declared default, not the empty string a failed read leaves behind.
  assert.deepEqual(JSON.parse(flag(result.argv, '--extra-vars')), {});
});

// This gateway's own playbook, beside its flow on main

test("records no custom run when the repository carries no playbook of its own", { skip: SKIP }, () => {
  const result = converge(appliance({ pointer: 'platform:\n  tag: v1.2.3\n' }));
  assert.equal(result.status, 0);
  assert.equal(result.customArgv, null, 'nothing of the gateway\'s own should have been run');
  // `null`, not an absent key: the platform reads this field to say "none" rather than "unknown".
  assert.equal(result.record.custom, null);
  assert.match(result.output, /no custom\.yml/);
});

test("runs the gateway's own custom.yml from the checkout, recording the revision", { skip: SKIP }, () => {
  const state = appliance({ pointer: 'platform:\n  tag: v1.2.3\n', custom: '- hosts: localhost\n' });
  const result = converge(state);

  assert.equal(result.status, 0);
  assert.ok(result.customArgv.includes('custom.yml'));
  // From the checkout, so roles/ and files/ beside custom.yml resolve.
  assert.equal(result.customCwd, `${state.gitops}/repo`);

  assert.equal(result.record.outcome, 'converged', 'the platform outcome is its own');
  assert.equal(result.record.custom.outcome, 'converged');
  assert.match(result.record.custom.revision, /^[0-9a-f]{40}$/);
  assert.match(result.record.custom.ran_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("hands custom.yml the platform's paths, after the gateway's own vars", { skip: SKIP }, () => {
  const state = appliance({
    pointer: 'platform:\n  tag: v1.2.3\n  vars:\n    chrony_servers:\n      - "server ntp.plant.example iburst"\n',
    custom: '- hosts: localhost\n',
  });
  const result = converge(state);

  const given = flags(result.customArgv, '--extra-vars').map((v) => JSON.parse(v));
  assert.equal(given.length, 2, 'the gateway\'s vars and the platform\'s paths, in that order');
  assert.deepEqual(given[0], { chrony_servers: ['server ntp.plant.example iburst'] });
  // LAST, so a custom.yml cannot move the directories the platform owns by declaring them itself.
  assert.deepEqual(given[1], {
    aber_state_dir: state.state,
    aber_data_dir: `${state.state}/data`,
    aber_compose_dir: `${state.state}/opt`,
    aber_repo_dir: `${state.gitops}/repo`,
    aber_platform_tag: 'v1.2.3',
  });
});

test('a failing custom.yml leaves the platform converged and still fails the unit', { skip: SKIP }, () => {
  const result = converge(
    appliance({ pointer: 'platform:\n  tag: v1.2.3\n', custom: '- hosts: localhost\n' }),
    { customExit: 2 },
  );
  // THE EXIT STATUS IS THE CUSTOM RUN'S. Recorded in the forge and visible in the unit's status:
  // a field nobody is watching is not where the failure this lane most often produces should live.
  assert.equal(result.status, 2);
  assert.equal(result.record.outcome, 'converged');
  assert.equal(result.record.tag, 'v1.2.3');
  assert.equal(result.record.custom.outcome, 'failed');
  assert.match(result.record.custom.detail, /exited 2/);
});

test('custom.yml is not attempted when the platform run failed', { skip: SKIP }, () => {
  const result = converge(
    appliance({ pointer: 'platform:\n  tag: v1.2.3\n', custom: '- hosts: localhost\n' }),
    { exit: 3 },
  );
  assert.equal(result.status, 3);
  assert.equal(result.record.outcome, 'failed');
  // The platform is what puts Docker and the directories in place; a custom playbook run without
  // it would fail for the platform's reason and report the failure as its own.
  assert.equal(result.customArgv, null);
  assert.equal(result.record.custom, null);
});

// The roots published on the platform repository's main

test('installs the published roots and restarts the flow that reads them', { skip: SKIP }, () => {
  const dir = posix(mkdtempSync(join(tmpdir(), 'aber-roots-')));
  const current = root(dir, 'current');
  const previous = root(dir, 'previous');
  const state = appliance({ pointer: 'platform:\n  tag: v1.2.3\n', bundle: `${current}${previous}` });
  const result = converge(state);

  assert.equal(result.status, 0);
  assert.equal(result.caFile, `${current}${previous}`, 'the whole bundle, so either root verifies');
  assert.equal(result.record.trust.outcome, 'installed');
  assert.equal(result.record.trust.changed, true);
  assert.equal(result.record.trust.spki_sha256, pinOf(`${dir}/current.crt`), 'the first root that verified');
  assert.match(result.record.trust.not_after, /\d{4} GMT$/);

  // What the heartbeat reports, read from a file rather than from the environment: gateway.env is
  // sourced once at container start and this changes between two of them.
  assert.deepEqual(result.caJson.roots, [pinOf(`${dir}/current.crt`), pinOf(`${dir}/previous.crt`)]);
  assert.equal(result.caJson.spki_sha256, pinOf(`${dir}/current.crt`));
  assert.ok(result.caJson.not_after_ms > Date.now(), 'a root that has already expired is not one to report');

  // The tls-config node reads the file when it connects, so the running container holds the old
  // root until it is restarted. Once, and only because the file changed.
  assert.deepEqual(result.dockerArgv, ['compose', 'restart', 'node-red']);
});

test('changes nothing when the platform publishes no bundle', { skip: SKIP }, () => {
  // Every platform tagged before this mechanism existed. The appliance keeps the root enrolment
  // gave it, which is still the root the broker presents.
  const result = converge(appliance({ pointer: 'platform:\n  tag: v1.2.3\n' }));
  assert.equal(result.status, 0);
  assert.equal(result.record.trust.outcome, 'absent');
  assert.equal(result.caFile, 'the root enrolment installed\n');
  assert.equal(result.caJson, null);
  assert.equal(result.dockerArgv, null);
});

test('refuses a bundle no root of which verifies the broker', { skip: SKIP }, () => {
  // THE REFUSAL THIS WHOLE MECHANISM TURNS ON. Installing a bundle that verifies nothing takes the
  // appliance off the air at the next restart, and there is no path back that is not a visit.
  const dir = posix(mkdtempSync(join(tmpdir(), 'aber-roots-')));
  const state = appliance({ pointer: 'platform:\n  tag: v1.2.3\n', bundle: root(dir, 'stranger') });
  const result = converge(state, { connects: false });

  assert.equal(result.status, 0, 'the appliance is working; the unit status is not where this goes');
  assert.equal(result.record.trust.outcome, 'refused');
  assert.match(result.record.trust.detail, /verifies mqtt\.plant\.example:8883/);
  assert.equal(result.caFile, 'the root enrolment installed\n', 'nothing was installed');
  assert.equal(result.dockerArgv, null);
  assert.match(result.output, /REFUSING/);
});

test('refuses a bundle carrying a block that is not a certificate', { skip: SKIP }, () => {
  const bundle = '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n';
  const result = converge(appliance({ pointer: 'platform:\n  tag: v1.2.3\n', bundle }));
  assert.equal(result.record.trust.outcome, 'refused');
  assert.equal(result.caFile, 'the root enrolment installed\n');
});

test('installs nothing and restarts nothing when the bundle is what is already held', { skip: SKIP }, () => {
  // The ordinary hourly pass: one clone, one connection, no write and no dropped session.
  const dir = posix(mkdtempSync(join(tmpdir(), 'aber-roots-')));
  const current = root(dir, 'current');
  const result = converge(appliance({
    pointer: 'platform:\n  tag: v1.2.3\n', bundle: current, installedCa: current,
  }));
  assert.equal(result.record.trust.outcome, 'installed');
  assert.equal(result.record.trust.changed, false);
  assert.equal(result.dockerArgv, null, 'a restart drops the MQTT session; it needs a reason');
  // Written all the same, so an appliance whose ca.json was removed gets it back without one.
  assert.equal(result.caJson.spki_sha256, pinOf(`${dir}/current.crt`));
});

test('does not look at the roots when the platform run failed', { skip: SKIP }, () => {
  const dir = posix(mkdtempSync(join(tmpdir(), 'aber-roots-')));
  const result = converge(
    appliance({ pointer: 'platform:\n  tag: v1.2.3\n', bundle: root(dir, 'current') }),
    { exit: 3 },
  );
  assert.equal(result.record.outcome, 'failed');
  // `null`, not an outcome: the directories and the compose project this depends on are the
  // platform playbook's to put in place.
  assert.equal(result.record.trust, null);
  assert.equal(result.caFile, 'the root enrolment installed\n');
});

test('the broker address is read out of gateway.env without sourcing it', { skip: SKIP }, () => {
  // Sourcing that file would put NODERED_CREDENTIAL_SECRET into the environment of every
  // ansible-playbook this script runs, including a gateway's own custom.yml.
  const dir = posix(mkdtempSync(join(tmpdir(), 'aber-roots-')));
  const state = appliance({
    pointer: 'platform:\n  tag: v1.2.3\n', bundle: root(dir, 'current'), custom: '- hosts: localhost\n',
  });
  const result = converge(state);
  assert.match(result.record.trust.detail, /verified against mqtt\.plant\.example:8883/);
  assert.doesNotMatch(result.output, /not-for-a-child-process/);
});

test('the script is the one the playbook installs', { skip: SKIP }, () => {
  // The converge role copies this file to /usr/local/bin. A suite passing against a copy that is
  // not what ships would assert nothing.
  const installed = readFileSync(
    join(REPO, 'forge', 'gateway-platform', 'roles', 'converge', 'tasks', 'main.yml'),
    'utf8',
  );
  assert.match(installed, /src: aber-gateway-converge/);
  assert.match(installed, /dest: \/usr\/local\/bin\/aber-gateway-converge/);
});

if (SKIP) console.log(`# gateway-converge: SKIPPED -- ${SKIP}`);
