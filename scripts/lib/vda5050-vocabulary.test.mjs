import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCLUDED, KEPT, vda5050SemanticId, vocabularyRows, walkState } from './vda5050-vocabulary.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'scripts/vocabularies/vda5050-3.0.0-state.schema'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

test('the walk finds every scalar leaf of the state message, and enters no array', () => {
  const { leaves, arrays } = walkState(SCHEMA);
  assert.deepEqual([...leaves.keys()].sort(), [...KEPT, ...Object.keys(EXCLUDED)].sort());
  for (const array of ['loads', 'errors', 'actionStates', 'nodeStates', 'edgeStates', 'information']) {
    assert.ok(arrays.includes(array), array);
  }
  assert.ok([...leaves.keys()].every(path => !arrays.some(array => path.startsWith(`${array}.`))));
});

test('the rows are the 24 fields the issue lists, with the schema\'s type, description and enum', () => {
  const rows = vocabularyRows(SCHEMA);
  const byName = Object.fromEntries(rows.map(row => [row.name, row]));
  assert.equal(rows.length, 24);
  assert.deepEqual(rows.map(row => row.name), [...KEPT].sort((a, b) => a.localeCompare(b)));

  assert.equal(byName['powerSupply.stateOfCharge'].datatype, 'Double');
  assert.equal(byName['powerSupply.charging'].datatype, 'Boolean');
  assert.equal(byName.lastNodeId.datatype, 'String');
  assert.deepEqual(byName.operatingMode.permittedValues,
    ['STARTUP', 'AUTOMATIC', 'SEMIAUTOMATIC', 'INTERVENED', 'MANUAL', 'SERVICE', 'TEACH_IN']);
  assert.deepEqual(byName['safetyState.activeEmergencyStop'].permittedValues, ['MANUAL', 'REMOTE', 'NONE']);
  assert.equal(byName.driving.permittedValues, null);
  assert.match(byName.driving.description, /^True: indicates that the mobile robot is driving and\/or rotating\./);
  assert.ok(rows.every(row => row.description === null || !/\s{2}|\n/.test(row.description)), 'one line each');
});

test('a field the schema gives no description has none, and the unit is the schema\'s own', () => {
  const byName = Object.fromEntries(vocabularyRows(SCHEMA).map(row => [row.name, row]));
  for (const name of ['mobileRobotPosition.x', 'mobileRobotPosition.y', 'mobileRobotPosition.theta']) {
    assert.equal(byName[name].description, null, name);
  }
  assert.equal(byName['velocity.vx'].unit, 'm/s');
  assert.equal(byName['velocity.omega'].unit, 'rad/s');
  assert.equal(byName['mobileRobotPosition.theta'].unit, 'rad');
  assert.equal(byName.driving.unit, null);
});

test('no row is the message header, the order flow or an array', () => {
  const names = vocabularyRows(SCHEMA).map(row => row.name);
  for (const left of ['headerId', 'timestamp', 'version', 'manufacturer', 'serialNumber',
                      'orderId', 'orderUpdateId', 'loads', 'errors', 'actionStates', 'nodeStates']) {
    assert.ok(!names.includes(left), left);
  }
});

test('an id is minted under aber.local, pinned to the major line, scoped by the message', () => {
  assert.equal(vda5050SemanticId('powerSupply.stateOfCharge'),
    'https://aber.local/semantics/vda5050/v3.0/State/powerSupply.stateOfCharge');
});

test('a kept path that is an array, or no longer a leaf, stops the build', () => {
  const schema = clone(SCHEMA);
  schema.properties.driving = { type: 'array', items: { type: 'boolean' } };
  assert.throws(() => vocabularyRows(schema), /is an array/);

  const renamed = clone(SCHEMA);
  delete renamed.properties.paused;
  assert.throws(() => vocabularyRows(renamed), /paused is kept and is not a scalar leaf/);
});

test('a leaf nobody has decided on stops the build, so a release that adds a field is read', () => {
  const schema = clone(SCHEMA);
  schema.definitions.powerSupply.properties.cycleCount = { type: 'integer', description: 'new in a later release' };
  assert.throws(() => vocabularyRows(schema), /no decision for: powerSupply\.cycleCount/);
});

test('a type the walk does not read, or a composition, stops the build', () => {
  const nullable = clone(SCHEMA);
  nullable.properties.driving = { type: ['boolean', 'null'] };
  assert.throws(() => vocabularyRows(nullable), /is not one of/);

  const composed = clone(SCHEMA);
  composed.properties.driving = { oneOf: [{ type: 'boolean' }, { type: 'string' }] };
  assert.throws(() => vocabularyRows(composed), /oneOf is not read/);

  const unresolved = clone(SCHEMA);
  unresolved.properties.velocity = { $ref: '#/definitions/nowhere' };
  assert.throws(() => vocabularyRows(unresolved), /cannot resolve \$ref/);
});

test('an integer is an Int64, and an enum of anything but plain words stops the build', () => {
  const schema = clone(SCHEMA);
  schema.definitions.powerSupply.properties.batteryHealth = { type: 'integer', description: 'whole percent' };
  assert.equal(vocabularyRows(schema).find(row => row.name === 'powerSupply.batteryHealth').datatype, 'Int64');

  const enumerated = clone(SCHEMA);
  enumerated.properties.operatingMode.enum = ['STARTUP', "it's"];
  assert.throws(() => vocabularyRows(enumerated), /enum of anything but plain words/);
});

test('another message\'s schema is refused', () => {
  const schema = clone(SCHEMA);
  schema.title = 'order';
  assert.throws(() => vocabularyRows(schema), /not the VDA 5050 state schema/);
});
