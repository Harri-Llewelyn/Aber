/**
 * Verify the generated OPC UA companion-specification blocks in 0002_seed_data.sql are intact. Same
 * discipline as scripts/check-mtconnect-seed-sync.mjs: the digest is recomputed from the file that
 * executes, with no network needed. CI runs the generator first and then this, which also catches
 * an upstream release moving under the pin. Two blocks: the vocabulary rows and the metric_groups
 * rows land in different parts of the seed, and enforce_metric_group_spelling() makes the first
 * spelling of a group permanent. The generator also writes the dashboard's group per data point,
 * which is held to both.
 *
 * Usage: node scripts/check-opcua-seed-sync.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COMMENT_BEGIN, COMMENT_END, tableCommentStatement } from './lib/opcua-vocabulary-comment.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = join(ROOT, 'supabase', 'migrations', '0002_seed_data.sql');

const BLOCKS = [
  {
    label: 'opcua_vocabulary',
    begin: '-- >>> BEGIN GENERATED opcua_vocabulary_rows',
    end: '-- <<< END GENERATED opcua_vocabulary_rows'
  },
  {
    label: 'metric_groups',
    begin: '-- >>> BEGIN GENERATED opcua_metric_groups',
    end: '-- <<< END GENERATED opcua_metric_groups'
  }
];

/**
 * Each specification's namespace, mirrored so the check can assert the id form independently: every
 * row's id is an ExpandedNodeId in its own specification's namespace.
 */
const NAMESPACES = {
  'OPC 40001 Machinery': 'http://opcfoundation.org/UA/Machinery/',
  'OPC 40010 Robotics': 'http://opcfoundation.org/UA/Robotics/',
  'OPC 40501 Machine Tools': 'http://opcfoundation.org/UA/MachineTool/',
  'OPC 40540 Additive Manufacturing': 'http://opcfoundation.org/UA/AdditiveManufacturing/',
  'OPC 30050 PackML': 'http://opcfoundation.org/UA/PackML/',
  'OPC 40001-4 Machinery Energy': 'http://opcfoundation.org/UA/Machinery/Energy/'
};

const fail = (message, ...detail) => {
  console.error(`OPC UA vocabulary check FAILED: ${message}`);
  for (const line of detail) console.error(`  ${line}`);
  console.error('  Regenerate with: node scripts/generate-opcua-vocabulary.mjs');
  process.exit(1);
};

// Normalised first: git checks the seed out as CRLF on Windows. See check-mtconnect-seed-sync.mjs.
const seed = readFileSync(SEED, 'utf8').replace(/\r\n/g, '\n');

const bodies = {};
for (const block of BLOCKS) {
  const beginAt = seed.indexOf(block.begin);
  const endAt = seed.indexOf(block.end);
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    fail(`the ${block.label} block markers are missing from 0002_seed_data.sql`,
         `expected ${block.begin} ... ${block.end}`);
  }

  const headerLine = seed.slice(beginAt, seed.indexOf('\n', beginAt));
  const stamp = headerLine.match(/(\d+) rows, sha256:([0-9a-f]+)/);
  if (!stamp) fail(`the ${block.label} BEGIN marker carries no row-count/digest stamp`, `saw: ${headerLine}`);
  const [, declaredRows, declaredDigest] = stamp;

  const anchor = seed.indexOf('CI verifies the digest above.', beginAt);
  if (anchor < 0 || anchor > endAt) fail(`the ${block.label} generated header is malformed`);
  const body = seed.slice(seed.indexOf('\n', anchor) + 1, endAt).replace(/\n$/, '');

  const actualDigest = createHash('sha256').update(body).digest('hex').slice(0, 16);
  if (actualDigest !== declaredDigest) {
    fail(`the ${block.label} block has been edited since it was generated`,
         `declared sha256:${declaredDigest}`,
         `actual   sha256:${actualDigest}`,
         'Browse names and datatypes in these rows are read from the OPC Foundation NodeSets;',
         'editing them here detaches the seed from the specification it claims to describe.');
  }
  bodies[block.label] = { body, declaredRows: Number(declaredRows), digest: actualDigest };
}

