import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '../../api'
import { downloadCSV } from '../../utils/downloadCSV'
import { ContextPanel } from '../common/ContextPanel'
import {
  IconHistory, IconDownload, IconX, IconLayoutDashboard, IconFactory, IconRadio, IconCpu, IconTrash,
  IconShieldCheck, IconLock, IconClipboardList, IconSettings
} from '../common/Icons'
import { HelpTip } from '../common/HelpTip'
import {
  DIGITAL_THREAD_ACTIONS, DIGITAL_THREAD_ENTITY_TYPES, ENTITY_KIND_BY_TABLE, digitalThreadEntityTypesFor
} from '../../constants'
import { useSetting } from '../../hooks/useSettings'

/**
 * `changed_by` names the user and is NULL for every machine write; `actor_source` names the kind of
 * actor, so a blank author is not ambiguous.
 */
const ACTOR_LABELS = {
  user:      { label: 'User',              title: 'Made by a signed-in operator' },
  ingestion: { label: 'Ingestion daemon',  title: 'Written by the Sparkplug B ingestion daemon' },
  migration: { label: 'Database migration', title: 'Written by a migration or an owner connection' },
  service:   { label: 'Service',           title: 'Written by an automated service on the service-role key' }
}

/** The actor badge's text and hover title, from the pair of columns that describe one actor. */
function actorLabel(event) {
  if (event.actor_source === 'user' || event.changed_by) return ACTOR_LABELS.user.label
  return ACTOR_LABELS[event.actor_source]?.label || '⚠ Unattributed'
}
function actorTitle(event) {
  if (event.changed_by) return `Changed by user ${event.changed_by}`
  return ACTOR_LABELS[event.actor_source]?.title || 'No actor recorded for this change'
}

/**
 * The trigger writes TG_TABLE_NAME ('devices'); the UI and page handovers use 'DEVICE'. The map in
 * constants.js normalises both and is shared with the filter and api.js so the three cannot drift.
 */
const ENTITY_KIND = ENTITY_KIND_BY_TABLE
/**
 * The kinds a deletion can be told about: this page fetches a lookup covering them, and
 * `digital_thread_page()` can probe a table for their rows (0117). Absence from `entityIdentities`
 * means the row is gone, for these and for nothing else. `NAMEPLATE` qualifies because
 * `device_nameplate` is keyed by the device's id, so the devices lookup names it and the devices
 * probe answers for it.
 *
 * ONE SET FOR BOTH USES -- the "deleted" flag and the hide filter. As two sets, a schema sat in the
 * gap: flagged deleted, never hidden, never counted, and since the count is what draws the reveal
 * control, no way to hide it.
 *
 * ACCESS IS OUT, though `list_user_accounts()` does name that lane (0116): its subject is an
 * `auth.users` row the RPC cannot probe, so the server can never hide one and the page must not
 * claim a deletion it cannot act on. An unnameable person falls back to a shortened id, unflagged.
 */
export const DELETABLE_KINDS = new Set(
  ['AREA', 'CELL', 'GATEWAY', 'DEVICE', 'SCHEMA', 'NAMEPLATE']
)

/** Before any lookup lands, nothing is answerable. Hoisted so it is not a new Set every render. */
const EMPTY_KINDS = new Set()

const entityKind = (t) =>
  ENTITY_KIND[String(t || '').toLowerCase()] || String(t || '').toUpperCase()

/**
 * Columns excluded from every diff: timestamp churn that would otherwise open each diff with a line
 * nobody came to read. `updated_at` and `last_seen` are not columns today; listed so the denylist
 * keeps working if they are added.
 */
const NOISE_FIELDS = new Set(['updated_at', 'last_heartbeat', 'last_seen'])

/**
 * Fields whose change is a governance act (what the asset is declared to be) rather than an
 * operational one. `asset_config` names the concept even though it is its own, unaudited, table.
 */
const GOVERNANCE_FIELDS = new Set([
  'schema_id', 'asset_config', 'asset_type', 'connection_method', 'grafana_url', 'access_url'
])
/* `identity_source` is deliberately absent: a device's first DBIRTH updates it alongside `status`,
   and it is provenance written by ingestion rather than operator configuration. `name` and `icon`
   are cosmetic, not governance. */

/** The four marker classes. `kind` is a CSS suffix as well as a key -- see `.dt-node-*`. */
export const MARKERS = {
  creation:    { label: 'Created',       hint: 'Row created — provisioning, or a first DBIRTH admitting the asset' },
  operational: { label: 'Operational',   hint: 'State change — status, cell, or another running-time property' },
  governance:  { label: 'Configuration', hint: 'Governance change — schema binding or declared configuration' },
  critical:    { label: 'Lifecycle',     hint: 'Lifecycle event — deleted, archived, or quarantined' }
}

/** Deep-enough equality for a JSONB snapshot: scalars by value, objects by serialisation. */
const sameValue = (a, b) => {
  if (a === b) return true
  if (a === null || a === undefined) return b === null || b === undefined
  if (typeof a === 'object' || typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
  }
  return false
}

/**
 * The changed columns between two row snapshots. `old_data` and `new_data` are whole rows
 * (`to_jsonb`), not deltas. An INSERT has no `old_data` and a DELETE no `new_data`; those render
 * one-sided with their empty columns dropped.
 */
export function diffFields(oldData, newData) {
  const before = oldData && typeof oldData === 'object' ? oldData : null
  const after  = newData && typeof newData === 'object' ? newData : null

  const snapshot = (obj, side) => Object.keys(obj)
    .filter(k => !NOISE_FIELDS.has(k))
    .filter(k => obj[k] !== null && obj[k] !== undefined && obj[k] !== '')
    .sort()
    .map(k => side === 'after'
      ? { field: k, before: undefined, after: obj[k] }
      : { field: k, before: obj[k], after: undefined })

  if (!before && !after) return []
  if (!before) return snapshot(after, 'after')
  if (!after)  return snapshot(before, 'before')

  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(k => !NOISE_FIELDS.has(k))
    .sort()
    .filter(k => !sameValue(before[k], after[k]))
    .map(k => ({ field: k, before: before[k], after: after[k] }))
}

/**
 * Which marker an event gets. `digital_thread.action` holds only INSERT / UPDATE / DELETE from the
 * trigger, so archiving, quarantining and a schema rebinding are derived from the diff.
 * SCHEMA_REJECTION is written by `record_ingestion_rejection()` with no diff, so the action itself
 * decides: governance, not critical. An INSERT is always creation, even of an already-quarantined
 * device.
 */
export function classifyEvent(event, diff) {
  const action = String(event.event_type || event.action || '').toUpperCase()

  // `audit_domain` is stamped at insert time; a security row is governance whatever its verb.
  // Optional, because fixtures and older page states supply rows without it, which fall through to
  // the derivation.
  if (event.audit_domain === 'security') return 'governance'

  if (action === 'SCHEMA_REJECTION') return 'governance'
  // TOKEN_MINTED and TOKEN_REVOKED record who may reach the stack: governance, not creation and not
  // critical. Named explicitly because rows without `audit_domain` still arrive.
  if (action === 'TOKEN_MINTED' || action === 'TOKEN_REVOKED') return 'governance'
  // The same argument, arriving from `user_roles` (0070). A revocation is not `critical`: that
  // marker is for an asset's lifecycle, and nothing on the shopfloor ended here.
  if (action === 'ROLE_GRANTED' || action === 'ROLE_REVOKED') return 'governance'
  if (action === 'DELETE') return 'critical'
  if (action === 'INSERT') return 'creation'

  const changed = new Set(diff.map(d => d.field))
  const roseTo = (field) => changed.has(field) && event.new_data?.[field] === true
  if (roseTo('is_archived') || roseTo('is_quarantined')) return 'critical'

  for (const field of changed) if (GOVERNANCE_FIELDS.has(field)) return 'governance'
  return 'operational'
}

/**
 * The range presets; `ms` of null is unbounded. The short presets exist because an act happens
 * inside a second, and a date-only picker could not frame one.
 */
const TIME_PRESETS = [
  { value: 'all', label: 'All time',       ms: null },
  { value: '15m', label: 'Last 15 minutes', ms: 15 * 60 * 1000 },
  { value: '1h',  label: 'Last 1 hour',     ms: 60 * 60 * 1000 },
  { value: '24h', label: 'Last 24 hours',   ms: 24 * 60 * 60 * 1000 },
  { value: '7d',  label: 'Last 7 days',     ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: 'Last 30 days',    ms: 30 * 24 * 60 * 60 * 1000 }
]

/**
 * The preset or custom dates as the `since` / `until` the API takes. All time is the default: most
 * arrivals are a handover for one asset whose last edit may be years old. Called at fetch time
 * rather than memoised, so a rolling window does not drift while the poll runs.
 */
