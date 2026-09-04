#!/usr/bin/env node
/**
 * The broker credential-issuing service.
 *
 * WHY IT EXISTS. `enroll-gateway` runs in a Deno edge worker: no Docker socket, no kubectl, no
 * access to the broker's password file. It cannot issue a Mosquitto account, and it must not be
 * given a credential that could -- a service-role key or a kubeconfig sitting in an edge function
 * is a far larger authority than "add one line to a password file".
 *
 * So the authority is moved behind an interface narrow enough to reason about: ONE endpoint, ONE
 * verb, one kind of object. This service can add a gateway account and do nothing else -- it cannot
 * read a password back (nothing can; the file holds hashes), cannot delete accounts, cannot reach
 * the database, and is not published outside the container network.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IT IS NOT. It is not a general credential API and must not become one. Every capability
 * added here is a capability reachable by whoever holds one bearer token, from a service whose
 * whole justification is that it holds LESS authority than the alternatives.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO TARGETS, ONE SHAPE.
 *
 *   compose  a container sharing the broker's PID namespace (`pid: "service:mosquitto"`) with the
 *            config volume mounted. It writes the file the broker is reading and SIGHUPs it.
 *
 *   k8s      a SIDECAR in the broker's pod. `shareProcessNamespace: true` is already set for the
 *            existing credential-reload sidecar, so the same SIGHUP works. The durable write is a
 *            PATCH of the Secret through the Kubernetes API -- never kubectl, which is not present
 *            and would need a kubeconfig this pod does not have.
 *
 * The two differ only in where the DURABLE copy lives. Applying it to the running broker is the
 * same code on both, which is the point: that half is where a divergence would show up as "the
 * gateway works on Compose and not on Kubernetes".
 *
 * ORDER IS FIXED AND MATTERS: durable first, running broker second. The Secret is the source of
 * truth, and a pod rescheduled between the two steps must come back holding the credential.
 * Applying locally first would produce a broker that accepts a gateway until the next restart.
 *
 * ---------------------------------------------------------------------------------------------
 * `-c` IS NEVER APPLIED TO THE PASSWORD FILE. Hashing goes to a scratch file holding exactly one
 * account (scripts/lib/mosquitto-credentials.mjs, hashArgv) and the result is merged in by
 * mergeCredential(), which THROWS rather than return contents that would lose an account. The real
 * file is only ever replaced wholly, atomically, with a value that guard has passed.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import {
  chmodSync, chownSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  CredentialError,
  PASSWORD_FILE,
  assertEntry,
  assertGatewayId,
  assertSafePassword,
  generatePassword,
  hashArgv,
  mergeCredential,
  mergeDelivery,
  serialiseDelivery,
  PLAYBACK_CREDENTIAL_FILE,
} from './lib/mosquitto-credentials.mjs';

// -------------------------------------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------------------------------------
const TARGET = process.env.CREDENTIAL_TARGET || 'compose';
const PORT = Number.parseInt(process.env.MQTT_CREDENTIAL_SERVICE_PORT || '9010', 10);
const TOKEN = process.env.MQTT_CREDENTIAL_SERVICE_TOKEN || '';
const PASSWD_PATH = process.env.MOSQUITTO_PASSWORD_FILE || PASSWORD_FILE;

// Where a playback target's password is dropped for the worker to read. The default MUST match
// playback_worker.py's PLAYBACK_CREDENTIAL_FILE -- the two ends of one volume, and a mismatch is
// silent at both: this side writes successfully and that side finds no file.
const PLAYBACK_DELIVERY_PATH =
  process.env.PLAYBACK_CREDENTIAL_FILE || PLAYBACK_CREDENTIAL_FILE;

/**
 * The broker's CA, returned alongside the credential.
 *
 * WHY HERE AND NOT IN enroll-gateway. An appliance needs three things that must all describe the
 * SAME broker: a username, a password, and the root that signs the certificate it will be shown.
 * This service is the only component that sits beside the broker on both targets, so it is the only
 * one that can read the CA the broker is actually presenting. Sourcing it anywhere else -- an edge
 * function's environment, a value pasted into .env -- creates a second copy that can drift, and the
 * failure of a stale CA is a TLS handshake alert at the appliance with nothing wrong at the broker.
 *
 * IT IS NOT A SECRET. A root certificate is public material by construction: it is distributed to
 * every appliance and contains no private key. `ca.key` sits beside it and is deliberately NOT read
 * here -- mosquitto-tls-init leaves it root-owned at 0600 and nothing but that script ever opens it.
 */
