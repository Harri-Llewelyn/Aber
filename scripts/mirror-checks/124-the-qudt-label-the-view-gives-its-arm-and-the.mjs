import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lastDefinition, need, compare, ok, problems, ROOT, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 124. The label QUDT goes by, and the order of its arm. The view concept_definitions names the
// standard of each definition (`'QUDT'`), the dashboard names the tab and the picker's badge the same
// (utils/qudt.js), and the arm sits between ASHRAE 223P's and OPC UA's, because QUDT issues its own
// IRIs, as 223P does, and OPC UA's are derived from a published namespace. Check 119 leaves QUDT out
// of the standards the form offers, since a quantity kind names what a reading measures and no metric
// is filed under it, so this is the only place the spelling is held. A badge that said "Qudt" would
// match no definition's standard.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const { QUDT_LABEL } = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/qudt.js')).href);

  const view = lastDefinition('CREATE OR REPLACE VIEW public.concept_definitions', ';', 'the concept_definitions view');
  if (!view) return;
  // The migration that declares it last: the nearest file marker above it, which is not a generated block's.
  const files = [...SCHEMA.slice(0, SCHEMA.lastIndexOf('CREATE OR REPLACE VIEW public.concept_definitions')).matchAll(/^-- >>> (\d{4}_\S+\.sql)$/gm)];
  const file = files.at(-1)?.[1] ?? view.file;
  const labels = [...view.body.matchAll(/'([^']+)'::text(?: AS standard)?(?=\s*\n\s*FROM)/g)].map((m) => m[1]);
  if (!need(view.body, /FROM public\.qudt_quantity_kinds/, 'the QUDT arm of concept_definitions')) return;

  compare('qudtLabel', 'the standard the view gives QUDT\'s arm and the label the dashboard shows', QUDT_LABEL, labels.find((l) => l === QUDT_LABEL) ?? '(no such arm)');

  const order = ['ASHRAE 223P', QUDT_LABEL, 'OPC UA'].map((l) => labels.indexOf(l));
  if (order.includes(-1) || !(order[0] < order[1] && order[1] < order[2])) {
    problems.push(`qudtLabel: the view's arms are ${JSON.stringify(labels)}, and QUDT does not come after ASHRAE 223P and before OPC UA`);
  } else {
    ok.push(`qudtLabel: the view's arms are ${labels.join(', ')}, so QUDT follows ASHRAE 223P and precedes OPC UA (${file})`);
  }
}