export function timeWindow(preset, customStart, customEnd) {
  /**
   * A custom bound as an ISO instant. Accepts `YYYY-MM-DDTHH:mm` from `datetime-local` and
   * `YYYY-MM-DD` from the older date input, which names a day and is widened to one end of it.
   * Parsed as local time: appending `Z` or using toISOString() would shift the window by the
   * timezone offset.
   */
  const iso = (value, endOfRange) => {
    if (!value) return ''
    const hasTime = String(value).includes('T')
    const d = hasTime
      ? new Date(value)
      : new Date(`${value}T${endOfRange ? '23:59:59.999' : '00:00:00.000'}`)
    if (Number.isNaN(d.getTime())) return ''
    // Minute granularity: an end bound of 16:11 must include 16:11:59.
    if (hasTime && endOfRange) d.setSeconds(59, 999)
    return d.toISOString()
  }

  if (preset === 'custom') return { since: iso(customStart, false), until: iso(customEnd, true) }

  const ms = TIME_PRESETS.find(p => p.value === preset)?.ms
  return { since: ms ? new Date(Date.now() - ms).toISOString() : '', until: '' }
}

/**
 * Lanes drawn before the rest fold behind a toggle. About a screen of lanes at 33px; a smaller cap
 * folded a single lane on a sixteen-asset stack.
 */
const DEFAULT_LANE_LIMIT = 30

/**
 * The fallback for the `ui.digital_thread_poll_seconds` setting, whose `fallback_source` names this
 * constant.
 */
const DEFAULT_POLL_SECONDS = 60

/**
 * Rows per request. `digital_thread_page()` scans the whole match to count deleted entities whatever
 * the page size, so a larger page only costs; paging is the answer, not a bigger page.
 */
const PAGE_SIZE = 200

/**
 * Fold a freshly polled first page into the pages already loaded. The thread is append-only and
 * read newest-first, so a poll can only prepend. If the fresh page and the held list no longer
 * overlap, more than PAGE_SIZE events arrived since the last poll, and the list restarts from the
 * newest page rather than splicing a hole.
 */
export function mergeFirstPage (prev, fresh) {
  if (!prev || prev.length === 0) return { events: fresh, reset: true }
  const held = new Set(prev.map(e => e.event_id))
  const added = fresh.filter(e => !held.has(e.event_id))
  // Every row is new AND there are rows: the two ranges do not touch. Anything else overlaps, so
  // the fresh rows sit directly on top of what is held.
  if (fresh.length > 0 && added.length === fresh.length) return { events: fresh, reset: true }
  return { events: [...added, ...prev], reset: false }
}

/* Markers too close to draw separately become one badge carrying the count. Grouping is by pixel
   distance, so the range control acts as a zoom, and positions are never nudged along the time
   axis: identical timestamps are the visual signature of one transaction. See the Digital Thread
   notes in frontend/README.md. */

/**
 * How close, in pixels, is too close: a 13px marker with a 2px ring touches at 14px. Pixels rather
 * than time, because whether two markers overlap depends on the range on screen.
 */
export const CLUSTER_GAP_PX = 14

/**
 * One lane's events, as the things its track actually draws.
 *
 * @param {Array}    events      one lane's events
 * @param {Function} xOf         event -> 0..1 along the track
 * @param {number}   trackWidth  measured px; 0 draws everything singly
 * @returns {Array} `{ isCluster, events, event, xOffset }`, left to right. `xOffset` is a fraction
 *                  of the track, 0..1; `event` is the earliest member, and is what a click selects.
 */
export function clusterEvents(events, xOf, trackWidth) {
  // Chronological; events sharing a timestamp order by `event_id`, the order the rows were written
  // inside one transaction, which is the row a click opens first.
  const ordered = [...events].sort(
    (a, b) => xOf(a) - xOf(b) || Number(a.event_id) - Number(b.event_id)
  )

  const item = (members) => ({
    isCluster: members.length > 1,
    events: members,
    event: members[0],
    // THE GROUP'S CENTRE, not its earliest member's. A badge is wider than a dot and stands for all
    // of them, so pinning it to the first would sit it left of the events it represents.
    xOffset: members.reduce((sum, e) => sum + xOf(e), 0) / members.length
  })

  // No measurement (jsdom, or before layout): draw everything singly rather than guess a width.
  if (!trackWidth) return ordered.map(e => item([e]))

  const groups = []
  let current = []
  let lastX = null

  // Chained from the previous member rather than the group's first: a run of events each 10px apart
  // is one pile.
  for (const e of ordered) {
    const x = xOf(e) * trackWidth
    if (lastX !== null && x - lastX <= CLUSTER_GAP_PX) current.push(e)
    else { if (current.length) groups.push(current); current = [e] }
    lastX = x
  }
  if (current.length) groups.push(current)

  return groups.map(item)
}

/**
 * The hover text on a cluster badge: a breakdown by classification in legend order, then whether
 * the members share a `causation_id` (one act) or merely a timestamp.
 */
