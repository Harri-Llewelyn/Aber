/**
 * Unit tests for the credential merge.
 *
 * `node --test scripts/lib/` -- the built-in runner, no dependency, because this file has to be
 * runnable in CI before `npm install` the same way check-docs-drift.mjs is.
 *
 * WHY THIS IS THE ONE PIECE WITH UNIT TESTS. Everything else in credential issuance fails loudly:
 * a bad kubeconfig, an unreachable broker, a container that is not running. The merge fails
 * SILENTLY -- a password file that lost an account is a valid password file, and Mosquitto keeps
 * the authenticated accounts in memory, so nothing goes wrong until the next reload, which may be
 * days later and will look like a broker fault rather than a provisioning one.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  GATEWAY_ID_PATTERN,
  CredentialError,
  accountsIn,
  assertEntry,
  assertGatewayId,
  assertSafePassword,
  generatePassword,
  hashArgv,
  hashScript,
  mergeCredential,
} from './mosquitto-credentials.mjs';

/** A realistically-shaped mosquitto_passwd 2.0.x line. */
const entryFor = (user, salt = 'c2FsdHNhbHQ=') =>
  `${user}:$7$101$${salt}$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==`;

const GW_A = 'gwy120000000000400080000';
const GW_B = 'gwy130000000000400080000';
const GW_C = 'gwy140000000000400080000';

const PLATFORM = [
  'factoryplus_ingestion:$7$101$YWJj$ZGVm',
  'factoryplus_i3x:$7$101$YWJj$ZGVm',
  'factoryplus_monitor:$7$101$YWJj$ZGVm',
].join('\n');

describe('mergeCredential', () => {
  test('appends a new account and keeps every existing one', () => {
    const existing = `${PLATFORM}\n${entryFor(GW_A)}\n`;
    const { contents, replaced, accounts } = mergeCredential(existing, entryFor(GW_B));

    assert.equal(replaced, false);
    assert.deepEqual(accounts, [
      'factoryplus_ingestion', 'factoryplus_i3x', 'factoryplus_monitor', GW_A, GW_B,
    ]);
    // The literal property the whole file exists for.
    for (const account of accountsIn(existing)) {
      assert.ok(contents.includes(`${account}:`), `${account} was dropped`);
    }
  });

  test('REPLACES an existing account rather than appending a second line', () => {
    // Mosquitto reads the FIRST match, so an appended duplicate silently pins the OLD password:
    // the rotation reports success and changes nothing.
    const existing = `${PLATFORM}\n${entryFor(GW_A, 'b2xkc2FsdA==')}\n`;
    const fresh = entryFor(GW_A, 'bmV3c2FsdA==');
    const { contents, replaced, accounts } = mergeCredential(existing, fresh);

    assert.equal(replaced, true);
    assert.equal(accounts.filter((a) => a === GW_A).length, 1, 'the account was duplicated');
    assert.ok(contents.includes('bmV3c2FsdA=='), 'the new hash is absent');
    assert.ok(!contents.includes('b2xkc2FsdA=='), 'the old hash survived');
  });

  test('creates the first account from empty contents', () => {
    for (const empty of ['', '\n', '   \n\n']) {
      const { contents, replaced, accounts } = mergeCredential(empty, entryFor(GW_A));
      assert.equal(replaced, false);
      assert.deepEqual(accounts, [GW_A]);
      assert.equal(contents, `${entryFor(GW_A)}\n`);
    }
  });

  test('always ends with exactly one trailing newline', () => {
    // mosquitto_passwd is tolerant, but a file whose last line has no terminator has been reported
    // to lose that account on some builds -- and a file with blank lines in the middle is a nuisance
    // to diff during an incident.
    for (const existing of ['', PLATFORM, `${PLATFORM}\n`, `${PLATFORM}\n\n\n`]) {
      const { contents } = mergeCredential(existing, entryFor(GW_A));
      assert.ok(contents.endsWith('\n'));
      assert.ok(!contents.endsWith('\n\n'));
      assert.ok(!contents.includes('\n\n'), 'blank line in the middle of the file');
    }
  });

  test('preserves account order, appending the new one last', () => {
    const existing = [entryFor(GW_A), entryFor(GW_B)].join('\n');
    const { accounts } = mergeCredential(existing, entryFor(GW_C));
    assert.deepEqual(accounts, [GW_A, GW_B, GW_C]);
  });

  test('a replaced account moves to the end, and that is harmless', () => {
    // Stated as a test so the behaviour is deliberate rather than incidental: order carries no
    // meaning to Mosquitto UNLESS there are duplicates, and duplicates are refused below.
    const existing = [entryFor(GW_A), entryFor(GW_B)].join('\n');
    const { accounts } = mergeCredential(existing, entryFor(GW_A, 'bmV3'));
    assert.deepEqual(accounts, [GW_B, GW_A]);
  });

  test('scales to a fleet without losing anyone', () => {
    const fleet = Array.from({ length: 250 }, (_, i) =>
      entryFor(`gwy${i.toString(16).padStart(21, '0')}`));
    const existing = fleet.join('\n');
    const { accounts } = mergeCredential(existing, entryFor(GW_A));
    assert.equal(accounts.length, 251);
  });

  test('refuses a file containing duplicate usernames instead of silently repairing it', () => {
    // Which credential is live depends on line order, so this is a repair decision an operator
    // must make -- not one a provisioning call should make on their behalf mid-incident.
    const existing = [entryFor(GW_B, 'b25l'), entryFor(GW_B, 'dHdv')].join('\n');
    assert.throws(
      () => mergeCredential(existing, entryFor(GW_A)),
      (err) => err instanceof CredentialError && err.code === 'duplicate_accounts',
    );
  });

  test('rejects an entry with no username', () => {
    assert.throws(() => mergeCredential(PLATFORM, ':$7$101$a$b'), CredentialError);
  });
});

