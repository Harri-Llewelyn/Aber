#!/usr/bin/env node
// The broker credential service: the authority to issue and revoke gateway accounts, kept out of the
// edge worker that enrols them and behind four verbs that name a gateway and nothing else:
//   POST /credentials   issue (or re-issue) one gateway's account: its role, the client, a password
//   POST /revocations   disable one gateway's account, which disconnects its live session
//   GET  /clients       the broker's own list of clients and roles, for the Access Control page
//   GET  /ca            the root the broker presents, its dates, and its public key's pin
// A sidecar in the broker's pod, speaking mosquitto_rr from the broker's own image to the plugin on
// loopback; it holds no database credential and is not published outside the container network.
// Reasoning: mosquitto/README.md, "The credential service and the boot reconcile".
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

const PORT = Number.parseInt(process.env.MQTT_CREDENTIAL_SERVICE_PORT || '9010', 10);
const TOKEN = process.env.MQTT_CREDENTIAL_SERVICE_TOKEN || '';

const MQTT_HOST = process.env.MQTT_HOST || 'mosquitto';
const MQTT_PORT = Number.parseInt(process.env.MQTT_PORT || '1883', 10);
const ADMIN_USER = process.env.MQTT_DYNSEC_ADMIN_USER || 'dynsec-admin';
const ADMIN_PASSWORD = process.env.MQTT_DYNSEC_ADMIN_PASSWORD || '';

// The root the broker presents, read beside it. Not a secret; ca.key alongside is deliberately not read.
const CA_FILE = process.env.MQTT_CA_FILE || '/mosquitto/certs/ca.crt';

const SECRET_NAME = process.env.MOSQUITTO_SECRET || 'mosquitto-passwords';
const PLAYBACK_SECRET_KEY = 'playback_credentials.json';
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

const log = (...args) => console.log('[gateway-credential]', ...args);

// Refuse to start without a token: a default would be in the repository, and running open would let
// anything that can reach this port publish telemetry as any gateway on the site.
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

// Constant time. timingSafeEqual throws on a length mismatch, which would itself leak the length,
// so the lengths are compared first and both branches still run a comparison.
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

// One command, one reply. No answer is the broker unreachable (502 to the caller); a reply carrying
// `error` is the plugin refusing, which the caller decides about.
const control = controlSender({
  host: MQTT_HOST, port: MQTT_PORT, username: ADMIN_USER, password: ADMIN_PASSWORD,
});

// Authenticated by the pod's ServiceAccount. The token is read on every call, not cached: projected
// tokens are short-lived and rotated in place.
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
  return process.env.ABER_NAMESPACE
    || readFileSync(`${SA_DIR}/namespace`, 'utf8').trim();
}

// Hands a fresh password to the playback worker by patching the Secret its pod mounts (archived migration
// 0078); the Role behind it is get and patch on one Secret by name. Decides nothing about
// eligibility: `deliver` arrives already answered by the database. Merged, not overwritten.
async function deliverToPlayback(sparkplugId, password) {
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

  // NULL rather than an error with no CA: Remote gateways need it, but a plaintext-only stack can
  // still issue.
  let caCert = null;
  try {
    caCert = readFileSync(CA_FILE, 'utf8');
  } catch {
    log(`no CA at ${CA_FILE}; returning ca_cert: null (MQTTS callers will refuse this)`);
  }

  // After the broker, not before: a delivery failure is logged and does not fail the issue, since the
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
    // Always true now that the plugin applies a command as it answers it; kept so callers keep one shape.
    applied_to_running_broker: true,
    apply_method: 'dynsec',
  };
}

function revoke(sparkplugId) {
  assertGatewayId(sparkplugId);
  const response = control({ command: 'disableClient', username: sparkplugId });
  if (isRefusal(response, 'not found')) return { revoked: false, existed: false };
  assertOk(response);
  return { revoked: true, existed: true };
}

function inventory() {
  const clients = assertOk(control({ command: 'listClients', verbose: true }));
  const roles = assertOk(control({ command: 'listRoles', verbose: true }));
  return { ...summariseInventory(clients, roles), read_at: new Date().toISOString() };
}

// The root as the certificate, its validity window, and the pin of its public key: the SHA-256 of
// the SubjectPublicKeyInfo in base64, which is what caPin.ts computes and an appliance's openssl
// prints. The key outlives the certificate (the CA is re-issued with rotationPolicy: Never), so a
// re-issue moves not_after and leaves the pin; a changed pin is a new key, the case a fleet is
// walked through. Not a secret, but authenticated because this port holds one door.
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

// A CredentialError maps to a 4xx or 502 by its code. Anything else is logged in full and returned
// in summary, since the detail can name a Secret, a namespace or a path.
function sendError(res, err) {
  if (err instanceof CredentialError) {
    const status = err.code === 'body_too_large' ? 413
      : err.code === 'backend_unavailable' ? 502
        : err.code === 'broker_refused' ? 502
          : 400;
    if (status === 502) console.error('[gateway-credential]', err.message);
    return send(res, status, { error: err.message, code: err.code });
  }
  console.error('[gateway-credential] request failed:', err);
  return send(res, 502, { error: 'credential operation failed', code: 'backend_unavailable' });
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  // Unauthenticated, and deliberately empty of detail: liveness only.
  if (req.method === 'GET' && pathname === '/healthz') {
    return send(res, 200, { status: 'ok' });
  }

  const routes = new Set(['/credentials', '/revocations', '/clients', '/ca']);
  if (!routes.has(pathname)) return send(res, 404, { error: 'not found' });

  // No detail about why: distinguishing "no header" from "wrong token" is a hint.
  if (!authorised(req)) {
    log(`rejected an unauthenticated request from ${req.socket.remoteAddress}`);
    return send(res, 401, { error: 'unauthorized' });
  }

  try {
    if (pathname === '/clients') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, inventory());
    }

    // 404 and not 502 when there is no CA: a plaintext-only stack is a deployment that has none, not a
    // broker that could not be reached, and the caller publishing a trust bundle has to tell those apart.
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

    // Generated here when the caller supplies none, the normal path: one fewer copy in transit.
    const password = parsed.password || generatePassword();
    // Strictly === true, so an absent key, a null or a truthy string cannot turn delivery on.
    const deliver = parsed.deliver_to_playback === true;

    const result = await issue(sparkplugId, password, { deliver });
    log(`issued ${result.replaced ? '(re-issued)' : '(new)'} credential for ${sparkplugId}`);

    // Returned once. The plugin stores a hash; this response is the only copy.
    return send(res, 200, { ...result, password });
  } catch (err) {
    return sendError(res, err);
  }
});

// 0.0.0.0 is the container's interface, not the host's: the port is not published.
server.listen(PORT, '0.0.0.0', () => {
  log(`listening on :${PORT} (broker ${MQTT_HOST}:${MQTT_PORT} as ${ADMIN_USER})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`${signal} received; closing.`);
    server.close(() => process.exit(0));
  });
}
