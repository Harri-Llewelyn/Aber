import { vda5050Sections, fieldTooltip, fieldType, VDA5050_GROUP } from '../../utils/vda5050'
import { STANDARDS } from '../../utils/standards'

/**
 * The VDA 5050 tab of the Vocabulary page: the readings an automated guided vehicle reports in its
 * `state` message. A field is a whole reading, picked as an ISO 22400 KPI is: Use starts a metric in
 * the AGV group, named by the field's path, with its datatype, semantic id and any enum's values.
 * In use is decided by semantic id where the catalog has one, and otherwise by a VDA 5050 metric
 * named for the field. Nothing here is edited.
 */
export function vda5050VocabularyTab({ vocabulary, catalog, onUseField }) {
  const sections = vda5050Sections(vocabulary).map(s => ({
    ...s,
    items: s.entries.map(field => ({ id: `vda:${field.name}`, name: field.name, field }))
  }))

  const semanticIds = new Set()
  const metricNames = []
  for (const metric of catalog || []) {
    if (metric?.semantic_id) semanticIds.add(metric.semantic_id)
    if (metric?.standard === STANDARDS.VDA5050 && metric?.name) metricNames.push(metric.name)
  }

  return {
    id: STANDARDS.VDA5050,
    label: 'VDA 5050',
    hint: 'Automated guided vehicle readings — the fields of the state message. VDA 5050 3.0 calls the vehicle a mobile robot.',
    searchPlaceholder: 'Search fields…',
    sections,
    isUsed: item =>
      (!!item.field.semantic_id && semanticIds.has(item.field.semantic_id)) ||
      metricNames.some(name => name === `${VDA5050_GROUP}/${fieldType(item.field)}` || name.endsWith(`/${fieldType(item.field)}`)),
    tooltipFor: item => fieldTooltip(item.field),
    idFor: item => (item.field.semantic_id ? { label: 'Semantic ID', value: item.field.semantic_id } : null),
    metaFor: item => [item.field.datatype, item.field.unit].filter(Boolean).join(' · '),
    onUse: onUseField ? (item => onUseField(item.field)) : undefined
  }
}
