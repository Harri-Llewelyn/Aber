import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 515. The routes aas-api's root lists under `served` are the aas-api paths of docs/openapi.yaml, both
// ways. test_aas_api.py compares them only on a running stack. And the ConceptDescription routes build
// no ConceptDescription of their own: they read each shell's Environment, which buildEnvironment()
// fills through buildConceptDescriptions() for aas-export too. A second builder would let the API and a
// file describe one concept two ways, and leave the licence rule on an imported vocabulary in one.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems515 = [];
  const index = read('supabase/functions/aas-api/index.ts');
  const routes = read('supabase/functions/aas-api/conceptDescriptions.ts');
  const spec = read('docs/openapi.yaml');

  const block = index.match(/served:\s*\[([\s\S]*?)\]/);
  const served = block ? [...block[1].matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]) : [];
  const documented = [...spec.matchAll(/^ {2}\/functions\/v1\/aas-api(\/\S*):\s*$/gm)].map((m) => m[1]);
  if (served.length === 0) problems515.push('aas-api/index.ts has no `served` list this check can read');
  for (const route of served) {
    if (!documented.includes(route)) problems515.push(`aas-api serves ${route}, and docs/openapi.yaml has no path for it`);
  }
  for (const route of documented) {
    if (!served.includes(route)) problems515.push(`docs/openapi.yaml documents aas-api's ${route}, which its root does not list`);
  }

  if (!/await conceptDescriptionRoute\(supabase, path, limit, cursor, devicePage\)/.test(index)) {
    problems515.push('aas-api/index.ts does not answer the ConceptDescription routes as the caller, over the devices /shells lists');
  }
  if (!/from "\.\.\/_shared\/aas\/shell\.ts"/.test(routes) || !/buildEnvironment\(record\)\.environment\.conceptDescriptions/.test(routes)) {
    problems515.push('aas-api/conceptDescriptions.ts does not read each shell\'s Environment for its ConceptDescriptions');
  }
  // The code without its comments, which name the builder to say where the text comes from.
  const code = routes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/modelType:\s*"ConceptDescription"|embeddedDataSpecifications|buildConceptDescriptions\(/.test(code)) {
    problems515.push('aas-api/conceptDescriptions.ts builds ConceptDescriptions of its own');
  }

  if (problems515.length) {
    fail('aas-api\'s routes, the API reference and the one ConceptDescription builder disagree:\n' + problems515.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`aas-api's root lists the ${served.length} routes docs/openapi.yaml documents for it, and its ConceptDescription routes read each shell's Environment, as aas-export does`);
  }
}
