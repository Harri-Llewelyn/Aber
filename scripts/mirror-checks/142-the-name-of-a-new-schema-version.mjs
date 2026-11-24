import { compare, lastDefinition, need, read } from './lib.mjs';

// 142. The name of a new schema version, one rule in three places (0318): fork_schema() names the
// draft, apply_device_schemas() names the one a document makes, and nextVersionName() predicts it in
// the Create Version dialog. Each is the lineage's name, `_v` and the parent's version plus one; the two
// functions number it further the same way while that name is taken, which the dialog does not predict.
// A dialog that reads another column promises a name the database will not give, and two functions that
// differ name one version two things. For a row with no lineage_name the dialog takes the stem of its
// own name, where the labels of check 113 take the whole name.
export default function check() {
  const fork = lastDefinition('CREATE OR REPLACE FUNCTION public.fork_schema(', '$$;', 'fork_schema()');
  const apply = lastDefinition('CREATE OR REPLACE FUNCTION public.apply_device_schemas(', '$$;', 'apply_device_schemas()');
  const parse = lastDefinition('CREATE OR REPLACE FUNCTION public.device_schemas_parse(', '$$;', 'device_schemas_parse()');
  const util = read('frontend/src/utils/schemaVersion.js');
  if (!fork || !apply || !parse) return;

  const js = need(util, /export const nextVersionName = \(schema\) =>\s+`\$\{schema\?\.(\w+) \|\| (\w+)\(schema\?\.(\w+)\)\}(_[a-z]+)\$\{nextVersion\(schema\)\}`/,
    'nextVersionName() in schemaVersion.js');
  const jsNext = need(util, /export const nextVersion = \(schema\) => schemaVersion\(schema\) \+ (\d+)/, 'nextVersion() in schemaVersion.js');

  const forkBase = need(fork.body, /v_base := parent\.(\w+);/, `what fork_schema() names a version from (${fork.file})`);
  const forkName = need(fork.body, /v_name := v_base \|\| '(_[a-z]+)' \|\| v_next;/, `the name fork_schema() gives (${fork.file})`);
  const forkNext = need(fork.body, /v_next := parent\.version \+ (\d+);/, `the number fork_schema() gives (${fork.file})`);
  const forkTaken = need(fork.body, /v_name := v_base \|\| '(_[a-z]+)' \|\| v_next \|\| '(_)' \|\| v_suffix;/,
    `how fork_schema() numbers a taken name further (${fork.file})`);

  const applyName = need(apply.body, /v_name := \(v_canon ->> '(\w+)'\) \|\| '(_[a-z]+)' \|\| v_version;/,
    `the name apply_device_schemas() gives (${apply.file})`);
  const applyNext = need(apply.body, /v_version := v_head\.version \+ (\d+);/, `the number apply_device_schemas() gives (${apply.file})`);
  const applyTaken = need(apply.body, /v_name := \(v_canon ->> '(\w+)'\) \|\| '(_[a-z]+)' \|\| v_version \|\| '(_)' \|\| v_suffix;/,
    `how apply_device_schemas() numbers a taken name further (${apply.file})`);
  // The checked schema's key and the column device_schemas_parse() fills it from, for the version in force.
  const canon = need(parse.body, /'(\w+)', v_lineage, 'head', v_head_id/, `the lineage the checked schema carries (${parse.file})`);
  const head = need(parse.body, /SELECT s\.id, s\.(\w+), s\.schema_definition\s+INTO v_head_id, v_lineage, v_head_def/,
    `the column device_schemas_parse() reads a lineage from (${parse.file})`);
  if (!js || !jsNext || !forkBase || !forkName || !forkNext || !forkTaken || !applyName || !applyNext || !applyTaken || !canon || !head) return;

  compare('nextSchemaVersionName', `the column nextVersionName() and fork_schema() name a version from (${fork.file})`, js[1], forkBase[1]);
  compare('nextSchemaVersionName', `the column a document's version is named from, through the checked schema (${parse.file}), and fork_schema()'s`,
    applyName[1] === canon[1] ? head[1] : `the checked schema's ${applyName[1]}`, forkBase[1]);
  compare('nextSchemaVersionName', 'what comes before the number in nextVersionName() and in both functions',
    js[4], [...new Set([forkName[1], forkTaken[1], applyName[2], applyTaken[2]])].join(' or '));
  compare('nextSchemaVersionName', "what each adds to the parent's version", jsNext[1], [...new Set([forkNext[1], applyNext[1]])].join(' or '));
  compare('nextSchemaVersionName', `how fork_schema() and apply_device_schemas() number a taken name further (${apply.file})`,
    `${forkTaken[1]}<n>${forkTaken[2]}<k>`, applyTaken[1] === applyName[1] ? `${applyTaken[2]}<n>${applyTaken[3]}<k>` : `${applyTaken[1]}, not ${applyName[1]}`);
  compare('nextSchemaVersionName', 'what nextVersionName() takes for a row with no lineage_name', `${js[2]}(${js[3]})`, 'baseSchemaName(schema_name)');
}
