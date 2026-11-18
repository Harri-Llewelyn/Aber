/**
 * The VDA 5050 vocabulary, as served from `vda5050_vocabulary` (migration 0302): the scalar fields of
 * the `state` message that are readings, generated from the VDA's JSON Schema at tag 3.0.0. A row is
 * keyed by the field's path in the message, `powerSupply.stateOfCharge`, and a metric is named by
 * the group `AGV` and that path with slashes: `AGV/powerSupply/stateOfCharge`. The ids are minted
 * here, under VDA5050_SEMANTIC_NAMESPACE.
 *
 * VDA 5050 3.0 calls the vehicle a mobile robot; the group, the tab and the help say so.
 */

import { STANDARDS, VDA5050_GROUP, vda5050FieldType } from './standards'
import { sparkplugDatatypeFor, categoryFor } from './opcua'
import { permittedValuesText } from './schemaProperty'

export { VDA5050_GROUP }

/** The sections of the tab, in the order shown, by the first segment of a field's path. */
const SECTIONS = [
  ['', 'Vehicle state', 'Whether the vehicle is driving or paused, its operating mode and the last node it reached. VDA 5050 3.0 calls the vehicle a mobile robot.'],
  ['powerSupply', 'Power supply', 'The battery: its charge, voltage, current and health, and whether it is charging.'],
  ['velocity', 'Velocity', 'The vehicle\'s speed along x and y and its turning speed, in the vehicle\'s own coordinates.'],
  ['mobileRobotPosition', 'Position', 'Where the vehicle is on its map. A position is a reading on the device, never the cell the device is in.'],
  ['safetyState', 'Safety', 'The emergency stop and the protective field.']
]

/** Fields, ordered by path. */
export function fields(vocabulary) {
  return (vocabulary || [])
    .slice()
    .sort((a, b) => (a?.name || '').localeCompare(b?.name || '', undefined, { sensitivity: 'base' }))
}

/**
 * The part of a metric name a field stands for: its path with a slash between the levels. Also the
 * value of the Add Metric type picker, since a name cannot hold a dot.
 */
export const fieldType = (entry) => vda5050FieldType(entry?.name)

/** Look a field up by its path, the vocabulary's key. */
export function fieldByName(vocabulary, name) {
  if (!name) return null
  return (vocabulary || []).find(f => f?.name === name) || null
}

/** Look a field up by the part of the metric name it stands for. */
export function fieldByType(vocabulary, type) {
  if (!type) return null
  return (vocabulary || []).find(f => fieldType(f) === type) || null
}

/** The vocabulary arranged into the tab's sections. A first segment this module does not know gets a section of its own. */
export function vda5050Sections(vocabulary) {
  const buckets = new Map()
  for (const field of fields(vocabulary)) {
    const head = field.name.includes('.') ? field.name.slice(0, field.name.indexOf('.')) : ''
    if (!buckets.has(head)) buckets.set(head, [])
    buckets.get(head).push(field)
  }
  const known = SECTIONS.filter(([head]) => buckets.has(head))
    .map(([head, title, hint]) => ({ key: `vda:${head || 'state'}`, title, hint, entries: buckets.get(head) }))
  const others = [...buckets.keys()].filter(head => !SECTIONS.some(([known]) => known === head)).sort()
    .map(head => ({ key: `vda:${head}`, title: head, hint: null, entries: buckets.get(head) }))
  return [...known, ...others]
}

/**
 * The Add Metric form state a field implies. The datatype follows the vocabulary: a JSON number is a
 * Double and a whole number an Int64, which the form offers as a Double. The unit is not filled in:
 * the schema writes `m/s`, and a metric's unit is an MTConnect UnitEnum name. An enum's values fill
 * the permitted values, so a mode a device reports outside them shows as out of vocabulary.
 */
export function vda5050Prefill(entry) {
  if (!entry) return null
  return {
    group: VDA5050_GROUP,
    type: fieldType(entry),
    units: '',
    datatype: sparkplugDatatypeFor(entry.datatype),
    category: categoryFor(entry.datatype),
    semanticId: entry.semantic_id || '',
    standard: STANDARDS.VDA5050,
    description: entry.description || '',
    permittedValues: permittedValuesText(entry.permitted_values)
  }
}

/** What a field chip's tooltip says: its path, the schema's description, then the schema's unit. */
export function fieldTooltip(entry) {
  if (!entry) return ''
  const unit = entry.unit ? ` (${entry.unit})` : ''
  return entry.description ? `${entry.name} — ${entry.description}${unit}` : `${entry.name}${unit}`
}
