import { Document } from 'yaml'
import { ordered } from './automationYaml'

/*
 * Derived metrics as YAML: the text an export writes. The rows are the record and the YAML is never
 * stored, so this renders what `derived_metrics_document()` answers, in the shape the JSON Schema at
 * /json-schema/derived-metrics.schema.json describes. The text is read back with the Automations
 * page's parser (parseAutomationsYaml), which maps a refusal's JSON path to its line.
 */

/** The keys of each map, in the order a file writes them. The database's jsonb has its own. */
const METRIC_KEYS = ['name', 'description', 'kind', 'input', 'states', 'inputs']
const INPUT_KEYS = ['metric', 'sign']

/** One derived metric as a file writes it: its keys in order, the inputs of a sum too. */
const metricShape = (metric) => ({
  ...ordered(metric, METRIC_KEYS),
  ...(metric.inputs ? { inputs: metric.inputs.map(i => ordered(i, INPUT_KEYS)) } : {}),
})

/**
 * The derived metrics as YAML, from `derived_metrics_document()`. Empty text for none. No folding: a
 * long description stays on its lines, as the person wrote it. A state such as `true` is written in
 * quotes, since the file holds text and YAML would otherwise read it as a boolean.
 */
export function renderDerivedMetricsYaml(metrics) {
  if (!metrics?.length) return ''
  return new Document(metrics.map(metricShape)).toString({ lineWidth: 0 })
}
