#!/usr/bin/env node
/**
 * Generate the QUDT vocabulary migration, and the unit map the AAS exporter reads, from QUDT's
 * published vocabulary files.
 *
 *   node scripts/generate-qudt-vocabulary.mjs
 *
 * Source: scripts/vocabularies/qudt-3.5.2-quantity-kinds.ttl and qudt-3.5.2-units.ttl, byte-for-byte
 * copies of `src/main/rdf/vocab/quantitykinds/VOCAB_QUDT-QUANTITY-KINDS-ALL.ttl` and
 * `src/main/rdf/vocab/unit/VOCAB_QUDT-UNITS-ALL.ttl` at tag v3.5.2 (2026-09-22) of
 * github.com/qudt/qudt-public-repo. QUDT declares its licence in both files (`dcterms:rights`:
 * Creative Commons Attribution 4.0, "Attribution should be made to QUDT.org"), and the repository's
 * LICENSE.md is beside them. The units file also carries a UCUM notice in its metadata, which applies
 * to the UCUM codes: none is taken.
 *
 * What is seeded: every quantity kind that is not deprecated, and only the units
 * scripts/vocabularies/mtconnect-units-to-qudt.json reaches. The crosswalk is checked here against
 * the MTConnect unit names the seed holds and against the units file, so a name missing from it, or
 * an IRI QUDT no longer has, stops the build.
 *
 * Three things are written: the two blocks in migration 0304, and
 * supabase/functions/_shared/aas/qudtUnits.ts, the name-to-IRI map the exporter sets `unitId` from.
 * scripts/check-qudt-seed-sync.mjs recomputes the digests the blocks carry and the module's text,
 * and CI runs this generator first, which fails on a source that has moved. The reader of the
 * Turtle is scripts/lib/turtle.mjs; what is kept and how it is rendered is scripts/lib/qudt-vocabulary.mjs.
 *
 * THE BLOCKS ARE IN 0304, NOT 0002. 0002 is released, and this vocabulary arrived after it, in tables
 * of their own.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  QUDT_VERSION, UNIT_MODULE_HEADER, quantityKinds, units, crosswalkProblems, reachedUnitIris, mtconnectUnitNames,
  unitIdsModule,
} from './lib/qudt-vocabulary.mjs';

/** Pinned by content: a different file is refused rather than read. */
const KINDS_FILE = 'scripts/vocabularies/qudt-3.5.2-quantity-kinds.ttl';
const KINDS_SHA256 = '729dc6c4f429a808d4c5d6766f1be13a3dc1196fd95f5bdb417a19f251cbce8f';
const UNITS_FILE = 'scripts/vocabularies/qudt-3.5.2-units.ttl';
const UNITS_SHA256 = '372448d68405c3bf561ffc99900bb3bffc5fe9affd345eccbadacbc8043be4c7';
const CROSSWALK_FILE = 'scripts/vocabularies/mtconnect-units-to-qudt.json';
const MTCONNECT_SEED = 'supabase/migrations/0002_seed_data.sql';
const MIGRATION_FILE = 'supabase/migrations/0304_a_quantity_kind_has_a_vocabulary.sql';
const MODULE_FILE = 'supabase/functions/_shared/aas/qudtUnits.ts';
const KIND_BEGIN = '-- >>> BEGIN GENERATED qudt_quantity_kinds';
const KIND_END = '-- <<< END GENERATED qudt_quantity_kinds';
const UNIT_BEGIN = '-- >>> BEGIN GENERATED qudt_units';
const UNIT_END = '-- <<< END GENERATED qudt_units';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;
const orNull = (value) => (value === null ? 'NULL' : sqlString(value));

function pinned(file, sha256) {
  const bytes = readFileSync(join(ROOT, file));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) {
    throw new Error(
      `${file} is sha256:${actual}, pinned to sha256:${sha256}. A new QUDT release is read (its diff, its ` +
      `licence, the counts in the migration's header) before the pin moves.`
    );
  }
  return bytes.toString('utf8');
}

/**
 * One statement for the block, a row to a line, so a regeneration is a clean diff. A row is rewritten
 * only where something differs: db-init replays this file on every boot, and a settled database
 * should write nothing.
 */
