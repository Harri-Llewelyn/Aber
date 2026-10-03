#!/usr/bin/env node
/**
 * Issue a broker CA and an MQTTS leaf certificate into mosquitto/tls-init, idempotently.
 *
 * WHY THIS EXISTS. Remote gateways connect over MQTTS on 8883, because a per-gateway broker
 * password crossing a plant network in clear text is not a credential, it is a transcript. In the
 * cluster, cert-manager issues the broker leaf from the ClusterIssuer in deploy/k8s/internal-ca.yaml
 * and the chart appends mosquitto-tls.conf when the Secret exists. This script is the off-cluster
 * fixture check-broker-config.mjs loads mosquitto.conf and that TLS listener against, and it
 * deliberately reproduces the ClusterIssuer's PROPERTIES rather than its mechanism:
 *
 *   selfSigned -> CA root -> leaf, never selfSigned -> leaf. A self-signed LEAF is verifiable by
 *   nobody, so a gateway would have to be told to skip verification -- and TLS that does not verify
 *   is indistinguishable, from the client's side, from a successful interception. There is no
 *   "insecure" switch anywhere in this stack and this file does not add the first one.
 *
 * ---------------------------------------------------------------------------------------------
 * THE CA IS NEVER REGENERATED ONCE IT EXISTS. THIS IS THE MOST IMPORTANT LINE IN THE FILE.
 *
 * Same reasoning as internal-ca.yaml's "helm uninstall would take it with it": the root is
 * distributed to every Remote gateway's trust store, by hand, one appliance at a time. Minting a
 * new one does not fail -- it succeeds, and every gateway in the plant then rejects the broker with
 * a verification error while the stack reports itself perfectly healthy. The fleet goes dark and
 * the cause is a container that ran successfully at boot.
 *
 * So: an existing CA is reused, always. The LEAF is reissued freely (it is presented by the broker
 * and trusted transitively, so replacing it costs nothing), and that split is what makes adding a
 * new hostname to the SAN a safe, routine act.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IT WRITES, and why the names are not ours to choose:
 *
 *   /mosquitto/certs/ca.crt    the root         -- distributed to gateways, returned by enroll-gateway
 *   /mosquitto/certs/tls.crt   the broker leaf
 *   /mosquitto/certs/tls.key   the broker key   (0600, uid 1883)
 *
 * `ca.crt` / `tls.crt` / `tls.key` are the kubernetes.io/tls key names cert-manager projects, and
 * mosquitto-tls.conf names those three paths. Using different names here would mean a second TLS
 * stanza, and the two would drift.
 *
 * Usage (normally run by the mosquitto-tls-init service, not by hand):
 *   node scripts/mosquitto-tls-init.mjs
 *   node scripts/mosquitto-tls-init.mjs --force-leaf    # reissue the leaf, keep the CA
 *   node scripts/mosquitto-tls-init.mjs --check         # report only, write nothing, exit 1 if work is due
 *
 * Environment:
 *   MQTT_TLS_CERT_DIR     where to write            (default /mosquitto/certs)
 *   MQTT_TLS_SAN_EXTRA    additional SAN entries, comma separated. Bare names are classified as
 *                         IP: or DNS: automatically; an explicit "DNS:x" / "IP:x" is passed through.
 *   MQTT_PUBLIC_HOST      the address gateways dial. Folded into the SAN, because a certificate
 *                         that does not name it fails verification at every appliance.
 *   MQTT_TLS_BROKER_UID   file owner for the key    (default 1883, the uid mosquitto drops to)
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, writeFileSync, rmSync, chmodSync, chownSync,
} from 'node:fs';
import { join } from 'node:path';

const CERT_DIR = process.env.MQTT_TLS_CERT_DIR || '/mosquitto/certs';
const BROKER_UID = Number.parseInt(process.env.MQTT_TLS_BROKER_UID || '1883', 10);

const CA_CRT = join(CERT_DIR, 'ca.crt');
const CA_KEY = join(CERT_DIR, 'ca.key');
const CA_SRL = join(CERT_DIR, 'ca.srl');
const TLS_CRT = join(CERT_DIR, 'tls.crt');
const TLS_KEY = join(CERT_DIR, 'tls.key');

const args = process.argv.slice(2);
const forceLeaf = args.includes('--force-leaf');
const checkOnly = args.includes('--check');

/**
 * Ten years for the root, 825 days for the leaf.
 *
 * The root's life is long because redistributing it is an ORGANISATIONAL event -- someone walks to
 * each appliance. The leaf's is 825 days because that is the longest a publicly-trusted certificate
 * may live under the CA/Browser Forum baseline, and while nothing here is publicly trusted, picking
 * the number everything else in the industry already enforces means no client surprises us by
 * refusing it.
 */
