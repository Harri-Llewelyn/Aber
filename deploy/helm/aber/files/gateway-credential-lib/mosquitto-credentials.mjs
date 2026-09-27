// What every issuer of a broker credential shares: the gateway id shape, the password alphabet and
// generator, the hashing argv, and the playback delivery store. Pure functions over strings with no
// I/O, used by the boot reconcile, the credential service, the operator CLI and the tests. The
// policy itself is in mosquitto-dynsec.mjs; the reasoning is in mosquitto/README.md.
import { randomBytes } from 'node:crypto';

// 'gwy' plus 21 lowercase hex characters: the GENERATED column in 0001_baseline_schema.sql, and
// what the broker confines the account to (spBv1.0/+/+/<username>/#). Any other username
// authenticates perfectly and then drops every message.
export const GATEWAY_ID_PATTERN = /^gwy[0-9a-f]{21}$/;

// A username mosquitto_passwd and the plugin both accept, for the platform principals.
export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// Where a playback target's password is delivered (archived migration 0078). Declared once and
// imported by both ends, because a writer/reader mismatch is silent on both sides; the Python end
// cannot import this, so check-docs-drift asserts the two agree.
export const PLAYBACK_CREDENTIAL_FILE = '/var/lib/aber/playback/credentials.json';

// Fold one delivered credential into the map already held. MERGED, NOT OVERWRITTEN: a stack can
// have several playback targets issued one at a time. A malformed store is replaced rather than
// fatal: by now the account exists and the password is about to be shown once.
export function mergeDelivery(existing, sparkplugId, password, onWarn = () => {}) {
  assertGatewayId(sparkplugId);
  assertSafePassword(password);

  let held = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Coerced to strings: a Python worker hands the value to paho as a password, and a number or null
        // would fail at CONNECT rather than here.
        for (const [k, v] of Object.entries(parsed)) {
          if (v !== null && v !== undefined) held[String(k)] = String(v);
        }
      } else {
        onWarn('playback delivery store is not a JSON object; replacing it');
      }
    } catch (err) {
      onWarn(`playback delivery store is unreadable (${err.message}); replacing it`);
    }
  }

  held[sparkplugId] = password;
  return held;
}

// Trailing newline, so the file is a well-formed text file.
export function serialiseDelivery(held) {
  return `${JSON.stringify(held, null, 2)}\n`;
}

// Distinguishable from a programming error, so callers can map it to a 4xx rather than a 500.
export class CredentialError extends Error {
  constructor(message, code = 'invalid_request') {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
  }
}

export function isGatewayId(value) {
  return typeof value === 'string' && GATEWAY_ID_PATTERN.test(value);
}

export function assertGatewayId(value) {
  if (!isGatewayId(value)) {
    throw new CredentialError(
      `'${value}' is not a gateway sparkplug_id ("gwy" followed by 21 lowercase hex characters).`,
      'invalid_sparkplug_id',
    );
  }
  return value;
}

// 32 bytes of base64url: long enough that the credential is not the weak link, and free of
// shell-hostile characters.
export function generatePassword() {
  return randomBytes(24).toString('base64url');
}

export function assertUsername(value) {
  if (typeof value !== 'string' || !USERNAME_PATTERN.test(value)) {
    throw new CredentialError(`'${value}' is not a usable MQTT username`, 'invalid_username');
  }
  return value;
}

// Validates one mosquitto_passwd line before its hash is transplanted into a client: an error
// message, an empty string or a multi-line dump must not be taken for an account. $7$ is the
// PBKDF2-SHA512 format 2.0.x writes, asserted because a plaintext entry is also valid to Mosquitto
// and would be a stored credential.
export function assertEntry(entry, username) {
  const line = String(entry || '').trim();

  if (!line.startsWith(`${username}:`)) {
    throw new CredentialError(
      `mosquitto_passwd produced a line for a different account (expected '${username}:...'): `
      + `${line.slice(0, 120)}`,
      'hash_mismatch',
    );
  }
  if (line.includes('\n')) {
    throw new CredentialError('mosquitto_passwd produced more than one line', 'hash_mismatch');
  }
  if (!/^[^:]+:\$7\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(line)) {
    throw new CredentialError(
      `mosquitto_passwd output is not a $7$ (PBKDF2-SHA512) entry: ${line.slice(0, 120)}`,
      'hash_mismatch',
    );
  }
  return line;
}

// Hashes ONE account into a mktemp file and prints it. The username and the password arrive as
// positional parameters $1 and $2, so nothing parses them as script text; the allow-lists are
// defence in depth rather than the defence. Constant, and therefore argument-free.
export function hashScript() {
  return [
    'set -e',
    'tmp=$(mktemp)',
    'mosquitto_passwd -b -c "$tmp" "$1" "$2"',
    'cat "$tmp"',
    'rm -f "$tmp"',
  ].join('; ');
}

// ['-c', script, '--', id, password]: sh -c assigns the first operand after the script to $0, so
// the -- is consumed there and the two real values land on $1 and $2. Validation stays here: an
// invalid argument should never reach a process at all.
export function hashArgv(sparkplugId, password) {
  assertGatewayId(sparkplugId);
  assertSafePassword(password);
  return hashArgvForUsername(sparkplugId, password);
}

// The same vector for any username the broker accepts: the operator's own passwords reach
// mosquitto_passwd positionally and never a command line, so the rule is only that the value is text.
export function hashArgvForUsername(username, password) {
  assertUsername(username);
  assertPrincipalPassword(password);
  return ['-c', hashScript(), '--', username, password];
}

// A platform principal's password: non-empty printable text, at most 128 characters.
export function assertPrincipalPassword(password) {
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (typeof password !== 'string' || !/^[^\x00-\x1f\x7f]{1,128}$/.test(password)) {
    throw new CredentialError('password must be 1-128 characters with no control characters', 'invalid_password');
  }
  return password;
}

// An INJECTION boundary, not a strength rule: generatePassword() decides strength. Kept from when
// these values were interpolated into a shell string, because a hand-typed password still reaches a
// command line in the operator CLI.
const PASSWORD_SAFE = /^[A-Za-z0-9_-]{16,128}$/;

export function assertSafePassword(password) {
  if (typeof password !== 'string' || !PASSWORD_SAFE.test(password)) {
    throw new CredentialError(
      'password must be 16-128 characters of base64url ([A-Za-z0-9_-]). This is an injection '
      + 'boundary, not a strength policy: the value is passed to mosquitto_passwd through a shell.',
      'invalid_password',
    );
  }
  return password;
}
