/**
 * Verify the generated MTConnect vocabulary block in 0002_seed_data.sql has not been hand-edited.
 * The generator writes the seed directly and stamps a SHA-256 of the rows into the BEGIN marker;
 * this recomputes it from the file that executes. A digest rather than re-running the generator,
 * which fetches from raw.githubusercontent.com and would make CI red whenever GitHub is
 * unreachable.
 *
 * The data item types' definitions are a second generated block, in migration 0301 (0002 is
 * released, so its rows gained the column there). It is held to the same digest, and to the rows of
 * the first: a definition for a type the vocabulary does not hold would update nothing, and one
 * that still carries the model's markup would reach every AAS export that defines the concept.
 *
 * Usage: node scripts/check-mtconnect-seed-sync.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = join(ROOT, 'supabase', 'migrations', '0002_seed_data.sql');
const BEGIN_MARKER = '-- >>> BEGIN GENERATED mtconnect_vocabulary';
const END_MARKER = '-- <<< END GENERATED mtconnect_vocabulary';

/** Mirrors KIND_SEGMENT in the generator and the old archived migration 0032's SQL expression. */
const KIND_SEGMENT = {
  DATA_ITEM_TYPE: 'DataItemType',
  SUB_TYPE: 'SubType',
  UNIT: 'Unit',
  NATIVE_UNIT: 'NativeUnit',
  COMPONENT: 'Component',
};
const SEMANTIC_BASE = 'https://aber.local/semantics/mtconnect/v2.0';

const fail = (message, ...detail) => {
  console.error(`MTConnect vocabulary check FAILED: ${message}`);
  for (const line of detail) console.error(`  ${line}`);
  console.error('  Regenerate with: node scripts/generate-mtconnect-vocabulary.mjs');
  process.exit(1);
};

// Line endings are normalised first: git checks the file out as CRLF on Windows, so a digest over
// the raw bytes fails on every Windows clone while passing in CI. scripts/sync-helm-chart-files.mjs
// normalises for the same reason.
const seed = readFileSync(SEED, 'utf8').replace(/\r\n/g, '\n');
const beginAt = seed.indexOf(BEGIN_MARKER);
const endAt = seed.indexOf(END_MARKER);
if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
  fail('the generated block markers are missing from 0002_seed_data.sql',
       `expected ${BEGIN_MARKER} ... ${END_MARKER}`);
}

const headerLine = seed.slice(beginAt, seed.indexOf('\n', beginAt));
const stamp = headerLine.match(/MTConnect (\S+), (\d+) rows, sha256:([0-9a-f]+)/);
if (!stamp) {
  fail('the BEGIN marker carries no version/row-count/digest stamp', `saw: ${headerLine}`);
}
const [, version, declaredRows, declaredDigest] = stamp;

// The body is everything after the three-line generated header, up to the END marker. Reconstructed
// the same way the generator writes it so the digest is over identical bytes.
const afterHeader = seed.indexOf('\n', seed.indexOf('CI verifies the digest above.', beginAt)) + 1;
const body = seed.slice(afterHeader, endAt).replace(/\n$/, '');

const actualDigest = createHash('sha256').update(body).digest('hex').slice(0, 16);
if (actualDigest !== declaredDigest) {
  fail('the vocabulary block has been edited since it was generated',
       `declared sha256:${declaredDigest}`,
       `actual   sha256:${actualDigest}`,
       'These rows are reference data owned by the MTConnect Institute, not by this repository.');
}

/**
 * Structural assertions, because a digest only proves the block is unchanged, not that it was ever
 * right.
 */
