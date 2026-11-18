/**
 * Verify the generated QUDT blocks in migration 0304 are intact, and that the unit map the AAS
 * exporter reads is the crosswalk's. As for the MTConnect, OPC UA, ASHRAE 223P and VDA 5050 checks,
 * each block's digest is recomputed from the file that executes, with no network needed. CI runs the
 * generator first and then this: the generator reads the copies of QUDT's files kept in
 * scripts/vocabularies/ and refuses any other, so a source that moved fails there.
 *
 * Usage: node scripts/check-qudt-seed-sync.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { KIND_BASE, UNIT_BASE, UNIT_MODULE_HEADER, reachedUnitIris, unitIdsModule } from './lib/qudt-vocabulary.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '0304_a_quantity_kind_has_a_vocabulary.sql');
const MODULE = join(ROOT, 'supabase', 'functions', '_shared', 'aas', 'qudtUnits.ts');
const CROSSWALK = join(ROOT, 'scripts', 'vocabularies', 'mtconnect-units-to-qudt.json');

const fail = (message, ...detail) => {
  console.error(`QUDT vocabulary check FAILED: ${message}`);
  for (const line of detail) console.error(`  ${line}`);
  console.error('  Regenerate with: node scripts/generate-qudt-vocabulary.mjs');
  process.exit(1);
};

// Normalised first: git checks this out as CRLF on Windows, and a digest over the raw bytes would
// fail on every Windows clone while passing in CI.
const normalised = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const sql = normalised(MIGRATION);

/** One block: its stamp, its digest checked, and its rows, one string a line. */
function block(table) {
  const begin = `-- >>> BEGIN GENERATED ${table}`;
  const end = `-- <<< END GENERATED ${table}`;
  const beginAt = sql.indexOf(begin);
  const endAt = sql.indexOf(end);
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    fail(`the generated block markers for ${table} are missing from 0304`, `expected ${begin} ... ${end}`);
  }
  const headerLine = sql.slice(beginAt, sql.indexOf('\n', beginAt));
  const stamp = headerLine.match(/QUDT (\S+), (\d+) rows, sha256:([0-9a-f]+)/);
  if (!stamp) fail(`the BEGIN marker of ${table} carries no version/row-count/digest stamp`, `saw: ${headerLine}`);
  const [, version, declaredRows, declaredDigest] = stamp;

  const anchor = sql.indexOf('CI verifies the digest above.', beginAt);
  if (anchor < 0 || anchor > endAt) fail(`the generated header of ${table} is malformed`);
  const body = sql.slice(sql.indexOf('\n', anchor) + 1, endAt).replace(/\n$/, '');
  const actualDigest = createHash('sha256').update(body).digest('hex').slice(0, 16);
  if (actualDigest !== declaredDigest) {
    fail(`the ${table} block has been edited since it was generated`,
         `declared sha256:${declaredDigest}`, `actual   sha256:${actualDigest}`,
         'These rows are read from QUDT\'s vocabulary files, not written by this repository.');
  }

  const lines = body.split('\n');
  const first = lines.findIndex((line) => line.endsWith(' VALUES'));
  const last = lines.findIndex((line) => line.startsWith('ON CONFLICT'));
  if (first < 0 || last < first) fail(`the ${table} statement is malformed`, 'expected INSERT ... VALUES, one row a line, then ON CONFLICT');
  const rows = lines.slice(first + 1, last);
  if (rows.length !== Number(declaredRows)) {
    fail(`the ${table} marker declares ${declaredRows} rows but ${rows.length} lines are rows`,
         'either a row was removed by hand or the statement form changed.',
         'A description on more than one line would also do this: the reader collapses whitespace so each',
         'row is one line, which is what the digest is taken over.');
  }
  return { version, rows };
}

const kinds = block('qudt_quantity_kinds');
const unitBlock = block('qudt_units');

const seenKinds = new Set();
for (const line of kinds.rows) {
  const row = line.match(/^\('(http:\/\/qudt\.org\/vocab\/quantitykind\/[^']+)', '((?:[^']|'')+)', (?:'((?:[^']|'')*)'|NULL)\),?$/);
  if (!row) fail('a quantity kind row is not in the form the generator writes', `saw: ${line.slice(0, 160)}`);
  const [, id, , description] = row;
  if (!id.startsWith(KIND_BASE)) fail(`${id} is not under ${KIND_BASE}`);
  if (seenKinds.has(id)) fail(`duplicate quantity kind ${id}`, 'the table is keyed on the IRI.');
  seenKinds.add(id);
  if (description !== undefined && [...description].some((ch) => ch === '\\' || ch === '$' || ch.charCodeAt(0) < 32)) {
    fail(`the description of ${id} holds a backslash, a control character or a dollar sign`,
         'QUDT\'s LaTeX is written out as plain text, and what it could not write out stops the generator.');
  }
}

const seenUnits = new Set();
for (const line of unitBlock.rows) {
  const row = line.match(/^\('(http:\/\/qudt\.org\/vocab\/unit\/[^']+)', '((?:[^']|'')+)', (?:'((?:[^']|'')*)'|NULL), (?:'((?:[^']|'')*)'|NULL)\),?$/);
  if (!row) fail('a unit row is not in the form the generator writes', `saw: ${line.slice(0, 160)}`);
  if (!row[1].startsWith(UNIT_BASE)) fail(`${row[1]} is not under ${UNIT_BASE}`);
  if (seenUnits.has(row[1])) fail(`duplicate unit ${row[1]}`, 'the table is keyed on the IRI.');
  seenUnits.add(row[1]);
}

// The units the table holds are the ones the crosswalk reaches and no others: a unit the export maps
// to must be a row, and a row nothing maps to is a unit nobody decided on.
const crosswalk = JSON.parse(normalised(CROSSWALK));
const reached = reachedUnitIris(crosswalk);
const missing = reached.filter((iri) => !seenUnits.has(iri));
const extra = [...seenUnits].filter((iri) => !reached.includes(iri));
if (missing.length) fail(`qudt_units lacks ${missing.length} unit(s) the crosswalk reaches`, missing.slice(0, 5).join(', '));
if (extra.length) fail(`qudt_units holds ${extra.length} unit(s) the crosswalk does not reach`, extra.slice(0, 5).join(', '));

// The map the exporter sets unitId from is the crosswalk's, byte for byte, so it cannot drift from it.
if (normalised(MODULE) !== unitIdsModule(crosswalk, UNIT_MODULE_HEADER)) {
  fail('supabase/functions/_shared/aas/qudtUnits.ts is not what the crosswalk generates',
       'the exporter would set unitId from a map that is not the one the seed was built from.');
}

console.log(`QUDT vocabulary intact: ${kinds.rows.length} quantity kinds and ${unitBlock.rows.length} units, QUDT ${kinds.version}.`);
console.log('  Digests, row form, IRI namespaces, key uniqueness, the crosswalk\'s units and the exporter\'s unit map verified.');
