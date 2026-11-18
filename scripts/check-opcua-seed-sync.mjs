/**
 * Verify the generated OPC UA companion-specification blocks in the migrations are intact. Same
 * discipline as scripts/check-mtconnect-seed-sync.mjs: the digest is recomputed from the file that
 * executes, with no network needed. CI runs the generator first and then this, which also catches
 * an upstream release moving under the pin.
 *
 * The vocabulary is seeded in BLOCKS, one per migration that grew it (scripts/lib/opcua-seed-blocks.mjs
 * says why and how). Each block has three regions: the metric_groups rows, which land apart from the
 * vocabulary rows, because enforce_metric_group_spelling() makes the first spelling of a group
 * permanent; the vocabulary rows; and the table's COMMENT, which names every specification seeded up
 * to and including that block. This check holds each block to its digests and to the rules below, and
 * the blocks to each other. The generator also writes the dashboard's group per data point, which is
 * held to every block.
 *
 * Usage: node scripts/check-opcua-seed-sync.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { BLOCKS, REGIONS, digestOf, groupUuid, readDigestRegion, regionAt } from './lib/opcua-seed-blocks.mjs';
import { tableCommentStatement } from './lib/opcua-vocabulary-comment.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

/**
 * Each specification's namespace, mirrored so the check can assert the id form independently: every
 * row's id is an ExpandedNodeId in its own specification's namespace.
 */
const NAMESPACES = {
  'OPC 40001 Machinery': 'http://opcfoundation.org/UA/Machinery/',
  'OPC 40001-2 Machinery Process Values': 'http://opcfoundation.org/UA/Machinery/ProcessValues/',
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
const text = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const VOCABULARY_ROW = /^INSERT INTO public\.opcua_vocabulary VALUES \('((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', '([^']+)', (?:'([^']+)'|NULL), '([^']+)'\)$/gm;
const GROUP_INSERT = /^INSERT INTO public\.metric_groups \(id, name, description, standard\) VALUES \('([^']+)', '([^']+)', '((?:[^']|'')*)', 'OPC UA'\)$/gm;
const GROUP_UPDATE = /^UPDATE public\.metric_groups SET description = '((?:[^']|'')*)'\n WHERE id = '([^']+)' AND description = '((?:[^']|'')*)';$/gm;

const escapeRegExp = (value) => value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');

// The blocks, in the order their migrations run.
const names = BLOCKS.map((block) => basename(block.file));
if (names.join() !== names.slice().sort().join()) fail('BLOCKS is not in the order of the migrations', names.join(', '));
for (const block of BLOCKS) {
  if (!basename(block.file).startsWith(`${block.since}_`)) {
    fail(`block ${block.since} names ${block.file}, which is not migration ${block.since}`);
  }
}

const blocks = BLOCKS.map((block) => {
  const file = text(join(ROOT, block.file));
  const regions = {};
  for (const [kind, region] of Object.entries(REGIONS)) {
    if (!regionAt(file, region)) {
      fail(`the ${region.label} region markers are missing from ${block.file}`, `expected ${region.begin} ... ${region.end}`);
    }
    if (kind === 'comment') continue;
    const read = readDigestRegion(file, region);
    if (read.malformed !== undefined) {
      fail(`the ${region.label} BEGIN marker of ${block.file} carries no row-count/digest stamp, or its header is malformed`,
           `saw: ${read.malformed}`);
    }
    if (read.actual !== read.digest) {
      fail(`the ${region.label} region of ${block.file} has been edited since it was generated`,
           `declared sha256:${read.digest}`,
           `actual   sha256:${read.actual}`,
           'Browse names and datatypes in these rows are read from the OPC Foundation NodeSets;',
           'editing them here detaches the seed from the specification it claims to describe.');
    }
    regions[kind] = read;
  }
  return { block, file, regions };
});

/** Structural assertions: a digest proves a block is unchanged, never that it was right. */
const seenKeys = new Set();
const seenIds = new Map();
const allRows = [];

for (const { block, regions } of blocks) {
  const vocabulary = regions.vocabulary;
  const statements = [...vocabulary.body.matchAll(VOCABULARY_ROW)];
  if (statements.length !== vocabulary.rows) {
    fail(`the ${block.since} block declares ${vocabulary.rows} vocabulary rows but ${statements.length} parsed`,
         'either a row was removed by hand or the statement form changed.');
  }

  for (const [statement, name, companionSpec, nodeId, , datatype, unit, semanticId] of statements) {
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
    const ALLOWED = ['Boolean', 'String', 'Double', 'Float', 'Byte', 'SByte', 'Int16', 'Int32', 'Int64',
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
    allRows.push({ block, statement });
  }
}

// Every row is generated: an INSERT outside a block, in any migration, would be a hand-written row.
for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
  const inserted = (text(join(MIGRATIONS, file)).match(/^INSERT INTO public\.opcua_vocabulary\b/gm) || []).length;
  const own = blocks.find(({ block }) => basename(block.file) === file);
  const generated = own ? own.regions.vocabulary.rows : 0;
  if (inserted !== generated) {
    fail(`${file} inserts ${inserted} opcua_vocabulary rows, ${generated} of them in a generated block`,
         'Add the row to ENTRIES in the generator instead of writing it by hand.');
  }
}

