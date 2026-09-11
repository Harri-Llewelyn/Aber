#!/usr/bin/env node
/**
 * The puller: this appliance converges its own flow to what somebody approved. Everything is
 * outbound, a `git fetch` over SSH and an HTTP call to Node-RED on this appliance's own network;
 * nothing accepts a flow from a request, a queue or an environment variable. Deploy only what is
 * committed.
 *
 * The forge is verified, never trusted on sight: `known_hosts` is written by bootstrap.mjs from the
 * enrolment response, and `StrictHostKeyChecking=yes` has no override anywhere in this file. With
 * no known_hosts file this refuses to sync and says so.
 *
 * The trigger is the tracked branch advancing, not the working copy differing, so an editor session
 * on the box is not discarded every tick. What this last deployed is recorded in deployed.json, and
 * the flow reports its hash on the heartbeat, so the dashboard can compare it with the head of main.
 *
 * The write is an overwrite, not a merge: measured against nodered/node-red:5.0.2, a flows.json
 * written back and reloaded leaves flows_cred.json untouched. A commit whose broker node has a
 * different id is dangerous and silent: the node gets `{}` for its credential, the gateway is
 * refused with CONNACK 5, and the next deploy prunes the orphaned ciphertext for good.
 * `assertBrokerCredentials()` therefore refuses to converge rather than warning.
 *
 * `--once` runs a single pass and exits, which is what an `ansible-pull` task would run when
 * scheduling moves to Ansible.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const DATA_DIR = process.env.NODE_RED_DATA_DIR || '/data';
const RUNTIME_DIR = process.env.NODE_RED_RUNTIME_DIR || '/usr/src/node-red/node_modules';
const NODE_RED_URL = (process.env.NODE_RED_URL || 'http://node-red:1880').replace(/\/+$/, '');
const CREDENTIAL_SECRET = process.env.NODERED_CREDENTIAL_SECRET || '';

const GITOPS_DIR = join(DATA_DIR, 'gitops');
const REPOSITORY = join(GITOPS_DIR, 'repository.json');
const KNOWN_HOSTS = join(GITOPS_DIR, 'known_hosts');
const DEPLOY_KEY = join(GITOPS_DIR, 'id_ed25519');
const SYNC_CREDENTIAL = join(GITOPS_DIR, 'nodered.json');
const CHECKOUT = join(GITOPS_DIR, 'repo');
/** Written after every deploy and read by the flow every minute. Must agree with bootstrap.mjs. */
const DEPLOYED = join(GITOPS_DIR, 'deployed.json');

const FLOWS = join(DATA_DIR, 'flows.json');
const CREDS = join(DATA_DIR, 'flows_cred.json');

/** The one file a gateway repository holds. Must agree with FLOW_PATH in _shared/forge.ts. */
const FLOW_FILE = 'flows.json';

const INTERVAL_MS = Math.max(30, Number(process.env.FLOW_SYNC_INTERVAL_SECONDS || 300)) * 1000;
const once = process.argv.slice(2).includes('--once');

const log = (...m) => console.log('[flow-sync]', ...m);
const warn = (...m) => console.warn('[flow-sync]', ...m);

/**
 * Log a given message only once per process: "no repository configured" is a steady state on a
 * deployment with no forge.
 */
const said = new Set();
const sayOnce = (key, ...m) => {
  if (said.has(key)) return;
  said.add(key);
  log(...m);
};

// Git, over SSH, with the forge's identity checked

/**
 * The SSH command git runs. `IdentitiesOnly=yes` so an agent or a stray key is not offered first;
 * `StrictHostKeyChecking=yes` with an explicit `UserKnownHostsFile`, never `accept-new` and never
 * `no`; `BatchMode=yes` so a prompt is an error rather than a hang.
 */
function sshCommand() {
  return [
    'ssh',
    '-i', DEPLOY_KEY,
    '-o', 'IdentitiesOnly=yes',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
  ].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
}

