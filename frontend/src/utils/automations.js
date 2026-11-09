import { spanWords } from './history'
import { plural } from './format'
import { triggerIdOfFingerprint } from '../routes'

/*
 * What the Automations page works out for itself: who may write, how a trigger reads in words, which
 * automations are firing and when each last fired, and why one applies to a device. Pure, so each rule
 * is unit-tested. The database is the authority on what a file may hold (apply_automations(), 0256);
 * docs/automations.md is the format's reference.
 */

/** Who may apply, enable, disable and delete. Mirror check 85 holds it to the three writers (0256). */
export const AUTOMATION_WRITE_ROLES = ['Administrator', 'Shopfloor_Manager']
export const mayWriteAutomations = (role) => AUTOMATION_WRITE_ROLES.includes(role)

/** The hover text of a control a reader may not use, in the roles' own words: "Requires Administrator or Shopfloor Manager". */
export const AUTOMATION_WRITE_TITLE = `Requires ${AUTOMATION_WRITE_ROLES.map(r => r.replace(/_/g, ' ')).join(' or ')}`

/**
 * The patterns and limits a file's values answer to, as `automations_key_format`,
 * `automations_parse()` and the JSON Schema hold them. Mirror check 87 holds them together.
 */
export const AUTOMATION_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const AUTOMATION_HOLD_PATTERN = /^(0|[1-9][0-9]{0,2})[smh]$/
export const AUTOMATION_SEVERITIES = ['critical', 'warning', 'info']

/** The path the dashboard serves the JSON Schema at, and the line that points VS Code's YAML extension at it. */
export const AUTOMATION_SCHEMA_PATH = '/json-schema/automations.schema.json'
export const schemaComment = (origin) => `# yaml-language-server: $schema=${origin}${AUTOMATION_SCHEMA_PATH}`

/**
 * The file `/automations/new` starts from: the example in docs/automations.md, whose drift check
 * holds the two together. Its device is not a real one, so the first save says which line to fix.
 */
export const AUTOMATION_EXAMPLE = `- id: lathe-3-spindle-hot
  alias: Lathe 3 spindle bearing hot
  description: Bearing above 80 °C for five minutes. Check the coolant feed first.
  enabled: true
  triggers:
    - trigger: threshold
      device: 3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13
      metric: Spindle/BEARING_TEMPERATURE
      above: 80
      for: 5m
  actions:
    - action: alert
      severity: warning
`

/** What an export is saved as. */
export const AUTOMATIONS_FILE_NAME = 'automations.yaml'

// ------------------------------------------------------------------------------------------------
// Words
// ------------------------------------------------------------------------------------------------

/** `for:` as seconds: "5m" is 300, "0s" is 0. Null for text that is not a hold. */
export function holdSeconds(text) {
  const m = AUTOMATION_HOLD_PATTERN.exec(String(text ?? ''))
  if (!m) return null
  return Number.parseInt(text, 10) * { s: 1, m: 60, h: 3600 }[text.slice(-1)]
}

/** The device ids a trigger names, whether its `device:` is one id or a list. */
export const triggerDevices = (trigger) => {
  const d = trigger?.device
  return (Array.isArray(d) ? d : [d]).filter(id => typeof id === 'string' && id)
}

/**
 * One trigger in words: "Spindle/BEARING_TEMPERATURE above 80 for 5 min on 2 devices". One device is
 * named when the document's device list knows its name.
 */
export function triggerWords(trigger, devices = {}) {
  if (!trigger) return ''
  if (trigger.trigger !== 'threshold') return String(trigger.trigger || 'trigger')
  const direction = trigger.above != null ? `above ${trigger.above}` : trigger.below != null ? `below ${trigger.below}` : ''
  const hold = holdSeconds(trigger.for)
  const held = hold ? ` for ${spanWords(hold * 1000)}` : ''
  const ids = triggerDevices(trigger)
  const on = ids.length === 1
    ? ` on ${devices?.[ids[0]]?.name || '1 device'}`
    : ids.length > 1 ? ` on ${plural(ids.length, 'device')}` : ''
  return `${trigger.metric ?? ''} ${direction}${held}${on}`.replace(/\s+/g, ' ').trim()
}

/** An automation's triggers in words: the first two, then how many more. */
export function automationWords(automation, devices = {}) {
  const triggers = automation?.triggers || []
  if (triggers.length === 0) return 'No trigger'
  const shown = triggers.slice(0, 2).map(t => triggerWords(t, devices)).join('; ')
  return triggers.length > 2 ? `${shown}; and ${triggers.length - 2} more` : shown
}

/** What the list's search matches: the name, the id, the words, the metrics and the devices' names. */
export function automationSearchText(automation, devices = {}) {
  const triggers = automation?.triggers || []
  return [
    automation?.alias, automation?.id, automation?.description,
    ...triggers.map(t => t.metric),
    ...triggers.flatMap(t => triggerDevices(t).map(id => devices?.[id]?.name)),
    automationWords(automation, devices),
  ].filter(Boolean).join('\n').toLowerCase()
}

// ------------------------------------------------------------------------------------------------
// Firing
// ------------------------------------------------------------------------------------------------

/** An alert's fingerprint as automation_alert_fingerprint() composes it: the trigger, the device and the metric. */
export function fingerprintParts(fingerprint) {
  const triggerId = triggerIdOfFingerprint(fingerprint)
  if (!triggerId) return null
  const [deviceId, ...metric] = String(fingerprint).slice('condition:'.length + triggerId.length + 1).split(':')
  return { triggerId, deviceId: deviceId || null, metric: metric.join(':') || null }
}