describe('assertEntry', () => {
  test('accepts a well-formed $7$ line', () => {
    assert.equal(assertEntry(`${entryFor(GW_A)}\n`, GW_A), entryFor(GW_A));
  });

  test('rejects a line for a different account', () => {
    // The failure this prevents: hashing succeeded for the wrong user and the merge would then add
    // an account nobody asked for while leaving the requested gateway unable to connect.
    assert.throws(
      () => assertEntry(entryFor(GW_B), GW_A),
      (err) => err.code === 'hash_mismatch',
    );
  });

  test('rejects an UNHASHED entry', () => {
    // Mosquitto accepts a plaintext password file, so this would work -- and would be a stored
    // credential in a file that exists to not hold one.
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

  test('rejects anything the ACL could not confine', () => {
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

describe('assertSafePassword', () => {
  test('accepts what generatePassword produces', () => {
    for (let i = 0; i < 50; i += 1) {
      const pw = generatePassword();
      assert.equal(assertSafePassword(pw), pw);
    }
  });

  test('rejects shell metacharacters', () => {
    // The boundary that makes hashScript's single-quote interpolation safe rather than merely
    // conventional. A quote here would end the quoted string and hand the rest to the shell.
    for (const bad of ["a'; rm -rf /; '", 'has spaces here!!', 'back`tick`valuehere', 'sh0rt', '$(id)aaaaaaaaaaaa']) {
      assert.throws(() => assertSafePassword(bad), CredentialError, `accepted ${bad}`);
    }
  });
});

describe('hashScript', () => {
  test('applies -c to a scratch file and never to the real one', () => {
    const script = hashScript();
    assert.match(script, /mosquitto_passwd -b -c "\$tmp"/);
    assert.ok(!script.includes('/mosquitto/config/password_file'));
    assert.match(script, /^set -e/);
  });

  test('takes its account from positional parameters, never from interpolation', () => {
    // The whole point of the change: the script text is a CONSTANT. If a future edit puts a
    // value back into it, this fails -- which is the only way to notice, since an interpolated
    // script keeps working perfectly right up until an argument contains a quote.
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

  test('a shell-hostile value would be inert even if the allow-lists let it through', () => {
    // Not a claim that they do -- the case above proves they do not. This pins the SECOND line
    // of defence the positional form adds: whatever reaches argv is data to `sh`, not script.
    const argv = hashArgv(GW_A, generatePassword());
    assert.ok(!argv[1].includes(GW_A), 'the id must not appear in the script text');
  });
});
