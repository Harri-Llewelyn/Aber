#!/usr/bin/env node
/**
 * =================================================================================================
 * THE PULLER. This appliance converges its own flow to what somebody approved.
 * =================================================================================================
 *
 * WHY PULL AND NOT PUSH. The platform never opens a connection to a gateway, and this is the piece
 * that would have made it do so. An inbound deployment path means a route through the plant firewall
 * per appliance, a static inventory that dynamic enrolment cannot supply, and a credential at the
 * centre that can write to every box. Everything here is outbound: a `git fetch` over SSH and an
 * HTTP call to Node-RED on this appliance's own compose network. Nothing anywhere assumes traffic
 * in the other direction -- the same rule `node_exporter` follows in the service beside it.
 *
 * WHAT THIS REPLACED. A `deploy-nodered` edge function used to POST a flow INTO an appliance, and
 * it refused an inline flow array in the request body with a stated reason: a Node-RED `function`
 * node is arbitrary JavaScript inside a container holding the MQTT credential. That refusal is the
 * one thing worth keeping from it, and it generalises to this file as its whole contract:
 *
 *      DEPLOY ONLY WHAT IS COMMITTED.
 *
 * Nothing here accepts a flow from anywhere but the tracked branch of this gateway's own repository,
 * and there is no code path that takes one from a request, a queue or an environment variable.
 *
 * -------------------------------------------------------------------------------------------------
 * THE FORGE IS VERIFIED, NEVER TRUSTED ON SIGHT.
 *
 * `known_hosts` is written by bootstrap.mjs from the enrolment response -- over TLS, on a single-use
 * token bound to one gateway row. So this appliance knows the forge's host key BEFORE its first
 * clone, and `StrictHostKeyChecking=yes` below is a check that can actually fail rather than
 * decoration. There is deliberately no option, environment variable or flag anywhere in this file
 * that disables it: roadmap 7 and 11 both refuse that switch, and a switch that exists is a switch
 * that ends up set on every appliance in a plant with a proxy.
 *
 * With no known_hosts file this REFUSES TO SYNC and says so. That is the correct failure: a gateway
 * that keeps publishing telemetry while declining to converge has lost a feature, where one that
 * pulls from an unverified forge has lost the guarantee the review step exists to give.
 *
 * -------------------------------------------------------------------------------------------------
 * IT CONVERGES ON A NEW REVISION, AND DOES NOT FIGHT THE EDITOR.
 *
 * The appliance's Node-RED editor is deliberately reachable -- bootstrap generates a password for it
 * precisely so somebody can work on the box in front of them. A sidecar that re-imposed the
 * committed flow on every tick would silently discard that work mid-edit, five minutes at a time,
 * and would make the editor unusable for the people it exists for.
 *
 * So the trigger is the TRACKED BRANCH ADVANCING, not the working copy differing. A missed deploy is
 * still caught up -- an appliance that was powered off when a proposal merged converges on its next
 * tick -- which is the self-healing property that matters. Local drift is a REPORTED fact rather
 * than a corrected one: the heartbeat already carries a flow hash, and comparing it to the committed
 * head is roadmap 7's drift detection, which is a dashboard concern and not this file's.
 *
 * -------------------------------------------------------------------------------------------------
 * THE WRITE IS AN OVERWRITE AND NOT A MERGE, AND THAT WAS PROVED BEFORE IT WAS BUILT.
 *
 * Node-RED keys credentials by NODE ID and holds them in flows_cred.json, encrypted separately from
 * the flow. The question this file turned on was whether writing a flow back over /data would break
 * that binding. Measured against nodered/node-red:5.0.2, the tag this bundle pins: a flows.json
 * written back and reloaded leaves flows_cred.json untouched -- not rewritten, not re-encrypted --
 * and the broker node keeps its credential. So there is no merge strategy here, and there should not
 * be one.
 *
 * WHAT IS DANGEROUS IS A COMMIT WHOSE BROKER NODE HAS A DIFFERENT ID, and it is dangerous in a way
 * nothing else would report. Node-RED starts, logs `Started flows`, and hands that node `{}` for its
 * credential: no warning and no failed check. The gateway then authenticates with an empty username,
 * Mosquitto refuses with CONNACK 5, and the editor says only "Connection failed to broker". Worse,
 * it is DESTRUCTIVE on the next deploy -- the orphaned credential is pruned and the file rewritten to
 * an encrypted `{}`, at which point the ciphertext is gone, bootstrap will not re-mint behind its
 * once-only guard, and the enrolment token is long spent. The recovery is a new bundle.
 *
 * That is why `assertBrokerCredentials()` below is a REFUSAL TO CONVERGE rather than a warning. It
 * turns a silent drop off the broker into a visible, reversible stop.
 *
 * -------------------------------------------------------------------------------------------------
 * RELATIONSHIP TO `ansible-pull`, WHICH IS WHERE THIS IS GOING.
 *
 * Roadmap 8 puts `ansible-pull` on the appliance against a SHARED platform playbook repository: the
 * OS baseline, the container versions, the CA, and this gateway's flow. When that lands, the
 * scheduling and the platform convergence become Ansible's and the transport becomes a task rather
 * than a loop. What does NOT move is everything below `deployFlow()`: the shape checks, the broker
 * credential assertion and the reload semantics are Node-RED knowledge that a playbook would have to
 * call out to anyway. This file is written so that half can be invoked once and exit -- see
 * `--once`, which is exactly what an Ansible task would run.
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
 * Log a given message only once per process.
 *
 * A GATEWAY THAT CANNOT CONVERGE SAYS SO ONCE, NOT EVERY FIVE MINUTES. "no repository configured" is
 * a steady state on a deployment with no forge, and repeating it forever buries the lines that mean
 * something in a log somebody has to read over a plant VPN.
 */
