// =================================================================================================
// scripts/try.mjs, scripts/lib/k3d.mjs and the localhost half of scripts/setup.mjs
//
// The parts that need no cluster: which tools are missing and what the message says, who holds a
// port, the arguments, the version read, the install the trial runs, and the values file setup
// writes for it. The cluster half is run by hand (`npm run try`, docs/install.md, Try it).
// =================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLUSTER_PORTS, apiPort, createClusterArgs, describeMissing, missingTools, parseClusters,
  portTakenMessage, publishersOf,
} from './lib/k3d.mjs';
import { CHART_REF, chartVersionOf, compareReleases, readChartVersion } from './lib/release-chart.mjs';
import { CONTEXT, DEFAULT_ADMIN_EMAIL, VALUES, adminFrom, installArgs, parseArgs } from './try.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A spawnSync stand-in: `answers` maps "cmd arg..." to an exit status; anything else is ENOENT. */
function stubSpawn(answers) {
  return (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    return key in answers ? { status: answers[key] } : { status: null, error: new Error('ENOENT') };
  };
}
const ALL_PRESENT = {
  'docker version': 0, 'docker info': 0, 'k3d version': 0, 'kubectl version --client': 0, 'helm version': 0,
};

test('every tool present and Docker running is nothing missing', () => {
  assert.deepEqual(missingTools(['docker', 'k3d', 'kubectl', 'helm'], stubSpawn(ALL_PRESENT)), []);
});

test('every missing tool is named, not only the first', () => {
  const answers = { 'docker version': 0, 'docker info': 0 };
  assert.deepEqual(missingTools(['docker', 'k3d', 'kubectl', 'helm'], stubSpawn(answers)).map((m) => m.tool),
    ['k3d', 'kubectl', 'helm']);
});

test('a Docker client whose daemon does not answer is Docker not running', () => {
  // `docker version` fails without a daemon; `docker --version` is the client alone.
  const answers = { ...ALL_PRESENT, 'docker version': 1, 'docker --version': 0, 'docker info': 1 };
  assert.deepEqual(missingTools(['docker', 'helm'], stubSpawn(answers)), [{ tool: 'docker', problem: 'not running' }]);
});

test('the message says where to get each tool, and how to start Docker', () => {
  const text = describeMissing([{ tool: 'k3d', problem: 'not installed' }, { tool: 'docker', problem: 'not running' }]);
  assert.match(text, /k3d\s+not installed\. Get it from https:\/\/k3d\.io/);
  assert.match(text, /docker\s+installed, but not running\. Start Docker Desktop/);
});

test('the container that publishes a port is found, ranges included', () => {
  const ps = [
    'k3d-aber-serverlb\t0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:1883->1883/tcp, 0.0.0.0:56123->6443/tcp',
    'some-broker\t0.0.0.0:8880-8890->8880-8890/tcp',
    'quiet\t',
  ].join('\n');
  assert.deepEqual(publishersOf(ps, 80), ['k3d-aber-serverlb']);
  assert.deepEqual(publishersOf(ps, 8883), ['some-broker']);
  assert.deepEqual(publishersOf(ps, 9999), []);
  assert.deepEqual(publishersOf('', 80), []);
});

test('a port the dev cluster holds names it and how to stop it', () => {
  const text = portTakenMessage(80, ['k3d-aber-serverlb']);
  assert.match(text, /dev cluster `aber`/);
  assert.match(text, /k3d cluster stop aber/);
});

test('a port held by another cluster, a container or a program says which', () => {
  assert.match(portTakenMessage(1883, ['k3d-other-serverlb']), /k3d cluster `other`[\s\S]*k3d cluster stop other/);
  assert.match(portTakenMessage(1883, ['mosquitto']), /the container mosquitto/);
  assert.match(portTakenMessage(80, []), /another program/);
});

test('a trial cluster publishes the dev loop\'s ports', () => {
  const args = createClusterArgs('aber-try', ['--kubeconfig-switch-context=false']);
  for (const p of CLUSTER_PORTS) assert.ok(args.includes(`${p}:${p}@loadbalancer`), `port ${p}`);
  assert.deepEqual(args.slice(0, 3), ['cluster', 'create', 'aber-try']);
  assert.equal(args.at(-1), '--wait');
  assert.ok(args.includes('--kubeconfig-switch-context=false'));
});

test('k3d and docker output are read', () => {
  assert.deepEqual(parseClusters('[{"name":"aber","serversRunning":0},{"name":"aber-try","serversRunning":1}]'),
    [{ name: 'aber', running: false }, { name: 'aber-try', running: true }]);
  assert.deepEqual(parseClusters(''), []);
  assert.equal(apiPort('0.0.0.0:61234\n[::]:61234'), '61234');
  assert.equal(apiPort(''), null);
});

