import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 449. The API reference documents the further semantic ids as 0299 declares them: a route for the table
// with every verb its policies give an Administrator, a route for the crosswalk view, and a schema for
// each with the very columns the table and the view have, the types the CHECK admits, and the limits.
// A column the table has and the reference lacks is one an integration cannot know to send or read.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SPEC = 'docs/openapi.yaml';
  const FILE = 'supabase/migrations/0299_a_metric_can_carry_more_than_one_semantic_id.sql';
  const spec = read(SPEC);
  const sql = read(FILE);
  const problems449 = [];
  // A path's or a schema's block in the spec: from its key to the next key at its own indent.
  const block = (key, indent) => {
    const head = `\n${' '.repeat(indent)}${key}:\n`;
    const start = spec.indexOf(head);
    if (start < 0) return undefined;
    const lines = spec.slice(start + head.length).split('\n');
    // The block ends at the next line indented no deeper than its own key.
    const depth = (line) => line.length - line.trimStart().length;
    let n = 0;
    while (n < lines.length && (lines[n].trim() === '' || depth(lines[n]) > indent)) n += 1;
    return lines.slice(0, n).join('\n');
  };
  // The keys of a schema's properties: each at eight spaces, one to a line.
  const names = (text) => [...text.matchAll(/^ {8}([a-z_]+):/gm)].map((m) => m[1]).sort().join(', ');

  const columns = [...(sql.match(/CREATE TABLE IF NOT EXISTS public\.metric_semantic_ids \(\n([\s\S]*?)\n {4}CONSTRAINT /)?.[1] ?? '')
    .matchAll(/^ {4}([a-z_]+) /gm)].map((m) => m[1]);
  if (columns.length === 0) problems449.push(`${FILE}: could not read the table's columns -- its shape changed, so this check is no longer checking anything`);
  const row = block('MetricSemanticId', 4);
  const write = block('MetricSemanticIdWrite', 4);
  const crosswalk = block('MetricSemanticIdCrosswalk', 4);
  if (!row || !write || !crosswalk) problems449.push(`${SPEC} lacks MetricSemanticId, MetricSemanticIdWrite or MetricSemanticIdCrosswalk`);
  else {
    const documented = names(row.slice(row.indexOf('\n      properties:\n')));
    if (documented !== [...columns].sort().join(', ')) problems449.push(`${SPEC}: MetricSemanticId documents the columns "${documented}", ${FILE} gives the table "${[...columns].sort().join(', ')}"`);
    // What a writer may send: every column but the two the database stamps.
    const writable = columns.filter((c) => !['created_at', 'created_by'].includes(c)).sort().join(', ');
    const sent = names(write.slice(write.indexOf('\n      properties:\n')));
    if (sent !== writable) problems449.push(`${SPEC}: MetricSemanticIdWrite documents "${sent}", the writer may send "${writable}"`);
    // The view's columns, from its first SELECT: the alias after AS, or the column's own name.
    const view = sql.match(/CREATE OR REPLACE VIEW public\.metric_semantic_id_crosswalk[^\n]*\n SELECT ([\s\S]*?)\n {3}FROM public\.metric_catalog m/)?.[1] ?? '';
    const viewColumns = view.split(',\n').map((c) => c.trim().replace(/::text/g, '')).map((c) => c.match(/ AS ([a-z_]+)$/)?.[1] ?? c.replace(/^m\./, '')).sort().join(', ');
    const shown = names(crosswalk.slice(crosswalk.indexOf('\n      properties:\n')));
    if (viewColumns === '' || shown !== viewColumns) problems449.push(`${SPEC}: MetricSemanticIdCrosswalk documents "${shown}", ${FILE} gives the view "${viewColumns}"`);
    // The types and the limits the CHECKs hold.
    const types = [...(sql.match(/metric_semantic_ids_type_valid\s+CHECK \(\(semantic_id_type = ANY \(ARRAY\[([^\]]*)\]\)\)\)/)?.[1] ?? '').matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort().join(', ');
    const enums = [...row.matchAll(/semantic_id_type: \{ type: string, enum: \[([^\]]*)\]/g)].map((m) => m[1].split(',').map((t) => t.trim()).sort().join(', '));
    if (!types || enums.length !== 1 || enums[0] !== types) problems449.push(`${SPEC}: MetricSemanticId's types are "${enums.join('" and "')}", the CHECK admits "${types}"`);
    const idMax = sql.match(/char_length\(semantic_id\) <= (\d+)/)?.[1];
    const sourceMax = sql.match(/char_length\(source\) <= (\d+)/)?.[1];
    if (!idMax || !row.includes(`semantic_id: { type: string, minLength: 1, maxLength: ${idMax},`)) problems449.push(`${SPEC}: MetricSemanticId does not give the id the length ${idMax} the CHECK holds`);
    if (!sourceMax || !row.includes(`source: { type: string, nullable: true, maxLength: ${sourceMax},`)) problems449.push(`${SPEC}: MetricSemanticId does not give the source the length ${sourceMax} the CHECK holds`);
  }

  // The verbs: a policy for each command, and a route that documents it.
  const verbs = { SELECT: 'get', INSERT: 'post', UPDATE: 'patch', DELETE: 'delete' };
  const path = block('/rest/v1/metric_semantic_ids', 2);
  if (!path) problems449.push(`${SPEC} has no /rest/v1/metric_semantic_ids`);
  for (const m of sql.matchAll(/^CREATE POLICY metric_semantic_ids_\w+ ON public\.metric_semantic_ids FOR (\w+) /gm)) {
    if (path && !path.split('\n').includes(`    ${verbs[m[1]]}:`)) problems449.push(`${SPEC}: /rest/v1/metric_semantic_ids documents no ${verbs[m[1]]}, which the ${m[1]} policy admits`);
  }
  if (!block('/rest/v1/metric_semantic_id_crosswalk', 2)) problems449.push(`${SPEC} has no /rest/v1/metric_semantic_id_crosswalk`);

  if (problems449.length) {
    fail(`the API reference does not document the further semantic ids as 0299 declares them:\n${problems449.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`docs/openapi.yaml documents metric_semantic_ids with its ${columns.length} columns and the four verbs its policies give, and the crosswalk view`);
  }
}
