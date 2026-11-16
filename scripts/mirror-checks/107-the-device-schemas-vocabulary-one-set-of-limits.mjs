import { compare, lastDefinition, need, read, SCHEMA } from './lib.mjs';

// 107. The device schemas vocabulary, one set of limits, patterns and keys in three places (0295):
// the JSON Schema the dashboard serves, device_schemas_parse()'s constants and lists, and the CHECKs on
// schemas and metric_catalog. A limit the schema states and the function does not is an editor that
// offers a file the database turns back; the reverse is one that refuses what the database would
// apply. The guard suite holds the two over fixtures; this holds the words and numbers that no
// fixture reaches.
export default function check() {
  const schema = JSON.parse(read('frontend/public/json-schema/device-schemas.schema.json'));
  const parse = lastDefinition('CREATE OR REPLACE FUNCTION public.device_schemas_parse(', '$$;', 'device_schemas_parse()');
  const { deviceSchema, metric } = schema.$defs;
  const words = (list) => [...list.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).join(', ');
  const typeCheck = need(SCHEMA, /CONSTRAINT schemas_semantic_id_type_valid CHECK \(\(\(semantic_id_type IS NULL\) OR \(semantic_id_type = ANY \(ARRAY\[([^\]]*)\]\)\)\)\)/,
    'schemas_semantic_id_type_valid in the migrations');
  const nameFormat = need(SCHEMA, /CONSTRAINT metric_catalog_name_format CHECK \(\(name ~ '([^']+)'::text\)\)/,
    'metric_catalog_name_format in the migrations');
  if (!parse) return;
  const constant = (name) => need(parse.body.split('\n').find((line) => line.trim().startsWith(`${name} `)) ?? '',
    /CONSTANT integer := (\d+);/, `${name} in device_schemas_parse() (${parse.file})`);
  const limits = ['c_max_schemas', 'c_max_metrics'].map(constant);
  if (limits.every(Boolean)) {
    compare('deviceSchemasVocabulary', 'the most schemas in a file and metrics in a schema, in the schema and in device_schemas_parse()',
      [schema.maxItems, deviceSchema.properties.metrics.maxItems].join(', '), limits.map((m) => m[1]).join(', '));
  }
  // The text lengths in the order the function checks them: name, description, semantic_id, change_description.
  const lengths = [...parse.body.matchAll(/char_length\(v_val #>> '\{\}'\) (?:NOT BETWEEN 1 AND|>) (\d+)/g)].map((m) => Number(m[1]));
  const p = deviceSchema.properties;
  compare('deviceSchemasVocabulary', `the longest name, description, semantic id and change description, in the schema and in device_schemas_parse() (${parse.file})`,
    [p.name.maxLength, p.description.maxLength, p.semantic_id.maxLength, p.change_description.maxLength].join(', '), lengths.join(', '));
  // A name and a semantic id have no space or control character at either end: two tests in the function, one pattern in the schema.
  const ends = [...parse.body.matchAll(/\(v_val #>> '\{\}'\) !~ '(\^\\S)' OR \(v_val #>> '\{\}'\) !~ '(\\S\$)'/g)];
  const asPattern = ends.map((m) => `${m[1]}(.*${m[2].slice(0, -1)})?$`);
  compare('deviceSchemasVocabulary', `the pattern of a name and of a semantic id in the schema and the ends device_schemas_parse() tests (${parse.file})`,
    [p.name.pattern, p.semantic_id.pattern].join(' | '), asPattern.slice(0, 2).join(' | '));
  const listed = need(parse.body, /NOT \(v_val #>> '\{\}'\) = ANY \(ARRAY\[([^\]]*)\]\)/, `device_schemas_parse()'s semantic id types (${parse.file})`);
  if (listed && typeCheck) {
    compare('deviceSchemasVocabulary', `the semantic id types device_schemas_parse() admits (${parse.file}) and the schema`,
      words(listed[1]), p.semantic_id_type.enum.join(', '));
    compare('deviceSchemasVocabulary', 'the semantic id types of the schema and the schemas table', p.semantic_id_type.enum.join(', '), words(typeCheck[1]));
  }
  if (nameFormat) {
    compare('deviceSchemasVocabulary', 'the metric name pattern of the schema and the catalogue table CHECK', metric.properties.name.pattern, nameFormat[1]);
  }
  // The keys each level admits, in the order the function checks them: schema, metric.
  const admitted = [...parse.body.matchAll(/NOT v_key = ANY \(ARRAY\[([^\]]*)\]\)/g)]
    .map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((k) => k[1]).sort().join(', '));
  compare('deviceSchemasVocabulary', `the keys device_schemas_parse() admits on a schema and a metric (${parse.file}) and the schema's properties`,
    admitted.join(' | '), [deviceSchema, metric].map((d) => Object.keys(d.properties).sort().join(', ')).join(' | '));
  // The statuses apply_device_schemas() gives each schema, which the preview draws with the words the
  // Automations preview uses (RESULT_STATUSES), the one list the dialogs share.
  const apply = lastDefinition('CREATE OR REPLACE FUNCTION public.apply_device_schemas(', '$$;', 'apply_device_schemas()');
  const sqlStatuses = apply && [...new Set([...apply.body.matchAll(/v_status := '([a-z]+)'/g)].map((m) => m[1]))].sort();
  const statuses = need(read('frontend/src/utils/automations.js'), /export const RESULT_STATUSES = \[([\s\S]*?)\n\]/, 'RESULT_STATUSES in utils/automations.js');
  const jsStatuses = statuses && [...statuses[1].matchAll(/value: '([a-z]+)'/g)].map((m) => m[1]).sort();
  if (sqlStatuses && jsStatuses) {
    compare('deviceSchemasVocabulary', `the statuses the preview draws and apply_device_schemas() gives (${apply.file})`,
      jsStatuses.join(', '), sqlStatuses.join(', '));
  }
  // What is required is what the function demands first: a name and metrics, a metric's name.
  compare('deviceSchemasVocabulary', 'what the schema requires of a schema and of a metric',
    [deviceSchema.required, metric.required].map((r) => r.slice().sort().join(', ')).join(' | '), 'metrics, name | name');
}
