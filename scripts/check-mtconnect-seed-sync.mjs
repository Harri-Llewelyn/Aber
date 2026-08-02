/**
 * Verify the MTConnect vocabulary seeded by 0002_seed_data.sql still matches what
 * generate-mtconnect-vocabulary.mjs produces.
 *
 * WHY THIS REPLACED A PLAIN FILE DIFF. Before the migrations were squashed, the generator owned an
 * entire migration and CI could simply re-run it and `diff` the file. The vocabulary now lives
 * inside the consolidated seed, so that check had nothing to compare against -- and the obvious
 * repair, having the generator write the seed section directly, is wrong: the generator emits only
 * `(kind, name, category)`, while the seeded rows also carry `semantic_id`, which the old migration
 * 0032 backfilled in a separate pass. Splicing generator output into the seed would silently drop
 * every semantic id on a fresh database.
 *
 * So the generator remains the authority on WHICH ROWS EXIST, and this compares exactly that: the
 * set of (kind, name, category) triples. It catches both directions of drift -- someone hand-editing
 * the vocabulary in the seed, and someone bumping SCHEMA_VERSION without re-squashing.
 *
 * Usage: node scripts/generate-mtconnect-vocabulary.mjs && node scripts/check-mtconnect-seed-sync.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = join(ROOT, 'supabase', 'migrations', 'archive', '20260101000018_mtconnect_vocabulary.sql');
const SEED = join(ROOT, 'supabase', 'migrations', '0002_seed_data.sql');

/** `'A', 'B', 'C'` -> ['A','B','C'], honouring SQL's doubled-quote escape and NULL. */
const parseValues = (body) => {
  const out = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    if (i >= body.length) break;
    if (body[i] === "'") {
      let value = '';
      i++;
      while (i < body.length) {
        if (body[i] === "'" && body[i + 1] === "'") { value += "'"; i += 2; continue; }
        if (body[i] === "'") { i++; break; }
        value += body[i++];
      }
      out.push(value);
    } else {
      let token = '';
      while (i < body.length && !/[,]/.test(body[i])) token += body[i++];
      out.push(token.trim().toUpperCase() === 'NULL' ? null : token.trim());
    }
  }
  return out;
};

/** Triples from the generator's `INSERT ... (kind, name, category) VALUES (..),(..);` block. */
const fromGenerated = (sql) => {
  const start = sql.indexOf('INSERT INTO public.mtconnect_vocabulary');
  if (start < 0) throw new Error('no mtconnect_vocabulary INSERT in the generated file');
  const block = sql.slice(start, sql.indexOf(';', start));
  const triples = new Set();
  for (const m of block.matchAll(/\(\s*('(?:[^']|'')*'\s*,\s*'(?:[^']|'')*'\s*,\s*(?:'(?:[^']|'')*'|NULL))\s*\)/gi)) {
    const [kind, name, category] = parseValues(m[1]);
    triples.add(JSON.stringify([kind, name, category]));
  }
  return triples;
};

/** Triples from the seed's one-row-per-statement `INSERT INTO x VALUES (...)` form. */
const fromSeed = (sql) => {
  const triples = new Set();
  for (const line of sql.split('\n')) {
    if (!line.startsWith('INSERT INTO public.mtconnect_vocabulary VALUES (')) continue;
    const open = line.indexOf('(');
    const close = line.lastIndexOf(')');
    const [kind, name, category] = parseValues(line.slice(open + 1, close));
    triples.add(JSON.stringify([kind, name, category]));
  }
  return triples;
};

const generated = fromGenerated(readFileSync(GENERATED, 'utf8'));
const seeded = fromSeed(readFileSync(SEED, 'utf8'));

const missing = [...generated].filter((t) => !seeded.has(t));
const extra = [...seeded].filter((t) => !generated.has(t));

if (missing.length || extra.length) {
  console.error('MTConnect vocabulary has drifted between the generator and 0002_seed_data.sql.');
  for (const t of missing.slice(0, 15)) console.error(`  missing from seed: ${t}`);
  for (const t of extra.slice(0, 15)) console.error(`  extra in seed:     ${t}`);
  console.error(`  ${missing.length} missing, ${extra.length} extra`);
  process.exit(1);
}

if (generated.size === 0) {
  console.error('parsed zero rows from the generator output -- the check is not actually checking anything');
  process.exit(1);
}

console.log(`MTConnect vocabulary is in sync: ${generated.size} rows match between the generator and 0002_seed_data.sql.`);
