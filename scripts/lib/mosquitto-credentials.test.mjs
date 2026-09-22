/**
 * Unit tests for the credential helpers.
 *
 * `node --test scripts/lib/mosquitto-credentials.test.mjs` -- the built-in runner, no dependency,
 * because this file has to be runnable in CI before `npm install` the same way check-docs-drift.mjs
 * is. The hashing argv and the playback delivery store are the pieces whose failure is silent: a
 * hash for the wrong account authenticates nobody, and a delivery store that lost an entry is still
 * a valid delivery store.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  GATEWAY_ID_PATTERN,
  CredentialError,
  assertEntry,
  assertGatewayId,
  assertSafePassword,
  assertUsername,
  generatePassword,
  hashArgv,
  hashArgvForUsername,
  hashScript,
  mergeDelivery,
  serialiseDelivery,
  PLAYBACK_CREDENTIAL_FILE,
} from './mosquitto-credentials.mjs';

/** A realistically-shaped mosquitto_passwd 2.0.x line. */
const entryFor = (user, salt = 'c2FsdHNhbHQ=') =>
  `${user}:$7$101$${salt}$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==`;

const GW_A = 'gwy120000000000400080000';
const GW_B = 'gwy130000000000400080000';

describe('assertEntry', () => {
  test('accepts a well-formed $7$ line', () => {
    assert.equal(assertEntry(`${entryFor(GW_A)}\n`, GW_A), entryFor(GW_A));
  });

  test('rejects a line for a different account', () => {
    // The failure this prevents: hashing succeeded for the wrong user and the client written
    // would authenticate somebody else.
    assert.throws(
      () => assertEntry(entryFor(GW_B), GW_A),
      (err) => err.code === 'hash_mismatch',
    );
  });

  test('rejects an UNHASHED entry', () => {
    // mosquitto_passwd never writes one, so a plaintext line is a bug upstream and would be a
    // stored credential.
    assert.throws(() => assertEntry(`${GW_A}:hunter2`, GW_A), CredentialError);
  });

  test('rejects empty output and error text', () => {
    for (const bad of ['', '   ', 'Error: unable to open file']) {
      assert.throws(() => assertEntry(bad, GW_A), CredentialError);
    }
  });

  test('rejects multi-line output', () => {
    assert.throws(
      () => assertEntry(`${entryFor(GW_A)}\n${entryFor(GW_B)}`, GW_A),
      CredentialError,
    );
  });
});

describe('assertGatewayId', () => {
  test('accepts a real sparkplug_id', () => {
    assert.equal(assertGatewayId(GW_A), GW_A);
    assert.ok(GATEWAY_ID_PATTERN.test(GW_A));
  });

  test('rejects anything the broker could not confine', () => {
    for (const bad of [
      'val_gateway_01',            // friendly name -- fails at verify_gateway_binding() too
      'GWY120000000000400080000',  // uppercase hex
      'gwy1200000000004000800',    // too short
      'gwy1200000000004000800001', // too long
      'gwy12000000000040008000g',  // not hex
      '', null, undefined, 42, {},
    ]) {
      assert.throws(() => assertGatewayId(bad), CredentialError, `accepted ${String(bad)}`);
    }
  });
});

describe('assertUsername', () => {
  test('accepts the platform principals and refuses what a shell or the plugin would misread', () => {
    for (const ok of ['factoryplus_ingestion', 'dynsec-admin', GW_A, 'bi.reader']) {
      assert.equal(assertUsername(ok), ok);
    }
    for (const bad of ['', 'has space', "a'b", 'x'.repeat(65), null]) {
      assert.throws(() => assertUsername(bad), CredentialError, `accepted ${String(bad)}`);
    }
  });
});

describe('assertSafePassword', () => {
  test('accepts what generatePassword produces', () => {
    for (let i = 0; i < 50; i += 1) {
      const pw = generatePassword();
      assert.equal(assertSafePassword(pw), pw);
    }
  });

  test('rejects shell metacharacters', () => {
    for (const bad of ["a'; rm -rf /; '", 'has spaces here!!', 'back`tick`valuehere', 'sh0rt', '$(id)aaaaaaaaaaaa']) {
      assert.throws(() => assertSafePassword(bad), CredentialError, `accepted ${bad}`);
    }
  });
});

describe('hashScript', () => {
  test('applies -c to a scratch file only', () => {
    const script = hashScript();
    assert.match(script, /mosquitto_passwd -b -c "\$tmp"/);
    assert.ok(!script.includes('/mosquitto/'));
    assert.match(script, /^set -e/);
  });

  test('takes its account from positional parameters, never from interpolation', () => {
    // The script text is a CONSTANT. If a future edit puts a value back into it, this fails --
    // which is the only way to notice, since an interpolated script keeps working perfectly right
    // up until an argument contains a quote.
    const script = hashScript();
    assert.match(script, /mosquitto_passwd -b -c "\$tmp" "\$1" "\$2"/);
    assert.strictEqual(script, hashScript(), 'the script must not vary per account');
  });
});

