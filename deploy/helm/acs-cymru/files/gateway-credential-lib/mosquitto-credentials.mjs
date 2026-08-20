/**
 * The one implementation of "add a gateway account to a Mosquitto password file".
 *
 * WHY THIS FILE EXISTS. Two things now issue broker credentials -- the operator CLI
 * (scripts/mosquitto-provision-gateway.mjs) and the enrolment service
 * (scripts/gateway-credential-service.mjs) -- and they run in different places against different
 * transports: `docker exec` and `kubectl` for the first, a mounted volume and the Kubernetes API
 * for the second. What they must NOT differ on is the merge: which lines survive, which line is
 * replaced, and what the file looks like afterwards.
 *
 * That is the part where this repository has already been burned. `mosquitto_passwd -b -c` CREATES
 * the file and discards everything in it, and a one-shot that re-ran with `-c` deleted every
 * gateway credential issued since boot -- invisibly, because Mosquitto keeps authenticated accounts
 * in memory and only notices at the next reload. See the mosquitto-init header in
 * docker-compose.yml for the full account of that failure.
 *
 * So the merge lives here, once, as a PURE FUNCTION over strings with no I/O, and both callers use
 * it. It is the only part of credential issuance that is unit-tested, because it is the only part
 * whose failure is silent.
 *
 * ---------------------------------------------------------------------------------------------
 * THE INVARIANT, STATED AS CODE RATHER THAN AS A COMMENT.
 *
 * `mergeCredential()` THROWS if its output would hold fewer accounts than its input, other than the
 * single account being replaced. A comment saying "never truncate" is advice; this is a check that
 * fires before anything is written. Every path that produces a password file goes through it.
 *
 * `-c` IS NEVER PASSED TO A FILE THAT MATTERS. Both callers hash into a scratch file that holds
 * exactly one account -- where `-c` is correct and required -- and then merge that one line in
 * here. The real password file is only ever written whole, from a value this function returned.
 */
import { randomBytes } from 'node:crypto';

/**
 * 'gwy' plus 21 lowercase hex characters.
 *
 * Mirrors the GENERATED column in 0001_baseline_schema.sql
 * ('gwy' || substr(encode(uuid_send(id),'hex'),1,21)) and, more importantly, mirrors what
 * mosquitto.acl's `pattern readwrite spBv1.0/+/+/%u/#` compares against. A username that is not a
 * real edge-node id produces an account confined to a subtree nothing will ever publish to -- which
 * authenticates perfectly and then drops every message, at 3am.
 */
export const GATEWAY_ID_PATTERN = /^gwy[0-9a-f]{21}$/;

/** Where both deployment targets keep the file. mosquitto.conf names this path for both. */
export const PASSWORD_FILE = '/mosquitto/config/password_file';

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

/**
 * The usernames a password file declares, in order.
 *
 * Blank lines are ignored. A line with no colon is NOT ignored -- it is returned as-is so
 * mergeCredential's count check sees it, because a corrupted file is a thing to preserve and refuse
 * to write over, not a thing to quietly tidy up.
 */
export function accountsIn(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(':');
      return colon === -1 ? line : line.slice(0, colon);
    });
}

/**
 * Validate one line of mosquitto_passwd output before it is allowed near the real file.
 *
 * mosquitto_passwd writes `<username>:$7$<iterations>$<salt>$<hash>`. Checking the shape here is
 * what stops an error message, an empty string or a multi-line dump being merged in as though it
 * were an account -- each of which would produce a file the broker rejects wholesale, taking every
 * OTHER gateway down with it.
 */
