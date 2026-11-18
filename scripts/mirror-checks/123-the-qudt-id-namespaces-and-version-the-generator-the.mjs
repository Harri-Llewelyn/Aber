import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, need, ok, problems, read, ROOT, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 123. The QUDT id namespaces and version, in five places. QUDT issues its own ids, so nothing is
// minted: the generator reads them under http://qudt.org/vocab/quantitykind/ and .../unit/, each
// table's CHECK admits no other prefix, the dashboard names the kind namespace (the picker and the
// tab tell a kind by it), i3X files a metric whose id starts with it in QUDT's namespace, and the
// exporter defers an id it holds no row for to QUDT by the same prefix. The release the tab credits
// is the one the generator reads. A namespace that moved in one place would leave i3X typing a kind
// as local, or a tab crediting a release the rows were not read from.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const generator = await import(pathToFileURL(join(ROOT, 'scripts/lib/qudt-vocabulary.mjs')).href);
  const dashboard = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/qudt.js')).href);

  compare('qudtVersion', 'the release the tab credits and the generator reads', dashboard.QUDT_VERSION, generator.QUDT_VERSION);
  compare('qudtIdNamespace', 'the kind namespace the dashboard and the generator share', dashboard.QUDT_KIND_NAMESPACE, generator.KIND_BASE);

  for (const [table, base, constraint] of [
    ['qudt_quantity_kinds', generator.KIND_BASE, /CONSTRAINT qudt_quantity_kinds_semantic_id_namespace\s+CHECK \(\(semantic_id ~~ '([^']+)'::text\)\)/],
    ['qudt_units', generator.UNIT_BASE, /CONSTRAINT qudt_units_semantic_id_namespace\s+CHECK \(\(semantic_id ~~ '([^']+)'::text\)\)/],
  ]) {
    const like = need(SCHEMA, constraint, `the namespace CHECK of ${table}`);
    if (like) compare('qudtIdNamespace', `the prefix ${table}'s CHECK admits and the generator reads`, like[1], `${base}%`);
  }

  const i3x = need(read('i3x/address_space.py'), /_QUDT_KIND_NAMESPACE = "([^"]+)"/, 'the QUDT namespace in i3x/address_space.py');
  if (i3x) compare('qudtIdNamespace', 'the prefix i3X files a quantity kind\'s type under', i3x[1], generator.KIND_BASE);

  const authority = need(read('supabase/functions/_shared/aas/shell.ts'), /\{ prefix: "(http:\/\/qudt\.org\/[^"]+)", authority: "QUDT" \}/,
    'the QUDT entry of ID_AUTHORITIES in shell.ts');
  if (authority) compare('qudtIdNamespace', 'the prefix the exporter defers to QUDT under', authority[1], generator.KIND_BASE);

  const seeded = [...SCHEMA.matchAll(/^\('(http:\/\/qudt\.org\/vocab\/(?:quantitykind|unit)\/[^']+)', /gm)].map((m) => m[1]);
  if (seeded.length === 0) {
    problems.push('qudtIdNamespace: found no seeded QUDT row -- the file\'s shape changed, so this check is no longer checking anything');
    return;
  }
  const strays = seeded.filter((id) => !id.startsWith(generator.KIND_BASE) && !id.startsWith(generator.UNIT_BASE));
  if (strays.length) {
    problems.push(`qudtIdNamespace: ${strays.slice(0, 3).join(', ')} is under neither ${generator.KIND_BASE} nor ${generator.UNIT_BASE}`);
  } else {
    ok.push(`qudtIdNamespace: ${seeded.length} seeded QUDT ids are under QUDT's kind and unit namespaces, as the generator, the tables' CHECKs, the dashboard, i3X and the exporter say`);
  }
}