const CA_DAYS = 3650;
const LEAF_DAYS = 825;

/** Reissue the leaf when it has less than this left, so renewal never waits for an outage. */
const LEAF_RENEW_BEFORE_DAYS = 90;

// -------------------------------------------------------------------------------------------------
// Subject Alternative Names
// -------------------------------------------------------------------------------------------------
/**
 * The three names every deployment needs, before anything the operator adds.
 *
 * `mosquitto` is how every in-network client addresses the broker (see the Service name note in
 * the chart). `localhost` and `127.0.0.1` are for the published port -- a gateway
 * being commissioned on the same machine, and `scripts/check-broker-config.mjs`, both dial it that
 * way. Omitting them makes the check fail with a hostname mismatch that reads as a broken CA.
 */
const BASE_SANS = ['DNS:mosquitto', 'DNS:localhost', 'IP:127.0.0.1'];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Classify a bare name, pass an already-qualified one through. */
function toSanEntry(raw) {
  const value = raw.trim();
  if (!value) return null;
  if (/^(DNS|IP):/i.test(value)) return value;
  // A bare IPv4 written as DNS: is not a mistake OpenSSL catches -- it produces a certificate
  // that verifies against a hostname nobody dials and fails against the address everybody does.
  return IPV4.test(value) ? `IP:${value}` : `DNS:${value}`;
}

function desiredSans() {
  const extra = [
    ...(process.env.MQTT_PUBLIC_HOST || '').split(','),
    ...(process.env.MQTT_TLS_SAN_EXTRA || '').split(','),
  ]
    .map(toSanEntry)
    .filter(Boolean);

  // Deduplicated case-insensitively: DNS names are case-insensitive, so `DNS:Mosquitto` and
  // `DNS:mosquitto` are one entry, and emitting both makes the SAN comparison below never settle.
  const seen = new Map();
  for (const entry of [...BASE_SANS, ...extra]) {
    seen.set(entry.toLowerCase(), entry);
  }
  return [...seen.values()];
}

// -------------------------------------------------------------------------------------------------
// OpenSSL
// -------------------------------------------------------------------------------------------------
function openssl(argv, { quiet = true } = {}) {
  return execFileSync('openssl', argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'],
  });
}

/**
 * Escape a DN attribute VALUE for `openssl req -subj`. OpenSSL 3 reads an unescaped `+` as the
 * separator of a multi-valued RDN and fails with `req: Missing '=' after RDN type string`, which
 * does not mention the plus sign; `/`, `=` and `,` are just as structural.
 */
function dn(value) {
  return String(value).replace(/([\\/+=,])/g, '\\$1');
}

const ORG = dn('Aber');
const ORG_UNIT = dn('Shopfloor data platform');

// -------------------------------------------------------------------------------------------------
// Inspection
// -------------------------------------------------------------------------------------------------
/** SAN entries currently on a certificate, normalised to the `DNS:x` / `IP:x` form. */
function currentSans(certPath) {
  let text;
  try {
    text = openssl(['x509', '-in', certPath, '-noout', '-text']);
  } catch {
    return null;
  }
  const block = text.match(/X509v3 Subject Alternative Name:\s*\n\s*(.+)/);
  if (!block) return [];
  return block[1]
    .split(',')
    .map((s) => s.trim().replace(/^IP Address:/, 'IP:'))
    .filter(Boolean);
}

/** Days remaining on a certificate, or null when it cannot be read. */
function daysRemaining(certPath) {
  let text;
  try {
    text = openssl(['x509', '-in', certPath, '-noout', '-enddate']);
  } catch {
    return null;
  }
  const m = text.match(/notAfter=(.+)/);
  if (!m) return null;
  const expiry = new Date(m[1].trim());
  if (Number.isNaN(expiry.getTime())) return null;
  return Math.floor((expiry.getTime() - Date.now()) / 86_400_000);
}

