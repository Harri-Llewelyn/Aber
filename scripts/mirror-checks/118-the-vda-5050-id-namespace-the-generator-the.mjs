import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, need, ok, problems, read, ROOT, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 118. The VDA 5050 id namespace, in five places. The VDA issues no concept identifiers, so every
// id is minted here, under one namespace pinned to the major line: the generator writes it into each
// row, the table's CHECK refuses any other, the dashboard names it (standards.js), i3X files a
// metric whose id starts with it in its own local namespace, and the seed carries it. A namespace
// that moved in one place would leave i3X typing AGV readings as local, or a form-made id the table
// would not have minted.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const generator = await import(pathToFileURL(join(ROOT, 'scripts/lib/vda5050-vocabulary.mjs')).href);
  const standards = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/standards.js')).href);
  const base = generator.SEMANTIC_BASE;

  compare('vda5050IdNamespace', 'the namespace the dashboard and the generator mint under', standards.VDA5050_SEMANTIC_NAMESPACE, base);

  const likeCheck = need(SCHEMA, /CONSTRAINT vda5050_vocabulary_semantic_id_namespace\s+CHECK \(\(semantic_id ~~ '([^']+)'::text\)\)/,
    'the namespace CHECK of vda5050_vocabulary');
  if (likeCheck) compare('vda5050IdNamespace', 'the prefix the table\'s CHECK admits', likeCheck[1], `${base}/State/%`);

  const i3x = read('i3x/address_space.py').match(/_LOCAL_STANDARD_NAMESPACES = \{([^}]*)\}/);
  const i3xNamespaces = i3x ? [...i3x[1].matchAll(/"(https:\/\/aber\.local\/semantics\/vda5050\/[^"]+)":/g)].map((m) => m[1]) : [];
  if (i3xNamespaces.length !== 1) {
    problems.push(`vda5050IdNamespace: expected one VDA 5050 namespace in i3x/address_space.py's _LOCAL_STANDARD_NAMESPACES, found ${JSON.stringify(i3xNamespaces)}`);
  } else {
    compare('vda5050IdNamespace', 'the namespace i3X files a VDA 5050 metric type in', i3xNamespaces[0], base);
  }

  const seeded = [...SCHEMA.matchAll(/^INSERT INTO public\.vda5050_vocabulary VALUES \('([^']+)',.*'([^']+)'\)$/gm)];
  if (seeded.length === 0) {
    problems.push('vda5050IdNamespace: found no seeded VDA 5050 field -- the file\'s shape changed, so this check is no longer checking anything');
    return;
  }
  const strays = seeded.filter(([, name, id]) => id !== generator.vda5050SemanticId(name));
  if (strays.length) {
    problems.push(`vda5050IdNamespace: ${strays.slice(0, 3).map(([, name, id]) => `${name} carries ${id}`).join('; ')}, not ${base}/State/<path>`);
  } else {
    ok.push(`vda5050IdNamespace: ${seeded.length} seeded ids are ${base}/State/<path>, as the generator, the table's CHECK, the dashboard and i3X say`);
  }
}