/**
 * Each occurrence of the automations' alerts with how it ended: `ended_at` is its `ends_at`, or for
 * a firing one that a later occurrence replaced (both writers open a new one without resolving the
 * old), that one's start. `firing` is still firing: nothing replaced it. The rows are newest first,
 * as the page reads them; alert_occurrences() (0243) makes the same rule.
 */
export function occurrencesWithEnds(rows) {
  const newer = new Map()
  return (rows || []).map(row => {
    const next = newer.get(row.fingerprint)
    newer.set(row.fingerprint, row.starts_at)
    const open = row.status === 'firing' && !row.ends_at
    return { ...row, ended_at: row.ends_at ?? next ?? null, replaced: open && next !== undefined, firing: open && next === undefined }
  })
}

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 }

/** The most serious severity among rows, for the badge's tone. */
export const worstSeverity = (rows) =>
  [...rows].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3))[0]?.severity ?? null

/**
 * The automations as the list draws them, from what `api.readAutomations()` read: `automations` and
 * `devices` from automations_document(), `rows` (each automation's uuid and trigger ids), `active`
 * (the alerts firing now, from platform_alerts_active) and `history` (the newest occurrences of
 * every automation alert). Each entry holds its document and `uuid`, `summary` in words, `firing`
 * (the rows firing now) and `lastFiredAt`.
 */
export function automationEntries({ automations = [], devices = {}, rows = [], active = [], history = [] } = {}) {
  const byKey = new Map(rows.map(r => [r.key, r]))
  const occurrences = occurrencesWithEnds(history)
  return automations
    .map(automation => {
      const row = byKey.get(automation.id)
      const triggerIds = new Set((row?.automation_triggers || []).map(t => t.id))
      const own = (fingerprint) => triggerIds.has(triggerIdOfFingerprint(fingerprint))
      const firing = active.filter(a => own(a.fingerprint))
      const last = occurrences.find(o => own(o.fingerprint))
      return {
        ...automation,
        key: automation.id,
        uuid: row?.id ?? null,
        updatedAt: row?.updated_at ?? null,
        summary: automationWords(automation, devices),
        triggerIds,
        firing,
        lastFiredAt: last?.starts_at ?? null,
        search: automationSearchText(automation, devices),
      }
    })
    .sort((a, b) => String(a.alias).localeCompare(String(b.alias)) || a.key.localeCompare(b.key))
}

/** The newest occurrences of one automation's alerts, as occurrencesWithEnds() reads them. */
export function recentFirings(entry, history, limit = 20) {
  return occurrencesWithEnds(history)
    .filter(o => entry.triggerIds.has(triggerIdOfFingerprint(o.fingerprint)))
    .slice(0, limit)
}

/** An object's entries as `key=value` text, for the labels and values an alert kept. */
export function pairsText(object) {
  if (!object || typeof object !== 'object') return ''
  return Object.entries(object).map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`).join(', ')
}

// ------------------------------------------------------------------------------------------------
// From an entity to its automations
// ------------------------------------------------------------------------------------------------

/** Why an automation applies to an entity, as automations_for_entity() says it, and the words for each. */
export const APPLIES_BECAUSE = {
  named: { label: 'Named', title: 'One of its triggers names this entity.' },
  'site-wide': { label: 'Site-wide', title: 'It applies to every modelled device, this one included.' },
}

/** The reasons from automations_for_entity(), as a map of automation key to its reasons in order. */
export function reasonsByKey(rows) {
  const map = new Map()
  for (const r of rows || []) map.set(r.key, [...(map.get(r.key) || []), r.reason])
  return map
}

// ------------------------------------------------------------------------------------------------
// What an apply or a preview answers
// ------------------------------------------------------------------------------------------------

/** The statuses apply_automations() gives each automation, in the order the preview lists them, with their words. */
export const RESULT_STATUSES = [
  { value: 'refused', label: 'Refused', tone: 'danger' },
  { value: 'new', label: 'New', tone: 'success' },
  { value: 'changed', label: 'Changed', tone: 'info' },
  { value: 'unchanged', label: 'Unchanged', tone: 'neutral' },
]

export const resultStatus = (value) => RESULT_STATUSES.find(s => s.value === value) ?? { value, label: String(value), tone: 'neutral' }

/** How many of the results an apply would write: the new and the changed. */
export const writtenCount = (results) => (results || []).filter(r => r.status === 'new' || r.status === 'changed').length

/** How many the database refused. */
export const refusedCount = (results) => (results || []).filter(r => r.status === 'refused').length

/**
 * What an apply says in its toast: the one automation by its id and what became of it, or how many were
 * written and how, from `source` (a file's name) when there is one.
 */
export function appliedWords(results, source = null) {
  const written = (results || []).filter(r => r.status === 'new' || r.status === 'changed')
  const from = source ? ` from ${source}` : ''
  if (written.length === 1) return `Automation '${written[0].key}' ${written[0].status === 'new' ? 'created' : 'changed'}${from}`
  const created = written.filter(r => r.status === 'new').length
  return `Applied ${plural(written.length, 'automation')}${from} (${created} new, ${written.length - created} changed)`
}

/** The keys a changed automation differs in, as a result's `changes` lists them. */
export const changeWords = (changes) => (changes || []).join(', ')