const statements = [...body.matchAll(
  /^INSERT INTO public\.mtconnect_vocabulary VALUES \('([^']+)', '((?:[^']|'')*)', (?:'([^']+)'|NULL), '([^']+)'\)$/gm
)];

if (statements.length !== Number(declaredRows)) {
  fail(`the marker declares ${declaredRows} rows but ${statements.length} parsed`,
       'either a row was removed by hand or the statement form changed.');
}

const seenKeys = new Set();
for (const [, kind, name, category, semanticId] of statements) {
  const unescaped = name.replace(/''/g, "'");
  if (!KIND_SEGMENT[kind]) fail(`unknown kind '${kind}' for '${unescaped}'`);

  // \u0000, not the character itself: Semgrep's parser, not Node, reads a raw NUL as the file's end.
  const key = `${kind}\u0000${unescaped}`;
  if (seenKeys.has(key)) {
    fail(`duplicate (kind, name): (${kind}, ${unescaped})`,
         'the table is keyed on this pair, so one of the two would be silently discarded.');
  }
  seenKeys.add(key);

  const expected = `${SEMANTIC_BASE}/${KIND_SEGMENT[kind]}/${unescaped}`;
  if (semanticId !== expected) {
    fail(`semantic id does not match the documented form for (${kind}, ${unescaped})`,
         `expected ${expected}`, `actual   ${semanticId}`,
         'The namespace pins v2.0 — the MAJOR line, never SCHEMA_VERSION — and stays under',
         'aber.local: an id under mtconnect.org would assert an interoperability nobody agreed.');
  }

  // Only SAMPLE/EVENT/CONDITION carry a category, and only data item types have one at all.
  if (kind === 'DATA_ITEM_TYPE') {
    if (!['SAMPLE', 'EVENT', 'CONDITION'].includes(category)) {
      fail(`data item type '${unescaped}' has category '${category ?? 'NULL'}'`,
           'metric_catalog.category is CHECK-constrained to SAMPLE/EVENT/CONDITION.');
    }
  } else if (category) {
    fail(`'${unescaped}' is a ${kind} but carries category '${category}'`,
         'only data item types have a category; everything else must be NULL.');
  }
}

// -------------------------------------------------------------------------------------------------
// The definitions, in 0301's own block.
// -------------------------------------------------------------------------------------------------
const DEFINITIONS = join(ROOT, 'supabase', 'migrations', '0301_an_mtconnect_concept_carries_its_own_definition.sql');
const DEFINITIONS_BEGIN = '-- >>> BEGIN GENERATED mtconnect_descriptions';
const DEFINITIONS_END = '-- <<< END GENERATED mtconnect_descriptions';

const failDefinitions = (message, ...detail) => {
  console.error(`MTConnect definitions check FAILED: ${message}`);
  for (const line of detail) console.error(`  ${line}`);
  console.error('  Regenerate with: node scripts/generate-mtconnect-vocabulary.mjs');
  process.exit(1);
};

const migration = readFileSync(DEFINITIONS, 'utf8').replace(/\r\n/g, '\n');
const definitionsAt = migration.indexOf(DEFINITIONS_BEGIN);
const definitionsEnd = migration.indexOf(DEFINITIONS_END);
if (definitionsAt < 0 || definitionsEnd < 0 || definitionsEnd < definitionsAt) {
  failDefinitions('the generated block markers are missing from 0301', `expected ${DEFINITIONS_BEGIN} ... ${DEFINITIONS_END}`);
}
const definitionsHeader = migration.slice(definitionsAt, migration.indexOf('\n', definitionsAt));
const definitionsStamp = definitionsHeader.match(/MTConnect (\S+), (\d+) of (\d+) data item types, sha256:([0-9a-f]+)/);
if (!definitionsStamp) {
  failDefinitions('the BEGIN marker carries no version/row-count/digest stamp', `saw: ${definitionsHeader}`);
}
const [, definitionsVersion, declaredDefinitions, declaredTypes, declaredDefinitionsDigest] = definitionsStamp;

const definitionsAnchor = migration.indexOf('CI verifies the digest above.', definitionsAt);
if (definitionsAnchor < 0 || definitionsAnchor > definitionsEnd) failDefinitions('the generated header is malformed');
const definitionsBody = migration.slice(migration.indexOf('\n', definitionsAnchor) + 1, definitionsEnd).replace(/\n$/, '');

const actualDefinitionsDigest = createHash('sha256').update(definitionsBody).digest('hex').slice(0, 16);
if (actualDefinitionsDigest !== declaredDefinitionsDigest) {
  failDefinitions('the definitions block has been edited since it was generated',
    `declared sha256:${declaredDefinitionsDigest}`, `actual   sha256:${actualDefinitionsDigest}`,
    "These definitions are the MTConnect model's own text, not this repository's.");
}

const defined = [...definitionsBody.matchAll(/^ {2}\('([^']+)', '((?:[^']|'')*)'\),?$/gm)];
if (defined.length !== Number(declaredDefinitions)) {
  failDefinitions(`the marker declares ${declaredDefinitions} definitions but ${defined.length} parsed`,
    'either a row was removed by hand or the statement form changed. A definition on more than one',
    'line does this: the generator collapses whitespace so each row is one line.');
}
const UPDATE_OPENS = 'UPDATE public.mtconnect_vocabulary AS v\n   SET description = d.description\n  FROM (VALUES\n';
const UPDATE_CLOSES =
  "\n  ) AS d (name, description)\n WHERE v.kind = 'DATA_ITEM_TYPE'\n   AND v.name = d.name\n   AND v.description IS DISTINCT FROM d.description;";
if (!definitionsBody.startsWith(UPDATE_OPENS) || !definitionsBody.endsWith(UPDATE_CLOSES)) {
  failDefinitions('the statement around the rows is not the one the generator writes',
    'it must stay an UPDATE of DATA_ITEM_TYPE rows only, and touch a row only when its text differs.');
}

const dataItemTypes = new Set(
  statements.filter(([, kind]) => kind === 'DATA_ITEM_TYPE').map(([, , name]) => name.replace(/''/g, "'"))
);
if (dataItemTypes.size !== Number(declaredTypes)) {
  failDefinitions(`the marker counts ${declaredTypes} data item types, and 0002's block holds ${dataItemTypes.size}`);
}
const seenDefinitions = new Set();
for (const [, name, text] of defined) {
  if (!dataItemTypes.has(name)) {
    failDefinitions(`'${name}' has a definition and is not a data item type in the vocabulary`,
      'the UPDATE would match no row, so the text would be lost without a word.');
  }
  if (seenDefinitions.has(name)) failDefinitions(`two definitions for '${name}'`);
  seenDefinitions.add(name);

  const unescaped = text.replace(/''/g, "'");
  if (unescaped.trim() === '') failDefinitions(`the definition of '${name}' is empty`);
  // The model's markup is rendered out by scripts/lib/mtconnect-definitions.mjs; what is left here
  // would reach an AAS export as written.
  const markup = unescaped.match(/\{\{|\}\}|[*`<>]|&[a-z#0-9]+;/);
  if (markup) {
    failDefinitions(`the definition of '${name}' still carries markup (${JSON.stringify(markup[0])})`, unescaped);
  }
}

console.log(
  `MTConnect vocabulary intact: ${statements.length} rows, schema ${version}, sha256:${actualDigest}.`
);
console.log('  Digest, semantic-id form, category rules and (kind, name) uniqueness all verified.');
console.log(
  `MTConnect definitions intact: ${defined.length} of ${dataItemTypes.size} data item types, XSD ${definitionsVersion}, sha256:${actualDefinitionsDigest}.`
);
console.log('  Digest, statement form, the types they name and the absence of markup all verified.');
