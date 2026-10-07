#!/usr/bin/env node
/**
 * Try Aber on this computer: the published release on a k3d cluster of its own, at localhost.
 *
 *   node scripts/try.mjs up [--admin-email=<address>]   npm run try
 *   node scripts/try.mjs down                           npm run try:down
 *
 * `up` creates the k3d cluster `aber-try` (unless it exists), writes deploy/helm/aber/values-try.yaml
 * with `npm run setup` (unless it exists, so a second run upgrades), installs the chart from GHCR at
 * Chart.yaml's version, waits for every workload and prints where to sign in. Nothing is built, no
 * DNS or certificate is needed (browsers resolve *.localhost to this machine and treat it as a
 * secure context), and nothing from values-dev.yaml is used: no demo accounts, no published
 * credentials. `down` deletes the cluster and keeps the values file.
 *
 * Every kubectl and helm call names the context, because the current one can change under a run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INIT_JOBS, apiPort, createClusterArgs, describeMissing, missingTools, parseClusters,
  portTakenMessage, publishersOf, CLUSTER_PORTS,
} from './lib/k3d.mjs';
import { CHART_REF, readChartVersion } from './lib/release-chart.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLUSTER = 'aber-try';
export const CONTEXT = `k3d-${CLUSTER}`;
export const NAMESPACE = 'aber';
export const RELEASE = 'aber';
export const VALUES = 'deploy/helm/aber/values-try.yaml';
/** ingestion.primaryHostId and sparkplugGroup: the site name a trial's gateways publish under. */
export const SITE_ID = 'try';
export const DEFAULT_ADMIN_EMAIL = 'trial@aber.local';
const DEV_CLUSTER = 'aber';

/** The command and the admin email from argv. Unknown flags are refused rather than ignored. */
export function parseArgs(argv) {
  const command = argv.find((a) => !a.startsWith('--')) || 'up';
  let adminEmail = DEFAULT_ADMIN_EMAIL;
  for (const a of argv.filter((x) => x.startsWith('--'))) {
    if (a.startsWith('--admin-email=')) adminEmail = a.slice('--admin-email='.length).trim().toLowerCase();
    else return { error: `unknown option ${a}` };
  }
  if (!['up', 'down'].includes(command)) return { error: `unknown command ${command}; one of up, down` };
  if (!/^[^@\s]+@[^@\s]+$/.test(adminEmail)) return { error: `--admin-email: '${adminEmail}' is not an email address` };
  return { command, adminEmail };
}

/** helm arguments for the install: the published chart, the trial's values, no TLS, nothing dev. */
export function installArgs(version) {
  return ['upgrade', '--install', RELEASE, CHART_REF, '--version', version,
    '--kube-context', CONTEXT, '-n', NAMESPACE, '--create-namespace',
    '-f', VALUES,
    '--set', `ingestion.primaryHostId=${SITE_ID}`, '--set', `ingestion.sparkplugGroup=${SITE_ID}`,
    '--timeout', '15m'];
}

/** The first administrator's email and password as `npm run setup` wrote them. */
export function adminFrom(valuesText) {
  return {
    email: /^supabaseAuth:\n\s+firstAdministrator:\n\s+email:\s*"([^"]*)"/m.exec(valuesText)?.[1] ?? null,
    password: /^\s+firstAdministratorPassword:\s*"([^"]*)"/m.exec(valuesText)?.[1] ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Process helpers: `capture` returns the output, `must` stops with the command on screen.
// ---------------------------------------------------------------------------------------------
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
function step(title) { console.log(`\n${bold('==')} ${title}`); }
function die(message) { console.error(`\n${red('FAILED')} ${message}`); process.exit(1); }
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function must(cmd, args, why) {
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit' });
  if (r.status !== 0) die(`${why}\n  ${cmd} ${args.join(' ')} exited ${r.status}`);
}
const inNamespace = (...args) => ['--context', CONTEXT, '-n', NAMESPACE, ...args];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(500, () => { s.destroy(); resolve(false); });
  });
}

/** The status of GET / on `host`, through Traefik on 127.0.0.1:80: Node does not resolve *.localhost. */
function probe(host) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 80, path: '/', headers: { Host: host }, timeout: 5000 },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ---------------------------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------------------------
function preflight(tools) {
  const missing = missingTools(tools);
  if (missing.length) die(`this needs ${tools.join(', ')}, and these cannot be used:\n${describeMissing(missing)}`);
}

async function assertPortsFree() {
  const ps = capture('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}']).out;
  for (const port of CLUSTER_PORTS) {
    const holders = publishersOf(ps, port);
    if (holders.length || await portOpen(port)) die(portTakenMessage(port, holders, DEV_CLUSTER));
  }
}

