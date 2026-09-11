/**
 * Verify the generated ASHRAE 223P block in 0002_seed_data.sql is intact. As for the MTConnect and
 * OPC UA checks, the digest is recomputed from the file that executes, with no network needed. CI
 * runs the generator first and then this, which also catches an upstream release moving under the
 * pin; 223P is still in public review, so its concepts can change.
 *
 * Usage: node scripts/check-ashrae223-seed-sync.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '0002_seed_data.sql');
const BEGIN_MARKER = '-- >>> BEGIN GENERATED ashrae223_vocabulary';
const END_MARKER = '-- <<< END GENERATED ashrae223_vocabulary';

const NAMESPACE = 'http://data.ashrae.org/standard223#';
const KINDS = ['Class', 'AbstractClass', 'Concept', 'Relation', 'EnumerationKind'];

const fail = (message, ...detail) => {
  console.error(`ASHRAE 223P vocabulary check FAILED: ${message}`);
  for (const line of detail) console.error(`  ${line}`);
  console.error('  Regenerate with: node scripts/generate-ashrae223-vocabulary.mjs');
  process.exit(1);
};

// Normalised first: git checks this out as CRLF on Windows, and a digest over the raw bytes would
// fail on every Windows clone while passing in CI.
const sql = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');
const beginAt = sql.indexOf(BEGIN_MARKER);
const endAt = sql.indexOf(END_MARKER);
if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
  fail('the generated block markers are missing', `expected ${BEGIN_MARKER} ... ${END_MARKER}`);
}

const headerLine = sql.slice(beginAt, sql.indexOf('\n', beginAt));
const stamp = headerLine.match(/(v[\d.a-z-]+), (\d+) rows, sha256:([0-9a-f]+)/);
if (!stamp) fail('the BEGIN marker carries no version/row-count/digest stamp', `saw: ${headerLine}`);
const [, version, declaredRows, declaredDigest] = stamp;

const anchor = sql.indexOf('CI verifies the digest above.', beginAt);
if (anchor < 0 || anchor > endAt) fail('the generated header is malformed');
const body = sql.slice(sql.indexOf('\n', anchor) + 1, endAt).replace(/\n$/, '');

const actualDigest = createHash('sha256').update(body).digest('hex').slice(0, 16);
if (actualDigest !== declaredDigest) {
  fail('the vocabulary block has been edited since it was generated',
       `declared sha256:${declaredDigest}`, `actual   sha256:${actualDigest}`,
       'These concepts are owned by ASHRAE and read from the open223 ontology, not by this repository.');
}

const statements = [...body.matchAll(
  /^INSERT INTO public\.ashrae223_vocabulary VALUES \('([^']+)', '([^']+)', '((?:[^']|'')*)', (?:'((?:[^']|'')*)'|NULL), (?:'([^']+)'|NULL), '([^']+)'\)$/gm
)];

if (statements.length !== Number(declaredRows)) {
  fail(`the marker declares ${declaredRows} rows but ${statements.length} parsed`,
       'either a row was removed by hand or the statement form changed.',
       'A multi-line description would also do this: the generator collapses whitespace to keep',
       'one statement per line, and that property is what the digest is taken over.');
}

const seen = new Set();
const names = new Set(statements.map((s) => s[1]));
for (const [, name, kind, , , parent, semanticId] of statements) {
  if (!KINDS.includes(kind)) fail(`'${name}' has concept_kind '${kind}'`, `allowed: ${KINDS.join(', ')}`);
  if (seen.has(name)) fail(`duplicate concept '${name}'`, 'the table is keyed on name alone.');
  seen.add(name);

  const expected = `${NAMESPACE}${name}`;
  if (semanticId !== expected) {
    fail(`semantic id does not match the ASHRAE namespace for '${name}'`,
         `expected ${expected}`, `actual   ${semanticId}`,
         'These ids are issued by ASHRAE; one minted locally would assert an interoperability',
         'nobody agreed to. See archived migration 0029.');
  }
  // A dangling parent would give the vocabulary panel a section header for a concept that is not
  // in the table -- the kind of thing that renders as an empty group and reads as a data loss.
  if (parent && !names.has(parent)) {
    fail(`'${name}' is a subclass of '${parent}', which is not in the vocabulary`);
  }
}

// QUDT is deliberately out of scope; a quantity kind arriving here means the import was followed.
if ([...names].some((n) => n.includes('/') || n.includes('#'))) {
  fail('a concept name carries a path or fragment separator, which suggests a foreign namespace');
}

console.log(`ASHRAE 223P vocabulary intact: ${statements.length} concepts, ${version}, sha256:${actualDigest}.`);
console.log('  Digest, semantic-id namespace, concept kinds, name uniqueness and subclass links verified.');