// The groups each block registers, and the descriptions it changes. A group is named once across the
// blocks, and a change replaces exactly the text an earlier block registered.
const registered = new Map();
for (const { block, regions } of blocks) {
  const groups = regions.groups;
  const inserts = [...groups.body.matchAll(GROUP_INSERT)];
  const updates = [...groups.body.matchAll(GROUP_UPDATE)];
  if (inserts.length + updates.length !== groups.rows) {
    fail(`the ${block.since} block declares ${groups.rows} metric_groups statements but ${inserts.length + updates.length} parsed`);
  }
  for (const [, id, groupName, description] of inserts) {
    if (groupName.includes('/')) {
      fail(`metric group '${groupName}' contains a slash`,
           'metric_groups_name_is_one_segment rejects it: a group is one path segment, not a path.');
    }
    if (id !== groupUuid(groupName)) fail(`metric group '${groupName}' carries the id ${id}, not the one its name derives`);
    if (registered.has(groupName)) fail(`metric group '${groupName}' is registered by the ${registered.get(groupName).since} block and again by the ${block.since} block`);
    registered.set(groupName, { id, since: block.since, description });
  }
  for (const [, description, id, was] of updates) {
    const earlier = [...registered.entries()].find(([, group]) => group.id === id);
    if (!earlier) fail(`the ${block.since} block rewords the metric group ${id}, which no block up to it registers`);
    const [groupName, group] = earlier;
    if (group.description !== was) {
      fail(`the ${block.since} block rewords '${groupName}' from a text the ${group.since} block did not register`,
           `registered ${group.description}`, `guarded on ${was}`,
           'The UPDATE is guarded on the text it replaces, so one that names another text changes nothing.');
    }
    if (description === was) fail(`the ${block.since} block rewords '${groupName}' to the text it already has`);
    group.description = description;
  }
}

// The table comment of each block names the specifications seeded up to it, so the last one in
// migration order is the live one.
for (const { block, file } of blocks) {
  const at = regionAt(file, REGIONS.comment);
  const actual = file.slice(at.beginAt, at.endAt).split('\n').find((line) => line.startsWith('COMMENT ON TABLE'));
  const upTo = allRows
    .filter((row) => BLOCKS.indexOf(row.block) <= BLOCKS.indexOf(block))
    .map((row) => row.statement)
    .join('\n');
  const expected = tableCommentStatement(upTo, Object.keys(NAMESPACES));
  if (actual !== expected) {
    fail(`the opcua_vocabulary table comment of the ${block.since} block does not name the specifications seeded up to it`,
         `expected ${expected}`, `actual   ${actual ?? '(none)'}`);
  }
}

// The dashboard's group per data point (frontend/src/utils/opcuaGroups.generated.js): unedited,
// one entry per row, each naming a group a block registers under OPC UA.
const GROUPS_MODULE = 'frontend/src/utils/opcuaGroups.generated.js';
{
  const module = text(join(ROOT, GROUPS_MODULE));
  const stamp = module.match(/^\/\/ GENERATED by scripts\/generate-opcua-vocabulary\.mjs -- (\d+) points, sha256:([0-9a-f]+)$/m);
  const body = module.match(/^export const OPCUA_GROUPS = \{\n([\s\S]*)\n\}\n$/m);
  if (!stamp || !body) fail(`${GROUPS_MODULE} is not in the form the generator writes`);
  const digest = digestOf(body[1]);
  if (digest !== stamp[2]) {
    fail(`${GROUPS_MODULE} has been edited since it was generated`, `declared sha256:${stamp[2]}`, `actual   sha256:${digest}`);
  }
  // The groups a block registers, and the hand-written rows beside them (Machine, MotionDevice).
  const known = new Set(registered.keys());
  for (const { file } of blocks) {
    for (const [, group] of file.matchAll(/^INSERT INTO public\.metric_groups VALUES \('[^']+', '([^']+)', .*'OPC UA'\)$/gm)) {
      known.add(group);
    }
  }
  const listed = new Set();
  let spec = null;
  for (const line of body[1].split('\n')) {
    const opened = line.match(/^ {2}'([^']+)': \{$/);
    const entry = line.match(/^ {4}'?([^':]+)'?: '([^']+)',?$/);
    if (opened) spec = opened[1];
    else if (entry && spec) {
      if (!known.has(entry[2])) {
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

console.log(`OPC UA vocabulary intact: ${allRows.length} rows across ` +
            `${Object.keys(NAMESPACES).length} companion specifications in ${blocks.length} blocks.`);
for (const { block, regions } of blocks) {
  console.log(`  ${block.since}: ${regions.vocabulary.rows} rows sha256:${regions.vocabulary.digest}, ` +
              `${regions.groups.rows} metric_groups statements sha256:${regions.groups.digest}.`);
}
console.log('  Digests, ExpandedNodeId ids (node_id = semantic_id), datatypes, key uniqueness, hand-written rows,');
console.log(`  group rewordings and the dashboard's groups (${GROUPS_MODULE}) all verified.`);
