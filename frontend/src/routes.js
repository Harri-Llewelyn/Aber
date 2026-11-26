import { pageUrl } from './hooks/useUrlState'
import { ENTITY_KIND_BY_TABLE, isAutomationAlert } from './constants'

/*
 * The addresses one page links to on another. A drill-down is a link to one of these, so it opens
 * in a new tab with Ctrl-click and survives a reload; the page at the other end reads the same
 * query parameters it writes when somebody sets the filter by hand.
 */

/**
 * One device: its id (or Sparkplug id) in the page's search, which opens its drawer. `archived` sets the
 * page's lifecycle filter too, which opens on what is in service.
 */
export const deviceUrl = (id, archived = false) => pageUrl('devices', { search: id, lifecycle: archived && 'archived' })
export const gatewayUrl = (id, archived = false) => pageUrl('gateways', { search: id, lifecycle: archived && 'archived' })
export const cellUrl = (id, archived = false) => pageUrl('cells', { search: id, lifecycle: archived && 'archived' })
export const areaUrl = (id, archived = false) => pageUrl('areas', { search: id, lifecycle: archived && 'archived' })
export const schemaUrl = (uuid) => pageUrl('schemas', { search: uuid })
/** The Schemas page with every version listed, superseded ones too: the page cannot search by a metric. */
export const allSchemaVersionsUrl = () => pageUrl('schemas', { status: 'all' })

/** Build Schema from Template on the Schemas page, with one template chosen, by its id. */
export const schemaFromTemplateUrl = (templateId) => pageUrl('schemas', { template: templateId })

/** The submodel templates, on the Vocabulary page's Templates tab. */
export const templatesUrl = () => pageUrl('vocabulary', {}, 'templates')

/** One device's readings over time on the History page, at the window it opens on. */
export const deviceHistoryUrl = (id) => `/history/device/${encodeURIComponent(id)}`

/** One cell's machines compared on the History page, at the window it opens on. */
export const cellHistoryUrl = (id) => `/history/cell/${encodeURIComponent(id)}`

/** One area's cells compared on the History page, at the window it opens on. */
export const areaHistoryUrl = (id) => `/history/area/${encodeURIComponent(id)}`

/** One metric across every device that reports it on the History page, at the window it opens on. A name holds slashes, so it is one encoded segment. */
export const metricHistoryUrl = (name) => `/history/metric/${encodeURIComponent(name)}`

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

/** One Audit Trail event with its drawer open, by the id its row has: an export's, in a toast. */
export const auditEventUrl = (eventId) => pageUrl('audit-trail', { event: eventId })

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

/*
 * The kinds whose address takes more than an id. `variant` is what entity_directory (0321) says sets the
 * record apart within its kind: a metric's tab, a capture's kind of subject, an identity withdrawn and a
 * person removed. `state` is whether it is archived, which four kinds can be.
 */
const deviceEntityUrl = (id, variant, state) => deviceUrl(id, state === 'archived')
const gatewayEntityUrl = (id, variant, state) => gatewayUrl(id, state === 'archived')
const cellEntityUrl = (id, variant, state) => cellUrl(id, state === 'archived')
const areaEntityUrl = (id, variant, state) => areaUrl(id, state === 'archived')
const metricEntityUrl = (id, variant) => metricUrl(id, variant === 'deprecated', variant === 'derived')
const captureEntityUrl = (id, variant) => captureSubjectUrl(variant, id)
const identityEntityUrl = (id, variant) => identityUrl(id, variant === 'withdrawn')
const personEntityUrl = (id, variant) => personUrl(id, variant === 'removed')

/**
 * One record by its kind, or null for a kind with no page or a record with no id to open it by. The id is
 * the one its own page finds it by: a capture's subject, a backup's run and an automation's key.
 */
export const entityUrl = (type, id, variant = null, state = null) => {
  const url = { device: deviceEntityUrl, gateway: gatewayEntityUrl, cell: cellEntityUrl, area: areaEntityUrl, schema: schemaUrl, metric: metricEntityUrl,
    capture: captureEntityUrl, backup: backupUrl, automation: automationUrl, identity: identityEntityUrl, person: personEntityUrl }[type]
  return url && id ? url(id, variant, state) : null
}

/** The Entities page searched by a text. A whole id that names one entity opens that entity, whatever its state. */
export const findEntityUrl = (text) => pageUrl('entities', { find: text })

/** One proposal with its drawer open, on the queue that holds it: Awaiting a decision or Decided. */
export const proposalUrl = (id, decided = false) => pageUrl('approvals', { proposal: id }, decided ? 'decided' : '')

/** One metric with its drawer open, in the catalog or on the Deprecated Metrics tab. */
export const metricUrl = (uuid, deprecated = false, derived = false) =>
  pageUrl('metrics', { metric: uuid }, deprecated ? 'deprecated' : derived ? 'derived' : '')