export function assertEntry(entry, sparkplugId) {
  const line = String(entry || '').trim();

  if (!line.startsWith(`${sparkplugId}:`)) {
    throw new CredentialError(
      `mosquitto_passwd produced a line for a different account (expected '${sparkplugId}:...'), `
      + `refusing to merge it: ${line.slice(0, 120)}`,
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
 * Merge one account into a password file's contents.
 *
 * REPLACES rather than appends when the account already exists. Mosquitto reads the FIRST match, so
 * appending a second line for the same username silently pins the OLD password -- the rotation
 * reports success and changes nothing.
 *
 * Returns the complete new contents; the caller writes them. Nothing here touches a filesystem or a
 * cluster, which is what makes the invariant below testable without either.
 *
 * @param {string} existing  current file contents ('' when there is no file yet)
 * @param {string} entry     one validated mosquitto_passwd line
 * @returns {{contents: string, replaced: boolean, accounts: string[]}}
 */
export function mergeCredential(existing, entry) {
  const line = String(entry).trim();
  const sparkplugId = line.slice(0, line.indexOf(':'));
  if (!sparkplugId) {
    throw new CredentialError('entry has no username', 'hash_mismatch');
  }

  const before = accountsIn(existing);
  const kept = String(existing || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith(`${sparkplugId}:`));

  const replaced = kept.length !== before.length;
  const contents = `${[...kept, line].join('\n')}\n`;
  const after = accountsIn(contents);

  // ---------------------------------------------------------------------------------------------
  // THE NO-TRUNCATION CHECK. Every account present before must still be present after, and the only
  // permitted change to the SET of accounts is the addition of this one.
  //
  // It is deliberately a comparison of sets rather than of counts: a count check passes if one
  // account is dropped while another is duplicated, which is precisely what an appending bug looks
  // like. `expected` is what the caller asked for; anything else is a bug in the lines above, and
  // writing the result would be worse than failing here.
  // ---------------------------------------------------------------------------------------------
  const expected = new Set([...before, sparkplugId]);
  const actual = new Set(after);
  const lost = [...expected].filter((u) => !actual.has(u));
  const gained = [...actual].filter((u) => !expected.has(u));

  if (lost.length || gained.length) {
    throw new CredentialError(
      'refusing to write a password file that would '
      + `${lost.length ? `LOSE account(s) ${lost.join(', ')}` : ''}`
      + `${lost.length && gained.length ? ' and ' : ''}`
      + `${gained.length ? `invent account(s) ${gained.join(', ')}` : ''}. `
      + 'This is the truncation guard in scripts/lib/mosquitto-credentials.mjs; it fires before '
      + 'anything is written, because a password file that loses accounts fails silently until the '
      + 'broker next reloads.',
      'merge_would_lose_accounts',
    );
  }

  // Duplicate usernames in the INPUT survive as duplicates in `kept` only if they belong to other
  // accounts, which is a pre-existing corruption this function is not entitled to fix silently. It
  // is reported instead, because the broker resolves a duplicate to whichever line comes first.
  if (after.length !== actual.size) {
    throw new CredentialError(
      'the existing password file contains duplicate usernames; refusing to rewrite it. '
      + 'Mosquitto resolves a duplicate to the FIRST match, so which credential is live depends on '
      + 'line order. Repair the file by hand.',
      'duplicate_accounts',
    );
  }

  return { contents, replaced, accounts: after };
}

/**
 * The shell fragment that hashes ONE account into a scratch file and prints it.
 *
 * Shared so the CLI's `kubectl exec` path and the service's local path cannot drift on the one
 * detail that matters: `-c` is applied to `$tmp`, a file created by mktemp for this purpose and
 * holding exactly one account. It is never applied to the real password file.
 *
 * NO INTERPOLATION AT ALL -- the id and the password arrive as POSITIONAL PARAMETERS, `$1` and
 * `$2`, supplied by hashArgv() below. They used to be interpolated into this string inside single
 * quotes, which was safe only because assertGatewayId() and assertSafePassword() reject every
 * character that could close one. That reasoning held, and it made the allow-lists the sole thing
 * between an argument and a shell: correct today, and one loosened regex away from not being.
 * Positional parameters are not parsed as script text at all, so the allow-lists become
 * defence in depth rather than the defence.
 *
 * Constant, and therefore argument-free: there is nothing left in it that varies per account.
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
 * The full `/bin/sh` argument vector for hashing one account.
 *
 * `['-c', script, '--', id, password]`: `sh -c` assigns the first operand after the script to
 * `$0`, so the `--` is consumed there and the two real values land on `$1` and `$2`. Without it
 * the id would become `$0` and the script would hash a password against nothing.
 *
 * Both backends build their command from this one function, which is what keeps the CLI's
 * `kubectl exec` path and the service's local `execFileSync` path from drifting on the calling
 * convention now that there is one to get wrong. Validation stays here -- an invalid argument
 * should never reach a process at all, positional or not.
 */
export function hashArgv(sparkplugId, password) {
  assertGatewayId(sparkplugId);
  assertSafePassword(password);
  return ['-c', hashScript(), '--', sparkplugId, password];
}

/**
 * base64url only, 16-128 characters.
 *
 * NOT a strength rule -- generatePassword() decides strength. This is an INJECTION boundary: these
 * values are interpolated into the shell fragment above, so the alphabet is restricted to
 * characters that cannot terminate a single-quoted string. A caller supplying its own password
 * (the enrolment service does not, but the CLI accepts one) is held to the same alphabet rather
 * than trusted.
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
