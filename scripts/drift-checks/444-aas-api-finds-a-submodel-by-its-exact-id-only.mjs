import { allFiles, fail, pass, read, sectionOf, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 444. aas-api finds a Submodel by its exact id only, on both submodel routes, through one function,
// so an id made from an earlier version's name answers 404 like any id the shell does not carry.
// 1.9.0 answered those old ids until 1.10.0, and 1.10.0 removed them: no edge function looks one up,
// and the API reference, the running-the-server help and the 1.10.0 upgrade note say an old id answers
// 404, the note citing the 1.9.0 note that announced it. A doc still promising the old ids would send
// a consumer to an id that is gone.
// -------------------------------------------------------------------------------------------------
const OLD_LOOKUP = ['previousSubmodelIds', 'submodelOfAPreviousVersion', 'schemaSubmodels'];
const NOTE = "### From 1.10.0, aas-api no longer answers a Submodel's old id";
const ANNOUNCED = 'upgrading.md#from-190-a-schemas-submodel-ids-follow-its-lineage-and-carry-its-version';

/** The block of docs/openapi.yaml for one path, up to the next path. */
function pathBlock(spec, path) {
  const at = spec.indexOf(`\n  ${path}:\n`);
  if (at < 0) return '';
  const next = spec.indexOf('\n  /', at + 1);
  return spec.slice(at, next < 0 ? undefined : next);
}

export default function check() {
  const problems444 = [];
  const index = read('supabase/functions/aas-api/index.ts');

  const calls = index.match(/\bsubmodelIn\(built, \w+\)/g) ?? [];
  if (calls.length !== 2) problems444.push(`aas-api reads a submodel through submodelIn() ${calls.length} time(s), not once on each of its two routes`);
  const helper = index.slice(index.indexOf('function submodelIn('), index.indexOf('export default async function handler'));
  if (!/^function submodelIn\(built: BuiltShell, identifier: string\) \{\s*return built\.submodels\.find\(\(s\) => s\.id === identifier\) \?\? null;\s*\}/.test(helper)) {
    problems444.push('submodelIn() does more than find the exact id in the built shell');
  }
  if (/\.submodels\.find\(/.test(index.replace(helper, ''))) problems444.push('a route of aas-api finds a submodel without submodelIn()');
  for (const file of allFiles.filter((f) => f.startsWith('supabase/functions/') && f.endsWith('.ts'))) {
    const text = read(file);
    const named = OLD_LOOKUP.filter((name) => text.includes(name));
    if (named.length) problems444.push(`${file} names ${named.join(', ')}, the lookup of an earlier version's id that 1.10.0 removed`);
  }

  const spec = read('docs/openapi.yaml').replace(/\r\n/g, '\n');
  const routes = [
    '/functions/v1/aas-api/submodels/{submodelIdentifier}',
    '/functions/v1/aas-api/shells/{aasIdentifier}/submodels/{submodelIdentifier}',
  ];
  for (const route of routes) {
    const block = pathBlock(spec, route);
    if (!block) problems444.push(`docs/openapi.yaml has no path ${route}`);
    else if (/until 1\.10\.0|no sooner\s+than 1\.10\.0/.test(block)) problems444.push(`docs/openapi.yaml's ${route} still promises the old ids until 1.10.0`);
  }
  if (!/such an old id\s+\(`[^`]*_v2\/OperationalTelemetry`\) answers `404`/.test(pathBlock(spec, routes[0]))) {
    problems444.push('docs/openapi.yaml\'s /submodels/{submodelIdentifier} does not say an old id answers 404');
  }

  const help = read('help/site/running-the-server.md');
  if (/until 1\.10\.0/.test(help)) problems444.push('help/site/running-the-server.md still says the old ids are answered until 1.10.0');
  if (!/answers such an old id with 404/.test(help)) problems444.push('help/site/running-the-server.md does not say an old id answers 404');

  const note = sectionOf(upgradingGuide(), NOTE);
  if (!note) {
    problems444.push(`help/site/upgrading.md (with the notes folded in) has no "${NOTE}" section`);
  } else {
    if (!note.includes(ANNOUNCED)) problems444.push('the 1.10.0 note does not link to the 1.9.0 note that announced the removal');
    for (const phrase of ['answers 404', 'submodel-refs', 'nothing to run']) {
      if (!note.includes(phrase)) problems444.push(`the 1.10.0 note does not say ${phrase}`);
    }
  }

  if (problems444.length) {
    fail('aas-api, the API reference, the help and the upgrade note disagree about a Submodel\'s old id:\n' + problems444.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('aas-api finds a Submodel by its exact id only, through one function on both routes, no edge function looks up an earlier version\'s id, and the API reference, the running-the-server help and the 1.10.0 upgrade note say an old id answers 404');
  }
}
