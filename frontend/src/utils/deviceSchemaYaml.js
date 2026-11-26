import { Document } from 'yaml'
import { ordered } from './automationYaml'

/*
 * Device schemas as YAML: the text an export writes. The rows are the record and the YAML is never
 * stored, so this renders what `device_schemas_document()` answers, in the shape the JSON Schema at
 * /json-schema/device-schemas.schema.json describes. The text is read back with the Automations
 * page's parser (parseAutomationsYaml), which maps a refusal's JSON path to its line.
 */

/** The keys of each map, in the order a file writes them. The database's jsonb has its own. */
const SCHEMA_KEYS = ['name', 'description', 'semantic_id', 'semantic_id_type', 'template', 'change_description', 'metrics', 'derived_metrics']
const METRIC_KEYS = ['name', 'minimum', 'maximum', 'semantic_id']

/** One schema as a file writes it: its keys in order, its metrics' too. */
const schemaShape = (schema) => ({
  ...ordered(schema, SCHEMA_KEYS),
  metrics: (schema.metrics || []).map(m => ordered(m, METRIC_KEYS)),
})

/**
 * The schemas as YAML, from `device_schemas_document()`. Empty text for no schema. No folding: a long
 * description stays on its lines, as the person wrote it.
 */
export function renderDeviceSchemasYaml(schemas) {
  if (!schemas?.length) return ''
  return new Document(schemas.map(schemaShape)).toString({ lineWidth: 0 })
}
