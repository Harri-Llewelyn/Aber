#!/usr/bin/env node
/**
 * The broker credential service.
 *
 * WHY IT EXISTS. `enroll-gateway` runs in a Deno edge worker with no way to reach the broker's
 * control topic, and it must not be given the plugin's admin credential: that is authority over
 * every principal on the broker, held by a component reachable through the gateway. So the
 * authority sits here, behind three verbs that name a gateway and nothing else:
 *
 *   POST /credentials   issue (or re-issue) one gateway's account: its role, the client, a password
 *   POST /revocations   disable one gateway's account, which disconnects its live session
 *   GET  /clients       the broker's own list of clients and roles, for the Access Control page
 *   GET  /ca            the root the broker presents, its dates, and its public key's pin
 *
 * It holds no database credential and is not published outside the container network. The admin
 * account it authenticates as reaches `$CONTROL/dynamic-security/#` and no other topic
 * (mosquitto/README.md), so a holder of this service's bearer token can issue and revoke gateway
 * accounts, and can read the inventory, and cannot read a message. Nothing here deletes a client
 * or a role: deleting a role a client holds took the broker down when measured.
 *
 * ONE SHAPE. The plugin persists its own document, so there is no durable copy for
 * this service to write and no broker to signal: a command answered without error is applied and
 * saved. The service speaks `mosquitto_rr` from the broker's own image, one request per command,
 * so the binary and the broker never disagree about the protocol. It is a sidecar in the broker's
 * pod and dials loopback.
 *
 * The playback delivery (0078): the worker runs in another pod, so the password goes into the
 * Secret that pod mounts. The Role behind that is `get` and `patch` on one Secret by name.
 */
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  CredentialError,
  assertGatewayId,
  assertSafePassword,
  generatePassword,
  mergeDelivery,
  serialiseDelivery,
} from './lib/mosquitto-credentials.mjs';
import { assertOk, isRefusal, issueWithControl, summariseInventory } from './lib/mosquitto-dynsec.mjs';
import { controlSender } from './lib/mosquitto-control.mjs';

// -------------------------------------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------------------------------------
const PORT = Number.parseInt(process.env.MQTT_CREDENTIAL_SERVICE_PORT || '9010', 10);
const TOKEN = process.env.MQTT_CREDENTIAL_SERVICE_TOKEN || '';

// The broker, and the plugin's admin account.
const MQTT_HOST = process.env.MQTT_HOST || 'mosquitto';
const MQTT_PORT = Number.parseInt(process.env.MQTT_PORT || '1883', 10);
const ADMIN_USER = process.env.MQTT_DYNSEC_ADMIN_USER || 'dynsec-admin';
const ADMIN_PASSWORD = process.env.MQTT_DYNSEC_ADMIN_PASSWORD || '';


/**
 * The broker's CA, returned alongside the credential.
 *
 * An appliance needs three things that must all describe the SAME broker: a username, a password,
 * and the root that signs the certificate it will be shown. This service sits beside the broker on
 * both targets, so it is the one component that can read the CA the broker is actually presenting.
 * It is not a secret: a root certificate contains no private key. `ca.key` sits beside it and is
 * deliberately not read.
 */
const CA_FILE = process.env.MQTT_CA_FILE || '/mosquitto/certs/ca.crt';

// Kubernetes only: the playback delivery's Secret.
const SECRET_NAME = process.env.MOSQUITTO_SECRET || 'mosquitto-passwords';
const PLAYBACK_SECRET_KEY = 'playback_credentials.json';
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

const log = (...args) => console.log('[gateway-credential]', ...args);

/**
 * REFUSE TO START WITHOUT A TOKEN, rather than defaulting to one or running open.
 *
 * A default would be in this file, therefore in the repository, therefore known. Running open would
 * mean any workload that can reach this port can issue a broker account for any edge node, and the
 * broker confines an account to `spBv1.0/+/+/<its id>/#`, which is the ability to publish telemetry
 * as any gateway on the site. 32 characters minimum: this is a bearer credential compared in full.
 */
if (TOKEN.length < 32) {
  console.error(
    '[gateway-credential] MQTT_CREDENTIAL_SERVICE_TOKEN is unset or shorter than 32 characters.\n'
    + 'This service issues broker credentials; an unauthenticated one lets anything that can reach\n'
    + 'the port publish Sparkplug telemetry as any gateway on the site. Run `npm run setup` to\n'
    + 'generate one, and give the same value to the supabase-functions service.'
  );
  process.exit(2);
}

