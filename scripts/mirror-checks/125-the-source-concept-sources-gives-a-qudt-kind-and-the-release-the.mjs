import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, lastDefinition, need, ok, problems, ROOT } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 125. The source concept_sources gives a QUDT quantity kind names the release the generator reads
// and the licence QUDT declares. An AAS export carries it as the ConceptDescription's
// sourceOfDefinition, so it is the credit to QUDT.org that travels with a kind's definition, and a
// release the rows were not read from, or a licence QUDT does not declare, would be asserted in every
// export. The view's last declaration is the one that counts, since db-init replays them in order.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const { QUDT_VERSION } = await import(pathToFileURL(join(ROOT, 'scripts/lib/qudt-vocabulary.mjs')).href);

  const view = lastDefinition('CREATE OR REPLACE VIEW public.concept_sources', ';', 'the concept_sources view');
  if (!view) return;
  const arm = need(view.body, /FROM public\.qudt_quantity_kinds/, 'the QUDT arm of concept_sources');
  const source = need(view.body, /'(QUDT [^']+)'::text AS source/, 'the source concept_sources gives a QUDT kind');
  if (!arm || !source) return;

  compare('qudtSource', 'the source concept_sources gives a QUDT kind and the credit built from the generator\'s release',
    source[1], `QUDT ${QUDT_VERSION}, QUDT.org, CC BY 4.0`);

  const columns = [...view.body.matchAll(/^\s{4}c\.(\w+)/gm)].map((m) => m[1]);
  if (columns.join(',') !== 'semantic_id,source') {
    problems.push(`qudtSource: concept_sources selects ${JSON.stringify(columns)}, and its columns are fixed to semantic_id and source`);
  } else {
    ok.push('qudtSource: concept_sources selects semantic_id and source, the two columns it is fixed to');
  }
}
