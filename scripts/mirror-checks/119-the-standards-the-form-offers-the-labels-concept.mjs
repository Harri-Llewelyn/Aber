import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lastDefinition, ok, problems, ROOT, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 119. The standards the Add Metric form offers (STANDARDS in utils/standards.js) and the labels the
// database gives them. A metric's `standard` is what a ConceptDescription's source is read from,
// and concept_definitions names the standard of each definition it serves, so a vocabulary that the
// form offers and the view spells another way would define a concept under a standard no metric
// carries. Every standard but Custom has a vocabulary arm in the view (IDTA and QUDT have an arm and no
// entry: IDTA is a template, and a QUDT quantity kind names what a reading measures, so neither is a
// standard a metric is named from), and a metric group registered under it, since the Standard filter
// and the group picker read the same spelling.
// -------------------------------------------------------------------------------------------------
// Arms of the view whose label is not a standard a metric is filed under.
const NOT_OFFERED = ['IDTA', 'QUDT'];

export default async function check() {
  const { STANDARDS } = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/standards.js')).href);
  const offered = Object.values(STANDARDS).filter((value) => value !== STANDARDS.CUSTOM);

  const view = lastDefinition('CREATE OR REPLACE VIEW public.concept_definitions', ';', 'the concept_definitions view');
  if (!view) return;
  // The migration that declares it last: the nearest file marker above it, which is not a generated block's.
  const files = [...SCHEMA.slice(0, SCHEMA.lastIndexOf('CREATE OR REPLACE VIEW public.concept_definitions')).matchAll(/^-- >>> (\d{4}_\S+\.sql)$/gm)];
  const file = files.at(-1)?.[1] ?? view.file;
  const labels = [...view.body.matchAll(/'([^']+)'::text(?: AS standard)?(?=\s*\n\s*FROM)/g)].map((m) => m[1]).filter((label) => !NOT_OFFERED.includes(label));
  const missingFromView = offered.filter((standard) => !labels.includes(standard));
  const missingFromForm = labels.filter((label) => !offered.includes(label));
  if (labels.length === 0) {
    problems.push('standardLabels: found no vocabulary arm in concept_definitions -- the file\'s shape changed, so this check is no longer checking anything');
  } else if (missingFromView.length || missingFromForm.length) {
    problems.push(`standardLabels: the form offers ${JSON.stringify(offered)} and ${file}'s view labels ${JSON.stringify(labels)}` +
      (missingFromView.length ? `; the view has no arm for ${missingFromView.join(', ')}` : '') +
      (missingFromForm.length ? `; the form offers no standard ${missingFromForm.join(', ')}` : ''));
  } else {
    ok.push(`standardLabels: the ${offered.length} standards the form offers are the labels of the concept_definitions arms (${file}), in the order ${labels.join(', ')}`);
  }

  const registered = new Set([...SCHEMA.matchAll(/INSERT INTO public\.metric_groups[^;]*?'([^']+)'\)\s*(?:ON CONFLICT[^;]*)?;/g)].map((m) => m[1]));
  const withoutGroup = offered.filter((standard) => !registered.has(standard));
  if (withoutGroup.length) {
    problems.push(`standardLabels: no metric group is registered under ${withoutGroup.join(', ')}, so the group picker has none to file under it`);
  } else {
    ok.push(`standardLabels: every one of the ${offered.length} standards has a metric group registered under its spelling`);
  }
}
