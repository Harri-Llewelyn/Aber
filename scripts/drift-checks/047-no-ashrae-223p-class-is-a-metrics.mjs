import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 47. No ASHRAE 223P class is a metric's semantic id, in the example set or from the Add Metric
// prefill, and the example readings and 0172 agree on the QUDT quantity kind each carries.
//
// 223P is a reference here. A class names equipment or a substance, so `TemperatureSensor` as the
// id of a Property whose value is 21.4 tells an AAS consumer the Property is a sensor. The example
// set's five readings carry QUDT quantity kinds instead. They are typed in the file, which takes no id
// from a vocabulary table, so this check is the join: each kind must be a row of qudt_quantity_kinds
// (0304). 0172 repoints an older install to the same five pairs, and the two must not drift apart. The prefill is the dashboard's one door that fills an id
// without being asked; the suggestion and the search are held by semanticIdSources.test.js.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const S223 = 'http://data.ashrae.org/standard223#';
  const QUANTITY_KIND = 'http://qudt.org/vocab/quantitykind/';
  const EXAMPLES_FILE = 'supabase/example-metrics.sql';
  const REPOINT_FILE = 'supabase/migrations/0172_a_223p_reading_carries_its_quantity_kind.sql';
  const PREFILL_FILE = 'frontend/src/utils/ashrae223.js';
  const offences = [];

  // A class IRI anywhere outside a comment is a row carrying one: the example set types no 223P id.
  const examples = read(EXAMPLES_FILE);
  for (const line of examples.split('\n')) {
    if (!line.trimStart().startsWith('--') && line.includes(S223)) {
      offences.push(`${EXAMPLES_FILE} carries a 223P class as an id: ${line.trim()}`);
    }
  }

  // The 223P block is the INSERT ... SELECT that names the standard once, one tuple per line.
  const block223 = examples.match(
    /INSERT INTO public\.metric_catalog \([^)]*\)\s*SELECT[^;]*?'ASHRAE 223P'[^;]*?FROM \(VALUES([\s\S]*?)\) AS /
  );
  const seeded = new Map(
    [...(block223?.[1] ?? '').matchAll(/\(\s*'(BMS\/[A-Za-z0-9_]+)',[^\n]*'([^']+)'\)/g)].map((m) => [m[1], m[2]])
  );
  if (seeded.size === 0) {
    offences.push(`found no 223P row in ${EXAMPLES_FILE}: the file's shape changed, so this check reads nothing`);
  }
  for (const [name, id] of seeded) {
    if (!id.startsWith(QUANTITY_KIND)) offences.push(`${name} carries ${id}, not a QUDT quantity kind`);
  }

  // The join: the kinds the table seeds, from the migration that creates it.
  const tableFile = readdirSync(join(REPO, 'supabase/migrations')).find(
    (f) => /^\d{4}_.*\.sql$/.test(f) && read(`supabase/migrations/${f}`).includes('CREATE TABLE IF NOT EXISTS public.qudt_quantity_kinds')
  );
  const kindRows = new Set(
    tableFile ? [...read(`supabase/migrations/${tableFile}`).matchAll(/^\('(http:\/\/qudt\.org\/vocab\/quantitykind\/[^']+)', /gm)].map((m) => m[1]) : []
  );
  if (kindRows.size === 0) {
    offences.push("found no seeded QUDT quantity kind: the table's migration changed shape, so the join reads nothing");
  }
  for (const [name, id] of seeded) {
    if (kindRows.size > 0 && !kindRows.has(id)) offences.push(`${name} carries ${id}, which qudt_quantity_kinds does not hold`);
  }

  // 0172's tuples: (name, the 223P class the seed gave it, the quantity kind it moves to).
  const repointed = new Map(
    [...read(REPOINT_FILE).matchAll(/\(\s*'(BMS\/[A-Za-z0-9_]+)',\s*'([^']+)',\s*'([^']+)'\)/g)]
      .map((m) => [m[1], { from: m[2], to: m[3] }])
  );
  for (const [name, { from }] of repointed) {
    if (!from.startsWith(S223)) offences.push(`${REPOINT_FILE} moves ${name} from ${from}, which is not a 223P class`);
  }
  for (const name of new Set([...seeded.keys(), ...repointed.keys()])) {
    if (seeded.get(name) !== repointed.get(name)?.to) {
      offences.push(
        `${name}: ${EXAMPLES_FILE} gives ${seeded.get(name) ?? 'nothing'}, ${REPOINT_FILE} moves it to ` +
          `${repointed.get(name)?.to ?? 'nothing'}`
      );
    }
  }

  const prefill = read(PREFILL_FILE).match(/export function ashrae223Prefill\([^)]*\) \{([\s\S]*?)\n\}/);
  if (!prefill) {
    offences.push(`found no ashrae223Prefill() in ${PREFILL_FILE}: this half reads nothing`);
  } else if (/\bsemanticId\b/.test(prefill[1])) {
    offences.push(`ashrae223Prefill() in ${PREFILL_FILE} fills semanticId, so Add Metric adopts a 223P class as the id`);
  }

  if (offences.length) {
    fail(
      'a 223P class is offered or seeded as a semantic id, or the example readings and 0172 disagree:\n' +
        offences.map((o) => `        ${o}`).join('\n')
    );
  } else {
    pass(
      `the ${seeded.size} example 223P reading(s) carry QUDT quantity kinds that qudt_quantity_kinds holds, ` +
        'the pairs 0172 repoints to, and the 223P prefill fills no semantic id'
    );
  }
}