const said = new Set();
const sayOnce = (key, ...m) => {
  if (said.has(key)) return;
  said.add(key);
  log(...m);
};

// =================================================================================================
// Git, over SSH, with the forge's identity checked
// =================================================================================================

/**
 * The SSH command git runs, and the four options that make it verifiable.
 *
 * `IdentitiesOnly=yes` because an agent or a stray ~/.ssh key would otherwise be offered first and
 * the forge would refuse an identity this appliance was never issued -- which presents as a
 * permission error naming no key at all.
 *
 * `StrictHostKeyChecking=yes` with an explicit `UserKnownHostsFile`. Not `accept-new`, which is
 * trust-on-first-use with a friendlier name, and never `no`.
 *
 * `BatchMode=yes` so a prompt is an error rather than a hang. There is no terminal here to answer
 * one, and a sidecar blocked forever on an invisible question is the hardest of these failures to
 * diagnose.
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
 * Bring the local checkout up to date with the tracked branch, and return both revisions.
 *
 * A FORCE-PUSH IS REFUSED RATHER THAN FOLLOWED, and that refusal belongs here rather than in the
 * dashboard. Roadmap 7 requires a revert to be a NEW COMMIT precisely because a rewritten history
 * cannot be told from a legitimate advance by anything downstream -- this would reconcile to the
 * rewritten head and report success, having deployed something no pull request ever showed. So the
 * remote head must be a descendant of what we last saw. When it is not, this stops and says so, and
 * a human decides.
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

// =================================================================================================
// What is allowed to reach /data/flows.json
// =================================================================================================

/**
 * The same two shape checks the browser and the edge function already make, made a third time.
 *
 * NOT REDUNDANT: this is the LAST of the three and the only one on the appliance. The other two
 * guard a proposal; this guards a DEPLOY, and a repository can be reached by a route that never
 * passed through either -- a commit pushed with the machine account, a merge made in the forge's
 * own UI, a repository restored from a backup. What is written to /data is checked here or nowhere.
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
 * REFUSE A COMMIT WHOSE BROKER NODES HAVE NO CREDENTIAL ON THIS APPLIANCE.
 *
 * This is the check the whole design turns on -- see the header. A broker node whose id is not a key
 * in flows_cred.json gets `{}` from the runtime, silently, and the appliance drops off the broker
 * with a message that names nothing. The next deploy then PRUNES the orphaned entry and the
 * ciphertext is gone for good.
 *
 * READ THROUGH NODE-RED'S OWN CREDENTIALS RUNTIME, never by hand-rolling the decryption. The file
 * format is Node-RED's; the one implementation guaranteed to agree with what its runtime will do is
 * the runtime's own module. bootstrap.mjs writes the file the same way for the same reason.
 *
 * THE KEY GOES IN THROUGH `settings.get('credentialSecret')`, NOT `setKey()`, and the difference is
 * not cosmetic. `load()` chooses its key by asking settings and hashing the answer with sha256;
 * `setKey()` is what the WRITE path uses. Initialising with a bare `settings: {}` and calling
 * setKey -- the obvious reading, and the mirror of what bootstrap.mjs does to write -- makes load()
 * conclude encryption is disabled and throw `Failed to decrypt credentials` against a file that is
 * perfectly good. Measured against nodered/node-red:5.0.2, the tag this bundle pins.
 *
 * AN UNREADABLE CREDENTIAL STORE IS ALSO A REFUSAL. If the secret is wrong or the file is corrupt,
 * this cannot tell "the ids match" from "I could not look", and deploying on the strength of a check
 * that did not run is the failure it exists to prevent. The runtime helps here: a wrong key THROWS
 * rather than returning an empty set, so the two are distinguishable -- also measured.
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

// =================================================================================================
// Telling Node-RED to pick it up
// =================================================================================================

/**
 * Reload the flow file through Node-RED's admin API.
 *
 * `Node-RED-Deployment-Type: reload` is the one that re-reads flows.json FROM DISK and leaves the
 * credential store alone. A `full` deploy would take the flow from this request body instead, which
 * would make this file a second way to get a flow onto an appliance -- exactly the inbound path the
 * puller exists to remove. The body is deliberately empty for that reason.
 *
 * AUTHENTICATED AS THE SYNC AGENT, not as admin. bootstrap.mjs writes that account into settings.js
 * and its password into /data/gitops/nodered.json; the human's password is printed once and stored
 * nowhere. The token grants nothing beyond the volume mount this process already has -- it is
 * needed because reloading is an API call, not because writing needs permission.
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

// =================================================================================================
// One pass
// =================================================================================================

/**
 * Write the flow and reload, having checked everything that can be checked first.
 *
 * WRITTEN THROUGH A TEMPORARY FILE AND RENAMED. A crash or a full disk halfway through a direct
 * write leaves a truncated flows.json, and Node-RED starting against a truncated flow file is an
 * appliance that needs a person in front of it. `rename` within the same directory is atomic, so the
 * file is either the old flow or the new one.
 */
