/**
 * Which broker accounts the orphan sweep would rotate.
 *
 *     node --test scripts/lib/orphaned-accounts.test.mjs
 *
 * THE FILTER IS THE SAFETY PROPERTY, and it is why these two functions are exported rather than
 * inlined. `scripts/revoke-orphaned-broker-accounts.mjs` rotates every account it selects to a
 * password nobody records, irreversibly. The password file also holds `factoryplus_ingestion`,
 * `factoryplus_i3x` and `factoryplus_monitor` -- platform services with no `gateways` row and no
 * prospect of one -- so a sweep keyed naively on "has no gateway row" would revoke the ingestion
 * daemon's own credential and stop the stack ingesting anything. From the script whose subject is
 * tidying up.
 *
 * That failure needs no database, no broker and no network to test, which is exactly why it should
 * be tested here rather than discovered on a stack.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAccounts, strays } from '../revoke-orphaned-broker-accounts.mjs';

const PASSWORD_FILE = [
  'factoryplus_ingestion:$7$101$abc',
  'factoryplus_i3x:$7$101$def',
  'gwy120000000000400080000:$7$101$ghi',
  'factoryplus_monitor:$7$101$jkl',
  'gwy2a71a14de1b04971bfbb5:$7$101$mno',
  '',
].join('\n');

test('platform service accounts are never candidates', () => {
  const accounts = parseAccounts(PASSWORD_FILE);
  assert.deepEqual(accounts, ['gwy120000000000400080000', 'gwy2a71a14de1b04971bfbb5']);
  // Named individually, because the cost of each one being swept is different and specific:
  // ingestion stops writing telemetry, i3X stops answering, monitoring goes blind.
  for (const service of ['factoryplus_ingestion', 'factoryplus_i3x', 'factoryplus_monitor']) {
    assert.ok(!accounts.includes(service), `${service} was selectable`);
  }
});

test('only a well-formed sparkplug id is selectable', () => {
  // The shape `gateways.sparkplug_id` generates and `revoke_gateway_credential()` validates. A
  // near-miss is not rotated on the guess that it was probably a gateway once.
  const accounts = parseAccounts([
    'gwy120000000000400080000:x',   // 3 + 21, valid
    'gwyNOTHEX000000000000000:x',   // right length, wrong alphabet
    'gwy1200000000004000800:x',     // too short
    'gwy1200000000004000800001:x',  // too long
    'gateway-cell-1:x',
  ].join('\n'));
  assert.deepEqual(accounts, ['gwy120000000000400080000']);
});

test('an account whose gateway still exists is left alone', () => {
  const accounts = ['gwy120000000000400080000', 'gwy2a71a14de1b04971bfbb5'];
  assert.deepEqual(
    strays(accounts, ['gwy120000000000400080000']),
    ['gwy2a71a14de1b04971bfbb5']
  );
});

test('an ARCHIVED gateway is still a gateway, so its account is not a stray', () => {
  // The script asks for every row, archived included: an archived gateway's credential belongs to
  // 0063's trigger and the pg_cron sweep, and rotating it from the host as well would be a second
  // mechanism racing the first over `credential_revoked_at`.
  const accounts = ['gwy120000000000400080000'];
  assert.deepEqual(strays(accounts, ['gwy120000000000400080000']), []);
});

test('nothing at the broker means nothing to do', () => {
  assert.deepEqual(strays([], ['gwy120000000000400080000']), []);
});

test('no gateways at all makes every gateway account a stray', () => {
  // A stack whose rows were wiped without the broker being touched -- `docker compose down -v` on
  // the database volume alone, which is a real thing to do by accident.
  const accounts = ['gwy120000000000400080000', 'gwy2a71a14de1b04971bfbb5'];
  assert.deepEqual(strays(accounts, []), accounts);
});