export function clusterSummary(events, kindOf) {
  const counts = new Map()
  for (const e of events) {
    const kind = kindOf(e)
    counts.set(kind, (counts.get(kind) || 0) + 1)
  }
  const breakdown = Object.keys(MARKERS)
    .filter(k => counts.has(k))
    .map(k => `${counts.get(k)} ${MARKERS[k].label}`)
    .join(', ')

  const stamps = events
    .map(e => new Date(e.timestamp).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  const first = stamps.length ? new Date(stamps[0]).toLocaleString() : ''
  const last  = stamps.length ? new Date(stamps[stamps.length - 1]).toLocaleString() : ''

  const causation = events[0]?.causation_id
  const oneAct = !!causation && events.every(e => e.causation_id === causation)

  const when = !stamps.length ? ''
    : oneAct ? `One transaction, at ${first}`
      : first === last ? `All at ${first}`
        : `${first} → ${last}`

  return `${events.length} events: ${breakdown}\n${when}\n`
       + 'Click to open the first — narrow the time range to separate them'
}

/**
 * The sections, in the order a plant is organised, then the governance lane. Order and labels come
 * from `DIGITAL_THREAD_ENTITY_TYPES`; only the icons live here, so a kind added to the shared table
 * reaches the timeline and the filter together.
 */
/** The icon for a kind with no section of its own — the raw kind, which `ENTITY_KIND` made legible. */
const FALLBACK_SECTION_ICON = IconHistory

const SECTION_ICONS = {
  AREA:               IconFactory,
  CELL:               IconLayoutDashboard,
  GATEWAY:            IconRadio,
  DEVICE:             IconCpu,
  // THE SECURITY LANE (0070), in the order a reader meets it: who holds what, what the machines
  // are, then the contracts and settings that shape both.
  ACCESS:             IconShieldCheck,
  'SERVICE IDENTITY': IconLock,
  SCHEMA:             IconClipboardList,
  SETTING:            IconSettings
}

/** A kind without an icon here still gets a section, with the fallback icon. */
const SECTIONS = DIGITAL_THREAD_ENTITY_TYPES.map(({ kind, label }) => ({
  kind,
  label,
  Icon: SECTION_ICONS[kind] || FALLBACK_SECTION_ICON
}))

const SECTION_ICON = Object.fromEntries(SECTIONS.map(s => [s.kind, s.Icon]))

/**
 * Is only some of what exists being drawn? `total` is null wherever the count is not known — a
 * server that returns no total (0115) — and not knowing is not a fraction.
 */
export const isPartial = (shown, total) => typeof total === 'number' && total > shown

/**
 * The pair where there is no room for words: "200/467", or "200" when that is all of them. The axis
 * corner is a 210px lane label and the export button a header control; the phrase below overflows
 * both. Used for the events against the whole match AND for the lanes against the lane cap, which
 * are the two numbers in that label and were both being drawn as though they were the whole thing.
 */
export const countRatio = (shown, total) =>
  isPartial(shown, total) ? `${shown}/${total}` : String(shown)

/**
 * How many events are drawn, and out of how many when that is not all of them: "200 of 467 events".
 *
 * The foot of the page used to read "200 events" above a button offering 200 more, which is the
 * same sentence whether the next page is the last or the third of twelve.
 *
 * @param {number}  shown events currently drawn
 * @param {?number} total events matching the filters, or null if the server did not say
 */
export function eventCountLabel (shown, total) {
  const events = (n) => `${n} ${n === 1 ? 'event' : 'events'}`
  return isPartial(shown, total) ? `${shown} of ${events(total)}` : events(shown)
}

/** A UUID shortened to something a person can compare at a glance, when there is no name. */
export const shortId = (id) => {
  const s = String(id || '')
  return s.length > 13 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s
}

/**
 * The fields an audit snapshot can name its subject with, in the order they are preferred.
 *
 * SHARED WITH `digital_thread_page()`'s `p_search` (0115). A field the search matches and this does
 * not is a row you can find and cannot identify; a field here that the search does not match is a
 * lane you can see and cannot search for. `sparkplug_id` is immutable and is what telemetry and
 * alerts are keyed by, so it outranks the rest where a row carries both.
 *
 * `role` is deliberately absent even though `user_roles` rows carry one, and 0115 searches it: the
 * lane is a PERSON, keyed by `user_roles.user_id`, and the role is what happened to them rather
 * than who they are. Labelling the lane with it would give two Administrators one name and would
 * change under a reader as pages arrive, because `resolveLaneName()` takes whichever event it
 * meets first. `list_user_accounts()` (0116) is how that lane gets named.
 */
const SNAPSHOT_IDENTITY_FIELDS = [
  'name',          // areas, cells, gateways, devices
  'sparkplug_id',  // gateways, devices -- immutable, and the key telemetry uses
  'schema_name',   // schemas; `version` is appended below
  'label',         // system_settings, the wording the Settings page shows
  'key',           // system_settings, when it has no label
  'stamp',         // backups, which is what the Backups page calls one
]

/**
 * The identity an audit row carries in its payload, for an entity the lookups cannot name -- one
 * deleted, or of a kind nothing looks up. Both snapshots are checked because an INSERT has only
 * `new_data` and a DELETE only `old_data`.
 */
export function snapshotIdentity(event) {
  const read = (field) => event?.new_data?.[field] ?? event?.old_data?.[field]

  for (const field of SNAPSHOT_IDENTITY_FIELDS) {
    const value = read(field)
    if (value === null || value === undefined || value === '') continue

    // A schema's version is part of its identity -- a lineage shares `schema_name` and differs
    // ONLY in `version` -- so it is returned separately rather than appended. Appended, it is the
    // end of the string, and the end of the string is what a 260px label ellipsises away: sixteen
    // versions of one schema drew sixteen lanes reading `VALIDATE_Schema_Robot_St…`.
    if (field === 'schema_name') {
      const version = read('version')
      return {
        label: String(value),
        qualifier: version ? `v${version}` : undefined,
        field: 'schema_name',
      }
    }
    return { label: String(value), field }
  }

  return null
}

/**
 * The lane label in three falls: the live join, then the audit snapshot, then a shortened id.
 *
 * `gone` is separate from `fromSnapshot` and answers a different question. `fromSnapshot` is where
 * the NAME came from; `gone` is whether the page is entitled to say the entity is deleted, which it
 * is only when a lookup covering that kind has landed and does not hold the id. A kind nothing
 * looks up is unnamed, not deleted.
 */
export function resolveLaneName(entityId, laneEvents, identities, { canTellDeleted = false } = {}) {
  const joined = identities.get(entityId)
  if (joined?.name) {
    return { name: joined.name, qualifier: joined.qualifier, fromSnapshot: false, gone: false }
  }

  // Absent from a lookup that covers this kind, once that lookup has landed. Decided here rather
  // than from `fromSnapshot`, so an entity deleted without a name in its payload is still flagged.
  const gone = Boolean(canTellDeleted)

  for (const e of laneEvents) {
    const snapshot = snapshotIdentity(e)
    if (snapshot) {
      return {
        name: snapshot.label,
        qualifier: snapshot.qualifier,
        fromSnapshot: true,
        identityField: snapshot.field,
        gone,
      }
    }
  }
  return { name: null, fromSnapshot: false, gone }
}

/**
 * The axis label format for a span. Adjacent ticks must never print the same string, so each band
 * is the coarsest format that still separates its own ticks.
 */
export function tickFormatter(spanMs) {
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR

  // Under an hour the seconds are shown: within a burst the minute is constant across several
  // ticks.
  if (spanMs < HOUR) {
    return (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }
  if (spanMs < 24 * HOUR) {
    return (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  // Past a day the date has to appear. Up to three days the clock still separates ticks that fall
  // on the same date; beyond that it is noise on a label that is already unambiguous.
  if (spanMs <= 3 * DAY) {
    return (d) => `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ` +
                  `${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }
  if (spanMs <= 30 * DAY) {
    return (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  /* Past thirty days, an ISO date built from local parts: `MMM YYYY` repeats across five ticks of
     one month, and toISOString() reports the previous day west of UTC. */
  return (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-` +
                `${String(d.getDate()).padStart(2, '0')}`
}

/** A diff value as text. Objects are serialised; an absent value is stated, not left blank. */
const formatValue = (v) => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'object') { try { return JSON.stringify(v) } catch { return String(v) } }
  return String(v)
}

const EmptyValue = ({ label }) => <span className="dt-diff-empty">{label}</span>

/**
 * The other audit rows written by the same transaction. Ordered by `event_id` ascending, the order
 * the rows were written; `recorded_at` is the transaction start time and identical across them.
 * Drawn from the fetched, filtered set, so a sibling outside the current filter is not counted, and
 * the control says so.
 */
export function causationSiblings(event, events) {
  // NULL is not a group: rows written before causation existed carry none, and matching NULLs would
  // collect all of them into one act.
  if (!event?.causation_id) return []

  return events
    .filter(e => e.causation_id === event.causation_id
              && String(e.event_id) !== String(event.event_id))
    .slice()
    .sort((a, b) => Number(a.event_id) - Number(b.event_id))
}

/**
 * Rendered only when there are siblings. The set is filtered, so the page cannot tell a single-row
 * act from siblings outside the filter; absence asserts nothing.
 */
function CausationGroup({ siblings, entityNames, onSelect }) {
  if (!siblings.length) return null

  return (
    <div className="dt-causation">
      <div className="context-panel-section-label">
        Same transaction
        <span className="section-count">{siblings.length}</span>
      </div>

      <p className="dt-causation-hint">
        {siblings.length === 1 ? 'One other change was' : `${siblings.length} other changes were`}
        {' '}written by the same act. Limited to the events currently loaded and filtered.
      </p>

      <ul className="dt-causation-list">
        {siblings.map(s => {
          // Same three falls as the lane label; a sibling may itself have been purged.
          const name = entityNames.get(s.entity_id) || snapshotIdentity(s)?.label
          return (
            <li key={s.event_id}>
              <button
                type="button"
                className="dt-causation-item"
                onClick={() => onSelect(s.event_id)}
                title={`Open this change to ${name || s.entity_id}`}
                /* Explicit, because the computed name would read the spans in order without saying
                   that activating it opens the row. */
                aria-label={`Open this change to ${name || s.entity_id}`}
              >
                <span className="dt-causation-kind">{entityKind(s.entity_type)}</span>
                <span className="dt-causation-name">
                  {name || <span className="mono">{shortId(s.entity_id)}</span>}
                </span>
                <span className="dt-causation-action">{s.event_type}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * The property diff, passed to ContextPanel through `beforeActions`. ContextPanel is presentational
 * and knows nothing about audit payloads.
 */
function EventDiff({ event, diff }) {
  const action = String(event.event_type || event.action || '').toUpperCase()
  // SCHEMA_REJECTION and TOKEN_MINTED are one-sided: `old_data` is NULL by construction, and a
  // Previous column would invite a search for a prior state that does not exist.
  const oneSided = action === 'INSERT' || action === 'DELETE' || action === 'SCHEMA_REJECTION'
    || action === 'TOKEN_MINTED' || action === 'BACKUP_REQUESTED' || action === 'BACKUP_TAKEN'

  return (
    <div className="dt-diff">
      <div className="context-panel-section-label">
        {action === 'INSERT' ? 'Initial properties'
          : action === 'DELETE' ? 'Final properties'
            : action === 'SCHEMA_REJECTION' ? 'Rejected payload'
              : action === 'FLOW_DEPLOYED' ? 'Deployed flow'
              : action === 'BACKUP_REQUESTED' ? 'Backup asked for'
              : action === 'BACKUP_TAKEN' ? 'Backup written'
              : action === 'BACKUP_PRUNED' ? 'Backup removed'
              : action === 'TOKEN_MINTED' ? 'Token issued'
                // Two-sided, unlike TOKEN_MINTED: a revocation carries the original mint in
                // `old_data` so the row stays readable after the denylist entry is pruned.
                : action === 'TOKEN_REVOKED' ? 'Token withdrawn'
                  : 'Changed properties'}
      </div>

      {diff.length === 0 ? (
        /* Either an UPDATE whose only changed column was on the noise denylist, or a row without
           snapshots. Neither is an error. */
        <div className="dt-diff-none">
          No property changes recorded outside the ignored timestamp columns.
        </div>
      ) : (
        <table className={`dt-diff-table${oneSided ? ' dt-diff-onesided' : ''}`}>
          <thead>
            <tr>
              <th>Property</th>
              {!oneSided && <th>Previous</th>}
              <th>{action === 'DELETE' ? 'Deleted'
                : action === 'INSERT' ? 'Created'
                  : action === 'SCHEMA_REJECTION' ? 'Observed'
                    : action === 'FLOW_DEPLOYED' ? 'Reported'
                    : action === 'BACKUP_REQUESTED' ? 'Asked'
                    : action === 'BACKUP_TAKEN' ? 'Written'
                    : action === 'BACKUP_PRUNED' ? 'Removed'
                    : action === 'TOKEN_MINTED' ? 'Issued'
                      : action === 'TOKEN_REVOKED' ? 'Revoked'
                        : 'New'}</th>
            </tr>
          </thead>
          <tbody>
            {diff.map(d => {
              const before = formatValue(d.before)
              const after  = formatValue(d.after)
              return (
                <tr key={d.field}>
                  <th scope="row" title={d.field}>{d.field}</th>
                  {!oneSided && (
                    <td className="dt-diff-before" title={before || undefined}>
                      {before === null ? <EmptyValue label="Not set" /> : before}
                    </td>
                  )}
                  <td className="dt-diff-after" title={(action === 'DELETE' ? before : after) || undefined}>
                    {action === 'DELETE'
                      ? (before === null ? <EmptyValue label="Not set" /> : before)
                      : (after === null ? <EmptyValue label="Cleared" /> : after)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

/**
 * The unabridged snapshots, shut by default. The diff answers what changed; this answers prove it.
 */
function RawSnapshots({ event }) {
  const dump = (value) => {
    try { return JSON.stringify(value, null, 2) } catch { return String(value) }
  }
  return (
    <details className="dt-raw">
      <summary className="dt-raw-summary">Raw audit payload</summary>
      <div className="dt-raw-body">
        <div className="dt-raw-label">old_data</div>
        <pre className="dt-raw-json">{event.old_data ? dump(event.old_data) : 'null'}</pre>
        <div className="dt-raw-label">new_data</div>
        <pre className="dt-raw-json">{event.new_data ? dump(event.new_data) : 'null'}</pre>
      </div>
    </details>
  )
}

/**
 * `initialEntity` is a handover from another page: `{ id, type }`. Applied to the ordinary filters,
 * so every control still works and Clear filters clears it. The id goes into the name filter, which
 * matches ids as well as names.
 */
export function DigitalThreadTab({ userRole, initialEntity, onClearEntity, showToast }) {
  // The kinds this role may ask for. The database policy decides what comes back; this decides
  // what is offered, so the two agree on which lanes exist for a Shopfloor_Manager.
  const entityTypes = useMemo(() => digitalThreadEntityTypesFor(userRole), [userRole])
  const allowedKinds = useMemo(() => new Set(entityTypes.map(e => e.kind)), [entityTypes])
  // Raw, from the API. `events` below is the displayed set, and every consumer reads that one so
  // the purged filter applies everywhere.
  const [allEvents, setAllEvents]     = useState([])
  // Whether to include events whose asset is no longer in the database. Hidden by default, and
  // phrased as Show so the resting control is unlit, like the Gateways and Cells toggles.
  const [showPurged, setShowPurged]   = useState(false)
  // Set once the asset lookups have landed; until then every id looks absent. Stays false if they
  // fail: unable to tell purged from live means hide nothing.
  const [lookupsLoaded, setLookupsLoaded] = useState(false)
  // The subset of DELETABLE_KINDS whose lookup actually landed, which is the set that may be called
  // deleted and hidden. Narrower than the constant whenever a tolerated lookup failed.
  const [loadedKinds, setLoadedKinds] = useState(EMPTY_KINDS)
  const [loading, setLoading]         = useState(true)
  const [entityTypeFilter, setEntityTypeFilter] = useState(initialEntity?.type || '')
  const [nameFilter, setNameFilter]   = useState(initialEntity?.id || '')
  const [actionFilter, setActionFilter] = useState('')
  const [rangePreset, setRangePreset] = useState('all')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd]     = useState('')
  const [devices, setDevices]         = useState([])
  const [gateways, setGateways]       = useState([])
  const [cells, setCells]             = useState([])
  const [areas, setAreas]             = useState([])
  const [schemas, setSchemas] = useState([])
  // Empty for a role that may not ask (0116), which is also a role that cannot see the lane.
  const [userAccounts, setUserAccounts] = useState([])
  const [selectedEventId, setSelectedEventId] = useState(null)
  const [showAllLanes, setShowAllLanes] = useState(false)

  /* Runtime overrides, each falling back to the constant above, which is what a stack whose
     Settings were never touched runs on. */
  const laneLimit = useSetting('ui.digital_thread_lane_limit', DEFAULT_LANE_LIMIT)
  const pollSeconds = useSetting('ui.digital_thread_poll_seconds', DEFAULT_POLL_SECONDS)

  useEffect(() => {
    // Cells, gateways, devices and schemas are joined here so the log can be searched by name; the
    // audit row stores only `entity_id`. Absence from this map is also what marks an entity as
    // deleted, so every audited table must be fetched.
    //
    // A TOLERATED LOOKUP RESOLVES TO null WHEN IT FAILED, which `[]` cannot say: an empty list and
    // a refused request are the same value and opposite facts, and reading the second as the first
    // would call every live entity of that kind deleted and then hide it. `loadedKinds` below
    // admits only the kinds whose own lookup landed.
    const tolerated = (p) => p.then(r => r || []).catch(() => null)
    Promise.all([
      api.get('/api/v1/devices'),
      api.get('/api/v1/gateways'),
      api.get('/api/v1/cells'),
      // Tolerated rather than required: this page must not fail to load because one lookup did,
      // and the uuid fallback below is exactly the behaviour that was there before.
      tolerated(api.get('/api/v1/schemas')),
      tolerated(api.get('/api/v1/areas')),
      // A ROLE-ASSIGNMENT ROW IS ABOUT A PERSON. `log_role_assignment()` keys it by `user_id`, and
      // this is the only way to turn that into anybody (0116). REFUSED FOR A SHOPFLOOR_MANAGER OR
      // AN OPERATOR, deliberately -- and they cannot see the lane either, so the empty list they
      // fall back to names nothing they were going to be shown.
      tolerated(api.listUserAccounts())
    ])
      .then(([d, g, c, sc, ar, us]) => {
        setDevices(d); setGateways(g); setCells(c); setSchemas(sc || []); setAreas(ar || [])
        setUserAccounts(us || [])
        // SUBTRACTED FROM THE CONSTANT, never listed again: a second list of kinds here is the
        // same two-sources-of-truth defect `DELETABLE_KINDS` was written to end, and it would go
        // stale silently the next time a kind joined. The required three landed or this branch did
        // not run, so only the tolerated lookups can take a kind away.
        const unanswerable = new Set([!sc && 'SCHEMA', !ar && 'AREA'].filter(Boolean))
        setLoadedKinds(new Set([...DELETABLE_KINDS].filter(k => !unanswerable.has(k))))
        setLookupsLoaded(true)
      })
      .catch(() => {})
  }, [])

  /**
   * entity_id -> `{ name, qualifier }`, across every audited table this page can look one up in.
   *
   * STRUCTURED RATHER THAN COMPOSED, because the lane label and everything else want different
   * things from it. A schema's `version` is the only thing separating one member of a lineage from
   * another, and it is at the END of the composed string -- which is what a fixed-width label
   * ellipsises away first. The lane draws it as its own element; `entityNames` below composes it
   * for every reader that wants one string.
   *
   * WHAT IS IN HERE ALSO DECIDES DELETION: `DELETABLE_KINDS` reads it to tell an absence that means
   * "gone" from one that means "nothing ever looked this kind up".
   */
  const entityIdentities = useMemo(() => {
    const m = new Map()
    for (const ar of areas)   m.set(ar.area_id, { name: ar.area_name })
    for (const c of cells)    m.set(c.cell_id, { name: c.cell_name })
    for (const g of gateways) m.set(g.gateway_id, { name: g.gateway_name })
    for (const d of devices)  m.set(d.asset_id, { name: d.asset_name })
    for (const sc of schemas) {
      const id = sc.id || sc.schema_uuid
      if (id) m.set(id, {
        name: sc.schema_name,
        qualifier: sc.version ? `v${sc.version}` : undefined,
      })
    }
    // The email, which is all `auth.users` carries here (0116). An account without one falls
    // through to the id, as every unnamed entity did before.
    for (const u of userAccounts) if (u?.user_id && u.email) m.set(u.user_id, { name: u.email })
    return m
  }, [areas, cells, gateways, devices, schemas, userAccounts])

  /**
   * The same thing as one string per id, which is what the search, the export, the drawer title and
   * the causation list all want. Derived rather than built a second time, so the two cannot drift.
   */
  const entityNames = useMemo(() => {
    const m = new Map()
    for (const [id, v] of entityIdentities) {
      if (v.name) m.set(id, v.qualifier ? `${v.name} ${v.qualifier}` : v.name)
    }
    return m
  }, [entityIdentities])

  /**
   * Events whose asset has been purged: in the log, absent from every live table. The list
   * endpoints do not filter `is_archived`, so absent means gone rather than retired. A DELETE event
   * in the page would be a worse test, because the page is capped and windowed.
   */
  // From the server, counted over everything the filters select rather than over the page. Null
  // means the server did not say, which must not render as zero.
  const [serverPurgedCount, setServerPurgedCount] = useState(null)
  // How many events match the current filters in total (0115), so the page can say what fraction
  // of them it is holding. Null on a server without it, and on a bare-array fixture: the counts
  // below then fall back to naming the loaded events alone, which is what they said before.
  const [totalMatching, setTotalMatching] = useState(null)
  // Whether the row limit bit. The page cannot tell otherwise, and "showing the newest 200" is the
  // difference between a quiet view and a quietly incomplete one -- which is how this was missed.
  const [truncated, setTruncated] = useState(false)

  /**
   * How many deleted entities the current filters cover. The server's count wins; a response without
   * one (an older API, or a bare-array fixture) falls back to counting the page, never to zero,
   * which would hide the control that reveals them.
   */
  const purgedEntityCount = useMemo(() => {
    if (serverPurgedCount !== null) return serverPurgedCount
    if (!lookupsLoaded) return 0
    // DISTINCT ENTITIES, not events. Counting rows answered a question nobody asked -- the button
    // read "(54)" beside a page whose own header said 16 assets. Scoped to `loadedKinds` for the
    // same reason the filter is: a kind nothing can answer for is unnamed, not deleted, and
    // counting it here would draw a control that reveals nothing.
    const seen = new Set()
    for (const e of allEvents) {
      if (loadedKinds.has(entityKind(e.entity_type)) && !entityNames.has(e.entity_id)) {
        seen.add(e.entity_id)
      }
    }
    return seen.size
  }, [serverPurgedCount, allEvents, entityNames, lookupsLoaded, loadedKinds])

  /**
   * What the page renders. Deleted entities are hidden by default. `digital_thread_page()` applies
   * the same rule as a predicate before the row limit; this client-side filter is kept for a server
   * without the RPC.
   */
  const events = useMemo(() => {
    if (showPurged || !lookupsLoaded) return allEvents
    // The same set that decides the "deleted" flag, so the two cannot disagree about a kind.
    return allEvents.filter(e => loadedKinds.has(entityKind(e.entity_type))
      ? entityNames.has(e.entity_id)
      : true)
  }, [allEvents, entityNames, showPurged, lookupsLoaded, loadedKinds])

  /**
   * The counts the page renders. Two spellings of one pair of numbers -- the ratio where the space
   * is a fixed-width label, the phrase where there is room -- derived here so the three places that
   * draw them cannot end up describing different sets.
   */
  const countLabel = eventCountLabel(events.length, totalMatching)
  const eventRatio = countRatio(events.length, totalMatching)
  const hasMoreToLoad = isPartial(events.length, totalMatching)

  /**
   * The search, sent as the typed text (0115).
   *
   * IT USED TO BE RESOLVED HERE, against `entityNames` -- the LIVE tables -- and sent as a list of
   * ids. So a search naming something that had been deleted matched no live row, sent an EMPTY id
   * list, and rendered as an empty thread: the one question this page exists to answer, answered
   * "nothing happened". The lane label never had that problem, because it falls back to the audit
   * snapshot; `p_search` reads the same fields, so the search now finds what the timeline draws.
   *
   * Still a database predicate rather than a filter over the page, which is what makes the row
   * limit apply to rows that will be shown, as the action filter and the time range do.
   */
  const search = nameFilter.trim()

  /** Where the next page starts; null at the end. Null is the only end-of-data signal (0077). */
  const [nextCursor, setNextCursor] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)

  /**
   * The loaded events, mirrored into a ref so the poll can merge without putting `allEvents` in
   * `load`'s dependencies, which would restart the interval on every fetch.
   */
  const allEventsRef = useRef([])
  useEffect(() => { allEventsRef.current = allEvents }, [allEvents])

  const buildUrl = useCallback((cursor) => {
    let url = `/api/v1/digital-thread?limit=${PAGE_SIZE}`
    if (entityTypeFilter) url += `&entity_type=${encodeURIComponent(entityTypeFilter)}`
    if (actionFilter)     url += `&action=${encodeURIComponent(actionFilter)}`
    if (search)           url += `&search=${encodeURIComponent(search)}`
    // Evaluated here, not held in state: see timeWindow's note on a rolling window going stale
    // under auto-refresh.
    const { since, until } = timeWindow(rangePreset, customStart, customEnd)
    if (since) url += `&since=${encodeURIComponent(since)}`
    if (until) url += `&until=${encodeURIComponent(until)}`
    if (showPurged) url += '&include_purged=true'
    // BOTH HALVES OR NEITHER (0077). `recorded_at` is not unique -- one transaction's rows all
    // carry one `now()` -- so the id is what makes the position exact rather than approximate.
    if (cursor && cursor.recorded_at && cursor.id != null) {
      url += `&before_recorded_at=${encodeURIComponent(cursor.recorded_at)}`
      url += `&before_id=${encodeURIComponent(cursor.id)}`
    }
    return url
  }, [entityTypeFilter, actionFilter, search, rangePreset, customStart, customEnd, showPurged])

  const load = useCallback((isInitial = false) => {
    if (isInitial) setLoading(true)
    api.get(buildUrl(null))
      // `d` is the event array carrying the page-level counts as properties. A fixture that
      // resolves a bare array reports no deleted entities and no truncation.
      .then(d => {
        const fresh = Array.isArray(d) ? d : []
        // The poll merges into the loaded pages rather than replacing them: a reader six pages back
        // must not lose five of them every minute.
        const { events, reset } = isInitial
          ? { events: fresh, reset: true }
          : mergeFirstPage(allEventsRef.current, fresh)
        setAllEvents(events)
        setServerPurgedCount(typeof d?.purgedAssets === 'number' ? d.purgedAssets : null)
        // Outside the `reset` guard below, like the purged count and for the same reason: both are
        // facts about everything the filters select, so a poll's answer is the current one whether
        // or not it replaced the list.
        setTotalMatching(typeof d?.totalMatching === 'number' ? d.totalMatching : null)
        // Only when the list was replaced. After a merge the cursor still points past the oldest
        // row held.
        if (reset) {
          setNextCursor(d?.nextCursor || null)
          setTruncated(Boolean(d?.truncated))
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [buildUrl])

  /**
   * One more page, appended. Deduped because a poll can land between the click and the response,
   * and the keyset cursor is a table position, so a row can arrive by both routes.
   */
  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    api.get(buildUrl(nextCursor))
      .then(d => {
        const page = Array.isArray(d) ? d : []
        setAllEvents(prev => {
          const seen = new Set(prev.map(e => e.event_id))
          return [...prev, ...page.filter(e => !seen.has(e.event_id))]
        })
        setNextCursor(d?.nextCursor || null)
        setTruncated(Boolean(d?.truncated))
        // `purgedAssets` and `totalMatching` are counted over the whole match, so page one's
        // answer already stands and the poll keeps it current.
        setLoadingMore(false)
      })
      .catch(() => setLoadingMore(false))
  }, [nextCursor, loadingMore, buildUrl])

  // A later handover -- clicking Digital Thread on a second device without leaving the page --
  // replaces the filter rather than being ignored because state was already initialised.
  useEffect(() => {
    if (!initialEntity?.id) return
    setEntityTypeFilter(initialEntity.type || '')
    setNameFilter(initialEntity.id)
  }, [initialEntity?.id, initialEntity?.type])

  const rangeIsFiltering =
    rangePreset === 'custom' ? !!(customStart || customEnd) : rangePreset !== 'all'

  const activeFilterCount =
    (entityTypeFilter ? 1 : 0) + (nameFilter ? 1 : 0) + (actionFilter ? 1 : 0) +
    // Showing deleted entities is the deviation, so Clear filters returns them to hidden.
    (rangeIsFiltering ? 1 : 0) + (showPurged ? 1 : 0)

  const resetFilters = () => {
    setEntityTypeFilter(''); setNameFilter(''); setActionFilter('')
    setRangePreset('all'); setCustomStart(''); setCustomEnd(''); setShowPurged(false)
    // Also drop the handover, or the effect above would immediately re-apply it and Clear Filters
    // would appear to do nothing.
    onClearEntity?.()
  }

  useEffect(() => {
    load(true)
  }, [load])

  /**
   * A fixed poll. `load(false)`: the initial flag swaps the timeline for a spinner, which would
   * flicker every minute. Safe with the drawer open, because `selected` is resolved from `events`
   * on every render. Rebuilt whenever `load` changes, so the timer measures from the most recent
   * fetch.
   */
  useEffect(() => {
    // Guarded: a setting of 0 or less would fire as fast as the event loop allows.
    const seconds = Number(pollSeconds) > 0 ? Number(pollSeconds) : DEFAULT_POLL_SECONDS
    const timer = setInterval(() => load(false), seconds * 1000)
    return () => clearInterval(timer)
  }, [load, pollSeconds])

  /** event_id -> { diff, kind }. Computed once per fetch; both the markers and the CSV read it. */
  const analysis = useMemo(() => {
    const m = new Map()
    for (const e of events) {
      const diff = diffFields(e.old_data, e.new_data)
      m.set(e.event_id, { diff, kind: classifyEvent(e, diff) })
    }
    return m
  }, [events])

  /**
   * One lane per audited entity, busiest first; ties break on the label so the order is stable
   * between refreshes.
   */
  const lanes = useMemo(() => {
    const byEntity = new Map()
    for (const e of events) {
      const key = `${String(e.entity_type).toLowerCase()}:${e.entity_id}`
      if (!byEntity.has(key)) {
        byEntity.set(key, { key, kind: entityKind(e.entity_type), entityId: e.entity_id, events: [] })
      }
      byEntity.get(key).events.push(e)
    }
    return [...byEntity.values()]
      .map(lane => ({
        ...lane,
        ...resolveLaneName(lane.entityId, lane.events, entityIdentities, {
          // Until a kind's lookup lands every id of it looks absent, so nothing may be called
          // deleted yet. Empty until then, and permanently short of a kind whose lookup failed.
          canTellDeleted: loadedKinds.has(lane.kind),
        }),
      }))
      .sort((a, b) =>
        b.events.length - a.events.length ||
        String(a.name || a.entityId).localeCompare(String(b.name || b.entityId)))
  }, [events, entityIdentities, loadedKinds])

  const visibleLanes = showAllLanes ? lanes : lanes.slice(0, laneLimit)
  const hiddenLaneCount = lanes.length - visibleLanes.length

  /**
   * The visible lanes, cut into sections after the cap is applied, so the cap means what it says
   * across the whole set. Empty sections are omitted.
   */
  /**
   * Lanes grouped into sections. Nothing visible may be dropped here: known kinds keep their order
   * and icons, and every remaining kind gets a section of its own with the fallback icon.
   */
  const sections = useMemo(() => {
    const known = SECTIONS
      .filter(s => allowedKinds.has(s.kind))
      .map(s => ({ ...s, lanes: visibleLanes.filter(l => l.kind === s.kind) }))
      .filter(s => s.lanes.length > 0)

    const claimed = new Set(SECTIONS.map(s => s.kind))
    const leftovers = [...new Set(visibleLanes.map(l => l.kind).filter(k => !claimed.has(k)))]
      .sort()
      .map(kind => ({
        kind,
        // The raw kind, uppercased: it reads as a gap to close rather than a considered label.
        label: kind,
        Icon: FALLBACK_SECTION_ICON,
        lanes: visibleLanes.filter(l => l.kind === kind)
      }))

    return [...known, ...leftovers]
  }, [visibleLanes, allowedKinds])

  /**
   * The x-axis extent, from the events rather than the range control: the default range is
   * unbounded, and a requested window would push a dense day into one corner of the track.
   */
  const domain = useMemo(() => {
    const stamps = events
      .map(e => new Date(e.timestamp).getTime())
      .filter(Number.isFinite)
    if (stamps.length === 0) return null
    let min = Math.min(...stamps)
    let max = Math.max(...stamps)
    // A single instant has no extent; pad it by an hour so the marker lands mid-track.
    if (max === min) { min -= 30 * 60 * 1000; max += 30 * 60 * 1000 }
    return { min, max, span: max - min }
  }, [events])

  /** Fraction of the track, 0..1, for a timestamp. */
  const fractionFor = useCallback((timestamp) => {
    if (!domain) return 0.5
    const t = new Date(timestamp).getTime()
    if (!Number.isFinite(t)) return 0.5
    return Math.min(1, Math.max(0, (t - domain.min) / domain.span))
  }, [domain])

  // The track carries 14px of padding at each end so extreme markers are not clipped; positions are
  // a calc against the padded width. Takes a fraction, because a cluster badge sits at the mean of
  // its members' positions.
  const offsetForFraction = (f) => `calc(14px + (100% - 28px) * ${f})`

  /* The track's rendered width, needed to know which markers collide: the threshold is in pixels
     and the track is `flex: 1`. The axis track always exists and every track shares its width.
     jsdom reports 0, which disables clustering. */
  const axisTrackNode = useRef(null)
  const [trackWidth, setTrackWidth] = useState(0)

  /* A callback ref rather than a mount effect: the timeline is absent until the fetch lands, so an
     effect with `[]` deps would measure null once and never again. */
  const axisTrackRef = useCallback((node) => {
    axisTrackNode.current = node
    if (node) setTrackWidth(node.offsetWidth || 0)
  }, [])

  useEffect(() => {
    const measure = () => setTrackWidth(axisTrackNode.current?.offsetWidth || 0)
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  /**
   * lane.key to the items its track draws. Computed here because the legend also needs the badge
   * count. Per lane, because a collision is only within one row.
   */
  const laneClusters = useMemo(() => {
    const m = new Map()
    for (const lane of visibleLanes) {
      m.set(lane.key, clusterEvents(lane.events, (e) => fractionFor(e.timestamp), trackWidth))
    }
    return m
  }, [visibleLanes, fractionFor, trackWidth])

  /**
   * How many badges are drawn, which the legend's Grouped entry counts. Badges rather than the
   * events inside them; that number is on each badge.
   */
  const clusterCount = useMemo(
    () => [...laneClusters.values()]
      .reduce((n, items) => n + items.filter(i => i.isCluster).length, 0),
    [laneClusters]
  )

  const ticks = useMemo(() => {
    if (!domain) return []
    const format = tickFormatter(domain.span)
    return [0, 0.25, 0.5, 0.75, 1].map(f => {
      const at = new Date(domain.min + domain.span * f)
      // The full timestamp is always one hover away, whatever the axis had room to print.
      return { f, label: format(at), title: at.toLocaleString() }
    })
  }, [domain])

  // Resolved fresh every render: a refresh replaces every event object. If the selected event drops
  // out of the filter, the drawer closes.
  const selected = events.find(e => String(e.event_id) === String(selectedEventId)) || null
  const selectedAnalysis = selected ? analysis.get(selected.event_id) : null

  /**
   * The selected entity's events, oldest first: Previous goes back in time and Next forward. Drawn
   * from the filtered set so the drawer and the lane describe the same events.
   */
  const selectedLaneEvents = useMemo(() => {
    if (!selected) return []
    return events
      .filter(e => e.entity_id === selected.entity_id)
      .slice()
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
  }, [events, selected?.entity_id])

  const selectedIndex = selectedLaneEvents
    .findIndex(e => String(e.event_id) === String(selectedEventId))
  const stepTo = (i) => {
    const next = selectedLaneEvents[i]
    if (next) setSelectedEventId(next.event_id)
  }

  /** The other rows this event's transaction wrote. See causationSiblings(). */
  const selectedSiblings = useMemo(
    () => (selected ? causationSiblings(selected, events) : []),
    [events, selected?.event_id, selected?.causation_id]
  )

  /**
   * The export rows, built explicitly: the raw `old_data` / `new_data` JSONB is unreadable in a
   * spreadsheet, so the computed diff is flattened into one column.
   */
  const exportRows = () => events.map(e => {
    const a = analysis.get(e.event_id) || { diff: [], kind: 'operational' }
    return {
      recorded_at:    e.timestamp,
      entity_type:    entityKind(e.entity_type),
      // Falls back the same way the lane label does, so purged entities export with a name;
      // `entity_name_source` says which fall produced it.
      entity_name:    entityNames.get(e.entity_id) || snapshotIdentity(e)?.label || '',
      entity_name_source: entityNames.get(e.entity_id)
        ? 'current'
        : (snapshotIdentity(e) ? `audit snapshot (${snapshotIdentity(e).field})` : 'unresolved'),
      entity_id:      e.entity_id,
      mutation_id:    e.event_id,
      causation_id:   e.causation_id ?? '',
      action:         e.event_type,
      classification: MARKERS[a.kind].label,
      actor:          actorLabel(e),
      actor_user_id:  e.changed_by || '',
      actor_source:   e.actor_source || '',
      changed_fields: a.diff.map(d => d.field).join(' '),
      changes:        a.diff
        .map(d => `${d.field}: ${formatValue(d.before) ?? '∅'} → ${formatValue(d.after) ?? '∅'}`)
        .join('; '),
      description:    e.description || ''
    }
  })

  return (
    <div className="page-layout">
      <div className="page-main">
        {/* The description is a tip on the title; Export sits in the header with the other actions
            and states the filtered count it will write. */}
        <div className="card">
          <div className="card-header">
            <h3 className="section-title">
              Digital Thread
              <HelpTip
                label="About the Digital Thread"
                text="Every attributed change to a cell, gateway, device, schema or proposal, in order and with its cause. Append-only and unprunable by any application role. Administrators and Auditors also see the security lane: role assignments, service identities and settings."
              />
            </h3>
            {/* WHAT IS LOADED, not what matches. Export writes the events the page is holding,
                and the tooltip says so rather than promising the filtered set: at 200 of 467 the
                difference is two thirds of the answer. */}
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => downloadCSV(exportRows(), 'digital-thread-export.csv')}
              title={hasMoreToLoad
                ? `Download the ${events.length} events loaded here as CSV. ${totalMatching} match `
                  + 'the current filters -- load the rest first to export them all.'
                : 'Download the events matching the current filters as CSV'}
            >
              <IconDownload size={13} /> Export CSV ({eventRatio})
            </button>
          </div>

          <div className="card-body">

        <div className="filter-bar">
          <select
            className="form-control"
            style={{ width: '150px' }}
            value={entityTypeFilter}
            onChange={e => setEntityTypeFilter(e.target.value)}
            title="Show only events against one kind of asset"
          >
            <option value="">All entities</option>
            {/* Every kind this role may ask for, from the same table the sections are built from,
                so a kind cannot be drawable and unfilterable. */}
            {entityTypes.map(({ kind, label }) => (
              <option key={kind} value={kind}>{label}</option>
            ))}
          </select>

          <input
            className="form-control"
            style={{ width: '220px' }}
            value={nameFilter}
            onChange={e => setNameFilter(e.target.value)}
            placeholder="Search by entity name or ID…"
            title="Filter by the asset's name, or by its id"
          />

          <select
            className="form-control"
            style={{ width: '150px' }}
            value={actionFilter}
            onChange={e => setActionFilter(e.target.value)}
            title="Filter by the database action recorded on the audit row -- the same value the event drawer shows as a badge. The coloured markers below are a SEPARATE, derived classification; see the key beside the timeline."
          >
            <option value="">Any action</option>
            {Object.entries(DIGITAL_THREAD_ACTIONS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>

          {/* All time is the default (see timeWindow). The window is a query parameter, so a
              narrower range does not spend the row budget outside it. */}
          <select
            className="form-control"
            style={{ width: '150px' }}
            value={rangePreset}
            onChange={e => setRangePreset(e.target.value)}
            title="Limit the timeline to a time range"
          >
            {TIME_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            <option value="custom">Custom range…</option>
          </select>

          {/* Shown only in custom mode. */}
          {rangePreset === 'custom' && (
            <>
              {/* `datetime-local`, not `date`: a date pair cannot express a window narrower than a
                  day. `timeWindow()` widens the end bound to :59.999. */}
              <input
                type="datetime-local"
                className="form-control"
                style={{ width: '210px' }}
                value={customStart}
                onChange={e => setCustomStart(e.target.value)}
                title="Range start, in local time"
                aria-label="Range start"
              />
              <input
                type="datetime-local"
                className="form-control"
                style={{ width: '210px' }}
                value={customEnd}
                onChange={e => setCustomEnd(e.target.value)}
                title="Range end, in local time (inclusive of that minute)"
                aria-label="Range end"
              />
            </>
          )}

          {/* Shown only when something is deleted, like Clear filters and the custom inputs. Same
              shape as the Gateways and Cells toggles. The tooltip says no longer in the database,
              because absence from the lookups is all the test sees.

              ENTITIES, NOT ASSETS: the count covers schemas as well as areas, cells, gateways and
              devices (0117), and a schema is a definition rather than shopfloor equipment. */}
          {purgedEntityCount > 0 && (
            <button
              className={`btn btn-sm ${showPurged ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setShowPurged(v => !v)}
              title="Include events for entities that are no longer in the database. The records are kept either way -- this only changes what is listed."
            >
              <IconTrash size={13} /> Show deleted entities ({purgedEntityCount})
            </button>
          )}

          {activeFilterCount > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={resetFilters} title="Clear every filter">
              <IconX size={13} /> Clear filters ({activeFilterCount})
            </button>
          )}

          {/* The spacer moved off Clear Filters and onto this group, so the right-hand end of the
              bar holds the same thing whether or not a filter happens to be set. */}
          <div className="filter-bar-spacer filter-bar-actions">
          </div>
        </div>
          </div>{/* .card-body */}

        {/* A second `.card-body`, so the controls and the trace get a divider from one rule. */}
        <div className="card-body">
          {loading ? (
            <div className="loading-wrap"><div className="spinner" /> Loading digital thread trace sequence…</div>
          ) : events.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><IconHistory size={36} /></div>
              {/* THE DELETED CASE FIRST, because it is the one the reader can act on and the one
                  they most often arrive at: `purged_assets` is counted over everything the filters
                  select INCLUDING the search, so a search naming something deleted comes back with
                  no events and a non-zero count. Without this the page says "nothing matches" while
                  holding the answer behind a toggle the reader has no reason to try. */}
              {!showPurged && purgedEntityCount > 0 ? (
                <>
                  <div className="empty-text">
                    Nothing here matches, but {purgedEntityCount === 1
                      ? 'one deleted entity does'
                      : `${purgedEntityCount} deleted entities do`}. Their records are kept; this
                    view just hides them.
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => setShowPurged(true)}
                    title="Include events for entities that are no longer in the database"
                  >
                    <IconTrash size={13} /> Show deleted entities ({purgedEntityCount})
                  </button>
                </>
              ) : (
                <div className="empty-text">
                  {rangeIsFiltering
                    ? 'No digital thread events in this time range. Widen it, or switch back to All time.'
                    : 'No digital thread events match the filter criteria.'}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* The legend for a derived colour scale: nothing else on the page says what amber
                  means. */}
              <div className="dt-legend">
                {Object.entries(MARKERS).map(([kind, m]) => (
                  <span key={kind} className="dt-legend-item" title={m.hint}>
                    <span className={`dt-node-dot dt-node-${kind}`} aria-hidden="true" />
                    {m.label}
                  </span>
                ))}

                {/* Shown only while a badge is on screen. The sample is a real `.dt-cluster`,
                    reading `n` as a placeholder for each badge's count. */}
                {clusterCount > 0 && (
                  <span
                    className="dt-legend-item"
                    title={`Events too close together to draw separately are ONE badge carrying the count — `
                         + `${clusterCount} on this timeline. Hover one for the breakdown, or narrow the `
                         + `time range and they separate back into individual markers.`}
                  >
                    <span className="dt-cluster dt-legend-cluster" aria-hidden="true">n</span>
                    Grouped ({clusterCount})
                  </span>
                )}
              </div>

              {/* WHAT THIS PAGE IS SHOWING, between the key and the timeline it describes.
                  It lived in the axis corner, at lane-label size and hard against the left edge
                  beside the first tick, where readers missed it -- so the one line that says how
                  much of the thread is on screen was the easiest thing on the page to overlook.

                  ENTITIES, not assets: a lane can be a setting, a role assignment or a backup job,
                  and `asset` is the shopfloor class. BOTH NUMBERS ARE WHAT IS DRAWN over what
                  there is -- the lane count named every lane while the cap drew thirty of them, so
                  a reader adding up the section badges got a different number from the one above
                  them. */}
              <div
                className="dt-count"
                title={[
                  hiddenLaneCount > 0
                    ? `${visibleLanes.length} of ${lanes.length} entities have a lane drawn; `
                      + 'the rest are behind Show all lanes.'
                    : `${lanes.length} ${lanes.length === 1 ? 'entity has' : 'entities have'} a lane.`,
                  hasMoreToLoad
                    ? `${events.length} of the ${totalMatching} events matching these filters `
                      + 'are loaded; the rest are behind Load more, at the foot of the page.'
                    : 'Every event matching these filters is loaded.'
                ].join('\n')}
              >
                {countRatio(visibleLanes.length, lanes.length)}
                {' '}{lanes.length === 1 ? 'entity' : 'entities'} · {eventRatio} events
              </div>

              <div className="dt-scroll">
                <div className="dt-swimlanes">
                  <div className="dt-lane dt-axis">
                    {/* The corner is a spacer now: it holds the lane labels' width so the ticks
                        line up with the tracks beside them, and nothing else. */}
                    <div className="dt-lane-label dt-axis-corner" aria-hidden="true" />
                    <div className="dt-track dt-axis-track" ref={axisTrackRef}>
                      {ticks.map(t => (
                        <span
                          key={t.f}
                          className="dt-tick"
                          style={{ left: `calc(14px + (100% - 28px) * ${t.f})` }}
                          title={t.title}
                        >
                          {t.label}
                        </span>
                      ))}
                    </div>
                  </div>

                  {sections.map(section => (
                    <React.Fragment key={section.kind}>
                      {/* The count is what is drawn, not what exists: the lane cap may fold some,
                          and the toggle below names the remainder. */}
                      <div className="dt-section" role="separator" aria-label={`${section.label} lanes`}>
                        {/* Icon, name and count as one badge, so a section reads as a heading over
                            the track cards. The rule beside it is CSS. */}
                        <span className="dt-section-badge">
                          <section.Icon size={12} />
                          <span className="dt-section-name">{section.label}</span>
                          <span className="dt-section-count">{section.lanes.length}</span>
                        </span>
                      </div>

                      {section.lanes.map(lane => (
                        <div className="dt-lane" key={lane.key}>
                          {/* No type badge: the section heading and the icon already carry the
                              kind, and the width goes to the name. The UUID is copyable in the
                              drawer's Entity ID field. */}
                          <div
                            className="dt-lane-label"
                            title={[
                              lane.name
                                ? `${lane.name}${lane.qualifier ? ` ${lane.qualifier}` : ''}`
                                : null,
                              lane.entityId,
                            ].filter(Boolean).join(' — ')}
                          >
                            {React.createElement(SECTION_ICON[lane.kind] || IconCpu, {
                              size: 12, className: 'dt-lane-icon'
                            })}
                            {lane.name
                              ? <strong className="dt-lane-name">{lane.name}</strong>
                              /* Neither the join nor a snapshot could name it: the shortened id,
                                 monospaced. */
                              : <span className="dt-lane-name dt-lane-unnamed mono">{shortId(lane.entityId)}</span>}
                            {/* THE PART THAT MUST SURVIVE TRUNCATION. A schema lineage shares its
                                name and differs only here, so ellipsising this away leaves a
                                column of identical labels. */}
                            {lane.qualifier && (
                              <span className="dt-lane-qualifier">{lane.qualifier}</span>
                            )}
                            {/* A name recovered from the audit payload means the entity is gone;
                                say so. */}
                            {/* `gone`, not `fromSnapshot`: the name coming from a snapshot says
                                where the label came from, and a settings or backup lane is named
                                that way while existing perfectly well. */}
                            {lane.gone && (
                              <span
                                className="dt-lane-gone"
                                title={lane.fromSnapshot
                                  ? 'This entity no longer exists — the name is the one recorded in its final audit snapshot'
                                  : 'This entity no longer exists, and its audit rows carry no name to recover'}
                              >
                                deleted
                              </span>
                            )}
                          </div>

                          <div className="dt-track">
                            {(laneClusters.get(lane.key) || []).map(item => {
                              /* The ring follows the drawer: a badge is lit while the drawer shows
                                 any of its events, so the highlight stays put while Previous / Next
                                 steps through the burst. */
                              const isSelected = item.events
                                .some(e => String(e.event_id) === String(selectedEventId))

                              if (item.isCluster) {
                                return (
                                  <button
                                    key={`cluster-${item.event.event_id}`}
                                    type="button"
                                    className={`dt-cluster${isSelected ? ' dt-node-selected' : ''}`}
                                    style={{ left: offsetForFraction(item.xOffset) }}
                                    /* The oldest member (see clusterEvents on the tiebreak), so
                                       Next means and then what. */
                                    onClick={() => setSelectedEventId(item.event.event_id)}
                                    title={clusterSummary(
                                      item.events,
                                      (e) => analysis.get(e.event_id)?.kind || 'operational'
                                    )}
                                    aria-label={`${item.events.length} events on `
                                      + `${lane.name || lane.entityId} from `
                                      + `${new Date(item.event.timestamp).toLocaleString()} — open the first`}
                                    aria-pressed={isSelected}
                                  >
                                    {item.events.length}
                                  </button>
                                )
                              }

                              const e = item.event
                              const kind = analysis.get(e.event_id)?.kind || 'operational'
                              return (
                                <button
                                  key={e.event_id}
                                  type="button"
                                  className={`dt-node dt-node-${kind}${isSelected ? ' dt-node-selected' : ''}`}
                                  style={{ left: offsetForFraction(item.xOffset) }}
                                  onClick={() => setSelectedEventId(e.event_id)}
                                  /* A plain `title`, as elsewhere: what, who, when. The rest is in
                                     the drawer. */
                                  title={`${e.event_type} · ${MARKERS[kind].label}\n${actorLabel(e)}\n${new Date(e.timestamp).toLocaleString()}`}
                                  aria-label={`${e.event_type} on ${lane.name || lane.entityId} at ${new Date(e.timestamp).toLocaleString()}`}
                                  aria-pressed={isSelected}
                                />
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </React.Fragment>
                  ))}
                </div>
              </div>

              {hiddenLaneCount > 0 && (
                <button
                  className="btn btn-ghost btn-sm dt-lane-toggle"
                  onClick={() => setShowAllLanes(true)}
                  title={`Draw the remaining ${hiddenLaneCount} lanes`}
                >
                  Show all lanes (+{hiddenLaneCount})
                </button>
              )}
              {showAllLanes && lanes.length > laneLimit && (
                <button
                  className="btn btn-ghost btn-sm dt-lane-toggle"
                  onClick={() => setShowAllLanes(false)}
                  title={`Collapse back to the ${laneLimit} busiest assets`}
                >
                  Show fewer lanes
                </button>
              )}

              {/* How much of the thread this is, and where its end is. `countLabel` is drawn against
                  the whole match; the parenthetical is the rarer disagreement between what was
                  FETCHED and what survived the client-side purged filter, which is a no-op against a
                  server that hides them itself and is not against one that does not. */}
              <div className="dt-pagination">
                <span
                  className="dt-pagination-count"
                  title={hasMoreToLoad
                    ? `${totalMatching} events match the current filters; this page holds the `
                      + `newest ${events.length}.`
                    : 'Every event matching the current filters is on this page.'}
                >
                  {countLabel}
                  {events.length !== allEvents.length && ` (${allEvents.length} loaded)`}
                </span>
                {nextCursor ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={loadMore}
                    disabled={loadingMore}
                    title={`Fetch the next ${PAGE_SIZE} events, older than the oldest one loaded`}
                  >
                    {loadingMore ? 'Loading…' : `Load ${PAGE_SIZE} more`}
                  </button>
                ) : truncated ? (
                  /* Cut off with no way forward: `truncated` and `next_cursor` come from the same
                     response, but a database without the paging RPC returns only the first. The
                     view is still incomplete and the reader is told so. */
                  <span className="dt-pagination-end">
                    Showing the newest {allEvents.length}
                    {typeof totalMatching === 'number' && ` of ${totalMatching}`} events — there are
                    older ones this view cannot reach.
                  </span>
                ) : (
                  /* Only meaningful once something was paged: a first response holding the whole
                     thread has no end to announce. */
                  allEvents.length >= PAGE_SIZE && (
                    <span className="dt-pagination-end">
                      End of the thread — every event matching these filters is loaded.
                    </span>
                  )
                )}
              </div>
            </>
          )}
        </div>{/* .card-body — the timeline */}
      </div>{/* .card */}
      </div>

      <ContextPanel
        open={!!selected}
        onClose={() => setSelectedEventId(null)}
        type={selected ? entityKind(selected.entity_type) : ''}
        onCopy={showToast}
        title={selected
          ? (entityNames.get(selected.entity_id) || snapshotIdentity(selected)?.label || selected.entity_id)
          : ''}
        subtitle={selected && (
          /* One flex item laid out internally as rows; `.context-panel-subtitle` is a wrapping row
             shared with other pages. */
          <div className="dt-drawer-nav">
            {/* Above the thing it changes. The subtitle slot is the only one ContextPanel offers
                above the metadata. */}
            <div className="dt-drawer-nav-pos" title="Position in this asset's history, oldest first">
              Event {selectedIndex + 1} of {selectedLaneEvents.length}
              {' · '}
              {entityNames.get(selected.entity_id)
                || snapshotIdentity(selected)?.label
                || shortId(selected.entity_id)}
            </div>

            <div className="dt-drawer-nav-btns">
              {/* Previous is older. Disabled rather than hidden at the ends, so the row does not
                  reflow under the cursor. */}
              <button
                className={`btn btn-ghost btn-sm dt-nav-btn${selectedIndex <= 0 ? ' btn-disabled' : ''}`}
                onClick={() => stepTo(selectedIndex - 1)}
                disabled={selectedIndex <= 0}
                title={selectedIndex <= 0
                  ? 'This is the oldest recorded change to this asset'
                  : 'Step back to the previous change to this asset'}
              >
                ◀ Previous
              </button>
              <button
                className={`btn btn-ghost btn-sm dt-nav-btn${selectedIndex >= selectedLaneEvents.length - 1 ? ' btn-disabled' : ''}`}
                onClick={() => stepTo(selectedIndex + 1)}
                disabled={selectedIndex >= selectedLaneEvents.length - 1}
                title={selectedIndex >= selectedLaneEvents.length - 1
                  ? 'This is the most recent change to this asset'
                  : 'Step forward to the next change to this asset'}
              >
                Next ▶
              </button>
            </div>

            <div className="dt-drawer-nav-badges">
              <span className="badge badge-warning" title="Audit event type">{selected.event_type}</span>
              <span className={`badge dt-badge-${selectedAnalysis?.kind}`} title={MARKERS[selectedAnalysis?.kind]?.hint}>
                {MARKERS[selectedAnalysis?.kind]?.label}
              </span>
            </div>
          </div>
        )}
        fields={selected ? [
          { label: 'Recorded', value: new Date(selected.timestamp).toLocaleString(), title: selected.timestamp },
          {
            label: 'Actor',
            value: actorLabel(selected),
            title: actorTitle(selected)
          },
          // Only when there is one: `changed_by` is NULL for every machine-originated write.
          ...(selected.changed_by
            ? [{ label: 'User ID', value: selected.changed_by, copyable: true, mono: true, title: 'The signed-in user who made this change' }]
            : []),
          { label: 'Entity ID', value: selected.entity_id, copyable: true, mono: true, title: 'The asset this change was made to' },
          // The audit row's own id. It identifies THIS mutation rather than the asset it touched,
          // which is what you need to quote when two edits a second apart are being told apart.
          { label: 'Mutation ID', value: String(selected.event_id), copyable: true, mono: true, title: 'Audit row ID for this single change' },
          // Only when there is one: rows written before causation existed carry none.
          ...(selected.causation_id
            ? [{
                label: 'Transaction',
                value: String(selected.causation_id),
                copyable: true,
                mono: true,
                title: 'The database transaction that wrote this row. Every audit row sharing it '
                     + 'was written by ONE act. Unique within this database only.'
              }]
            : []),
          { label: 'Description', value: selected.description, full: true }
        ] : []}
        beforeActions={selected && selectedAnalysis && (
          <>
            {/* Above the diff, for the reason the subtitle nav is: a control that changes what the
                drawer shows belongs above it. */}
            <CausationGroup
              siblings={selectedSiblings}
              entityNames={entityNames}
              onSelect={setSelectedEventId}
            />
            <EventDiff event={selected} diff={selectedAnalysis.diff} />
          </>
        )}
      >
        {selected && <RawSnapshots event={selected} />}
      </ContextPanel>
    </div>
  )
}