function deployFlow(text) {
  const temporary = join(DATA_DIR, `.flows.json.${randomUUID()}`);
  writeFileSync(temporary, text, { mode: 0o644 });
  renameSync(temporary, FLOWS);
}

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

  // ALREADY RUNNING IT. A revision can advance without the flow changing -- a README edit, a merge
  // commit, a revert that restores what is deployed. Reloading Node-RED for those would drop every
  // MQTT connection on the appliance to achieve nothing.
  const running = existsSync(FLOWS) ? readFileSync(FLOWS, 'utf8') : '';
  if (sha256(running) === sha256(text)) {
    log(`${revision.slice(0, 12)} matches what is already running; recorded without a reload.`);
  } else {
    deployFlow(text);
    await reloadNodeRed();
    log(`deployed ${revision.slice(0, 12)} and reloaded Node-RED`);
  }

  writeFileSync(
    DEPLOYED,
    JSON.stringify({
      revision,
      branch: repository.branch || 'main',
      flow_sha256: sha256(text),
      deployed_at: new Date().toISOString(),
    }, null, 2),
    { mode: 0o644 },
  );
}

// =================================================================================================
// The loop
// =================================================================================================

/**
 * A FAILED TICK IS NEVER FATAL. The forge being unreachable, Node-RED still starting, a plant link
 * that drops at night: every one of these is ordinary, and an appliance that exits on the first of
 * them stops converging forever while its container reports "restarting" to nobody. So each pass is
 * caught, named and retried on the next tick.
 *
 * The one thing that must not be swallowed is a REFUSAL -- a rewritten history, a mismatched broker
 * id. Those are logged at every occurrence rather than once, because they mean a person has to
 * decide something and the log is the only place that will say so.
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
