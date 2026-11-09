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

/** One device's readings over time on the History page, at the window it opens on. */
export const deviceHistoryUrl = (id) => `/history/device/${encodeURIComponent(id)}`

/** Every device provisioned with one schema. */
export const devicesForSchemaUrl = (uuid) => pageUrl('devices', { schema: uuid })

/** Every device in one cell, archived ones included: the Devices page hides those by default. */
export const devicesInCellUrl = (id) => pageUrl('devices', { cell: id, lifecycle: ['active', 'archived'] })

/** The replay lanes on one gateway, the Playback gateway: the Devices page hides lanes by default. */
export const replayLanesUrl = (gatewayId) => pageUrl('devices', { gateway: gatewayId, replay: true })

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

/** Every change one person or machine identity made, by their user id: the trail's Changed by. */
export const changesByUrl = (userId) => pageUrl('audit-trail', { changed_by: userId })

/** The readings ingestion refused or flagged for one device: its SCHEMA_REJECTION rows. */
export const schemaRejectionsUrl = (deviceId) =>
  pageUrl('audit-trail', { search: deviceId, action: 'SCHEMA_REJECTION' })

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

/** One record by its kind (`device`, `gateway`, `cell`, `area`, `schema`), or null for any other. */
export const entityUrl = (type, id) => {
  const url = { device: deviceUrl, gateway: gatewayUrl, cell: cellUrl, area: areaUrl, schema: schemaUrl }[type]
  return url && id ? url(id) : null
}

/** One proposal with its drawer open, on the queue that holds it: Awaiting a decision or Decided. */
export const proposalUrl = (id, decided = false) => pageUrl('approvals', { proposal: id }, decided ? 'decided' : '')

/** One metric with its drawer open, in the catalog or on the Deprecated Metrics tab. */
export const metricUrl = (uuid, deprecated = false, derived = false) =>
  pageUrl('metrics', { metric: uuid }, deprecated ? 'deprecated' : derived ? 'derived' : '')

/** A gateway or a device on the Capture page, with its captures open. */
export const captureSubjectUrl = (kind, id) => pageUrl('capture', { subject: id }, kind === 'device' ? 'device' : '')

/** One backup run on the Backups page, or the page itself. */
export const backupUrl = (runId = '') => pageUrl('backups', { run: runId })

/**
 * One person on Access Control › People with their drawer open, by their user id, which survives a
 * change of address. People opens it whatever its filters show; a removed person is shown with the
 * removed.
 */
export const personUrl = (userId, removed = false) =>
  pageUrl('access-control', { removed, person: userId }, 'people')

/**
 * One machine identity on Access Control › Machine identities, found by name or principal id;
 * likewise the withdrawn.
 */
export const identityUrl = (name, withdrawn = false) => pageUrl('access-control', { search: name, withdrawn }, 'identities')

/** One app that signs people in, on Access Control › Apps, with its drawer open. */
export const appUrl = (id) => pageUrl('access-control', { app: id }, 'apps')

/** One setting, by its key, on the category that holds it. */
export const settingUrl = (key) => pageUrl('settings', { setting: key })

/** Settings › Notifications: the webhook, its routes and the delivery log. */
export const notificationsUrl = () => pageUrl('settings', {}, 'notifications')

/** The Metric Catalog with Unmapped on. */
export const unmappedMetricsUrl = () => pageUrl('metrics', { unmapped: true })

/** One tab of a page, as the search's cards and the rail's signals open it. */
export const tabUrl = (page, tab = '') => pageUrl(page, {}, tab)

/** The capture and playback rules (0226), which name their job in the `job` label. */
const JOB_RULES = new Set(['aber-job-failed', 'aber-job-stuck'])
const JOB_LABEL = /^(capture|playback) job \S+$/

/**
 * The page in the dashboard for a Grafana alert whose subject has one, as `{ to, title }`, or null
 * for any other alert, whose home is its rule in Grafana. The alert counter and the alert toasts
 * both link by this, so they agree.
 *
 * - A machine identity's token: the identity on Access Control, where a new token is issued.
 * - A capture or playback job: the Capture page on the tab of its kind, read from the `job` label.
 *   The strip above every tab shows a job in flight, with Stop; the tab lists a failed one.
 * - The playback worker not reporting: the Playbacks tab, whose strip shows the waiting playback.
 */
export const alertPage = (alert) => {
  if (alert?.entity_type === 'service_identity' && alert.entity_id) {
    return { to: identityUrl(alert.entity_id), title: 'Show this machine identity on Access Control' }
  }
  if (alert?.rule_uid === 'aber-playback-worker-stale') {
    return { to: tabUrl('capture', 'playbacks'), title: 'Show the waiting playback on the Capture page' }
  }
  const kind = JOB_RULES.has(alert?.rule_uid) && JOB_LABEL.exec(alert.labels?.job ?? '')?.[1]
  if (!kind) return null
  return { to: tabUrl('capture', `${kind}s`), title: `Show this ${kind} on the Capture page` }
}