describe('hashArgv', () => {
  test('puts the id and password on $1 and $2, behind a -- that absorbs $0', () => {
    const password = generatePassword();
    const argv = hashArgv(GW_A, password);
    assert.deepStrictEqual(argv, ['-c', hashScript(), '--', GW_A, password]);
    // `sh -c script name a b` assigns `name` to $0. Without the `--` the gateway id would land
    // there and the password would be hashed against nothing.
    assert.strictEqual(argv[2], '--');
  });

  test('validates its arguments before they reach a process at all', () => {
    assert.throws(() => hashArgv('not-a-gateway', generatePassword()), CredentialError);
    assert.throws(() => hashArgv(GW_A, "'; id; '"), CredentialError);
  });

  test('the platform form takes any broker username and any printable password', () => {
    const password = generatePassword();
    assert.deepStrictEqual(
      hashArgvForUsername('factoryplus_ingestion', password),
      ['-c', hashScript(), '--', 'factoryplus_ingestion', password],
    );
    assert.throws(() => hashArgvForUsername('has space', password), CredentialError);
    // An operator's own value: short and outside base64url is theirs to choose, because the
    // value is a positional parameter and never a command line.
    assert.equal(hashArgvForUsername('factoryplus_ingestion', 'aber123')[4], 'aber123');
    assert.equal(hashArgvForUsername('factoryplus_ingestion', "it's fine!")[4], "it's fine!");
    assert.throws(() => hashArgvForUsername('factoryplus_ingestion', ''), CredentialError);
    assert.throws(() => hashArgvForUsername('factoryplus_ingestion', 'has\nnewline'), CredentialError);
    // The gateway form keeps the stricter rule: its password can reach a command line in the CLI.
    assert.throws(() => hashArgv(GW_A, 'short'), CredentialError);
  });

  test('a shell-hostile value would be inert even if the allow-lists let it through', () => {
    // Pins the SECOND line of defence the positional form adds: whatever reaches argv is data to
    // `sh`, not script.
    const argv = hashArgv(GW_A, generatePassword());
    assert.ok(!argv[1].includes(GW_A), 'the id must not appear in the script text');
  });
});

/**
 * The playback delivery store (0078). A delivery store that lost an entry is a valid delivery
 * store, and the playback worker reads it every three seconds without complaint -- so a dropped
 * target surfaces days later as a job refused with "this worker holds no broker credential for ...".
 */
// Valid per assertSafePassword: 16-128 characters of base64url. Short, friendly fixtures like
// 'alpha' are REFUSED by it -- which is the guard working.
const ALPHA_PW = 'alpha-password-0000000000';
const BETA_PW  = 'beta-password-00000000000';
const OLD_PW   = 'old-password-000000000000';
const NEW_PW   = 'new-password-000000000000';

describe('mergeDelivery', () => {
  test('keeps every target already delivered', () => {
    const first = mergeDelivery('', GW_A, ALPHA_PW);
    const second = mergeDelivery(serialiseDelivery(first), GW_B, BETA_PW);
    assert.deepEqual(second, { [GW_A]: ALPHA_PW, [GW_B]: BETA_PW });
  });

  test('a re-issue replaces that target and disturbs no other', () => {
    const held = mergeDelivery(serialiseDelivery({ [GW_A]: OLD_PW, [GW_B]: BETA_PW }), GW_A, NEW_PW);
    assert.equal(held[GW_A], NEW_PW);
    assert.equal(held[GW_B], BETA_PW);
  });

  test('an unparseable store is replaced rather than throwing', () => {
    // The account exists at the broker by the time this runs and the password is about to be shown
    // once. Throwing would strand a credential nobody can use to preserve a file nobody can parse.
    const warnings = [];
    const held = mergeDelivery('{not json', GW_A, ALPHA_PW, (m) => warnings.push(m));
    assert.deepEqual(held, { [GW_A]: ALPHA_PW });
    assert.equal(warnings.length, 1);
  });

  test('a JSON array is not a delivery store', () => {
    const warnings = [];
    const held = mergeDelivery('["gwy1"]', GW_A, ALPHA_PW, (m) => warnings.push(m));
    assert.deepEqual(held, { [GW_A]: ALPHA_PW });
    assert.equal(warnings.length, 1);
  });

  test('values are coerced to strings for the Python end', () => {
    // paho hands the value straight to the broker as a password. A number surviving the round trip
    // fails at CONNECT, where the cause is a broker refusal rather than a type.
    const held = mergeDelivery(JSON.stringify({ [GW_B]: 1234567890123456 }), GW_A, ALPHA_PW);
    assert.equal(held[GW_B], '1234567890123456');
    assert.equal(typeof held[GW_B], 'string');
  });

  test('a null value is dropped rather than delivered as "null"', () => {
    const held = mergeDelivery(JSON.stringify({ [GW_B]: null }), GW_A, ALPHA_PW);
    assert.ok(!(GW_B in held));
  });

  test('the same validation as an issue, so a delivery cannot name a non-gateway', () => {
    assert.throws(() => mergeDelivery('', 'not-a-gateway', ALPHA_PW), CredentialError);
  });

  test('serialises as an object the worker can parse, with a trailing newline', () => {
    const text = serialiseDelivery(mergeDelivery('', GW_A, ALPHA_PW));
    assert.equal(text.at(-1), '\n');
    assert.deepEqual(JSON.parse(text), { [GW_A]: ALPHA_PW });
  });

  test('the delivery path is absolute and matches the mount the chart provides', () => {
    // playback_worker.py defaults to this same string, and the two cannot import from each other --
    // check-docs-drift.mjs is what holds them together. This pins the value it checks against.
    assert.equal(PLAYBACK_CREDENTIAL_FILE, '/var/lib/acs-cymru/playback/credentials.json');
  });
});