if (!ADMIN_PASSWORD) {
  console.error(
    '[gateway-credential] MQTT_DYNSEC_ADMIN_PASSWORD is empty. This service authenticates to the\n'
    + 'broker\'s Dynamic Security plugin as that account; without it nothing can be issued or\n'
    + 'revoked. Run `npm run setup`, and give the same value to the mosquitto-init service.'
  );
  process.exit(2);
}

// -------------------------------------------------------------------------------------------------
// Authentication
// -------------------------------------------------------------------------------------------------
/**
 * Constant-time bearer comparison. timingSafeEqual throws on a length mismatch, which would itself
 * leak the length, so the lengths are compared first and both branches still run a comparison.
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
// The control topic
// -------------------------------------------------------------------------------------------------
/**
 * One command to the plugin, its one response back. A non-zero exit or an empty reply is the
 * broker being unreachable, which is 502 to the caller; a reply carrying `error` is the plugin
 * refusing, which the caller decides about.
 */
const control = controlSender({
  host: MQTT_HOST, port: MQTT_PORT, username: ADMIN_USER, password: ADMIN_PASSWORD,
});

// -------------------------------------------------------------------------------------------------
// Kubernetes API (playback delivery only)
// -------------------------------------------------------------------------------------------------
/**
 * A request to the API server, authenticated by the pod's ServiceAccount. The token is read on
 * every call rather than cached: projected tokens are short-lived and rotated in place.
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
 * Hand a freshly-issued password to the playback worker, by writing it where the worker reads.
 *
 * The plaintext exists in exactly two places for exactly as long as this request: here, and in the
 * browser that will show it once. A delivery that does not happen now cannot happen later.
 *
 * THIS FUNCTION MAKES NO DECISION ABOUT WHO IS ELIGIBLE. `deliver` is decided by
 * `authorize_virtual_gateway_credential()` (0078) from `is_simulated` and arrives already answered;
 * this service holds a `sparkplug_id` and no database connection, by design.
 *
 * MERGED, NOT OVERWRITTEN: a stack can have several playback targets, issued one at a time.
 */
async function deliverToPlayback(sparkplugId, password) {
  // A second key in the broker's Secret, so this pod's Role needs `patch` on one Secret by name.
  // The playback Deployment mounts this key alone via `items:`.
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

async function issue(sparkplugId, password, { deliver = false } = {}) {
  assertGatewayId(sparkplugId);
  assertSafePassword(password);

  const { replaced } = issueWithControl(control, sparkplugId, password);

  // NULL RATHER THAN AN ERROR when there is no CA. enroll-gateway treats a missing CA as fatal --
  // physical gateways connect over 8883 exclusively -- but a plaintext-only stack can still issue.
  let caCert = null;
  try {
    caCert = readFileSync(CA_FILE, 'utf8');
  } catch {
    log(`no CA at ${CA_FILE}; returning ca_cert: null (MQTTS callers will refuse this)`);
  }

  // AFTER THE BROKER, NOT BEFORE. A delivery failure is logged and does not fail the issue: the
  // account exists and the browser is about to show the password.
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
    playback_delivery: delivery,
    replaced,
    // Always true now: the plugin applies a command to the running broker as it answers it. Kept
    // so the callers that report it to an operator keep one shape.
    applied_to_running_broker: true,
    apply_method: 'dynsec',
  };
}

/** Disable the account. The plugin disconnects a live session and refuses the next CONNECT. */
function revoke(sparkplugId) {
  assertGatewayId(sparkplugId);
  const response = control({ command: 'disableClient', username: sparkplugId });
  if (isRefusal(response, 'not found')) return { revoked: false, existed: false };
  assertOk(response);
  return { revoked: true, existed: true };
}

/** The broker's own inventory. Usernames, roles and the disabled flag; never hash material. */
function inventory() {
  const clients = assertOk(control({ command: 'listClients', verbose: true }));
  const roles = assertOk(control({ command: 'listRoles', verbose: true }));
  return { ...summariseInventory(clients, roles), read_at: new Date().toISOString() };
}

/**
 * The root the broker presents, read from the same file `/credentials` hands to an enrolling
 * appliance. Returned as the certificate, the window it is valid for, and the pin of its public
 * key -- the SHA-256 of the SubjectPublicKeyInfo in base64, which is what
 * `supabase/functions/_shared/caPin.ts` computes and what an appliance's `openssl` prints.
 *
 * THE KEY OUTLIVES THE CERTIFICATE. `deploy/k8s/internal-ca.yaml` re-issues the root with
 * `rotationPolicy: Never`, so a re-issue moves `not_after` and leaves `spki_sha256` where it was;
 * a changed pin is a new key, which is the case a fleet has to be walked through.
 *
 * NOT A SECRET: a root certificate carries no private key, and `ca.key` beside it is not read.
 * Authenticated all the same, because this port is the credential service's and holds one door.
 */
