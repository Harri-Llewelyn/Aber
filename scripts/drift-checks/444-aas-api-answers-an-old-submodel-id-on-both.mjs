import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 444. aas-api answers an id made from an earlier version's name on both submodel routes, through the
// one function, after the exact id; and the API reference, the upgrade note and the running-the-server
// help each say how long: until 1.10.0, and that a file holds only the new id. A route that went back
// to the exact match alone would 404 for a consumer that stored an id, in the one minor that promised
// it would not; a promise worded differently in three places is three promises.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems444 = [];
  const index = read('supabase/functions/aas-api/index.ts');
  const lookup = read('supabase/functions/_shared/aas/previousSubmodelIds.ts');

  if (!/from "\.\.\/_shared\/aas\/previousSubmodelIds\.ts"/.test(index)) problems444.push('aas-api does not import the old-id lookup');
  const calls = index.match(/await submodelIn\(supabase, built, \w+\)/g) ?? [];
  if (calls.length !== 2) problems444.push(`aas-api reads a submodel through submodelIn() ${calls.length} time(s), not once on each of its two routes`);
  const helper = index.slice(index.indexOf('async function submodelIn'), index.indexOf('async function devicePage'));
  if (!/built\.submodels\.find\(\(s\) => s\.id === identifier\) \?\?\s*await submodelOfAPreviousVersion/.test(helper)) {
    problems444.push('submodelIn() does not try the exact id first and an earlier version\'s name after');
  }
  if (/built\??\.submodels\.find\(\(s\) => s\.id === (identifier|subIdentifier)\)/.test(index.replace(helper, ''))) {
    problems444.push('a route of aas-api still matches the exact id alone');
  }
  if (!/s\.kept && s\.ids\[role\]/.test(lookup) || !/\.in\("lineage_root_id", roots\)/.test(lookup)) {
    problems444.push('the lookup does not ask only for the lineages the device carries');
  }

  const docs = [
    ['docs/openapi.yaml', read('docs/openapi.yaml')],
    ['the upgrade note', read('unreleased/upgrading/09-a-submodels-id-follows-its-schemas-lineage-and-carries-its-version.md')],
    ['help/site/running-the-server.md', read('help/site/running-the-server.md')],
  ];
  for (const [name, text] of docs) {
    if (!/until 1\.10\.0/.test(text) && !/no sooner\s+than 1\.10\.0/.test(text)) problems444.push(`${name} does not say the old ids are answered until 1.10.0`);
  }
  if (!/A file holds only the (current|new) id|file holds only the (current|new)/.test(docs[0][1])) problems444.push('docs/openapi.yaml does not say a file holds only the current id');

  if (problems444.length) {
    fail('the old Submodel ids and what the docs promise about them disagree:\n' + problems444.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('aas-api answers an earlier version\'s Submodel id on both routes after the exact id, for the lineages the device carries, and the API reference, the upgrade note and the running-the-server help each say until 1.10.0');
  }
}
