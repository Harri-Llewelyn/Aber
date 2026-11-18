import { fail, pass, read, walk } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 452. The OPC UA section of docs/vocabularies.md counts what the migrations seed: one row of its
// table for each companion specification, with the number of data points and the migrations that
// seed them, and the sentence above the table gives the totals. The API reference says the same
// totals. The rows are generated into marked blocks of the migrations that grew the vocabulary
// (scripts/lib/opcua-seed-blocks.mjs), so a block added or a row added changes a count here, and a
// document that still says 75 is a count nobody can tell is stale.
// -------------------------------------------------------------------------------------------------
const WORDS = { five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

export default function check() {
  const migrations = walk('supabase/migrations').filter((f) => /^supabase\/migrations\/[^/]+\.sql$/.test(f)).sort();
  const seeded = new Map(); // specification -> Map(migration number -> rows)
  for (const file of migrations) {
    const number = file.match(/migrations\/(\d{4})_/)?.[1];
    for (const [, spec] of read(file).matchAll(/^INSERT INTO public\.opcua_vocabulary VALUES \('(?:[^']|'')*', '((?:[^']|'')*)'/gm)) {
      if (!seeded.has(spec)) seeded.set(spec, new Map());
      seeded.get(spec).set(number, (seeded.get(spec).get(number) ?? 0) + 1);
    }
  }
  const total = [...seeded.values()].reduce((sum, byMigration) => sum + [...byMigration.values()].reduce((a, b) => a + b, 0), 0);

  const doc = read('docs/vocabularies.md');
  const section = doc.match(/\n## OPC UA companion specifications\n([\s\S]*?)\n## /)?.[1] ?? '';
  const offences = [];
  const sentence = section.match(/holds (\w+) companion specifications and (\d+) data points/);
  if (!sentence) {
    offences.push('docs/vocabularies.md: the OPC UA section no longer says "holds <n> companion specifications and <n> data points"');
  } else {
    if ((WORDS[sentence[1]] ?? Number(sentence[1])) !== seeded.size) {
      offences.push(`docs/vocabularies.md: the OPC UA section says ${sentence[1]} specifications, the migrations seed ${seeded.size}`);
    }
    if (Number(sentence[2]) !== total) {
      offences.push(`docs/vocabularies.md: the OPC UA section says ${sentence[2]} data points, the migrations seed ${total}`);
    }
  }

  const documented = new Map();
  for (const [, spec, count, by] of section.matchAll(/^\| (OPC [^|]+?) \| (\d+) \| ([^|]+) \|$/gm)) {
    documented.set(spec, { count: Number(count), by });
  }
  for (const [spec, byMigration] of seeded) {
    const row = documented.get(spec);
    const rows = [...byMigration.values()].reduce((a, b) => a + b, 0);
    const by = [...byMigration].sort(([a], [b]) => (a < b ? -1 : 1)).map(([number, n]) => `\`${number}\` (${n})`).join(', ');
    if (!row) offences.push(`docs/vocabularies.md: the OPC UA table has no row for ${spec}, which the migrations seed with ${rows} data points`);
    else if (row.count !== rows) offences.push(`docs/vocabularies.md: the OPC UA table gives ${spec} ${row.count} data points, the migrations seed ${rows}`);
    else if (row.by.trim() !== by) offences.push(`docs/vocabularies.md: the OPC UA table says ${spec} is seeded by ${row.by.trim()}, the migrations by ${by}`);
  }
  for (const spec of documented.keys()) {
    if (!seeded.has(spec)) offences.push(`docs/vocabularies.md: the OPC UA table lists ${spec}, which no migration seeds`);
  }

  const api = read('docs/openapi.yaml').match(/\/rest\/v1\/opcua_vocabulary:[\s\S]*?(\d+) data points from (\w+) companion specifications/);
  if (!api) offences.push('docs/openapi.yaml: the opcua_vocabulary route no longer says "<n> data points from <n> companion specifications"');
  else if (Number(api[1]) !== total || (WORDS[api[2]] ?? Number(api[2])) !== seeded.size) {
    offences.push(`docs/openapi.yaml: the opcua_vocabulary route says ${api[1]} data points from ${api[2]} specifications, the migrations seed ${total} from ${seeded.size}`);
  }

  if (!seeded.size) {
    fail('check 452 found no opcua_vocabulary row in supabase/migrations, so it reads nothing');
  } else if (offences.length) {
    fail('the OPC UA vocabulary documents do not count what the migrations seed:\n' + offences.map((o) => `        ${o}`).join('\n'));
  } else {
    pass(`the OPC UA table in docs/vocabularies.md and the API reference count the ${total} data points of ${seeded.size} specifications, by the migrations that seed them`);
  }
}
