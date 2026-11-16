import { compare, lastDefinition, need, read, SCHEMA } from './lib.mjs';

// 111. The derived metrics vocabulary, one set of limits, patterns, kinds and keys in four places (0297):
// the JSON Schema the dashboard serves, derived_metrics_parse()'s constants and lists, the shape check
// and the trigger of 0267, and the CHECK on the catalogue's names. A limit the schema states and the
// function does not is an editor that offers a file the database turns back; the reverse is one that
// refuses what the database would add. The guard suite holds the two over fixtures; this holds the words
// and numbers that no fixture reaches.
export default function check() {
  const schema = JSON.parse(read('frontend/public/json-schema/derived-metrics.schema.json'));
  const parse = lastDefinition('CREATE OR REPLACE FUNCTION public.derived_metrics_parse(', '$$;', 'derived_metrics_parse()');
  const shape = lastDefinition('CREATE OR REPLACE FUNCTION public.derivation_shape_problem(', '$$;', 'derivation_shape_problem()');
  const apply = lastDefinition('CREATE OR REPLACE FUNCTION public.apply_derived_metrics(', '$$;', 'apply_derived_metrics()');
  const trigger = lastDefinition('CREATE OR REPLACE FUNCTION public.enforce_derived_metric(', '$$;', 'enforce_derived_metric()');
  const nameFormat = need(SCHEMA, /CONSTRAINT metric_catalog_name_format CHECK \(\(name ~ '([^']+)'::text\)\)/,
    'metric_catalog_name_format in the migrations');
  if (!parse || !shape || !apply || !trigger || !nameFormat) return;
  const { derivedMetric, input } = schema.$defs;
  const props = derivedMetric.properties;
  const constant = (fn, name, type) => need(fn.body.split('\n').find((line) => line.trim().startsWith(`${name} `)) ?? '',
    new RegExp(`CONSTANT ${type}\\s+:=\\s+'?([^;']+)'?;`), `${name} in ${fn.file}`)?.[1];

  compare('derivedMetricsVocabulary', `the most derived metrics in a file, in the schema and in derived_metrics_parse() (${parse.file})`,
    schema.maxItems, constant(parse, 'c_max_metrics', 'integer'));
  compare('derivedMetricsVocabulary', `the most inputs of a sum, in the schema, in derived_metrics_parse() (${parse.file}) and in derivation_shape_problem() (${shape.file})`,
    [props.inputs.maxItems, props.inputs.maxItems].join(', '),
    [constant(parse, 'c_max_inputs', 'integer'), constant(shape, 'c_max_inputs', 'integer')].join(', '));
  compare('derivedMetricsVocabulary', `the fewest inputs of a sum, in the schema and in derivation_shape_problem() (${shape.file})`,
    props.inputs.minItems, need(shape.body, /NOT BETWEEN (\d+) AND c_max_inputs/, 'the fewest inputs of a sum in derivation_shape_problem()')?.[1]);
  compare('derivedMetricsVocabulary', 'the metric name pattern of the schema (a name, an input, an input of a sum), derived_metrics_parse(), derivation_shape_problem() and the catalogue table CHECK',
    [props.name.pattern, props.input.pattern, input.properties.metric.pattern, constant(parse, 'c_name', 'text'), constant(shape, 'c_name', 'text')].join(' | '),
    new Array(5).fill(nameFormat[1]).join(' | '));
  compare('derivedMetricsVocabulary', `the longest description, in the schema and in derived_metrics_parse() (${parse.file})`,
    props.description.maxLength, [...parse.body.matchAll(/char_length\(v_val #>> '\{\}'\) > (\d+)/g)].map((m) => m[1]).join(', '));

  // The kinds, in the order the dashboard offers them: the schema's, the function's, the shape check's and the dashboard's.
  const words = (list) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).join(', ');
  const parseKinds = need(parse.body, /NOT \(v_val #>> '\{\}'\) = ANY \(ARRAY\[([^\]]*)\]\)/, `derived_metrics_parse()'s kinds (${parse.file})`);
  const shapeKinds = need(shape.body, /NOT IN \(('counter_rate'[^)]*)\)/, `derivation_shape_problem()'s kinds (${shape.file})`);
  const dashboardKinds = need(read('frontend/src/utils/derivedMetric.js'), /DERIVATION_KINDS = \[([\s\S]*?)\n\]/, 'DERIVATION_KINDS in utils/derivedMetric.js');
  if (parseKinds && shapeKinds && dashboardKinds) {
    const dashboard = [...dashboardKinds[1].matchAll(/id: '([a-z_]+)'/g)].map((m) => m[1]).join(', ');
    const kinds = props.kind.enum.join(', ');
    compare('derivedMetricsVocabulary', 'the kinds of the schema, derived_metrics_parse(), derivation_shape_problem() and the dashboard\'s list',
      [kinds, kinds, kinds].join(' | '), [words(parseKinds[1]), words(shapeKinds[1]), dashboard].join(' | '));
  }

  // The keys each level admits, in the order the function checks them: a derived metric, then an input of a sum.
  const admitted = [...parse.body.matchAll(/NOT v_key = ANY \(ARRAY\[([^\]]*)\]\)/g)]
    .map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((k) => k[1]).sort().join(', '));
  compare('derivedMetricsVocabulary', `the keys derived_metrics_parse() admits on a derived metric and on an input of a sum (${parse.file}) and the schema's properties`,
    admitted.join(' | '), [derivedMetric, input].map((d) => Object.keys(d.properties).sort().join(', ')).join(' | '));
  compare('derivedMetricsVocabulary', 'the signs of an input, in the schema and in derivation_shape_problem()',
    input.properties.sign.enum.slice().sort().join(', '),
    need(shape.body, /NOT IN \((-?\d+), (-?\d+)\)/, 'the signs in derivation_shape_problem()')?.slice(1, 3).sort().join(', '));
  // What is required: a name and a kind, a metric and a sign.
  compare('derivedMetricsVocabulary', 'what the schema requires of a derived metric and of an input',
    [derivedMetric.required, input.required].map((r) => r.slice().sort().join(', ')).join(' | '), 'kind, name | metric, sign');

  // A derived metric is a Double: the writer's datatype, the trigger's and the dashboard's.
  const writer = need(apply.body, /c_datatype CONSTANT integer := (\d+);/, `apply_derived_metrics()'s datatype (${apply.file})`);
  const trig = need(trigger.body, /IF NEW\.datatype <> (\d+) THEN/, `enforce_derived_metric()'s datatype (${trigger.file})`);
  const dash = need(read('frontend/src/utils/derivedMetric.js'), /export const DERIVED_DATATYPE = (\d+)/, 'DERIVED_DATATYPE in utils/derivedMetric.js');
  if (writer && trig && dash) {
    compare('derivedMetricsVocabulary', `the datatype of a derived metric, in apply_derived_metrics() (${apply.file}), enforce_derived_metric() (${trigger.file}) and the dashboard`,
      [dash[1], dash[1]].join(', '), [writer[1], trig[1]].join(', '));
  }

  // The statuses the two functions give each metric, all of which the preview draws with the words the
  // Automations preview uses (RESULT_STATUSES). A changed one is not among them: an upload only adds.
  const sql = [...new Set([...parse.body.matchAll(/'(new|unchanged|refused|changed)'/g), ...apply.body.matchAll(/'(new|unchanged|refused|changed)'/g)].map((m) => m[1]))].sort();
  const statuses = need(read('frontend/src/utils/automations.js'), /export const RESULT_STATUSES = \[([\s\S]*?)\n\]/, 'RESULT_STATUSES in utils/automations.js');
  if (statuses) {
    const drawn = [...statuses[1].matchAll(/value: '([a-z]+)'/g)].map((m) => m[1]);
    compare('derivedMetricsVocabulary', `the statuses the preview draws and apply_derived_metrics() gives (${apply.file}), none of them changed`,
      sql.filter((s) => drawn.includes(s) && s !== 'changed').join(', '), sql.join(', '));
  }
}
