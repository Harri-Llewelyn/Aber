import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, need, ok, problems, ROOT, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 117. The VDA 5050 metric group, and the name a field makes. The Add Metric form's prefill
// (utils/standards.js) files a field under one group, which the migration must register under the
// standard and register as that spelling: enforce_metric_group_spelling() makes the first spelling
// permanent, so a form that wrote `Agv` would be refused by a database that holds `AGV`. And the
// form turns a field's path into the rest of a metric's name by changing its dots to slashes; the
// result, behind the group, must pass `metric_catalog_name_format` for every seeded field, since a
// dot is the one character a name cannot hold.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const standards = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/standards.js')).href);

  const registered = [...SCHEMA.matchAll(
    /INSERT INTO public\.metric_groups \(id, name, description, standard\)\s*VALUES \('[^']*', '([^']+)',\s*'(?:[^']|'')*',\s*'VDA 5050'\)/g
  )].map((m) => m[1]);
  if (registered.length !== 1) {
    problems.push(`vda5050Group: expected one metric group registered under VDA 5050, found ${JSON.stringify(registered)}`);
  } else {
    compare('vda5050Group', 'the group the form files a VDA 5050 field under', standards.VDA5050_GROUP, registered[0]);
  }

  const nameFormat = need(SCHEMA, /CONSTRAINT metric_catalog_name_format CHECK \(\(name ~ '([^']+)'::text\)\)/,
    'metric_catalog_name_format');
  const rows = [...SCHEMA.matchAll(/^INSERT INTO public\.vda5050_vocabulary VALUES \('([^']+)',/gm)].map((m) => m[1]);
  if (!nameFormat || rows.length === 0) {
    problems.push('vda5050FieldName: found no metric_catalog_name_format or no seeded VDA 5050 field -- the file\'s shape changed, so this check is no longer checking anything');
    return;
  }
  // The CHECK's pattern, written as the migration has it, and the same pattern here as a literal:
  // a change to the database's rule stops this check rather than being followed silently.
  const format = /^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;
  compare('vda5050FieldName', 'the name format the form tests a name against', format.source.replaceAll('\\/', '/'), nameFormat[1]);
  const refused = rows.filter((name) => !format.test(`${standards.VDA5050_GROUP}/${standards.vda5050FieldType(name)}`));
  if (refused.length) {
    problems.push(`vda5050FieldName: the form names ${refused.slice(0, 5).join(', ')} so that metric_catalog_name_format refuses the name`);
  } else {
    ok.push(`vda5050FieldName: all ${rows.length} seeded VDA 5050 fields make a name metric_catalog_name_format admits, behind the group ${standards.VDA5050_GROUP}`);
  }
}
