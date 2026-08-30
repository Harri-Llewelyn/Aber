// =================================================================================================
// scripts/lib/env-fold.mjs
//
// The cases worth pinning are the ones whose failure is INVISIBLE AT THE TIME. A bug here does not
// surface during the reset -- it surfaces minutes later as four gateways failing to authenticate
// with no CONNACK code, which reads as a broker problem and is not one.
// =================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldGatewayCredentials } from './env-fold.mjs';

const ENV = [
  'POSTGRES_PASSWORD=keepme',
  'SUPABASE_JWT_SECRET=alsokeepme',
  'MQTT_GW_CNC_MACHINING_USER=gwy120000000000400080000',
  'MQTT_GW_CNC_MACHINING_PASSWORD=old-secret',
  'GRAFANA_ADMIN_PASSWORD=keepme-too',
].join('\n');

const GATEWAYS = [
  '# written by provision-gateways.mjs',
  'MQTT_GW_CNC_MACHINING_USER=gwy120000000000400080000',
  'MQTT_GW_CNC_MACHINING_PASSWORD=new-secret',
].join('\n');

test('replaces a gateway credential in place rather than appending a second one', () => {
  // THE DEFECT THIS WHOLE FUNCTION GUARDS. A duplicate assignment is resolved differently by docker
  // compose and by a shell that sources the file, so the two would disagree about which credential
  // is live -- and the reset would report success either way.
  const { text, replaced, added } = foldGatewayCredentials(ENV, GATEWAYS);

  assert.equal(text.match(/^MQTT_GW_CNC_MACHINING_PASSWORD=/gm).length, 1);
  assert.match(text, /^MQTT_GW_CNC_MACHINING_PASSWORD=new-secret$/m);
  assert.doesNotMatch(text, /old-secret/);
  assert.deepEqual(replaced.sort(), ['MQTT_GW_CNC_MACHINING_PASSWORD', 'MQTT_GW_CNC_MACHINING_USER']);
  assert.deepEqual(added, []);
});

test('leaves every non-gateway line untouched', () => {
  // It is handed a file holding the database passwords, the JWT secret and the service keys. The
  // narrow key pattern is what keeps this a credential fold rather than a merge.
  const { text } = foldGatewayCredentials(ENV, GATEWAYS);
  assert.match(text, /^POSTGRES_PASSWORD=keepme$/m);
  assert.match(text, /^SUPABASE_JWT_SECRET=alsokeepme$/m);
  assert.match(text, /^GRAFANA_ADMIN_PASSWORD=keepme-too$/m);
});

test('preserves line order, so a hand-annotated .env survives a reset', () => {
  const { text } = foldGatewayCredentials(ENV, GATEWAYS);
  const keys = text.split('\n').map(l => l.split('=')[0]);
  assert.deepEqual(keys, [
    'POSTGRES_PASSWORD',
    'SUPABASE_JWT_SECRET',
    'MQTT_GW_CNC_MACHINING_USER',
    'MQTT_GW_CNC_MACHINING_PASSWORD',
    'GRAFANA_ADMIN_PASSWORD',
  ]);
});

test('appends a gateway .env has never seen', () => {
  const { text, replaced, added } = foldGatewayCredentials(
    ENV,
    'MQTT_GW_NEW_CELL_PASSWORD=brand-new'
  );
  assert.match(text, /^MQTT_GW_NEW_CELL_PASSWORD=brand-new$/m);
  assert.deepEqual(replaced, []);
  assert.deepEqual(added, ['MQTT_GW_NEW_CELL_PASSWORD']);
});

test('rewrites EVERY occurrence when .env holds a key twice', () => {
  // Strictly worse than either outcome alone: one new value and one stale one means which wins
  // depends on who reads the file, and the two readers disagree.
  const doubled = 'MQTT_GW_A_PASSWORD=one\nOTHER=x\nMQTT_GW_A_PASSWORD=two';
  const { text, replaced } = foldGatewayCredentials(doubled, 'MQTT_GW_A_PASSWORD=fresh');
  assert.equal(text.match(/=fresh$/gm).length, 2);
  assert.doesNotMatch(text, /=one|=two/);
  // Reported once: it is one key, however many lines carried it.
  assert.deepEqual(replaced, ['MQTT_GW_A_PASSWORD']);
});

test('takes the later value when .env.gateways holds a key twice', () => {
  // Matches what a shell sourcing the file would do, and what the awk this replaces did.
  const { text } = foldGatewayCredentials('MQTT_GW_A_PASSWORD=old', 'MQTT_GW_A_PASSWORD=first\nMQTT_GW_A_PASSWORD=second');
  assert.match(text, /^MQTT_GW_A_PASSWORD=second$/m);
});

test('ignores comments and blank lines in .env.gateways', () => {
  const { added } = foldGatewayCredentials('X=1', '# a comment\n\n  \nMQTT_GW_B_USER=u');
  assert.deepEqual(added, ['MQTT_GW_B_USER']);
});

test('does not match a key that merely contains the prefix', () => {
  // `# MQTT_GW_...` in a comment and `X_MQTT_GW_A_PASSWORD` are both anchored out. A fold that
  // rewrote a commented-out line would resurrect a credential somebody deliberately disabled.
  const { replaced, added, text } = foldGatewayCredentials(
    '# MQTT_GW_A_PASSWORD=commented\nX_MQTT_GW_A_PASSWORD=prefixed',
    'MQTT_GW_A_PASSWORD=fresh'
  );
  assert.deepEqual(replaced, []);
  assert.deepEqual(added, ['MQTT_GW_A_PASSWORD']);
  assert.match(text, /^# MQTT_GW_A_PASSWORD=commented$/m);
  assert.match(text, /^X_MQTT_GW_A_PASSWORD=prefixed$/m);
});

test('handles CRLF input, which is what a Windows editor leaves behind', () => {
  // The platform this port exists for. Splitting on \n alone would leave a trailing \r inside every
  // value, so a password would come out with an invisible character appended.
  const { text, replaced } = foldGatewayCredentials(
    'A=1\r\nMQTT_GW_A_PASSWORD=old\r\nB=2',
    'MQTT_GW_A_PASSWORD=fresh\r\n'
  );
  assert.deepEqual(replaced, ['MQTT_GW_A_PASSWORD']);
  assert.match(text, /^MQTT_GW_A_PASSWORD=fresh$/m);
  assert.doesNotMatch(text, /\r/);
});

test('an empty .env.gateways changes nothing and reports nothing', () => {
  // The signal stack-reset.mjs prints a warning for: it is indistinguishable from success by
  // looking at the file, and it means Node-RED keeps credentials the rebuilt broker does not know.
  const { text, replaced, added } = foldGatewayCredentials(ENV, '');
  assert.equal(text, ENV);
  assert.deepEqual(replaced, []);
  assert.deepEqual(added, []);
});

test('survives null and undefined rather than throwing mid-reset', () => {
  // It runs after the volumes are already gone. Throwing here would abandon a stack between
  // teardown and a working state, which is the failure mode the whole port is about.
  assert.equal(foldGatewayCredentials(null, null).text, '');
  assert.equal(foldGatewayCredentials('A=1', undefined).text, 'A=1');
});