async function ensureCluster() {
  step(`cluster ${CLUSTER}`);
  const listed = capture('k3d', ['cluster', 'list', '-o', 'json']);
  const cluster = listed.ok ? parseClusters(listed.out).find((c) => c.name === CLUSTER) : undefined;
  if (cluster?.running) {
    console.log('  exists, running');
  } else if (cluster) {
    await assertPortsFree();
    must('k3d', ['cluster', 'start', CLUSTER], 'k3d could not start the cluster');
  } else {
    await assertPortsFree();
    // The current context is left alone: every call below names this one.
    must('k3d', createClusterArgs(CLUSTER, ['--kubeconfig-switch-context=false']), 'k3d could not create the cluster');
  }
  // k3d writes the API endpoint as host.docker.internal on Windows and macOS, which some adapters
  // resolve to an address nothing answers on. Loopback always works: the port is published there.
  const port = apiPort(capture('docker', ['port', `k3d-${CLUSTER}-serverlb`, '6443']).out);
  if (port) capture('kubectl', ['config', 'set-cluster', CONTEXT, `--server=https://127.0.0.1:${port}`]);
  const nodes = capture('kubectl', ['--context', CONTEXT, 'get', 'nodes', '-o',
    'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}']);
  if (!nodes.ok || !nodes.out.includes('True')) die(`the cluster is not answering: ${nodes.err || nodes.out}`);
  console.log(`  context ${CONTEXT}, API on 127.0.0.1:${port}`);
}

/** The runbook's Traefik setting, as a site applies it: each client's address reaches the stack. */
async function ensureTraefikConfig() {
  step('Traefik keeps the client address');
  must('kubectl', ['--context', CONTEXT, 'apply', '-f', 'deploy/k8s/traefik-config.yaml'],
    'the Traefik HelmChartConfig did not apply');
  for (let i = 0; i < 60; i++) {
    const policy = capture('kubectl', ['--context', CONTEXT, '-n', 'kube-system', 'get', 'svc', 'traefik',
      '-o', 'jsonpath={.spec.externalTrafficPolicy}']).out;
    if (policy === 'Local') { console.log('  externalTrafficPolicy Local'); return; }
    await sleep(3000);
  }
  die('Traefik\'s Service did not move to externalTrafficPolicy Local within 3 minutes');
}

function ensureValues(adminEmail) {
  step(`passwords in ${VALUES}`);
  if (existsSync(path.join(REPO, VALUES))) {
    const { email } = adminFrom(readFileSync(path.join(REPO, VALUES), 'utf8'));
    console.log('  exists: reused, so this run upgrades the trial rather than starting over');
    if (email && email !== adminEmail) console.log(`  its administrator is ${email}; delete the file to use ${adminEmail}`);
    return;
  }
  // Setup's own closing lines describe a site install; only its failure is shown here.
  const r = spawnSync(process.execPath, ['scripts/setup.mjs', '--domain=localhost', `--admin-email=${adminEmail}`,
    `--out=${VALUES}`], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) die(`npm run setup failed:\n${r.stdout}${r.stderr}`);
  console.log(`  written, with every password generated for this trial`);
}

async function install(version) {
  step(`install ${CHART_REF} ${version}`);
  // No --wait: it deadlocks the first install (deploy/k8s/README.md says why). The hooks are
  // waited for regardless.
  must('helm', installArgs(version), 'helm did not install the release');
  step('wait for the init Jobs');
  for (const job of INIT_JOBS) {
    must('kubectl', inNamespace('wait', '--for=condition=complete', `job/${RELEASE}-${job}`, '--timeout=10m'),
      `${job} did not complete`);
  }
  step('wait for every workload');
  const workloads = capture('kubectl', inNamespace('get', 'statefulset,deploy,daemonset', '-o', 'name')).out
    .split('\n').filter(Boolean);
  for (const w of workloads) {
    must('kubectl', inNamespace('rollout', 'status', w, '--timeout=10m'), `${w} did not roll out`);
  }
  step('wait for the dashboard');
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await probe('app.localhost') === 200) { console.log('  http://app.localhost answers'); return; }
    await sleep(3000);
  }
  die('every workload rolled out, and http://app.localhost does not answer 200 through Traefik on port 80');
}

function finish() {
  const { email, password } = adminFrom(readFileSync(path.join(REPO, VALUES), 'utf8'));
  console.log(`
${bold('Aber is running on this computer.')}

  Open        http://app.localhost
  Sign in as  ${email ?? '(no first administrator in ' + VALUES + ')'}
  Password    ${password ?? '(none)'}

  For data, add a Simulated gateway (Gateways -> New Gateway). It runs in Aber's own Node-RED, so
  there is nothing to install; tutorial/README.md builds a gateway the same way.

  Remove it   npm run try:down   (deletes the cluster and everything in it)`);
}

async function up(adminEmail) {
  preflight(['docker', 'k3d', 'kubectl', 'helm']);
  const version = readChartVersion(REPO);
  await ensureCluster();
  await ensureTraefikConfig();
  ensureValues(adminEmail);
  await install(version);
  finish();
}

function down() {
  preflight(['docker', 'k3d']);
  step(`delete cluster ${CLUSTER}`);
  const listed = capture('k3d', ['cluster', 'list', '-o', 'json']);
  if (listed.ok && !parseClusters(listed.out).some((c) => c.name === CLUSTER)) {
    console.log('  no such cluster; nothing to delete');
  } else {
    must('k3d', ['cluster', 'delete', CLUSTER], 'k3d could not delete the cluster');
  }
  console.log(`\n  ${VALUES} is kept, so \`npm run try\` reuses its passwords.` +
    `\n  Delete it too for new ones:  ${process.platform === 'win32' ? 'del' : 'rm'} ${VALUES.split('/').join(path.sep)}`);
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) die(args.error);
  if (args.command === 'down') down();
  else await up(args.adminEmail);
}