const CA_FILE = process.env.MQTT_CA_FILE || '/mosquitto/certs/ca.crt';
const BROKER_UID = Number.parseInt(process.env.MQTT_BROKER_UID || '1883', 10);

// Kubernetes only.
const SECRET_NAME = process.env.MOSQUITTO_SECRET || 'mosquitto-passwords';
const SECRET_KEY = 'password_file';
// The playback delivery, carried as a SECOND KEY in the same Secret so this pod's Role still needs
// `patch` on exactly one Secret by name. The playback Deployment mounts this key alone.
const PLAYBACK_SECRET_KEY = 'playback_credentials.json';
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

const log = (...args) => console.log('[gateway-credential]', ...args);

if (TARGET !== 'compose' && TARGET !== 'k8s') {
  console.error(`[gateway-credential] CREDENTIAL_TARGET must be 'compose' or 'k8s' (got '${TARGET}')`);
  process.exit(2);
}

/**
 * REFUSE TO START WITHOUT A TOKEN, rather than defaulting to one or running open.
 *
 * A default would be in this file, therefore in the repository, therefore known. Running open would
 * mean any workload that can reach this port can mint a broker account for any edge node -- and
 * because mosquitto.acl confines an account to `spBv1.0/+/+/%u/#`, that is the ability to publish
 * telemetry as any gateway on the site. Failing to boot is loud; the alternative is silent.
 *
 * 32 characters minimum: this is a bearer credential compared in full, not a password with a
 * user behind it, so the only meaningful attack is guessing.
 */
if (TOKEN.length < 32) {
  console.error(
    '[gateway-credential] MQTT_CREDENTIAL_SERVICE_TOKEN is unset or shorter than 32 characters.\n'
    + 'This service mints broker credentials; an unauthenticated one lets anything that can reach\n'
    + 'the port publish Sparkplug telemetry as any gateway on the site. Run `npm run setup` to\n'
    + 'generate one, and give the same value to the supabase-functions service.'
  );
  process.exit(2);
}

// -------------------------------------------------------------------------------------------------
// Authentication
// -------------------------------------------------------------------------------------------------
/**
 * Constant-time bearer comparison.
 *
 * timingSafeEqual throws on a length mismatch, which would itself leak the length -- so the lengths
 * are compared first and BOTH branches still run a comparison of equal-length buffers. The result
 * is combined so an early return cannot reintroduce the timing signal.
 */