/** Does the leaf actually chain to the CA we hold? */
function leafVerifies() {
  try {
    openssl(['verify', '-CAfile', CA_CRT, TLS_CRT]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why the leaf needs reissuing, or null when it does not.
 *
 * Returns a REASON rather than a boolean so the log says which of the four conditions fired --
 * "reissuing the leaf" on every boot with no explanation is how a subtly broken comparison
 * (a SAN normalisation bug, say) hides as routine noise.
 */
function leafWorkReason(wantSans) {
  if (forceLeaf) return '--force-leaf was passed';
  if (!existsSync(TLS_CRT) || !existsSync(TLS_KEY)) return 'no leaf certificate present';
  if (!leafVerifies()) return 'the leaf does not chain to the CA in this directory';

  const have = (currentSans(TLS_CRT) || []).map((s) => s.toLowerCase());
  const missing = wantSans.filter((s) => !have.includes(s.toLowerCase()));
  if (missing.length) return `the SAN does not cover ${missing.join(', ')}`;

  const left = daysRemaining(TLS_CRT);
  if (left === null) return 'the leaf expiry could not be read';
  if (left < LEAF_RENEW_BEFORE_DAYS) return `the leaf expires in ${left} day(s)`;

  return null;
}

// -------------------------------------------------------------------------------------------------
// Issuance
// -------------------------------------------------------------------------------------------------
function issueCa() {
  console.log('[mosquitto-tls-init] no CA present -- issuing a new root.');
  openssl([
    'req', '-x509', '-newkey', 'rsa:4096', '-sha256', '-days', String(CA_DAYS), '-nodes',
    '-keyout', CA_KEY, '-out', CA_CRT,
    '-subj', `/O=${ORG}/OU=${ORG_UNIT}/CN=${dn('Aber Internal CA (fixture)')}`,
    // pathlen:0 -- this root signs LEAVES and may not delegate. A CA that can mint intermediates is
    // a broader authority than anything here needs, and narrowing it costs nothing.
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);

  // RSA, not ECDSA, matching internal-ca.yaml -- and for its reason, which is compatibility rather
  // than cryptography: industrial gateways run embedded TLS stacks of varying age and some support
  // only RSA. The failure is a handshake alert on a subset of the fleet with nothing useful logged
  // at the broker, which is the shape that gets blamed on the network.

  console.log(`[mosquitto-tls-init] issued a ${CA_DAYS}-day root at ${CA_CRT}.`);
  console.log(
    '[mosquitto-tls-init] DISTRIBUTE THIS ROOT to every Remote gateway. Until it is in an '
    + 'appliance\'s trust store that appliance cannot verify the broker, and MQTTS will fail closed.'
  );
}

function issueLeaf(wantSans, reason) {
  console.log(`[mosquitto-tls-init] reissuing the broker leaf: ${reason}.`);

  const csr = join(CERT_DIR, 'tls.csr');
  const ext = join(CERT_DIR, 'leaf.ext');

  try {
    openssl([
      'req', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-keyout', TLS_KEY, '-out', csr,
      '-subj', `/O=${ORG}/CN=mosquitto`,
    ]);

    // An EXTFILE, not `-addext`. `openssl x509 -req` ignores extensions carried on the CSR unless
    // it is given -copy_extensions, and silently: it produces a certificate with no SAN at all,
    // which then fails hostname verification at every client while `openssl verify` still says OK.
    writeFileSync(
      ext,
      [
        'basicConstraints=CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        `subjectAltName=${wantSans.join(',')}`,
        '',
      ].join('\n'),
    );

    openssl([
      'x509', '-req', '-in', csr, '-CA', CA_CRT, '-CAkey', CA_KEY,
      // -CAserial with an explicit path, not -CAcreateserial's implicit one: the implicit file is
      // placed beside the CA anyway, but naming it keeps the directory's contents a closed set that
      // the idempotency check below can reason about.
      '-CAcreateserial', '-CAserial', CA_SRL,
      '-out', TLS_CRT, '-days', String(LEAF_DAYS), '-sha256', '-extfile', ext,
    ]);
  } finally {
    // The CSR and the extension file are inputs, not state. Leaving them in a directory the broker
    // mounts would invite a later reader to treat them as configuration.
    for (const path of [csr, ext]) rmSync(path, { force: true });
  }

  console.log(`[mosquitto-tls-init] leaf issued for ${wantSans.join(', ')} (${LEAF_DAYS} days).`);
}

/**
 * Permissions, and the failure they prevent.
 *
 * Mosquitto drops to uid 1883 and reads its own key AFTER dropping. A key it cannot read produces
 *
 *     Error: Unable to load server key file "/mosquitto/certs/tls.key". Check keyfile.
 *     OpenSSL Error[0]: error:8000000D:system library::Permission denied
 *
 * which reads as a malformed key rather than as a permission, and exits 1 before any listener opens.
 * `openssl req -keyout` writes 0600 owned by whoever ran it -- root, here -- so without this the
 * broker never starts. The CA KEY is deliberately left root-owned and 0600: the broker has no reason
 * to hold the key that signs for it.
 */
function applyOwnership() {
  chmodSync(CA_KEY, 0o600);
  for (const path of [CA_CRT, TLS_CRT]) chmodSync(path, 0o644);
  chmodSync(TLS_KEY, 0o600);

  try {
    chownSync(TLS_KEY, BROKER_UID, BROKER_UID);
    chownSync(TLS_CRT, BROKER_UID, BROKER_UID);
    chownSync(CA_CRT, BROKER_UID, BROKER_UID);
  } catch (err) {
    // Not fatal on its own -- a stack running this as a non-root user may already have the right
    // owner -- but it is the single most likely reason the broker will now refuse to start, so it
    // is reported rather than swallowed.
    console.warn(
      `[mosquitto-tls-init] could not chown the certificates to uid ${BROKER_UID} (${err.message}). `
      + 'If the broker exits with "Unable to load server key file", this is why.'
    );
  }
}

// -------------------------------------------------------------------------------------------------
// main
// -------------------------------------------------------------------------------------------------
function main() {
  mkdirSync(CERT_DIR, { recursive: true });

  const wantSans = desiredSans();

  // A CA certificate with no key cannot sign, and a key with no certificate cannot be trusted.
  // Either alone is a half-deleted directory, and continuing would either fail obscurely at the
  // signing step or mint a SECOND root beside the one still deployed to the fleet.
  const caCrt = existsSync(CA_CRT);
  const caKey = existsSync(CA_KEY);
  if (caCrt !== caKey) {
    console.error(
      `[mosquitto-tls-init] ${CERT_DIR} holds ${caCrt ? 'ca.crt without ca.key' : 'ca.key without ca.crt'}.\n`
      + 'Refusing to continue: issuing a fresh root here would invalidate the one already '
      + 'distributed to every Remote gateway, and every appliance would fail verification at once.\n'
      + 'Restore the missing half from backup, or delete both DELIBERATELY and re-enrol the fleet.'
    );
    process.exit(1);
  }

  const caWorkDue = !caCrt;
  const leafReason = caWorkDue ? 'the CA was just issued' : leafWorkReason(wantSans);

  if (checkOnly) {
    if (!caWorkDue && !leafReason) {
      console.log('[mosquitto-tls-init] certificates are current; nothing to do.');
      process.exit(0);
    }
    console.error(
      `[mosquitto-tls-init] work is due: ${caWorkDue ? 'no CA present' : leafReason}.`
    );
    process.exit(1);
  }

  if (caWorkDue) issueCa();
  else console.log(`[mosquitto-tls-init] reusing the existing root (${daysRemaining(CA_CRT)} days left).`);

  if (leafReason) issueLeaf(wantSans, leafReason);
  else console.log(`[mosquitto-tls-init] leaf is current (${daysRemaining(TLS_CRT)} days left); leaving it alone.`);

  applyOwnership();

  // Prove the result rather than assume it. Everything above can succeed and still leave a leaf
  // that does not chain -- a stale CA beside a fresh leaf, most plausibly -- and the symptom of
  // that is a TLS handshake failure at a gateway hours later, with nothing wrong at the broker.
  if (!leafVerifies()) {
    console.error(
      '[mosquitto-tls-init] the leaf does NOT verify against the CA in this directory. '
      + 'The broker would start and every client would then fail to connect. Re-run with '
      + '--force-leaf to reissue it from the current root.'
    );
    process.exit(1);
  }

  // READ BACK FROM THE CERTIFICATE, not echoed from `wantSans`. Printing the DESIRED list would
  // report names the leaf does not carry any time the two disagree -- which is precisely the state
  // this message would be consulted in, and it would confirm the wrong thing.
  console.log(
    `[mosquitto-tls-init] ready: ${CERT_DIR} holds a verified chain for `
    + `${(currentSans(TLS_CRT) || []).join(', ')}.`
  );
}

try {
  main();
} catch (err) {
  // execFileSync attaches the tool's own stderr, which is where OpenSSL says anything useful.
  const detail = err?.stderr ? `\n${String(err.stderr).trim()}` : '';
  console.error(`[mosquitto-tls-init] ${err.message}${detail}`);
  process.exit(1);
}
