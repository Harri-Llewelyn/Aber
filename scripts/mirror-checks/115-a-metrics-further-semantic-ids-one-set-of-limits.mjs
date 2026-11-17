import { compare, lastDefinition, need, problems, read, SCHEMA } from './lib.mjs';

// 115. A metric's further semantic ids, one set of limits in two places (0299): the most a metric
// carries, and the longest id and source, in enforce_metric_semantic_id() and the table's CHECKs, and in
// utils/furtherSemanticIds.js, which the Edit dialog asks before it offers Add. A limit the dialog states
// and the database does not is a button that errors on every press; the reverse is a dialog that refuses
// what the database would take. The database holds the limits for every writer, so the dashboard's copy
// is only what saves the round trip, and it must not say more or less.
export default function check() {
  const enforce = lastDefinition('CREATE OR REPLACE FUNCTION public.enforce_metric_semantic_id(', '$$;', 'enforce_metric_semantic_id()');
  const idCheck = need(SCHEMA, /CONSTRAINT metric_semantic_ids_id_valid\s+CHECK \(\(\(semantic_id = btrim\(semantic_id\)\) AND \(char_length\(semantic_id\) >= 1\) AND \(char_length\(semantic_id\) <= (\d+)\)\)\)/,
    'metric_semantic_ids_id_valid in the migrations');
  const sourceCheck = need(SCHEMA, /CONSTRAINT metric_semantic_ids_source_valid\s+CHECK \(\(\(source IS NULL\) OR \(\(source = btrim\(source\)\) AND \(char_length\(source\) >= 1\) AND \(char_length\(source\) <= (\d+)\)\)\)\)/,
    'metric_semantic_ids_source_valid in the migrations');
  const js = read('frontend/src/utils/furtherSemanticIds.js');
  // Each exported number constant by name, from one fixed pattern.
  const constants = new Map([...js.matchAll(/^export const ([A-Z_]+) = (\d+)$/gm)].map((m) => [m[1], m[2]]));
  const constant = (name) => {
    if (constants.has(name)) return [null, constants.get(name)];
    problems.push(`could not find ${name} in frontend/src/utils/furtherSemanticIds.js -- the file's shape changed, so this check is no longer checking anything`);
    return null;
  };
  const jsMax = constant('MAX_FURTHER_SEMANTIC_IDS');
  const jsId = constant('FURTHER_ID_MAX_LENGTH');
  const jsSource = constant('FURTHER_SOURCE_MAX_LENGTH');
  const sqlMax = enforce && need(enforce.body, /c_max CONSTANT integer := (\d+);/, `c_max in enforce_metric_semantic_id() (${enforce.file})`);
  if (sqlMax && jsMax) {
    compare('furtherSemanticIds', `the most further ids a metric carries, in enforce_metric_semantic_id() (${enforce.file}) and the Edit dialog`, jsMax[1], sqlMax[1]);
  }
  if (idCheck && jsId) {
    compare('furtherSemanticIds', "the longest further semantic id, in the table's CHECK and the Edit dialog", jsId[1], idCheck[1]);
  }
  if (sourceCheck && jsSource) {
    compare('furtherSemanticIds', "the longest source of a further id, in the table's CHECK and the Edit dialog", jsSource[1], sourceCheck[1]);
  }
}
