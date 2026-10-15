import { pageUrl } from './hooks/useUrlState'
import { ENTITY_KIND_BY_TABLE } from './constants'

/*
 * The addresses one page links to on another. A drill-down is a link to one of these, so it opens
 * in a new tab with Ctrl-click and survives a reload; the page at the other end reads the same
 * query parameters it writes when somebody sets the filter by hand.
 */

/** One device: its id (or Sparkplug id) in the page's search, which opens its drawer. */
export const deviceUrl = (id) => pageUrl('devices', { search: id })
export const gatewayUrl = (id) => pageUrl('gateways', { search: id })
export const cellUrl = (id) => pageUrl('cells', { search: id })
export const areaUrl = (id) => pageUrl('areas', { search: id })
export const schemaUrl = (uuid) => pageUrl('schemas', { search: uuid })

/** Every device provisioned with one schema. */
export const devicesForSchemaUrl = (uuid) => pageUrl('devices', { schema: uuid })

/** The Site Map, scrolled to one area. */
export const siteMapAreaUrl = (id) => pageUrl('site-map', { area: id })

/**
 * One entity's history. A device's trail includes its nameplate and schema rows, which carry the
 * device's id, so a device sets no kind: the id in the search selects every row keyed by it.
 * `deleted` shows entities no live table holds, for a tombstone's hand-over.
 */
export const trailKindFilter = (type) => {
  const kind = ENTITY_KIND_BY_TABLE[type] || String(type || '').toUpperCase()
  return kind === 'DEVICE' ? '' : kind
}
export const trailUrl = (id, type = '', deleted = false) =>
  pageUrl('audit-trail', { search: id, type: trailKindFilter(type), deleted })

/** The open proposals about one entity. */
export const approvalsForUrl = (subject) => pageUrl('approvals', { search: subject })

/**
 * The page that owns a proposal's subject, where its Propose a Change dialog seeds itself from the
 * proposal. Areas are tested before cells: the device fallthrough would otherwise take them.
 */
export const proposalSubjectUrl = (proposal) => {
  const type = proposal.entity_type || ''
  if (type.startsWith('area')) return areaUrl(proposal.entity_id)
  if (type.startsWith('cell')) return cellUrl(proposal.entity_id)
  if (type.startsWith('gateway')) return gatewayUrl(proposal.entity_id)
  return deviceUrl(proposal.entity_id)
}

/** One setting, by its key, on the category that holds it. */
export const settingUrl = (key) => pageUrl('settings', { setting: key })

/** The Metric Catalog with Unmapped on. */
export const unmappedMetricsUrl = () => pageUrl('metrics', { unmapped: true })

/** One tab of a page, as the search's cards and the rail's signals open it. */
export const tabUrl = (page, tab = '') => pageUrl(page, {}, tab)
