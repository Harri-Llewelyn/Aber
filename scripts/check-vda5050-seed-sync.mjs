/**
 * Verify the generated VDA 5050 block in migration 0302 is intact. As for the MTConnect, OPC UA and
 * ASHRAE 223P checks, the digest is recomputed from the file that executes, with no network needed.
 * CI runs the generator first and then this: the generator reads the copy of the schema kept in
 * scripts/vocabularies/ and refuses any other, so a source that moved fails there.
 *
 * Usage: node scripts/check-vda5050-seed-sync.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DATATYPES, KEPT, SEMANTIC_BASE, vda5050SemanticId } from './lib/vda5050-vocabulary.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '0302_an_agv_reading_has_a_vocabulary.sql');
const BEGIN_MARKER = '-- >>> BEGIN GENERATED vda5050_vocabulary';
const END_MARKER = '-- <<< END GENERATED vda5050_vocabulary';

const fail = (message, ...detail) => {
  console.error(`VDA 5050 vocabulary check FAILED: ${message}`);
  for (const line of detail) console.error(`  ${line}`);
  console.error('  Regenerate with: node scripts/generate-vda5050-vocabulary.mjs');
  process.exit(1);
};

// Normalised first: git checks this out as CRLF on Windows, and a digest over the raw bytes would
// fail on every Windows clone while passing in CI.
const sql = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');
const beginAt = sql.indexOf(BEGIN_MARKER);
const endAt = sql.indexOf(END_MARKER);
if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
  fail('the generated block markers are missing from 0302', `expected ${BEGIN_MARKER} ... ${END_MARKER}`);
}

const headerLine = sql.slice(beginAt, sql.indexOf('\n', beginAt));
const stamp = headerLine.match(/VDA 5050 (\S+), (\d+) rows, sha256:([0-9a-f]+)/);
if (!stamp) fail('the BEGIN marker carries no version/row-count/digest stamp', `saw: ${headerLine}`);
const [, version, declaredRows, declaredDigest] = stamp;

const anchor = sql.indexOf('CI verifies the digest above.', beginAt);
if (anchor < 0 || anchor > endAt) fail('the generated header is malformed');
const body = sql.slice(sql.indexOf('\n', anchor) + 1, endAt).replace(/\n$/, '');

const actualDigest = createHash('sha256').update(body).digest('hex').slice(0, 16);
if (actualDigest !== declaredDigest) {
  fail('the vocabulary block has been edited since it was generated',
       `declared sha256:${declaredDigest}`, `actual   sha256:${actualDigest}`,
       'These fields are read from the VDA\'s schema, not written by this repository.');
}

const statements = [...body.matchAll(
  /^INSERT INTO public\.vda5050_vocabulary VALUES \('([^']+)', '([A-Za-z0-9]+)', (?:'([^']*)'|NULL), (?:'((?:[^']|'')*)'|NULL), (?:ARRAY\[((?:'[A-Za-z0-9_]+'(?:, )?)+)\]|NULL), '([^']+)'\)$/gm
)];
if (statements.length !== Number(declaredRows)) {
  fail(`the marker declares ${declaredRows} rows but ${statements.length} parsed`,
       'either a row was removed by hand or the statement form changed.',
       'A description on more than one line would also do this: the generator collapses whitespace so each',
       'row is one line, which is what the digest is taken over.');
}

const datatypes = new Set(Object.values(DATATYPES));
const seen = new Set();
for (const [, name, datatype, , , values, semanticId] of statements) {
  if (!datatypes.has(datatype)) fail(`'${name}' has datatype '${datatype}'`, `allowed: ${[...datatypes].join(', ')}`);
  if (values && datatype !== 'String') fail(`'${name}' is a ${datatype} with permitted values`, 'only a string enum carries them.');
  if (seen.has(name)) fail(`duplicate field '${name}'`, 'the table is keyed on name alone.');
  seen.add(name);

  if (semanticId !== vda5050SemanticId(name)) {
    fail(`semantic id does not match the minted form for '${name}'`,
         `expected ${vda5050SemanticId(name)}`, `actual   ${semanticId}`,
         `These ids are minted here under ${SEMANTIC_BASE}, pinned to the major line: the VDA issues none,`,
         'and one under its own name would assert an interoperability nobody agreed.');
  }
}

// The rows are the kept fields and no others: a field the schema holds that nobody decided on, or a
// row dropped by hand with the digest recomputed, shows here.
const missing = KEPT.filter(name => !seen.has(name));
const extra = [...seen].filter(name => !KEPT.includes(name));
if (missing.length || extra.length) {
  fail('the rows are not the fields scripts/lib/vda5050-vocabulary.mjs keeps',
       missing.length ? `missing: ${missing.join(', ')}` : '', extra.length ? `extra: ${extra.join(', ')}` : '');
}

// The group the fields file under, registered by the same migration, and what its description says.
const group = sql.match(/INSERT INTO public\.metric_groups \(id, name, description, standard\)\s*VALUES \('[^']*', '([^']+)',\s*'((?:[^']|'')*)',\s*'([^']+)'\)/);
if (!group) fail('0302 registers no metric group');
if (group[1] !== 'AGV' || group[3] !== 'VDA 5050') fail(`0302 registers the group '${group[1]}' under '${group[3]}', not AGV under VDA 5050`);
if (!/calls the vehicle a mobile robot/.test(group[2])) {
  fail('the AGV group\'s description does not say that VDA 5050 3.0 calls the vehicle a mobile robot');
}

console.log(`VDA 5050 vocabulary intact: ${statements.length} fields, ${version}, sha256:${actualDigest}.`);
console.log('  Digest, semantic-id form, datatypes, name uniqueness, the kept fields and the AGV group verified.');
