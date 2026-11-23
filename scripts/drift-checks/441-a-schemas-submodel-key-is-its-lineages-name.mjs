import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 441. A schema's AAS Submodel key is made from its lineage's name, in every reader. The exporter
// (shell.ts) builds each schema's key from `lineage_name` through assignSubmodelKeys(), never from
// the version's own `schema_name`, and puts the schema's version in `administration` on both
// schema-derived Submodels; the clashes it settled are counted in the stats. i3X reads the same column
// for a type's source type, and the dashboard's schema list carries it. A reader that went back to
// schema_name would change a Submodel id, or a source type, at every publish.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems441 = [];
  const shell = read('supabase/functions/_shared/aas/shell.ts');
  const keys = read('supabase/functions/_shared/aas/submodelKeys.ts');
  const api = read('frontend/src/api.js');
  const loop = shell.slice(shell.indexOf('const { keys: submodelKeys'), shell.indexOf('// Submodel: DerivedMetrics.'));

  if (!/rootKey: toIdShort\(String\(schema\.lineage_name \|\| schema\.schema_name \|\| ""\), "Submodel"\)/.test(loop)) {
    problems441.push('shell.ts does not make a schema\'s key from its lineage_name, falling back to schema_name only where a row has none');
  }
  if (/toIdShort\(String\(schema\.schema_name/.test(loop.replace(/schema\.lineage_name \|\| schema\.schema_name/, ''))) {
    problems441.push('shell.ts makes a Submodel key from the version\'s own schema_name again');
  }
  for (const id of ['OperationalTelemetry', 'KeyPerformanceIndicators']) {
    const block = loop.slice(loop.indexOf(`id: submodelId(\`\${baseKey}/${id}\`)`));
    const submodel = block.slice(0, block.indexOf('});'));
    if (!/administration,/.test(submodel)) problems441.push(`shell.ts does not give the ${id} Submodel its administration.version`);
  }
  if (!/const administration = \{ version: String\(Number\(schema\.version\) \|\| 1\) \}/.test(loop)) {
    problems441.push('shell.ts\'s administration is not the schema\'s version as a string');
  }
  if (!/submodel_key_clashes: keyClashes/.test(shell)) problems441.push('the export\'s stats do not count the keys that clashed, as submodel_key_clashes');
  if (!/export function assignSubmodelKeys/.test(keys) || !/_v\$\{s\.version\}/.test(keys)) {
    problems441.push('submodelKeys.ts no longer qualifies a draft beside the version in force with its version');
  }
  if (!/slice\(0, 8\)/.test(keys)) problems441.push('submodelKeys.ts does not qualify a clash with the first eight hex digits of a root id, which the notes say');

  const i3x = read('i3x/address_space.py');
  const service = read('i3x/i3x_service.py');
  if (!/row\.get\("lineage_name"\) or row\.get\("schema_name"\)/.test(i3x)) problems441.push('i3x/address_space.py schema_source_type_id() does not fall back to the lineage name');
  if (!/"schemas",\s*\{"select": "id,schema_name,lineage_name,/.test(service)) problems441.push('i3x_service.py does not read lineage_name with the schemas');

  if (!/lineage_name: s\.lineage_name \?\? s\.schema_name/.test(api)) problems441.push('the dashboard\'s schema list does not carry lineage_name');
  if (!/label: lineageVersionLabel/.test(api)) problems441.push('Approvals names a schema\'s proposal by something other than its lineage and version');
  const tab = read('frontend/src/components/tabs/SchemasTab.jsx');
  if (!/`'\$\{lineageName\(published\)\}' v\$\{result\.version\} published/.test(tab)) problems441.push('the publish toast does not name the schema by its lineage');
  if (!/against \$\{lineageVersionLabel\(selectedSchema\)\}/.test(tab)) problems441.push('the Validate Payload tooltip does not name the schema by its lineage and version');

  if (problems441.length) {
    fail('a schema\'s Submodel key and the labels that name a schema are not made from its lineage:\n' + problems441.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('a schema\'s Submodel key is its lineage\'s name in the exporter, i3X and the dashboard\'s list; both derived Submodels carry administration.version; a clash is counted; Approvals, the publish toast and the Validate Payload tooltip name a schema by its lineage once');
  }
}
