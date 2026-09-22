/**
 * The two copies of the flow shape check agree, on the same files.
 *
 *     node --test scripts/lib/flow-shape.test.mjs
 *
 * A `flows.json` is checked twice on its way to an appliance: `forge-events` checks the pushed
 * commit and posts the `acs/flow-shape` status that `main` requires, and `flow-sync.mjs` checks
 * the committed file again on the appliance before deploying it. They are in two files because
 * they run in two places -- an edge worker and a container on somebody else's hardware -- and
 * neither can import the other.
 *
 * A DIVERGENCE IS WORSE THAN NO CHECK. A file that passes in the forge and fails on the appliance
 * was approved by a person who was told it was fine, and the gateway stops converging with the
 * only evidence in its own flow-sync log. So this runs the same fixtures through both copies and
 * compares the answers, rather than comparing the two texts: the texts differ legitimately, one
 * being TypeScript.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SOURCES = {
  'the appliance (flow-sync.mjs)': join(REPO, 'forge', 'gateway-platform', 'appliance', 'flow-sync.mjs'),
  'the forge (forge-events/index.ts)': join(REPO, 'supabase', 'functions', 'forge-events', 'index.ts'),
};

/**
 * One copy of `flowRejectionReason`, as a callable. Lifted out of its file rather than imported:
 * neither file can be loaded here, one being TypeScript and the other calling Node-RED on import.
 * The TypeScript annotations this function carries are removed by name, so a copy that grows a
 * different one fails loudly here rather than being silently mangled.
 */
function lift(path) {
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf('function flowRejectionReason(');
  assert.notEqual(start, -1, `${path} no longer declares flowRejectionReason`);

  // Balanced braces from the first one, so the body ends where it ends.
  let depth = 0;
  let end = -1;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && (depth -= 1) === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, `${path}: flowRejectionReason has unbalanced braces`);

  const source = text.slice(start, end)
    .replace('function flowRejectionReason(flow: unknown): string | null', 'function flowRejectionReason(flow)')
    .replace('(n as { type?: unknown }).type', 'n.type');
  assert.ok(!source.includes(': unknown') && !source.includes(' as {'),
    `${path}: flowRejectionReason carries a type annotation this test does not know how to remove`);
  return new Function(`${source}; return flowRejectionReason;`)();
}

/**
 * What each copy must answer. `null` is "deploy it"; a string is a refusal, and the two copies are
 * allowed to word their refusals differently, so only the verdict is compared.
 */
const FIXTURES = [
  { what: 'an ordinary flow', value: [{ id: 'a', type: 'mqtt-broker' }], refused: false },
  { what: 'a flow with several nodes', value: [{ id: 'a', type: 'tab' }, { id: 'b', type: 'inject' }], refused: false },
  { what: 'an empty array, which Node-RED accepts', value: [], refused: false },
  // A node with no `type` beside one that has it is a malformed flow, not a credential file.
  { what: 'one typeless node among typed ones', value: [{ id: 'a', type: 'tab' }, { id: 'b' }], refused: false },

  { what: 'flows_cred.json', value: { 'aber-broker': { user: 'x', password: 'y' } }, refused: true },
  { what: 'an array of credential entries', value: [{ user: 'x' }, { user: 'y' }], refused: true },
  { what: 'an object', value: { flows: [] }, refused: true },
  { what: 'a string', value: 'not a flow', refused: true },
  { what: 'a number', value: 42, refused: true },
  { what: 'null', value: null, refused: true },
];

const COPIES = Object.entries(SOURCES).map(([name, path]) => [name, lift(path)]);

test('both copies were found and are callable', () => {
  assert.equal(COPIES.length, 2);
  for (const [name, fn] of COPIES) assert.equal(typeof fn, 'function', name);
});

for (const { what, value, refused } of FIXTURES) {
  test(`${refused ? 'refuses' : 'accepts'} ${what}, in both copies`, () => {
    for (const [name, reject] of COPIES) {
      const answer = reject(value);
      assert.equal(
        answer !== null,
        refused,
        `${name} ${answer === null ? 'accepted' : `refused (${answer})`} ${what}`,
      );
    }
  });
}

test('the two copies agree on every fixture, which is the property that matters', () => {
  const [[firstName, first], [secondName, second]] = COPIES;
  for (const { what, value } of FIXTURES) {
    assert.equal(
      first(value) === null,
      second(value) === null,
      `${firstName} and ${secondName} disagree about ${what}`,
    );
  }
});