/** One imported vocabulary on the Vocabulary page's Imported tab, its concepts open; the tab with no id. */
export const siteVocabularyUrl = (id = '') => pageUrl('vocabulary', { file: id }, 'imported')

/** A gateway or a device on the Capture page, with its captures open. */
export const captureSubjectUrl = (kind, id) => pageUrl('capture', { subject: id }, kind === 'device' ? 'device' : '')

/** One recording or playback (`kind` 'capture' or 'playback') on its tab of the Capture page: the only job listed there. */
export const captureJobUrl = (kind, id) => pageUrl('capture', { job: id }, `${kind}s`)

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

/** The Automations page: the list, or one automation by its `id:` in the file. */
export const automationsUrl = () => pageUrl('automations')
/** A new automation: the editor on the example. No `?open=1`, which names a saved automation whose id is `new`. */
export const newAutomationUrl = () => '/automations/new'
/** `new` opens the starter and `built-in` the Built-in tab, so an automation with either id opens with `?open=1` to say it is that one. */
export const automationUrl = (key) => (key === 'new' || key === 'built-in' ? `/automations/${key}?open=1` : `/automations/${encodeURIComponent(key)}`)
/** Every automation that applies to one device (or any entity), and why. */
export const automationsForEntityUrl = (id) => pageUrl('automations', { entity: id })
/** The automation that owns a trigger, by the trigger's id: the page opens that automation. */
export const automationForTriggerUrl = (triggerId) => pageUrl('automations', { trigger: triggerId })

/** The Automations page's Built-in tab: the alerts Aber raises about itself. Its id is navigation.jsx's. */
export const builtInAlertsUrl = () => tabUrl('automations', 'built-in')
/** One built-in alert, by its rule's uid, with its drawer open. */
export const builtInRuleUrl = (uid) => pageUrl('automations', { rule: uid }, 'built-in')

/**
 * Where an alert a built-in rule raised opens in the dashboard: the rule's drawer on the Built-in
 * tab, by the `rule_uid` the row keeps. A row written before the uid was kept opens the tab searched
 * by the alert's name. An alert an automation raised is no built-in rule's, and answers null:
 * alertPage() names its page.
 */
export const builtInAlertUrl = (alert) => {
  if (isAutomationAlert(alert)) return null
  const { rule_uid: uid, alert_name: name } = alert ?? {}
  if (uid) return builtInRuleUrl(uid)
  return name ? pageUrl('automations', { search: name }, 'built-in') : builtInAlertsUrl()
}

/**
 * The trigger id in the fingerprint of an alert an automation raised, `condition:<trigger
 * id>:<device id>:<metric>` (automation_alert_fingerprint(), 0255), or null for any other alert.
 */
export const triggerIdOfFingerprint = (fingerprint) =>
  /^condition:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/.exec(String(fingerprint ?? ''))?.[1] ?? null

/** The capture and playback rules (0226), which name their job in the `job` label. */
const JOB_RULES = new Set(['aber-job-failed', 'aber-job-stuck'])
const JOB_LABEL = /^(capture|playback) job (\S+)$/

/**
 * The page in the dashboard for a Grafana alert whose subject has one, as `{ to, title }`, or null
 * for any other alert, whose home is its rule in Grafana. The alert counter and the alert toasts
 * both link by this, so they agree.
 *
 * - A machine identity's token: the identity on Access Control, where a new token is issued.
 * - A capture or playback job: the Capture page on the tab of its kind, narrowed to that job, both
 *   read from the `job` label. The strip above every tab shows a job in flight, with Stop; the tab
 *   lists a failed one.
 * - The playback worker not reporting: the Playbacks tab, whose strip shows the waiting playback.
 * - An alert an automation raised: that automation, found by the trigger id its fingerprint names.
 */
export const alertPage = (alert) => {
  if (alert?.entity_type === 'service_identity' && alert.entity_id) {
    return { to: identityUrl(alert.entity_id), title: 'Show this machine identity on Access Control' }
  }
  const trigger = triggerIdOfFingerprint(alert?.fingerprint)
  if (trigger) return { to: automationForTriggerUrl(trigger), title: 'Show the automation that raised this alert' }
  if (alert?.rule_uid === 'aber-playback-worker-stale') {
    return { to: tabUrl('capture', 'playbacks'), title: 'Show the waiting playback on the Capture page' }
  }
  const job = JOB_RULES.has(alert?.rule_uid) ? JOB_LABEL.exec(alert.labels?.job ?? '') : null
  if (!job) return null
  const [, kind, id] = job
  return { to: captureJobUrl(kind, id), title: `Show this ${kind} on the Capture page` }
}
