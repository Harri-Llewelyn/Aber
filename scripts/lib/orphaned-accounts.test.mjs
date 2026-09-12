/**
 * Which broker accounts the orphan sweep would disable.
 *
 *     node --test scripts/lib/orphaned-accounts.test.mjs
 *
 * THE FILTER IS THE SAFETY PROPERTY, and it is why these two functions are exported rather than
 * inlined. `scripts/revoke-orphaned-broker-accounts.mjs` disables every account it selects. The
 * broker's client list also holds `factoryplus_ingestion`, `factoryplus_i3x`, `factoryplus_monitor`
 * and the plugin's admin -- platform accounts with no `gateways` row and no prospect of one -- so a
 * sweep keyed naively on "has no gateway row" would disable the ingestion daemon's own credential
 * and stop the stack ingesting anything. From the script whose subject is tidying up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAccounts, strays } from '../revoke-orphaned-broker-accounts.mjs';

const client = (username, extra = {}) => ({ username, roles: [], disabled: false, ...extra });

const CLIENTS = [
  client('dynsec-admin'),
  client('factoryplus_ingestion'),
  client('factoryplus_i3x'),
  client('gwy120000000000400080000'),
  client('factoryplus_monitor'),
  client('gwy2a71a14de1b04971bfbb5'),
];

test('platform service accounts are never candidates', () => {
  const accounts = parseAccounts(CLIENTS);
  assert.deepEqual(accounts, ['gwy120000000000400080000', 'gwy2a71a14de1b04971bfbb5']);
  // Named individually, because the cost of each one being swept is different and specific:
  // ingestion stops writing telemetry, i3X stops answering, monitoring goes blind, and nothing
  // can be issued or revoked without the admin.
  for (const service of ['dynsec-admin', 'factoryplus_ingestion', 'factoryplus_i3x', 'factoryplus_monitor']) {
    assert.ok(!accounts.includes(service), `${service} was selectable`);
  }
});

test('only a well-formed sparkplug id is selectable', () => {
  // The shape `gateways.sparkplug_id` generates and `revoke_gateway_credential()` validates. A
  // near-miss is not disabled on the guess that it was probably a gateway once.
  const accounts = parseAccounts([
    client('gwy120000000000400080000'),   // 3 + 21, valid
    client('gwyNOTHEX000000000000000'),   // right length, wrong alphabet
    client('gwy1200000000004000800'),     // too short
    client('gwy1200000000004000800001'),  // too long
    client('gateway-cell-1'),
  ]);
  assert.deepEqual(accounts, ['gwy120000000000400080000']);
});

test('an account already disabled is not listed again', () => {
  const accounts = parseAccounts([
    client('gwy120000000000400080000', { disabled: true }),
    client('gwy2a71a14de1b04971bfbb5'),
  ]);
  assert.deepEqual(accounts, ['gwy2a71a14de1b04971bfbb5']);
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
  // the trigger and the pg_cron sweep, and disabling it from the host as well would be a second
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
