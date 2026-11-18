import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 475. The documents count the QUDT rows the seed holds and the MTConnect unit names the crosswalk
// maps: the quantity kinds and the units the blocks of 0304 declare, and how many of the unit names
// map to a QUDT unit and how many to none. The count is in the vocabulary document (its section, the
// settled row and the architecture table), the API reference, the migration's own header and its note.
// A stale count is the claim a reader cannot tell is stale, and these move whenever QUDT's release or
// the crosswalk does.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems475 = [];
  const migrations = readdirSync(join(REPO, 'supabase/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f));
  const file = migrations.find((f) => read(`supabase/migrations/${f}`).includes('CREATE TABLE IF NOT EXISTS public.qudt_quantity_kinds'));
  if (!file) {
    fail('475: no migration creates qudt_quantity_kinds -- the table moved, so this check is no longer checking anything');
    return;
  }
  const sql = read(`supabase/migrations/${file}`);
  // The row count a block's BEGIN line declares: `-- >>> BEGIN GENERATED <table> -- QUDT 3.5.2, 83 rows, sha256:...`.
  const stamp = (table) => {
    const at = sql.indexOf(`BEGIN GENERATED ${table} -- QUDT `);
    return at < 0 ? NaN : Number(sql.slice(at, sql.indexOf('\n', at)).match(/, (\d+) rows/)?.[1]);
  };
  const kinds = stamp('qudt_quantity_kinds');
  const units = stamp('qudt_units');
  const crosswalk = JSON.parse(read('scripts/vocabularies/mtconnect-units-to-qudt.json')).units;
  const names = Object.keys(crosswalk).length;
  const mapped = Object.values(crosswalk).filter((entry) => entry.unit).length;
  const none = names - mapped;
  if (!(kinds > 0 && units > 0 && names > 0)) {
    fail('475: read no QUDT row count from the migration or the crosswalk -- their shape changed, so this check reads nothing');
    return;
  }
  const withComma = (n) => n.toLocaleString('en-US');

  const doc = read('docs/vocabularies.md');
  const section = doc.slice(doc.indexOf('## QUDT (quantity kinds and units)'), doc.indexOf('## VDA 5050 (AGVs)'));
  const claims = [
    ['the QUDT section of docs/vocabularies.md', section, [`**${withComma(kinds)} quantity kinds**`, `**${units} units**`, `**${mapped} map and ${none} map to nothing.**`]],
    ['the settled row on 223P and QUDT in docs/vocabularies.md', doc, [`(every kind that is not deprecated, ${withComma(kinds)})`, `(the ${units} units MTConnect's names map to)`]],
    ['the architecture table', read('docs/architecture.md'), [`${withComma(kinds)} quantity kinds, and the ${units} units`]],
    ['the Verified identities table in docs/vocabularies.md', doc, [`${withComma(kinds)} kinds and ${units} units seeded`]],
    ['docs/openapi.yaml', read('docs/openapi.yaml'), [`${units} of QUDT's`, `${none} of the ${names} names map to none`]],
    [`${file}'s header`, sql, [`${kinds} of them`, `the ${units} QUDT units`, `${none} of the ${names} names`]],
    ['its migration note', read('unreleased/migrations/0304.md'), [`${kinds} of them`, `the ${units} QUDT units`, `${mapped} map.`]],
    ['its upgrade note', read('unreleased/upgrading/a-quantity-kind-has-a-vocabulary.md'), [`${kinds} quantity kinds`, `${mapped} of MTConnect's ${names} unit`]],
  ];
  for (const [where, text, wanted] of claims) {
    for (const claim of wanted) {
      if (!text.includes(claim)) problems475.push(`${where} does not say "${claim}"`);
    }
  }

  // The crosswalk's counts are the generator's too: the figures the generator's output prints.
  const reasons = Object.entries(crosswalk).filter(([, entry]) => entry.unit === null && !String(entry.reason || '').trim());
  if (reasons.length) problems475.push(`${reasons.map(([name]) => name).join(', ')} map to nothing and give no reason`);

  if (problems475.length) {
    fail('the documents and the QUDT seed disagree:\n' + problems475.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the vocabulary document, the architecture table, the API reference, the migration's header and its two notes count the ${withComma(kinds)} QUDT quantity kinds, the ${units} units and the crosswalk's ${mapped} mapped names and ${none} with none, as the seed and the crosswalk hold them`);
  }
}