test('arguments: up by default, an admin email, down, and nothing unknown', () => {
  assert.deepEqual(parseArgs([]), { command: 'up', adminEmail: DEFAULT_ADMIN_EMAIL });
  assert.deepEqual(parseArgs(['up', '--admin-email=Me@Plant.Example']), { command: 'up', adminEmail: 'me@plant.example' });
  assert.equal(parseArgs(['down']).command, 'down');
  assert.match(parseArgs(['--admin-email=nope']).error, /not an email address/);
  assert.match(parseArgs(['--domain=x']).error, /unknown option/);
  assert.match(parseArgs(['sideways']).error, /unknown command/);
});

test('the version is Chart.yaml\'s version:, not appVersion or apiVersion', () => {
  assert.equal(chartVersionOf('apiVersion: v2\nname: aber\nversion: 1.2.3\nappVersion: "9.9.9"\n'), '1.2.3');
  assert.equal(chartVersionOf('apiVersion: v2\n'), null);
  assert.equal(readChartVersion(REPO), /^version:\s*(\S+)/m.exec(readFileSync(join(REPO, 'deploy/helm/aber/Chart.yaml'), 'utf8'))[1]);
});

test('releases compare by number, not as text', () => {
  assert.ok(compareReleases('v1.10.0', '1.9.2') > 0);
  assert.ok(compareReleases('1.0.2', '1.1.0') < 0);
  assert.equal(compareReleases('v1.1.0', '1.1.0'), 0);
  assert.ok(compareReleases('2.0.0', '1.99.99') > 0);
  assert.throws(() => compareReleases('1.1', '1.1.0'), /not a release version/);
  assert.throws(() => compareReleases('1.1.0-ci.abcdef12', '1.1.0'), /not a release version/);
});

test('the trial installs the published chart with its own values, and nothing from development', () => {
  const args = installArgs('1.2.3');
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[3], CHART_REF);
  assert.equal(at('--version'), '1.2.3');
  assert.equal(at('--kube-context'), CONTEXT);
  assert.equal(at('-n'), 'aber');
  assert.ok(args.includes('--create-namespace'));
  assert.deepEqual(args.filter((_, i) => args[i - 1] === '-f'), [VALUES]);
  const sets = args.filter((_, i) => args[i - 1] === '--set');
  assert.deepEqual(sets, ['ingestion.primaryHostId=try', 'ingestion.sparkplugGroup=try']);
  const joined = args.join(' ');
  assert.doesNotMatch(joined, /values-dev|deploy\/helm\/aber(?!\/values-try)|tls|cert|demoAccounts|exampleMetrics|--wait/);
});

// setup.mjs is a script, so its localhost half is tested by running it.
function setup(...args) {
  return spawnSync(process.execPath, [join(REPO, 'scripts/setup.mjs'), ...args], { encoding: 'utf8', input: '' });
}

test('setup accepts localhost, warns as it does with no domain, and writes the trial\'s values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aber-try-'));
  try {
    const out = join(dir, 'values-try.yaml');
    const r = setup('--domain=localhost', '--admin-email=trial@aber.local', `--out=${out}`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /REMOTE GATEWAYS CANNOT BE ENROLLED/);
    const text = readFileSync(out, 'utf8');
    assert.match(text, /^ {2}publicBaseDomain: "localhost"$/m);
    assert.match(text, /^gitea:\n {2}ssh:\n {4}external:\n {6}port: 2222$/m);
    const admin = adminFrom(text);
    assert.equal(admin.email, 'trial@aber.local');
    assert.match(admin.password, /^[a-z2-9]{6}(-[a-z2-9]{6}){3}$/);
    assert.doesNotMatch(text, /demoAccounts|exampleMetrics/);

    // A second run leaves the file alone: the trial's re-run reuses its passwords.
    writeFileSync(out, `${text}# marker\n`);
    assert.equal(setup('--domain=localhost', `--out=${out}`).status, 0);
    assert.match(readFileSync(out, 'utf8'), /# marker\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setup still refuses a subdomain of localhost, a loopback address and a URL', () => {
  for (const domain of ['app.localhost', '127.0.0.1', '127.0.0.1.nip.io', 'http://localhost', 'localhost:8080']) {
    const r = setup(`--domain=${domain}`, '--out=never-written.yaml');
    assert.equal(r.status, 1, domain);
    assert.match(r.stderr, /--domain:/, domain);
  }
});
