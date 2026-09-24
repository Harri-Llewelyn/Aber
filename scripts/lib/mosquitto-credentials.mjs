/**
 * What every issuer of a broker credential shares: the gateway id shape, the password alphabet, the
 * password generator, the hashing argv, and the playback delivery store. Pure functions over
 * strings with no I/O, used by the boot reconcile, the credential service, the operator CLI and
 * the tests. The policy itself is in mosquitto-dynsec.mjs.
 */
import { randomBytes } from 'node:crypto';

/**
 * 'gwy' plus 21 lowercase hex characters.
 *
 * Mirrors the GENERATED column in 0001_baseline_schema.sql
 * ('gwy' || substr(encode(uuid_send(id),'hex'),1,21)) and, more importantly, what the broker
 * confines the account to: `spBv1.0/+/+/<username>/#`. A username that is not a real edge-node id
 * produces an account confined to a subtree nothing will ever publish to -- which authenticates
 * perfectly and then drops every message, at 3am.
 */
export const GATEWAY_ID_PATTERN = /^gwy[0-9a-f]{21}$/;

/** A username mosquitto_passwd and the plugin both accept, for the platform principals. */
export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Where a playback target's password is delivered (0078).
 *
 * DECLARED ONCE AND IMPORTED BY BOTH ENDS, because a mismatch between the writer and the reader is
 * silent on both sides: gateway-credential writes successfully and playback_worker finds no file,
 * so the operator sees a credential issued cleanly and a worker that never picks it up. The Python
 * end cannot import this, so scripts/check-docs-drift.mjs asserts the two agree along with the two
 * mount paths that carry them.
 */
export const PLAYBACK_CREDENTIAL_FILE = '/var/lib/aber/playback/credentials.json';

/**
 * Fold one delivered credential into the map already held, keyed by `sparkplug_id`.
 *
 * MERGED, NOT OVERWRITTEN. A stack can have several playback targets and they are issued one at a
 * time, so writing a single-entry store would silently revoke delivery for every other target on
 * each issue -- and the symptom would arrive much later, as a playback refused for a gateway nobody
 * had touched.
 *
 * A MALFORMED STORE IS REPLACED RATHER THAN FATAL. By the time this runs the account already exists
 * at the broker and the password is about to be shown once; throwing here would strand a credential
 * nobody can use in order to preserve a file nobody can parse. `onWarn` is how the caller reports
 * that without this module knowing what a log is.
 */
export function mergeDelivery(existing, sparkplugId, password, onWarn = () => {}) {
  assertGatewayId(sparkplugId);
  assertSafePassword(password);

  let held = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // COERCED TO STRINGS, because this is read back by a Python worker that will hand the value
        // to paho as a password. A number or a null surviving a round trip through JSON would fail
        // at CONNECT with a broker refusal rather than here, where the cause is visible.
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

/** The delivery store's serialised form. Trailing newline so the file is a well-formed text file. */
export function serialiseDelivery(held) {
  return `${JSON.stringify(held, null, 2)}\n`;
}

/** Distinguishable from a programming error, so callers can map it to a 4xx rather than a 500. */
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

/**
 * 32 bytes of base64url.
 *
 * Long enough that the credential is not the weak link, and free of shell-hostile characters so it
 * can be pasted into a gateway config, an .env file or a YAML value without quoting games. Same
 * generator the CLI has always used -- moved, not changed.
 */
export function generatePassword() {
  return randomBytes(24).toString('base64url');
}

export function assertUsername(value) {
  if (typeof value !== 'string' || !USERNAME_PATTERN.test(value)) {
    throw new CredentialError(`'${value}' is not a usable MQTT username`, 'invalid_username');
  }
  return value;
}

/**
 * Validate one line of mosquitto_passwd output before its hash is transplanted into a client.
 *
 * mosquitto_passwd writes `<username>:$7$<iterations>$<salt>$<hash>`. Checking the shape here is
 * what stops an error message, an empty string or a multi-line dump being taken for an account.
 */
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
  // `$7$` is the PBKDF2-SHA512 format 2.0.x writes. Asserted rather than assumed: a plaintext
  // password file is also syntactically valid to Mosquitto when `allow_anonymous false` is set with
  // no hashing, so a silently unhashed entry would work and would be a stored credential.
  if (!/^[^:]+:\$7\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(line)) {
    throw new CredentialError(
      `mosquitto_passwd output is not a $7$ (PBKDF2-SHA512) entry: ${line.slice(0, 120)}`,
      'hash_mismatch',
    );
  }
  return line;
}

/**
 * The shell fragment that hashes ONE account into a scratch file and prints it.
 *
 * `-c` is applied to `$tmp`, a file created by mktemp for this purpose and holding exactly one
 * account; the line is read back and the file removed. The username and the password arrive as
 * POSITIONAL PARAMETERS, `$1` and `$2`, supplied by hashArgv() below, so nothing parses them as
 * script text and the allow-lists are defence in depth rather than the defence. Constant, and
 * therefore argument-free.
 */
export function hashScript() {
  return [
    'set -e',
    'tmp=$(mktemp)',
    'mosquitto_passwd -b -c "$tmp" "$1" "$2"',
    'cat "$tmp"',
    'rm -f "$tmp"',
  ].join('; ');
}

/**
 * The full `/bin/sh` argument vector for hashing one gateway account.
 *
 * `['-c', script, '--', id, password]`: `sh -c` assigns the first operand after the script to
 * `$0`, so the `--` is consumed there and the two real values land on `$1` and `$2`. Without it
 * the id would become `$0` and the script would hash a password against nothing. Validation stays
 * here: an invalid argument should never reach a process at all, positional or not.
 */
export function hashArgv(sparkplugId, password) {
  assertGatewayId(sparkplugId);
  assertSafePassword(password);
  return hashArgvForUsername(sparkplugId, password);
}

/**
 * The same vector for any username the broker accepts: the platform principals and the admin,
 * whose passwords are the operator's own values from the environment. They reach mosquitto_passwd
 * as a positional parameter and never a command line, so the rule is only that the value is text.
 */
export function hashArgvForUsername(username, password) {
  assertUsername(username);
  assertPrincipalPassword(password);
  return ['-c', hashScript(), '--', username, password];
}

/** A platform principal's password: non-empty printable text, at most 128 characters. */
export function assertPrincipalPassword(password) {
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (typeof password !== 'string' || !/^[^\x00-\x1f\x7f]{1,128}$/.test(password)) {
    throw new CredentialError('password must be 1-128 characters with no control characters', 'invalid_password');
  }
  return password;
}

/**
 * base64url only, 16-128 characters.
 *
 * NOT a strength rule -- generatePassword() decides strength. This is an INJECTION boundary kept
 * from when these values were interpolated into a shell string; they are positional now, and the
 * alphabet is kept because a hand-typed password still reaches a command line in the operator CLI.
 * A caller supplying its own password is held to it rather than trusted.
 */
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
