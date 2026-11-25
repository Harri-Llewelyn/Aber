import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, need, problems, read, ROOT, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 153. What a template element may be, in four places (0320): the generator reads a template's
// cardinality and model type against its lists, the table's CHECKs admit them, the API reference lists
// them, and the Templates tab has words for each cardinality. A value one admits and another lacks is a
// row the boot refuses, or one the tab says is not stated. And the Nameplate template's id, which the
// dashboard's nameplate read and the AAS exporter name, is the seeded template's.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const generator = await import(pathToFileURL(join(ROOT, 'scripts/lib/idta-template.mjs')).href);
  const page = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/idtaTemplates.js')).href);
  const listed = (text) => [...text.matchAll(/'([A-Za-z]+)'::text/g)].map((m) => m[1]).sort();
  const sorted = (values) => [...values].sort();

  const cardinality = need(SCHEMA, /CONSTRAINT idta_template_elements_cardinality_valid\s+CHECK \(\(cardinality = ANY \(ARRAY\[([^\]]*)\]/, 'the cardinality CHECK of idta_template_elements');
  if (cardinality) {
    compare('templateElement', 'the cardinalities the table admits and the generator reads', listed(cardinality[1]), sorted(generator.CARDINALITIES));
    compare('templateElement', 'the cardinalities the Templates tab has words for', sorted(Object.keys(page.CARDINALITY_LABELS)), listed(cardinality[1]));
  }
  const modelType = need(SCHEMA, /CONSTRAINT idta_template_elements_model_type_valid\s+CHECK \(\(model_type = ANY \(ARRAY\[([^\]]*)\]/, 'the model type CHECK of idta_template_elements');
  if (modelType) compare('templateElement', 'the model types the table admits and the generator reads', listed(modelType[1]), sorted(generator.MODEL_TYPES));

  const api = read('docs/openapi.yaml');
  const schema = api.slice(api.indexOf('    IDTATemplateElement:\n'), api.indexOf('    ConceptDefinition:\n'));
  for (const [column, values] of [['cardinality', generator.CARDINALITIES], ['model_type', generator.MODEL_TYPES]]) {
    const line = schema.split('\n').find((l) => l.trim().startsWith(`${column}: {`));
    const enumerated = line?.match(/enum: \[([^\]]+)\]/)?.[1].split(',').map((v) => v.trim()) ?? [];
    compare('templateElement', `the API reference's ${column} values and the generator's`, sorted(enumerated), sorted(values));
  }

  // The generated block seeds it under the same id the dashboard's nameplate read and the exporter name.
  const named = read('frontend/src/api.js').match(/NAMEPLATE_TEMPLATE_ID = '([^']+)'/);
  if (!named) {
    problems.push('templateElement: found no NAMEPLATE_TEMPLATE_ID in the dashboard -- the file\'s shape changed, so this check is no longer checking anything');
    return;
  }
  const seeded = need(SCHEMA, /^SELECT '([^']+)', 'Digital Nameplate', 'IDTA 02006', '[^']+',$/m, 'the seeded Digital Nameplate template');
  if (seeded) compare('templateElement', 'the Nameplate template the dashboard reads and the one seeded', named[1], seeded[1]);
}
