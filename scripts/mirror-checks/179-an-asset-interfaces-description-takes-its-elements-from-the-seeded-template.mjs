import { compare, need, ok, problems, read, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 179. An Asset Interfaces Description takes its elements from the seeded template. aas-api builds one
// in buildInterfacesDescription() (_shared/aas/shell.ts), and each element's idShort, type and ids come
// from the row at a template path the builder names, in the rows 0320 seeds. A path no row has leaves
// the description out of every shell, and a row of another model type is an element the template does
// not have. So every path named is a seeded row of the type built there, the template ids are the
// seeded ones, and the builder types no IRI of its own.
// -------------------------------------------------------------------------------------------------
const BUILT_AS = { prop: 'Property', smc: 'SubmodelElementCollection', security: 'SubmodelElementList' };

export default function check() {
  const shell = read('supabase/functions/_shared/aas/shell.ts');
  const templateId = need(shell, /export const INTERFACES_TEMPLATE_ID =\s*"([^"]+)";/, 'INTERFACES_TEMPLATE_ID in shell.ts');
  const templates = need(shell, /export const INTERFACE_TEMPLATES = \{ http: "([^"]+)", mqtt: "([^"]+)" \}/, 'INTERFACE_TEMPLATES in shell.ts');
  const body = need(shell, /\nexport function buildInterfacesDescription\(([\s\S]*?)\n}\n/, 'buildInterfacesDescription() in shell.ts');
  const seeded = need(SCHEMA, /^SELECT '([^']+)', 'Asset Interfaces Description', 'IDTA 02017', '[^']+',$/m, 'the seeded Asset Interfaces Description template');
  if (!templateId || !templates || !body || !seeded) return;

  compare('interfacesTemplate', 'the Asset Interfaces Description template aas-api reads and the one seeded', templateId[1], seeded[1]);

  const block = SCHEMA.slice(seeded.index, SCHEMA.indexOf('\n  ) AS e (', seeded.index));
  const rows = new Map([...block.matchAll(/^\('([^']+)', (?:NULL|'[^']*'), \d+, (?:NULL|'[^']*'), '([A-Za-z]+)'/gm)]
    .map((m) => [m[1], m[2]]));
  const binding = { http: templates[1], mqtt: templates[2] };
  for (const [name, root] of Object.entries(binding)) {
    compare('interfacesTemplate', `the ${name} interface's template collection`, rows.get(root), 'SubmodelElementCollection');
  }

  const calls = [...body[1].matchAll(/\b(prop|smc|security)\((binding|"http"|"mqtt"), "([^"]*)"/g)];
  if (calls.length < 25) {
    problems.push(`interfacesTemplate: ${calls.length} template paths read out of buildInterfacesDescription(), so this check is no longer checking anything`);
    return;
  }
  const wrong = [];
  for (const [, builder, under, path] of calls) {
    const roots = under === 'binding' ? Object.values(binding) : [binding[under.slice(1, -1)]];
    for (const root of roots) {
      const full = path ? `${root}.${path}` : root;
      const type = rows.get(full);
      if (type !== BUILT_AS[builder]) wrong.push(`${full}: built as ${BUILT_AS[builder]}, ${type ? `seeded as ${type}` : 'not seeded'}`);
    }
  }
  if (wrong.length) problems.push(`interfacesTemplate: buildInterfacesDescription() names template paths the seed does not have as it builds them:\n${wrong.map((w) => `        ${w}`).join('\n')}`);
  else ok.push(`interfacesTemplate: the ${calls.length} template paths buildInterfacesDescription() names are seeded rows of the types it builds`);

  const typed = [...body[1].matchAll(/"(https?:\/\/[^"]*|urn:[^"]*)"/g)].map((m) => m[1]);
  if (typed.length) problems.push(`interfacesTemplate: buildInterfacesDescription() types ids of its own instead of reading the template's rows: ${typed.join(', ')}`);
}