const statement = (table, columns, rows) =>
  `INSERT INTO public.${table} (${columns.join(', ')}) VALUES\n${rows.join(',\n')}\n` +
  `ON CONFLICT (semantic_id) DO UPDATE SET\n` +
  columns.slice(1).map((column, i) => `  ${column} = EXCLUDED.${column}${i < columns.length - 2 ? ',' : ''}`).join('\n') + '\n' +
  ` WHERE (${columns.slice(1).map((c) => `${table}.${c}`).join(', ')})\n` +
  `       IS DISTINCT FROM (${columns.slice(1).map((c) => `EXCLUDED.${c}`).join(', ')});`;

const kinds = quantityKinds(pinned(KINDS_FILE, KINDS_SHA256));
const qudtUnits = units(pinned(UNITS_FILE, UNITS_SHA256));
const crosswalk = JSON.parse(readFileSync(join(ROOT, CROSSWALK_FILE), 'utf8'));
const problems = crosswalkProblems(crosswalk, mtconnectUnitNames(readFileSync(join(ROOT, MTCONNECT_SEED), 'utf8')), qudtUnits);
if (problems.length > 0) throw new Error(`${CROSSWALK_FILE} is not sound:\n  ${problems.join('\n  ')}`);
if (kinds.length < 1000) {
  // A reader that quietly stopped early is the failure with no symptom: the migration would still
  // apply and the vocabulary would simply be short. QUDT 3.5.2 has 1126 kinds that are not deprecated.
  throw new Error(`only ${kinds.length} quantity kinds were read, which is too few to be right`);
}

const kindRows = kinds.map((k) => `(${sqlString(k.semanticId)}, ${sqlString(k.name)}, ${orNull(k.description)})`);
const unitRows = reachedUnitIris(crosswalk).map((iri) => {
  const u = qudtUnits.get(iri);
  return `(${sqlString(u.semanticId)}, ${sqlString(u.name)}, ${orNull(u.symbol)}, ${orNull(u.uneceCode)})`;
});

const block = (begin, table, columns, rows, what) => {
  const body = statement(table, columns, rows);
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
  const header =
    `${begin} -- QUDT ${QUDT_VERSION}, ${rows.length} rows, sha256:${digest}\n` +
    `-- GENERATED by scripts/generate-qudt-vocabulary.mjs from ${what}.\n` +
    `-- Do not edit these rows by hand: change the script and re-run it. CI verifies the digest above.`;
  return { text: `${header}\n${body}\n`, digest };
};
const kindBlock = block(KIND_BEGIN, 'qudt_quantity_kinds', ['semantic_id', 'name', 'description'], kindRows, KINDS_FILE);
const unitBlock = block(UNIT_BEGIN, 'qudt_units', ['semantic_id', 'name', 'symbol', 'unece_code'], unitRows,
  `${UNITS_FILE}, taking the units ${CROSSWALK_FILE} reaches`);

// Normalised, as the check reads it: a CRLF checkout would otherwise mix the file's line endings.
let migration = readFileSync(join(ROOT, MIGRATION_FILE), 'utf8').replace(/\r\n/g, '\n');
for (const [begin, end, made] of [[KIND_BEGIN, KIND_END, kindBlock], [UNIT_BEGIN, UNIT_END, unitBlock]]) {
  const beginAt = migration.indexOf(begin);
  const endAt = migration.indexOf(end);
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    throw new Error(`markers not found in ${MIGRATION_FILE}. Expected a block delimited by:\n  ${begin}\n  ${end}`);
  }
  migration = migration.slice(0, beginAt) + made.text + migration.slice(endAt);
}
writeFileSync(join(ROOT, MIGRATION_FILE), migration, 'utf8');
writeFileSync(join(ROOT, MODULE_FILE), unitIdsModule(crosswalk, UNIT_MODULE_HEADER), 'utf8');

console.log(`QUDT ${QUDT_VERSION}: wrote ${kinds.length} quantity kinds and ${unitRows.length} units into ${MIGRATION_FILE}`);
console.log(`  sha256:${kindBlock.digest} (kinds), sha256:${unitBlock.digest} (units)`);
console.log(`  ${kinds.filter((k) => k.description).length} kinds with a description; ` +
            `${Object.values(crosswalk.units).filter((e) => e.unit).length} of ${Object.keys(crosswalk.units).length} MTConnect units map`);
console.log(`  wrote ${MODULE_FILE}`);