function tokenMatches(presented) {
  const a = Buffer.from(presented || '', 'utf8');
  const b = Buffer.from(TOKEN, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function authorised(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? tokenMatches(match[1]) : false;
}

// -------------------------------------------------------------------------------------------------
// Hashing -- always into a scratch file, never into the real one
// -------------------------------------------------------------------------------------------------
/**
 * Produce one `username:$7$...` line using the broker image's own mosquitto_passwd.
 *
 * THE BINARY MATTERS. The hash has to be readable by the mosquitto that will verify it, and
 * reimplementing PBKDF2-SHA512 in the `$7$` framing is a way to produce a file that looks right and
 * refuses every login with nothing logged at either end. This service is built FROM the broker
 * image for that reason -- see gateway-credential/Dockerfile.
 */
function hashEntry(sparkplugId, password) {
  const out = execFileSync('/bin/sh', hashArgv(sparkplugId, password), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return assertEntry(out, sparkplugId);
}

// -------------------------------------------------------------------------------------------------
// Applying to the running broker (both targets)
// -------------------------------------------------------------------------------------------------
/**
 * The broker's pid, found by scanning /proc.
 *
 * A shared PID namespace is what makes this visible: `pid: "service:mosquitto"` on Compose,
 * `shareProcessNamespace: true` on the pod. /proc is read directly rather than shelling out to
 * `pidof` so the failure is a value this code can reason about rather than a non-zero exit.
 *
 * NOT PID 1 in either case -- Compose's shared namespace keeps the broker's own pid, and on
 * Kubernetes pid 1 is the pause container.
 */
function brokerPid() {
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (readFileSync(`/proc/${name}/comm`, 'utf8').trim() === 'mosquitto') {
        return Number.parseInt(name, 10);
      }
    } catch {
      // The process exited between readdir and read. Normal; keep looking.
    }
  }
  return null;
}

/**
 * Merge the entry into the file the broker is reading, then SIGHUP it.
 *
 * ATOMIC: written to a sibling temp path and renamed. rename(2) within a filesystem is atomic, so
 * the broker can never observe a half-written password file -- which, if it reloaded at that
 * instant, would drop every account after the truncation point. That is the same class of failure
 * as `-c`, reached by a different route, and it is the reason this is not a plain writeFileSync.
 *
 * Ownership is applied BEFORE the rename, so the file is never briefly readable at the final path.
 */
function applyLocally(sparkplugId, entry) {
  const existing = existsSync(PASSWD_PATH) ? readFileSync(PASSWD_PATH, 'utf8') : '';
  const { contents, replaced, accounts } = mergeCredential(existing, entry);

  const tmp = `${PASSWD_PATH}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  try {
    chownSync(tmp, BROKER_UID, BROKER_UID);
  } catch (err) {
    log(`could not chown the password file to uid ${BROKER_UID}: ${err.message}`);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, PASSWD_PATH);

  // SIGHUP, not a restart: Mosquitto re-reads the password and ACL files in place and keeps every
  // connected gateway. A restart would drop the entire fleet to add one account.
  const pid = brokerPid();
  if (pid) {
    process.kill(pid, 'SIGHUP');
    return { applied: true, method: 'SIGHUP', accounts: accounts.length, replaced };
  }

  // Not fatal. On Kubernetes the Secret has already been patched and the reload sidecar converges
  // within its watch interval; on Compose the broker picks it up when it next starts. The caller is
  // told so it can tell the appliance to retry rather than reporting a working credential as broken.
  log('WARNING: no mosquitto process visible; the file was written but not applied.');
  return { applied: false, method: 'none', accounts: accounts.length, replaced };
}

// -------------------------------------------------------------------------------------------------
// Kubernetes API
// -------------------------------------------------------------------------------------------------
/**
 * A request to the API server, authenticated by the pod's ServiceAccount.
 *
 * NOT kubectl: it is not in this image and would need a kubeconfig the pod does not have. The token
 * is READ ON EVERY CALL rather than cached -- projected ServiceAccount tokens are short-lived and
 * rotated in place by the kubelet, so a value captured at boot expires while the process keeps
 * running and every write starts failing 401 hours after a successful start.
 */
function k8sRequest(method, path, body) {
  const token = readFileSync(`${SA_DIR}/token`, 'utf8').trim();
  const ca = readFileSync(`${SA_DIR}/ca.crt`);

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = httpsRequest(
      {
        host: process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc',
        port: process.env.KUBERNETES_SERVICE_PORT || 443,
        path,
        method,
        ca,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/merge-patch+json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data ? JSON.parse(data) : null);
          } else {
            reject(new Error(`${method} ${path} -> ${res.statusCode}: ${data.slice(0, 300)}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function namespace() {
  return process.env.ACS_CYMRU_NAMESPACE
    || readFileSync(`${SA_DIR}/namespace`, 'utf8').trim();
}

/**
 * Merge the entry into the Secret and patch it back.
 *
 * A MERGE PATCH OF ONE KEY, not a replace: the Secret may hold other keys, and re-creating it would
 * drop them. The merge itself is the shared one, so its truncation guard covers the Kubernetes path
 * exactly as it covers the file.
 */
async function patchSecret(entry) {
  const ns = namespace();
  const path = `/api/v1/namespaces/${ns}/secrets/${SECRET_NAME}`;

  let existing = '';
  try {
    const secret = await k8sRequest('GET', path);
    const encoded = secret?.data?.[SECRET_KEY];
    if (encoded) existing = Buffer.from(encoded, 'base64').toString('utf8');
  } catch (err) {
    // A missing Secret is recoverable -- the chart creates it empty, but a hand-rolled install may
    // not have. Anything else (403, unreachable) is not, and must not be read as "empty".
    if (!/-> 404:/.test(err.message)) throw err;
    log(`Secret ${ns}/${SECRET_NAME} not found; creating its first account.`);
  }

  const { contents, replaced, accounts } = mergeCredential(existing, entry);

  await k8sRequest('PATCH', path, {
    data: { [SECRET_KEY]: Buffer.from(contents, 'utf8').toString('base64') },
  });

  return { replaced, accounts: accounts.length };
}

// -------------------------------------------------------------------------------------------------
// Issuing
// -------------------------------------------------------------------------------------------------
/**
 * Hand a freshly-issued password to the playback worker, by writing it where the worker reads.
 *
 * ---------------------------------------------------------------------------------------------
 * THE ONLY COMPONENT THAT CAN DO THIS, WHICH IS WHY IT IS HERE AND NOT SOMEWHERE TIDIER.
 *
 * The plaintext exists in exactly two places for exactly as long as this request: here, where it was
 * generated, and in the browser that will show it once. The broker keeps a hash and the database
 * keeps an audit row naming neither. So a delivery that does not happen now cannot happen later --
 * there is nothing left to deliver.
 *
 * ---------------------------------------------------------------------------------------------
 * THIS FUNCTION MAKES NO DECISION ABOUT WHO IS ELIGIBLE, and must not start.
 *
 * `deliver` is decided by `authorize_virtual_gateway_credential()` (0078) from `is_simulated` -- the
 * same predicate `start_playback_job()` gates on -- and arrives already answered. This service
 * cannot check it: it holds a `sparkplug_id` and no database connection, by design. Re-deciding it
 * here from anything locally available would mean guessing, and the failure of a wrong guess is a
 * real gateway's password in a file the replay worker reads.
 *
 * ---------------------------------------------------------------------------------------------
 * MERGED, NOT OVERWRITTEN. A stack can have several playback targets and they are issued one at a
 * time; writing a single-entry file would silently revoke delivery for every other target on each
 * issue. A malformed existing file is REPLACED rather than aborting the issue -- the account already
 * exists at the broker by the time this runs, so refusing here would strand a credential nobody can
 * use in order to preserve a file nobody can parse.
 */
async function deliverToPlayback(sparkplugId, password) {
  // ON KUBERNETES IT IS A SECOND KEY IN THE SAME SECRET, not a second Secret, and that is an RBAC
  // decision rather than a tidiness one. This pod's Role grants `get` and `patch` on ONE Secret by
  // name -- see the chart's own note about why that is not `secrets: ["*"]` -- so a separate Secret
  // would mean widening the authority of the component that mints broker credentials. A PATCH
  // merges `data` keys, so the password file beside it is untouched.
  //
  // The playback Deployment mounts THIS KEY ALONE via `items:`, so it never receives the broker's
  // password file even though the two share a Secret.
  if (TARGET === 'k8s') {
    const ns = namespace();
    const path = `/api/v1/namespaces/${ns}/secrets/${SECRET_NAME}`;

    let existing = '';
    try {
      const secret = await k8sRequest('GET', path);
      const encoded = secret?.data?.[PLAYBACK_SECRET_KEY];
      if (encoded) existing = Buffer.from(encoded, 'base64').toString('utf8');
    } catch (err) {
      if (!/-> 404:/.test(err.message)) throw err;
      log(`Secret ${ns}/${SECRET_NAME} not found; creating its first playback delivery.`);
    }

    const held = mergeDelivery(existing, sparkplugId, password, log);
    await k8sRequest('PATCH', path, {
      data: {
        [PLAYBACK_SECRET_KEY]:
          Buffer.from(serialiseDelivery(held), 'utf8').toString('base64'),
      },
    });
    log(`delivered a playback credential for ${sparkplugId} (${Object.keys(held).length} held)`);
    return { delivered: true, held: Object.keys(held).length, via: 'secret' };
  }

  const existing = existsSync(PLAYBACK_DELIVERY_PATH)
    ? readFileSync(PLAYBACK_DELIVERY_PATH, 'utf8')
    : '';
  const held = mergeDelivery(existing, sparkplugId, password, log);

  // ATOMIC, and 0600 like the password file beside it. The worker re-reads this every three seconds,
  // so a plain write would eventually be read half-finished -- and the failure of that is a parse
  // error logged once and a credential that appears never to have arrived.
  const tmp = `${PLAYBACK_DELIVERY_PATH}.tmp`;
  mkdirSync(dirname(PLAYBACK_DELIVERY_PATH), { recursive: true });
  writeFileSync(tmp, serialiseDelivery(held), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, PLAYBACK_DELIVERY_PATH);

  // THE COUNT AND THE IDS, NEVER THE VALUES. Gateway ids are safe to log and are what an operator
  // needs to confirm a delivery; the passwords are the thing this file exists to contain.
  log(`delivered a playback credential for ${sparkplugId} (${Object.keys(held).length} held)`);
  return { delivered: true, held: Object.keys(held).length, via: 'file' };
}

async function issue(sparkplugId, password, { deliver = false } = {}) {
  assertGatewayId(sparkplugId);
  assertSafePassword(password);

  const entry = hashEntry(sparkplugId, password);

  // DURABLE FIRST. See the header: a pod or container replaced between these two steps must come
  // back holding the credential, so the store of record is written before the running broker.
  let durable = { replaced: false, accounts: null };
  if (TARGET === 'k8s') {
    durable = await patchSecret(entry);
  }

  const local = applyLocally(sparkplugId, entry);

  // NULL RATHER THAN AN ERROR when there is no CA. This service's job is credentials; whether MQTTS
  // is available is the caller's policy decision. enroll-gateway treats a missing CA as fatal --
  // physical gateways connect over 8883 exclusively and there is no unverified fallback anywhere in
  // this stack -- but a stack running plaintext-only should still be able to issue an account.
  let caCert = null;
  try {
    caCert = readFileSync(CA_FILE, 'utf8');
  } catch {
    log(`no CA at ${CA_FILE}; returning ca_cert: null (MQTTS callers will refuse this)`);
  }

  // AFTER THE BROKER, NOT BEFORE. Delivering a password the broker has not accepted would give the
  // worker a credential that fails at CONNECT -- which is the exact state this change was written to
  // end. A delivery failure is logged and does NOT fail the issue: the account exists, the browser
  // is about to show the password, and refusing here would strand it for the sake of a file the
  // operator can still fill in by hand.
  let delivery = null;
  if (deliver) {
    try {
      delivery = await deliverToPlayback(sparkplugId, password);
    } catch (err) {
      log(`WARNING: could not deliver the playback credential: ${err.message}`);
      delivery = { delivered: false, error: err.message };
    }
  }

  return {
    sparkplug_id: sparkplugId,
    ca_cert: caCert,
    // Reported so the edge function can tell the operator whether the worker will pick this up on
    // its own or whether they still have to place it -- the difference between "done" and "done,
    // now do the other half", which is not something to leave them to discover.
    playback_delivery: delivery,
    replaced: TARGET === 'k8s' ? durable.replaced : local.replaced,
    accounts: TARGET === 'k8s' ? durable.accounts : local.accounts,
    // Reported rather than assumed, so `enroll-gateway` can tell an appliance to retry its first
    // connection instead of presenting a working credential as a failure.
    applied_to_running_broker: local.applied,
    apply_method: local.method,
    target: TARGET,
  };
}

// -------------------------------------------------------------------------------------------------
// HTTP
// -------------------------------------------------------------------------------------------------
function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    // This service is reached by another service, never by a browser. Saying so costs nothing and
    // removes any question about whether a page could be talked into calling it.
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      // A bounded body, because this endpoint takes two short strings and an unbounded reader is
      // an availability problem on a service the enrolment path depends on.
      if (data.length > limit) {
        reject(new CredentialError('request body too large', 'body_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  // UNAUTHENTICATED, and deliberately empty of detail: it exists for the container healthcheck and
  // reports liveness, never the state of the password file or which accounts exist.
  if (req.method === 'GET' && pathname === '/healthz') {
    return send(res, 200, { status: 'ok', target: TARGET });
  }

  if (pathname !== '/credentials') return send(res, 404, { error: 'not found' });
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  if (!authorised(req)) {
    // No detail about why. A response distinguishing "no header" from "wrong token" is a hint.
    log(`rejected an unauthenticated request from ${req.socket.remoteAddress}`);
    return send(res, 401, { error: 'unauthorized' });
  }

  try {
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(raw || '{}');
    } catch {
      throw new CredentialError('body is not valid JSON', 'invalid_request');
    }

    const sparkplugId = parsed.sparkplug_id;
    // The password is generated HERE when the caller does not supply one, which is the normal path:
    // enroll-gateway has no reason to invent credential material, and a value generated at the
    // point of use is one fewer copy in transit.
    const password = parsed.password || generatePassword();

    // STRICTLY `=== true`, so an absent key, a null, or a truthy string cannot turn delivery on.
    // The caller that sets this is `gateway-credential`, which reads it out of
    // authorize_virtual_gateway_credential() (0078); `enroll-gateway` never sets it and must not,
    // because a physical appliance's credential travels to the appliance and has no business in a
    // file the replay worker reads. Defaulting off is what makes "forgot to pass it" a playback
    // target the operator must place by hand, rather than a real gateway's password delivered.
    const deliver = parsed.deliver_to_playback === true;

    const result = await issue(sparkplugId, password, { deliver });
    log(
      `issued ${result.replaced ? '(replaced)' : '(new)'} credential for ${sparkplugId}; `
      + `${result.accounts} account(s); applied=${result.applied_to_running_broker}`
    );

    // The password is returned ONCE. mosquitto_passwd stores only a hash, so there is no path by
    // which it could be read back -- this response is the only copy that will ever exist.
    return send(res, 200, { ...result, password });
  } catch (err) {
    if (err instanceof CredentialError) {
      const status = err.code === 'body_too_large' ? 413 : 400;
      return send(res, status, { error: err.message, code: err.code });
    }
    // Logged in full, returned in summary: the detail can name a Secret, a namespace or a path.
    console.error('[gateway-credential] issuance failed:', err);
    return send(res, 502, { error: 'credential issuance failed', code: 'backend_unavailable' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  // 0.0.0.0 is the CONTAINER's interface, not the host's: neither target publishes this port, and
  // the Kubernetes side is additionally confined by a NetworkPolicy that admits only the edge
  // functions. Binding narrower would break the health probe, which dials the pod IP.
  log(`listening on :${PORT} (target=${TARGET}, password file ${PASSWD_PATH})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`${signal} received; closing.`);
    server.close(() => process.exit(0));
  });
}
