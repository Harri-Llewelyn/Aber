/**
 * Verify the generated IDTA submodel-template blocks are intact. As for the OPC UA check, each block's
 * digest is recomputed from the file that executes, with no network needed. CI runs the generator first
 * and then this: the generator reads the copies kept in scripts/vocabularies/ and refuses any other, so
 * a source that moved fails there.
 *
 * What a digest cannot say is checked here: the rows are the form the generator writes, each element
 * follows its parent, the ordinals run from 1, an id has its type's shape, and no row holds a filler
 * where a definition would be. Every row is in a block: an INSERT outside one, in any migration, would
 * be typed by hand.
 *
 * Usage: node scripts/check-idta-seed-sync.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { BLOCKS, CARDINALITIES, COLUMNS, MODEL_TYPES, REGION, TEMPLATES, semanticIdType } from './lib/idta-template.mjs';
import { readDigestRegion } from './lib/opcua-seed-blocks.mjs';
import { rowsOf, splitStatements } from './lib/idta-template-rows.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

const fail = (message, ...detail) => {
  console.error(`IDTA template check FAILED: ${message}`);
  for (const line of detail) console.error(`  ${line}`);
  console.error('  Regenerate with: node scripts/generate-idta-template.mjs');
  process.exit(1);
};

// Normalised first: git checks this out as CRLF on Windows, and a digest over the raw bytes would
// fail on every Windows clone while passing in CI.
const text = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const names = BLOCKS.map((block) => basename(block.file));
if (names.join() !== names.slice().sort().join()) fail('BLOCKS is not in the order of the migrations', names.join(', '));

const seeded = [];
for (const block of BLOCKS) {
  if (!basename(block.file).startsWith(`${block.since}_`)) fail(`block ${block.since} names ${block.file}, which is not migration ${block.since}`);
  const region = readDigestRegion(text(join(ROOT, block.file)), REGION);
  if (region === null) fail(`the generated block markers are missing from ${block.file}`, `expected ${REGION.begin} ... ${REGION.end}`);
  if (region.malformed !== undefined) fail(`the BEGIN marker of ${block.file} carries no row-count/digest stamp, or its header is malformed`, `saw: ${region.malformed}`);
  if (region.actual !== region.digest) {
    fail(`the block of ${block.file} has been edited since it was generated`,
         `declared sha256:${region.digest}`, `actual   sha256:${region.actual}`,
         'These rows are read from IDTA\'s templates, not written by this repository.');
  }

  const own = TEMPLATES.filter(({ since }) => since === block.since);
  const statements = splitStatements(region.body);
  if (statements.length !== own.length) fail(`the ${block.since} block holds ${statements.length} statements for ${own.length} templates`);
  let count = 0;
  statements.forEach((statement, at) => {
    const made = rowsOf(statement);
    if (made === null) fail(`statement ${at + 1} of the ${block.since} block is not in the form the generator writes`, `saw: ${statement.slice(0, 160)}`);
    const { name, number, version } = own[at];
    if (made.template.join(' / ') !== [made.template[0], name, number, version].join(' / ')) {
      fail(`statement ${at + 1} of the ${block.since} block seeds ${made.template.join(', ')}`, `TEMPLATES says ${name}, ${number}, ${version}`);
    }
    count += made.rows.length;
    seeded.push({ templateId: made.template[0], name, rows: made.rows });
  });
  if (count !== region.rows) fail(`the ${block.since} marker declares ${region.rows} rows but ${count} parsed`, 'either a row was removed by hand or the statement form changed.');

  const inserted = (text(join(ROOT, block.file)).match(/^INSERT INTO public\.idta_template_elements\b/gm) || []).length;
  if (inserted !== statements.length) fail(`${block.file} writes idta_template_elements ${inserted} times, ${statements.length} of them in the generated block`);
}
for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql') && !names.includes(name))) {
  if (/^INSERT INTO public\.idta_template_elements\b/m.test(text(join(MIGRATIONS, file)))) {
    fail(`${file} inserts idta_template_elements rows outside a generated block`, 'Add the template to TEMPLATES in scripts/lib/idta-template.mjs instead.');
  }
}

/** Structural assertions: a digest proves a block is unchanged, never that it was right. */
for (const { name, templateId, rows } of seeded) {
  const wrong = (row, message, ...detail) => fail(`${name}: ${row.path} ${message}`, ...detail);
  if (semanticIdType(templateId) !== 'IRI') fail(`${name}: the template id ${templateId} is not an IRI`);
  const paths = new Set();
  rows.forEach((row, at) => {
    if (row.ordinal !== at + 1) wrong(row, `has the ordinal ${row.ordinal}, not ${at + 1}`);
    if (paths.has(row.path)) wrong(row, 'is seeded twice', 'the table is keyed on the template and the path.');
    if (row.parent_path !== null && !paths.has(row.parent_path)) wrong(row, `follows no row for its parent ${row.parent_path}`);
    paths.add(row.path);
    const last = row.path.slice((row.parent_path ?? '').length).replace(/^[.]/, '');
    if (row.id_short === null ? !/^\[\d+\]$/.test(last) : last !== row.id_short && !/^\[\d+\]$/.test(last)) {
      wrong(row, `does not end in its idShort ${row.id_short}`);
    }
    if (!MODEL_TYPES.includes(row.model_type)) wrong(row, `has the model type ${row.model_type}`);
    if (row.cardinality !== null && !CARDINALITIES.includes(row.cardinality)) wrong(row, `has the cardinality ${row.cardinality}`);
    if ((row.semantic_id === null) !== (row.semantic_id_type === null)) wrong(row, 'has a semantic id or its type without the other');
    if (row.semantic_id !== null && semanticIdType(row.semantic_id) !== row.semantic_id_type) wrong(row, `types ${row.semantic_id} as ${row.semantic_id_type}`);
    for (const id of row.supplemental_semantic_ids) semanticIdType(id);
    if (row.definition === 'EMPTY' || row.example_value === 'EMPTY') wrong(row, 'holds a filler where a definition would be');
  });
}

console.log(`IDTA templates intact: ${seeded.map(({ name, rows }) => `${name} (${rows.length} elements)`).join(', ')} in ${BLOCKS.length} block.`);
console.log(`  Digest, row form (${COLUMNS.length} columns), parents, order, ids, cardinalities and hand-written rows verified.`);