function git(args, cwd) {
  return execFileSync('git', ['-c', `safe.directory=${CHECKOUT}`, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_SSH_COMMAND: sshCommand(), GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

/**
 * Bring the local checkout up to date with the tracked branch, and return both revisions. A
 * force-push is refused rather than followed: the remote head must be a descendant of what we last
 * saw, since a rewritten history cannot be told from a legitimate advance by anything downstream. A
 * revert must be a new commit.
 */
function fetchBranch(branch) {
  git(['fetch', '--quiet', 'origin', branch], CHECKOUT);

  const remote = git(['rev-parse', 'FETCH_HEAD'], CHECKOUT);
  let local = null;
  try {
    local = git(['rev-parse', 'HEAD'], CHECKOUT);
  } catch {
    // A checkout with no commits yet. Nothing to compare against, so nothing to refuse.
  }

  if (local && local !== remote) {
    let descendant = true;
    try {
      git(['merge-base', '--is-ancestor', local, remote], CHECKOUT);
    } catch {
      descendant = false;
    }
    if (!descendant) {
      throw new Error(
        `the tracked branch '${branch}' no longer contains ${local.slice(0, 12)}, which this `
        + 'appliance already holds. That is a rewritten history, not an advance, and it is refused: '
        + 'a revert must be a new commit so that what is deployed is always something a pull '
        + 'request showed. Nothing was changed.',
      );
    }
  }

  git(['checkout', '--quiet', '--force', 'FETCH_HEAD'], CHECKOUT);
  return { local, remote };
}

/** Clone on first run, fetch afterwards. Returns the revision now checked out. */
function syncCheckout(repository) {
  const branch = repository.branch || 'main';

  if (!existsSync(join(CHECKOUT, '.git'))) {
    mkdirSync(dirname(CHECKOUT), { recursive: true });
    log(`cloning ${repository.ssh_url} (${branch})`);
    execFileSync('git', [
      'clone', '--quiet', '--branch', branch, '--single-branch', repository.ssh_url, CHECKOUT,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_SSH_COMMAND: sshCommand(), GIT_TERMINAL_PROMPT: '0' },
    });
  }

  const { remote } = fetchBranch(branch);
  return remote;
}

// What is allowed to reach /data/flows.json

/**
 * The same two shape checks the browser and the edge function make, made a third time. This is the
 * only one on the appliance, and a repository can be reached by a route that never passed the other
 * two: a push with the machine account, a merge in the forge's UI, a restore from backup.
 */
function flowRejectionReason(flow) {
  if (!Array.isArray(flow)) {
    return 'a Node-RED flow export is a JSON array of nodes, and the committed file is not one';
  }
  if (flow.length && flow.every((n) => typeof n === 'object' && n && !n.type)) {
    return 'the committed file looks like flows_cred.json rather than flows.json, and a credential '
      + 'file must never be deployed as a flow';
  }
  return null;
}

/**
 * Refuse a commit whose broker nodes have no credential on this appliance: such a node gets `{}`
 * from the runtime, the appliance drops off the broker with a message that names nothing, and the
 * next deploy prunes the orphaned ciphertext. Read through Node-RED's own credentials runtime, with
 * the key supplied through `settings.get('credentialSecret')`, not `setKey()`: `load()` hashes the
 * settings answer, and initialising with bare settings makes it conclude encryption is disabled and
 * throw against a good file (measured against nodered/node-red:5.0.2). An unreadable store is also
 * a refusal; a wrong key throws rather than returning an empty set, so the two are distinguishable.
 */
async function assertBrokerCredentials(flow) {
  const brokerIds = flow
    .filter((node) => node && node.type === 'mqtt-broker' && node.id)
    .map((node) => node.id);

  if (brokerIds.length === 0) return;

  if (!CREDENTIAL_SECRET) {
    throw new Error(
      'NODERED_CREDENTIAL_SECRET is not set for this container, so the committed broker node ids '
      + 'cannot be checked against the stored credentials. Refusing to deploy a flow that could '
      + 'silently drop this gateway off the broker. Add the same value the bundle .env holds.',
    );
  }
  if (!existsSync(CREDS)) {
    throw new Error(`${CREDS} does not exist, so this appliance holds no broker credential to check`
      + ' the committed flow against.');
  }

  const credentials = (
    await import(`${RUNTIME_DIR}/@node-red/runtime/lib/nodes/credentials.js`)
  ).default;

  const noop = () => {};
  credentials.init({
    log: { debug: noop, warn: noop, trace: noop, info: noop, _: (s) => s },
    // `_credentialSecret` must come back undefined: a value there would make the runtime treat this
    // as a system-generated key it should migrate away from, and mark the store dirty.
    settings: { get: (key) => (key === 'credentialSecret' ? CREDENTIAL_SECRET : undefined) },
  });

  try {
    await credentials.load(JSON.parse(readFileSync(CREDS, 'utf8')));
  } catch (err) {
    throw new Error(
      `${CREDS} could not be decrypted (${err.message}). Refusing to deploy: a check that did not `
      + 'run is not a check that passed.',
    );
  }

  const orphaned = brokerIds.filter((id) => {
    const held = credentials.get(id);
    return !held || !held.user;
  });

  if (orphaned.length) {
    throw new Error(
      `the committed flow has mqtt-broker node(s) ${orphaned.join(', ')} with no credential on this `
      + 'appliance. Node-RED would start, report success and hand those nodes an empty username -- '
      + 'the broker would refuse the connection with no stated cause, and the NEXT deploy would '
      + 'prune the credential this appliance still holds. The usual cause is a flow exported and '
      + 're-imported through the editor\'s "Import copy", which re-ids every node. Commit the '
      + 'appliance\'s own /data/flows.json instead. Nothing was changed.',
    );
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Telling Node-RED to pick it up

/**
 * Reload the flow file through Node-RED's admin API. `Node-RED-Deployment-Type: reload` re-reads
 * flows.json from disk and leaves the credential store alone; a `full` deploy would take the flow
 * from the request body, a second way to get a flow onto an appliance, so the body is empty.
 * Authenticated as the sync agent, whose password bootstrap.mjs wrote to /data/gitops/nodered.json.
 */
async function reloadNodeRed() {
  if (!existsSync(SYNC_CREDENTIAL)) {
    throw new Error(
      `${SYNC_CREDENTIAL} does not exist, so there is no way to ask Node-RED to reload. This `
      + 'appliance was enrolled before flow sync existed; re-issue the credential with:  '
      + 'docker compose run --rm bootstrap node /bundle/bootstrap.mjs --reset-admin-password',
    );
  }

  const { username, password } = JSON.parse(readFileSync(SYNC_CREDENTIAL, 'utf8'));

  const tokenResponse = await fetch(`${NODE_RED_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'node-red-admin',
      grant_type: 'password',
      scope: '*',
      username,
      password,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(
      `Node-RED refused the sync agent's login (${tokenResponse.status}). If settings.js was `
      + 'rewritten by hand the agent\'s account may be gone; --reset-admin-password restores it.',
    );
  }

  const { access_token: accessToken } = await tokenResponse.json();

  const reload = await fetch(`${NODE_RED_URL}/flows`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Node-RED-Deployment-Type': 'reload',
    },
    body: '{}',
  });

  if (!reload.ok) {
    throw new Error(`Node-RED refused the reload (${reload.status}: ${await reload.text()})`);
  }
}

// One pass

/**
 * Write the flow and reload, having checked everything first. Written through a temporary file and
 * renamed, so a crash or a full disk leaves either the old flow or the new one, never a truncated
 * file.
 */
function deployFlow(text) {
  const temporary = join(DATA_DIR, `.flows.json.${randomUUID()}`);
  writeFileSync(temporary, text, { mode: 0o644 });
  renameSync(temporary, FLOWS);
}

/**
 * The last record written here, or by bootstrap.mjs for the enrolment flow, whose `revision` is
 * null so the first tick converges. Missing or unreadable is the same as never deployed.
 */
function readDeployed() {
  try {
    return JSON.parse(readFileSync(DEPLOYED, 'utf8'));
  } catch {
    return {};
  }
}

async function syncOnce() {
  if (!existsSync(REPOSITORY)) {
    sayOnce('no-repo', 'this gateway has no repository, so there is nothing to converge to. That is'
      + ' a deployment without the forge, not a fault.');
    return;
  }

  const repository = JSON.parse(readFileSync(REPOSITORY, 'utf8'));
  if (!repository.ssh_url) {
    sayOnce('no-url', `${REPOSITORY} names no ssh_url; nothing to pull from.`);
    return;
  }

  // THE ONE PRECONDITION WITH NO WORKAROUND. See the header: there is no flag here that skips it.
  if (!existsSync(KNOWN_HOSTS)) {
    sayOnce('no-known-hosts',
      `REFUSING TO SYNC: ${KNOWN_HOSTS} does not exist, so this appliance cannot verify the forge`
      + ' it would be pulling from. Restart the forge so it publishes its host key, then re-enrol'
      + ' this appliance. Telemetry is unaffected.');
    return;
  }
  if (!existsSync(DEPLOY_KEY)) {
    sayOnce('no-key', `REFUSING TO SYNC: ${DEPLOY_KEY} does not exist, so there is no identity to`
      + ' authenticate to the forge with.');
    return;
  }

  const revision = syncCheckout(repository);
  const deployed = readDeployed();

  if (deployed.revision === revision) {
    sayOnce(`current-${revision}`, `up to date at ${revision.slice(0, 12)}`);
    return;
  }

  const committed = join(CHECKOUT, FLOW_FILE);
  if (!existsSync(committed)) {
    // The ORDINARY state of a freshly provisioned repository: `enroll-gateway` creates it with an
    // initial commit and no flow, and nothing writes one until a proposal is merged.
    sayOnce(`no-flow-${revision}`,
      `${revision.slice(0, 12)} holds no ${FLOW_FILE} yet; nothing to deploy.`);
    return;
  }

  const text = readFileSync(committed, 'utf8');
  let flow;
  try {
    flow = JSON.parse(text);
  } catch (err) {
    throw new Error(`the committed ${FLOW_FILE} is not valid JSON (${err.message})`);
  }

  const rejection = flowRejectionReason(flow);
  if (rejection) throw new Error(`refusing to deploy ${revision.slice(0, 12)}: ${rejection}`);

  await assertBrokerCredentials(flow);

  // Already running it: a revision can advance without the flow changing, and reloading Node-RED
  // for that would drop every MQTT connection to achieve nothing.
  const running = existsSync(FLOWS) ? readFileSync(FLOWS, 'utf8') : '';
  if (sha256(running) === sha256(text)) {
    log(`${revision.slice(0, 12)} matches what is already running; recorded without a reload.`);
  } else {
    deployFlow(text);
    await reloadNodeRed();
    log(`deployed ${revision.slice(0, 12)} and reloaded Node-RED`);
  }

  // `flow_sha256` is what the heartbeat reports as Flow_Hash: the flow's `read deployed.json`
  // branch reads this file every minute. The platform holds the same digest for the head of main.
  writeFileSync(
    DEPLOYED,
    JSON.stringify({
      revision,
      branch: repository.branch || 'main',
      flow_sha256: sha256(text),
      deployed_at: new Date().toISOString(),
      source: 'flow-sync',
    }, null, 2),
    { mode: 0o644 },
  );
}

// The loop

/**
 * A failed tick is never fatal: an unreachable forge, a Node-RED still starting or a dropped plant
 * link is ordinary, so each pass is caught, named and retried on the next tick. A refusal (a
 * rewritten history, a mismatched broker id) is logged at every occurrence, because a person has to
 * decide something.
 */
async function tick() {
  try {
    await syncOnce();
  } catch (err) {
    warn(`sync failed: ${err.message}`);
  }
}

log(`watching for approved flows every ${INTERVAL_MS / 1000}s (Node-RED at ${NODE_RED_URL})`);
await tick();

if (!once) {
  setInterval(tick, INTERVAL_MS);
}