/** Structural assertions: a digest proves the block is unchanged, never that it was right. */
const vocab = bodies.opcua_vocabulary;
const statements = [...vocab.body.matchAll(
  /^INSERT INTO public\.opcua_vocabulary VALUES \('((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', '([^']+)', (?:'([^']+)'|NULL), '([^']+)'\)$/gm
)];

if (statements.length !== vocab.declaredRows) {
  fail(`the marker declares ${vocab.declaredRows} vocabulary rows but ${statements.length} parsed`,
       'either a row was removed by hand or the statement form changed.');
}

const escapeRegExp = (text) => text.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');

// Every row is generated: an INSERT outside the block would be a hand-written row.
const everywhere = (seed.match(/^INSERT INTO public\.opcua_vocabulary\b/gm) || []).length;
if (everywhere !== statements.length) {
  fail(`0002_seed_data.sql inserts ${everywhere} opcua_vocabulary rows, ${statements.length} of them in the generated block`,
       'Add the row to ENTRIES in the generator instead of writing it by hand.');
}

const seenKeys = new Set();
const seenIds = new Map();
for (const [, name, companionSpec, nodeId, , datatype, unit, semanticId] of statements) {
  const unescaped = name.replace(/''/g, "'");
  const namespace = NAMESPACES[companionSpec];
  if (!namespace) {
    fail(`unknown companion_spec '${companionSpec}' for '${unescaped}'`,
         `known: ${Object.keys(NAMESPACES).join(', ')}`);
  }

  // The table is keyed on this pair precisely because two specifications legitimately define the
  // same name -- Machinery Energy's `Mass` is a utility flow, Robotics' is a payload weight.
  const key = `${companionSpec} ${unescaped}`;
  if (seenKeys.has(key)) {
    fail(`duplicate (companion_spec, name): (${companionSpec}, ${unescaped})`,
         'the table is keyed on this pair, so one of the two would be silently discarded.');
  }
  seenKeys.add(key);

  // The identifier OPC UA publishes, in the row's own namespace, as both columns.
  if (!new RegExp(`^nsu=${escapeRegExp(namespace)};[isgb]=[^;]+$`).test(semanticId)) {
    fail(`semantic id for (${companionSpec}, ${unescaped}) is not an ExpandedNodeId in ${namespace}`,
         `expected nsu=${namespace};i=<id>`, `actual   ${semanticId}`);
  }
  if (nodeId !== semanticId) {
    fail(`node_id and semantic_id differ for (${companionSpec}, ${unescaped})`,
         `node_id     ${nodeId}`, `semantic_id ${semanticId}`);
  }
  if (seenIds.has(semanticId)) {
    fail(`(${companionSpec}, ${unescaped}) and ${seenIds.get(semanticId)} carry the same id ${semanticId}`);
  }
  seenIds.set(semanticId, `(${companionSpec}, ${unescaped})`);

  // Sparkplug has no enumeration type and no fixed-width unsigned beyond what these map onto; a
  // datatype outside this set means the generator resolved something it should have curated.
  const ALLOWED = ['Boolean', 'String', 'Double', 'Float', 'Int16', 'Int32', 'Int64',
                   'UInt16', 'UInt32', 'UInt64', 'DateTime', 'LocalizedText'];
  if (!ALLOWED.includes(datatype)) {
    fail(`'${unescaped}' has datatype '${datatype}', which is not one this platform can model`,
         `allowed: ${ALLOWED.join(', ')}`,
         'A specification-defined enumeration should have been resolved to String by the generator.');
  }
  if (unit && unit !== unit.toUpperCase()) {
    fail(`'${unescaped}' has unit '${unit}', which is not upper-case`,
         'Units are drawn from the MTConnect unit vocabulary, which is upper-case throughout.');
  }
}