function certificateAuthority() {
  let pem;
  try {
    pem = readFileSync(CA_FILE, 'utf8');
  } catch {
    throw new CredentialError(
      `no CA at ${CA_FILE}; this deployment presents no root for an appliance to trust`,
      'no_ca',
    );
  }
  let certificate;
  try {
    certificate = new X509Certificate(pem);
  } catch (err) {
    throw new CredentialError(`${CA_FILE} is not a certificate: ${err.message}`, 'no_ca');
  }
  return {
    ca_cert: pem,
    not_before: new Date(certificate.validFrom).toISOString(),
    not_after: new Date(certificate.validTo).toISOString(),
    spki_sha256: createHash('sha256')
      .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64'),
    read_at: new Date().toISOString(),
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
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      // Bounded: this endpoint takes two short strings.
      if (data.length > limit) {
        reject(new CredentialError('request body too large', 'body_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function parseJson(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new CredentialError('body is not valid JSON', 'invalid_request');
  }
}

function sendError(res, err) {
  if (err instanceof CredentialError) {
    const status = err.code === 'body_too_large' ? 413
      : err.code === 'backend_unavailable' ? 502
        : err.code === 'broker_refused' ? 502
          : 400;
    if (status === 502) console.error('[gateway-credential]', err.message);
    return send(res, status, { error: err.message, code: err.code });
  }
  // Logged in full, returned in summary: the detail can name a Secret, a namespace or a path.
  console.error('[gateway-credential] request failed:', err);
  return send(res, 502, { error: 'credential operation failed', code: 'backend_unavailable' });
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  // UNAUTHENTICATED, and deliberately empty of detail: liveness only.
  if (req.method === 'GET' && pathname === '/healthz') {
    return send(res, 200, { status: 'ok' });
  }

  const routes = new Set(['/credentials', '/revocations', '/clients', '/ca']);
  if (!routes.has(pathname)) return send(res, 404, { error: 'not found' });

  if (!authorised(req)) {
    // No detail about why. A response distinguishing "no header" from "wrong token" is a hint.
    log(`rejected an unauthenticated request from ${req.socket.remoteAddress}`);
    return send(res, 401, { error: 'unauthorized' });
  }

  try {
    if (pathname === '/clients') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, inventory());
    }

    // 404 AND NOT 502 when there is no CA: a plaintext-only stack is a deployment that has none,
    // not a broker that could not be reached, and the caller publishing a trust bundle has to be
    // able to tell those apart before it writes one.
    if (pathname === '/ca') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      try {
        return send(res, 200, certificateAuthority());
      } catch (err) {
        if (err instanceof CredentialError && err.code === 'no_ca') {
          return send(res, 404, { error: err.message, code: err.code });
        }
        throw err;
      }
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const parsed = await parseJson(req);
    const sparkplugId = parsed.sparkplug_id;

    if (pathname === '/revocations') {
      const result = revoke(sparkplugId);
      log(`revoked ${sparkplugId}: ${result.existed ? 'disabled, live session dropped' : 'no such client'}`);
      return send(res, 200, { sparkplug_id: sparkplugId, ...result });
    }

    // The password is generated HERE when the caller does not supply one, which is the normal
    // path: a value generated at the point of use is one fewer copy in transit.
    const password = parsed.password || generatePassword();
    // STRICTLY `=== true`, so an absent key, a null, or a truthy string cannot turn delivery on.
    const deliver = parsed.deliver_to_playback === true;

    const result = await issue(sparkplugId, password, { deliver });
    log(`issued ${result.replaced ? '(re-issued)' : '(new)'} credential for ${sparkplugId}`);

    // The password is returned ONCE. The plugin stores a hash; this response is the only copy.
    return send(res, 200, { ...result, password });
  } catch (err) {
    return sendError(res, err);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  // 0.0.0.0 is the CONTAINER's interface, not the host's: the port is not published.
  log(`listening on :${PORT} (broker ${MQTT_HOST}:${MQTT_PORT} as ${ADMIN_USER})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`${signal} received; closing.`);
    server.close(() => process.exit(0));
  });
}
