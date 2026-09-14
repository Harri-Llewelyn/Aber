/**
 * What `acs-gateway-converge` does with the state an enrolled appliance holds.
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
const SCRIPT = join(REPO, 'forge', 'gateway-platform', 'roles', 'converge', 'files', 'acs-gateway-converge');

/** Every tool the script itself invokes. A missing one is a skipped suite, never a failure. */
const MISSING = ['bash', 'jq', 'python3', 'git'].filter(
  (tool) => spawnSync(tool, ['--version'], { stdio: 'ignore' }).status !== 0,
);
const SKIP = MISSING.length
  ? `needs ${MISSING.join(', ')} on PATH; the platform playbook's base role installs them on an appliance`
  : false;

/** Forward slashes throughout: these become environment variables a shell reads. */
const posix = (p) => p.replace(/\\/g, '/');

/**
 * An appliance's state directory, as `bootstrap.mjs` leaves it. `pointer` is the platform.yml the
 * puller's checkout carries; null means a repository that has none yet. Anything set to null is
 * left out, which is how the absent-file refusals are reached.
 */
function appliance({ key = 'PRIVATE KEY', knownHosts = 'forge ssh-ed25519 AAAA', repository, pointer, custom } = {}) {
  const state = posix(mkdtempSync(join(tmpdir(), 'acs-converge-')));
  const gitops = `${state}/data/gitops`;
  mkdirSync(gitops, { recursive: true });

  if (key !== null) writeFileSync(`${gitops}/id_ed25519`, key);
  if (knownHosts !== null) writeFileSync(`${gitops}/known_hosts`, knownHosts);
  if (repository !== null) {
    writeFileSync(`${gitops}/repository.json`, JSON.stringify({
      ssh_url: 'ssh://git@forge:22/gateways/gateway-gwy1.git',
      branch: 'main',
      platform_ssh_url: 'ssh://git@forge:22/platform/gateway-platform.git',
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
  return { state, gitops };
}

/**
 * Run the script with a stubbed `ansible-pull` first on PATH. The stub records its own argv one
 * argument per line, so an argument carrying a space is still one line's worth of value, and exits
 * with `exit`.
 */
function converge({ state, gitops }, { exit = 0, customExit = 0 } = {}) {
  const bin = `${state}/bin`;
  mkdirSync(bin, { recursive: true });

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
      ACS_STATE_DIR: state,
      ACS_DATA_DIR: `${state}/data`,
      ACS_COMPOSE_DIR: `${state}/opt`,
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
  assert.equal(flag(result.argv, '--url'), 'ssh://git@forge:22/platform/gateway-platform.git');
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
    acs_state_dir: state.state,
    acs_data_dir: `${state.state}/data`,
    acs_compose_dir: `${state.state}/opt`,
    acs_repo_dir: `${state.gitops}/repo`,
    acs_platform_tag: 'v1.2.3',
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

test('the script is the one the playbook installs', { skip: SKIP }, () => {
  // The converge role copies this file to /usr/local/bin. A suite passing against a copy that is
  // not what ships would assert nothing.
  const installed = readFileSync(
    join(REPO, 'forge', 'gateway-platform', 'roles', 'converge', 'tasks', 'main.yml'),
    'utf8',
  );
  assert.match(installed, /src: acs-gateway-converge/);
  assert.match(installed, /dest: \/usr\/local\/bin\/acs-gateway-converge/);
});

if (SKIP) console.log(`# gateway-converge: SKIPPED -- ${SKIP}`);