const groups = bodies.metric_groups;
const groupStatements = [...groups.body.matchAll(
  /^INSERT INTO public\.metric_groups \(id, name, description, standard\) VALUES \('([^']+)', '([^']+)', '((?:[^']|'')*)', 'OPC UA'\)$/gm
)];
if (groupStatements.length !== groups.declaredRows) {
  fail(`the marker declares ${groups.declaredRows} metric_groups rows but ${groupStatements.length} parsed`);
}
for (const [, , groupName] of groupStatements) {
  if (groupName.includes('/')) {
    fail(`metric group '${groupName}' contains a slash`,
         'metric_groups_name_is_one_segment rejects it: a group is one path segment, not a path.');
  }
}

// The table comment is recomputed from the whole seed, so a specification added by hand fails here
// until the generator is re-run.
{
  const beginAt = seed.indexOf(COMMENT_BEGIN);
  const endAt = seed.indexOf(COMMENT_END);
  if (beginAt < 0 || endAt < beginAt) fail('the opcua_vocabulary table comment block is missing from 0002_seed_data.sql');
  const actual = seed.slice(beginAt, endAt).split('\n').find((l) => l.startsWith('COMMENT ON TABLE'));
  const expected = tableCommentStatement(seed, Object.keys(NAMESPACES));
  if (actual !== expected) {
    fail('the opcua_vocabulary table comment does not name the specifications the seed holds',
         `expected ${expected}`, `actual   ${actual ?? '(none)'}`);
  }
}

// The dashboard's group per data point (frontend/src/utils/opcuaGroups.generated.js): unedited,
// one entry per row, each naming a group the seed registers under OPC UA.
const GROUPS_MODULE = 'frontend/src/utils/opcuaGroups.generated.js';
{
  const text = readFileSync(join(ROOT, GROUPS_MODULE), 'utf8').replace(/\r\n/g, '\n');
  const stamp = text.match(/^\/\/ GENERATED by scripts\/generate-opcua-vocabulary\.mjs -- (\d+) points, sha256:([0-9a-f]+)$/m);
  const body = text.match(/^export const OPCUA_GROUPS = \{\n([\s\S]*)\n\}\n$/m);
  if (!stamp || !body) fail(`${GROUPS_MODULE} is not in the form the generator writes`);
  const digest = createHash('sha256').update(body[1]).digest('hex').slice(0, 16);
  if (digest !== stamp[2]) {
    fail(`${GROUPS_MODULE} has been edited since it was generated`, `declared sha256:${stamp[2]}`, `actual   sha256:${digest}`);
  }
  const registered = new Set();
  for (const [, group] of seed.matchAll(/^INSERT INTO public\.metric_groups (?:\(id, name, description, standard\) )?VALUES \('[^']+', '([^']+)', .*'OPC UA'\)$/gm)) {
    registered.add(group);
  }
  const listed = new Set();
  let spec = null;
  for (const line of body[1].split('\n')) {
    const opened = line.match(/^ {2}'([^']+)': \{$/);
    const entry = line.match(/^ {4}'?([^':]+)'?: '([^']+)',?$/);
    if (opened) spec = opened[1];
    else if (entry && spec) {
      if (!registered.has(entry[2])) {
        fail(`${GROUPS_MODULE} files (${spec}, ${entry[1]}) under ${entry[2]}, which the seed does not register under OPC UA`);
      }
      listed.add(`${spec} ${entry[1]}`);
    }
  }
  const missing = [...seenKeys].filter((key) => !listed.has(key));
  const extra = [...listed].filter((key) => !seenKeys.has(key));
  if (missing.length || extra.length || Number(stamp[1]) !== listed.size) {
    fail(`${GROUPS_MODULE} does not list exactly the seeded data points`,
         ...missing.map((key) => `no group for ${key}`), ...extra.map((key) => `no row for ${key}`));
  }
}

console.log(`OPC UA vocabulary intact: ${statements.length} rows across ` +
            `${Object.keys(NAMESPACES).length} companion specifications, sha256:${vocab.digest}.`);
console.log(`  ${groupStatements.length} metric_groups rows, sha256:${groups.digest}.`);
console.log('  Digests, ExpandedNodeId ids (node_id = semantic_id), datatypes, key uniqueness and the');
console.log(`  dashboard's groups (${GROUPS_MODULE}) all verified.`);
