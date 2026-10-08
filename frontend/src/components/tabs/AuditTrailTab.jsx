import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '../../api'
import { downloadCSV } from '../../utils/downloadCSV'
import { KNOWN_PRINCIPALS } from '../../utils/serviceIdentities'
import { ContextPanel } from '../common/ContextPanel'
import {
  IconHistory, IconDownload, IconLayoutDashboard, IconFactory, IconRadio, IconCpu, IconTrash,
  IconShieldCheck, IconLock, IconClipboardList, IconSettings, IconTag, IconChevronRight
} from '../common/Icons'
import { CardHeading } from '../common/CardHeading'
import { SearchInput } from '../common/SearchInput'
import { ClearFilters } from '../common/ClearFilters'
import { FiltersPopover } from '../common/FiltersPopover'
import { ListFoot } from '../common/ListFoot'
import { LoadingState } from '../common/LoadingState'
import { EmptyState } from '../common/EmptyState'
import {
  AUDIT_TRAIL_ACTIONS, AUDIT_TRAIL_ENTITY_TYPES, ENTITY_KIND_BY_TABLE, auditTrailEntityTypesFor
} from '../../constants'
import { useSetting } from '../../hooks/useSettings'

/**
 * `actor_source` names the kind of actor; `changed_by` only says which principal it was, and is set
 * for a machine write as well as a person's.
 */
const ACTOR_LABELS = {
  user:      { label: 'User',              title: 'Made by a signed-in operator' },
  ingestion: { label: 'Ingestion daemon',  title: 'Written by the Sparkplug B ingestion daemon' },
  migration: { label: 'Database migration', title: 'Written by a migration or an owner connection' },
  service:   { label: 'Service',           title: 'Written by a machine identity or the service-role key' }
}

/** Whether an id is a machine identity: one the dashboard names, or one with a `machine_principals` row. */
const isMachineId = (id, machinePrincipals) =>
  !!id && (id in KNOWN_PRINCIPALS || !!machinePrincipals?.has(id))

/** A machine wrote the row: by its `actor_source`, or, where that is absent, by its principal. */
function isMachineRow(event, machinePrincipals) {
  const src = event.actor_source
  if (src) return src !== 'user'
  return isMachineId(event.changed_by, machinePrincipals)
}

/** The actor badge's text and hover title, decided on `actor_source` before `changed_by`. */
function actorLabel(event, machinePrincipals) {
  const src = event.actor_source
  if (src && ACTOR_LABELS[src]) return ACTOR_LABELS[src].label
  if (!src && event.changed_by && !isMachineId(event.changed_by, machinePrincipals)) return ACTOR_LABELS.user.label
  return '⚠ Unattributed'
}
function actorTitle(event, machinePrincipals) {
  const src = event.actor_source
  if (src && ACTOR_LABELS[src]) return ACTOR_LABELS[src].title
  if (!src && event.changed_by && !isMachineId(event.changed_by, machinePrincipals)) return `Changed by user ${event.changed_by}`
  return 'No actor recorded for this change'
}

/**
 * The trigger writes TG_TABLE_NAME ('devices'); the UI and page handovers use 'DEVICE'. The map in
 * constants.js normalises both and is shared with the filter and api.js so the three cannot drift.
 */
const ENTITY_KIND = ENTITY_KIND_BY_TABLE
/**
 * The kinds a deletion can be told about: this page fetches a lookup covering them, and
 * `audit_trail_page()` can probe a table for their rows. Absence from `entityIdentities` means the
 * row is gone, for these and for nothing else. `NAMEPLATE` and `DEVICE SCHEMA` qualify because
 * their rows are keyed by the device's id, so the devices lookup names them and the devices probe
 * answers for them.
 *
 * One set serves both the "deleted" flag and the hide filter, so a kind cannot be flagged and
 * never hidden. ACCESS is out, though `list_user_accounts()` names that lane: its subject is an
 * `auth.users` row the RPC cannot probe, so the page must not claim a deletion the server cannot
 * act on. An unnameable person falls back to a shortened id, unflagged.
 */
const DELETABLE_KINDS = new Set(
  ['AREA', 'CELL', 'GATEWAY', 'DEVICE', 'SCHEMA', 'NAMEPLATE', 'DEVICE SCHEMA']
)

/** Before any lookup lands, nothing is answerable. Hoisted so it is not a new Set every render. */
const EMPTY_KINDS = new Set()

const entityKind = (t) =>
  ENTITY_KIND[String(t || '').toLowerCase()] || String(t || '').toUpperCase()

/**
 * The kind filter a hand-over from another page sets. A device's trail includes its nameplate and
 * schema rows, which carry the device's id as `entity_id`, so a DEVICE hand-over sets none: the id
 * in the search box then selects every row keyed by that device, and only those.
 */
export const handoverKindFilter = (type) => (entityKind(type) === 'DEVICE' ? '' : (type || ''))

/**
 * Columns excluded from every diff: timestamp churn that would otherwise open each diff with a line
 * nobody came to read. `updated_at` and `last_seen` are not columns today; listed so the denylist
 * keeps working if they are added.
 */
const NOISE_FIELDS = new Set(['updated_at', 'last_heartbeat', 'last_seen'])

/**
 * Fields whose change is a governance act (what the entity is declared to be) rather than an
 * operational one. `asset_config` names the concept even though it is its own, unaudited, table.
 */
const GOVERNANCE_FIELDS = new Set([
  'schema_id', 'asset_config', 'connection_method', 'grafana_url', 'access_url'
])
/* `identity_source` is deliberately absent: a device's first DBIRTH updates it alongside `status`,
   and it is provenance written by ingestion rather than operator configuration. `name` and `icon`
   are cosmetic, not governance. */

/**
 * The four marker classes. `kind` is a CSS suffix as well as a key -- see `.trail-node-*`. Each has
 * a shape as well as a colour, so the classes stay apart without colour vision.
 */
export const MARKERS = {
  creation:    { label: 'Created',       shape: 'square',   hint: 'Row created — provisioning, or a first DBIRTH admitting the device' },
  operational: { label: 'Operational',   shape: 'circle',   hint: 'State change — status, cell, or another running-time property' },
  governance:  { label: 'Configuration', shape: 'diamond',  hint: 'Governance change — schema binding or declared configuration' },
  critical:    { label: 'Lifecycle',     shape: 'triangle', hint: 'Lifecycle event — deleted, archived, deprecated, or quarantined' }
}

/**
 * Each shape's outline in the 13px box `CLUSTER_GAP_PX` is measured against, sized to carry about
 * the weight of the 9px circle: the square smaller, the diamond and the triangle larger, the
 * triangle raised a little so it does not sit low on the track.
 */
const MARKER_PATHS = {
  circle:   'M2 6.5a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0Z',
  square:   'M2.75 2.75h7.5v7.5h-7.5Z',
  diamond:  'M6.5 1L12 6.5L6.5 12L1 6.5Z',
  triangle: 'M6.5 0.5L12.5 11.5H0.5Z'
}

/**
 * One event-class marker, on the track and in the legend alike. The selected ring is the same
 * outline stroked wider underneath, inside the SVG, so it follows a triangle as it does a circle;
 * a box-shadow would ring the button's box instead.
 */
export function TrailMarker({ kind, selected = false }) {
  const shape = (MARKERS[kind] || MARKERS.operational).shape
  const d = MARKER_PATHS[shape]
  return (
    <svg
      className={`trail-node-mark trail-node-${kind}`}
      data-shape={shape}
      viewBox="0 0 13 13"
      width="13"
      height="13"
      aria-hidden="true"
      focusable="false"
    >
      {selected && <path className="trail-node-ring" d={d} />}
      <path className="trail-node-shape" d={d} />
    </svg>
  )
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
 * Which marker an event gets. `audit_trail.action` holds only INSERT / UPDATE / DELETE from the
 * trigger, so archiving, quarantining and a schema rebinding are derived from the diff.
 * SCHEMA_REJECTION is written by `record_ingestion_rejection()` with no diff, so the action itself
 * decides: governance, not critical. An INSERT is always creation, even of an already-quarantined
 * device, except a `device_submodels` row, which is a schema binding and governance whatever its
 * verb.
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
  // The same argument, arriving from `user_roles`. A revocation is not `critical`: that
  // marker is for an entity's lifecycle, and nothing on the shopfloor ended here.
  if (action === 'ROLE_GRANTED' || action === 'ROLE_REVOKED') return 'governance'
  // A device_submodels row is a schema binding: attaching or detaching one is the governance act
  // a change to `schema_id` is, not a creation or a deletion of the device.
  if (String(event.entity_type || '').toLowerCase() === 'device_submodels') return 'governance'
  if (action === 'DELETE') return 'critical'
  if (action === 'INSERT') return 'creation'

  const changed = new Set(diff.map(d => d.field))
  const roseTo = (field) => changed.has(field) && event.new_data?.[field] === true
  // `deprecated` is a metric's retirement, as `is_archived` is an entity's.
  if (roseTo('is_archived') || roseTo('is_quarantined') || roseTo('deprecated')) return 'critical'

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
 * arrivals are a handover for one entity whose last edit may be years old. Called at fetch time
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
 * The fallback for the `ui.audit_trail_poll_seconds` setting, whose `fallback_source` names this
 * constant.
 */
const DEFAULT_POLL_SECONDS = 60

/**
 * Rows per request. `audit_trail_page()` scans the whole match to count deleted entities whatever
 * the page size, so a larger page only costs; paging is the answer, not a bigger page.
 */
const PAGE_SIZE = 200

/**
 * Fold a freshly polled first page into the pages already loaded. The trail is append-only and
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
   axis: identical timestamps are the visual signature of one transaction. See the Audit Trail
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

/** The icon for a kind with no section of its own — the raw kind, which `ENTITY_KIND` made legible. */
const FALLBACK_SECTION_ICON = IconHistory

const SECTION_ICONS = {
  AREA:               IconFactory,
  CELL:               IconLayoutDashboard,
  GATEWAY:            IconRadio,
  DEVICE:             IconCpu,
  // The security lane, in the order a reader meets it: who holds what, what the machines are,
  // then the contracts and settings that shape both.
  ACCESS:             IconShieldCheck,
  'SERVICE IDENTITY': IconLock,
  SCHEMA:             IconClipboardList,
  METRIC:             IconTag,
  SETTING:            IconSettings
}

/**
 * The sections, in the order a plant is organised, then the security lane. Order and labels come
 * from `AUDIT_TRAIL_ENTITY_TYPES`; only the icons live here, so a kind added to the shared table
 * reaches the timeline and the filter together. A kind without an icon here still gets a section,
 * with the fallback icon.
 */
const SECTIONS = AUDIT_TRAIL_ENTITY_TYPES.map(({ kind, label }) => ({
  kind,
  label,
  Icon: SECTION_ICONS[kind] || FALLBACK_SECTION_ICON
}))

/**
 * Is only some of what exists being drawn? `total` is null wherever the count is not known — a
 * response that carries no total — and not knowing is not a fraction.
 */
export const isPartial = (shown, total) => typeof total === 'number' && total > shown

/**
 * What is drawn over what there is, as a ratio: "200/467", or "200" when that is all of them. The
 * events against the whole match, in the foot and on the Export button.
 */
export const countRatio = (shown, total) =>
  isPartial(shown, total) ? `${shown}/${total}` : String(shown)

/** A UUID shortened to something a person can compare at a glance, when there is no name. */
export const shortId = (id) => {
  const s = String(id || '')
  return s.length > 13 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s
}

/**
 * What the entity, mutation and transaction ids in the event drawer are for. Each one ends by
 * saying where it can be pasted, because an identifier a reader cannot spend is the thing they
 * were asking about.
 */
const ENTITY_ID_HELP =
  'The row this change was made to -- a device, a schema, a setting -- in the table its lane '
  + 'names. It is the id the rest of the platform knows that entity by. Paste it into the search '
  + 'box above for everything that has ever happened to it, or into the global search (Ctrl+K), '
  + 'which opens the entity itself where it has a page and offers this one where it does not.'

const MUTATION_ID_HELP =
  'This audit row, not the thing it changed. It is the value to quote in a ticket or an incident '
  + 'note: it never changes, and two edits a second apart are told apart by it and by nothing '
  + 'else. The search box above accepts it; it is `audit_trail.id` in SQL and the '
  + '`mutation_id` column of the CSV export.'

const TRANSACTION_ID_HELP =
  'The database transaction that wrote this row. Every audit row carrying the same one was written '
  + 'by a SINGLE act -- an approval and the change it applied, a delete that cascaded. Where the '
  + 'act wrote more than is loaded, "Show whole transaction" below loads all of them. It is unique '
  + 'within this database only, and is '
  + 'not preserved by a restore from a dump: group by it, never store it as a reference. It is '
  + '`audit_trail.causation_id` in SQL and `transaction_id` in the CSV export.'

/**
 * The fields an audit snapshot can name its subject with, in the order they are preferred.
 *
 * Shared with `audit_trail_page()`'s `p_search`. A field the search matches and this does not is
 * a row you can find and cannot identify; a field here that the search does not match is a lane
 * you can see and cannot search for. `sparkplug_id` is immutable and is what telemetry and
 * alerts are keyed by, so it outranks the rest where a row carries both.
 *
 * `role` is deliberately absent even though `user_roles` rows carry one and `p_search` matches it:
 * the lane is a person, keyed by `user_roles.user_id`, and the role is what happened to them.
 * Labelling the lane with it would give two Administrators one name and would change under a
 * reader as pages arrive, because `resolveLaneName()` takes whichever event it meets first.
 * `list_user_accounts()` is how that lane gets named.
 */
const SNAPSHOT_IDENTITY_FIELDS = [
  'name',          // areas, cells, gateways, devices
  'sparkplug_id',  // gateways, devices -- immutable, and the key telemetry uses
  'schema_name',   // schemas; `version` is appended below
  'label',         // system_settings, the wording the Settings page shows
  'key',           // system_settings, when it has no label
  'stamp',         // backups, which is what the Backups page calls one
  // Last, because it is a category rather than an identity: a backup job has no name column, and
  // `origin` is the only thing its payload carries that says what the act was. `backups` rows also
  // carry one and reach `stamp` first, so the order of this list matters.
  'origin',        // backup_jobs; the short id is appended, see CATEGORY_IDENTITY_FIELDS
]

/**
 * Fields whose value names a KIND of thing rather than one thing. Every backup job requested by
 * hand shares `origin`, and two of them requested in the same minute are otherwise one label drawn
 * twice -- so a lane named from one of these carries its short id as the qualifier chip.
 */
const CATEGORY_IDENTITY_FIELDS = new Set(['origin'])

/** How the Backups page words an origin, so one act is not described two ways in one dashboard. */
const ORIGIN_LABELS = { requested: 'On request', scheduled: 'Scheduled' }

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

    // Worded as the Backups page words it. An unrecognised origin is passed through rather than
    // dropped: a new one is still more use than a uuid, and the search matches the stored value
    // either way -- ILIKE is case-blind, so what is drawn is close enough to what is typed.
    if (field === 'origin') {
      return { label: ORIGIN_LABELS[value] || String(value), field: 'origin' }
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
        // A category names what the act WAS, not which one it was, so the id is what keeps two of
        // them apart. Decided here rather than in snapshotIdentity(), which reads one event and
        // does not know the entity it belongs to.
        qualifier: CATEGORY_IDENTITY_FIELDS.has(snapshot.field)
          ? shortId(entityId)
          : snapshot.qualifier,
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

const EmptyValue = ({ label }) => <span className="trail-diff-empty">{label}</span>

/**
 * The other audit rows written by the same transaction. Ordered by `event_id` ascending, the order
 * the rows were written; `recorded_at` is the transaction start time and identical across them.
 * Drawn from the fetched, filtered set, so a sibling outside the current filter is not listed;
 * `transaction_rows` on the event says how many there are in all.
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
 * Rendered whenever the row carries a transaction, siblings or not. Two numbers decide what it
 * says: `event.transaction_rows`, how many rows the transaction wrote, counted by
 * audit_trail_page() over the whole table; and `siblings`, drawn from the loaded,
 * filtered set. One row, and there is nothing to offer; every row loaded, and the list is
 * complete; rows missing, how many, and the control that loads them. Without the count (a row
 * from a response that lacks it) the section hedges instead, because a group whose other members
 * are outside the filter then looks identical to a single-row act.
 *
 * `isolated` means the search already IS this transaction, so the control would do what has been
 * done; rows still missing then are on pages not yet fetched.
 */
function CausationGroup({ event, siblings, entityNames, onSelect, onShowTransaction, isolated }) {
  if (!event?.causation_id) return null

  const known = Number.isFinite(event.transaction_rows)
  const loaded = siblings.length
  // The other rows the act wrote, and how many of them are not on this page.
  const others = known ? Math.max(0, event.transaction_rows - 1) : null
  const missing = known ? Math.max(0, others - loaded) : null

  const some = (n) => (n === 1 ? 'One other change' : `${n} other changes`)
  const hint = !known
    ? (isolated
        ? (loaded === 0
            ? 'Nothing else was written by this act.'
            : `${some(loaded)} written by this act, and this is all of them.`)
        : (loaded === 0
            ? 'Nothing else written by this act is loaded — which is not the same as there '
              + 'being nothing else.'
            : `${some(loaded)} ${loaded === 1 ? 'was' : 'were'} written by the same act. `
              + 'Limited to the events currently loaded and filtered.'))
    : (others === 0
        ? 'Nothing else was written by this act.'
        : missing === 0
          ? `${some(others)} written by this act, and this is all of them.`
          : `${some(others)} ${others === 1 ? 'was' : 'were'} written by this act. `
            + `${missing === 1 ? 'One' : missing} of them ${missing === 1 ? 'is' : 'are'} not loaded: `
            + (isolated
                ? 'on a page not yet fetched.'
                : 'outside the current filters, or on a page not yet fetched.'))

  // Offered when there is something to load. Not once the search is this transaction: a control
  // that would do what has been done reads as though it might do something more.
  const offerControl = !isolated && (!known || missing > 0)
  // The true count where it is known. Without it, zero loaded siblings is an unknown rather than a
  // total, and a "0" chip beside a hint that says so asserts the very thing the hint is refusing to.
  const chip = known ? others : ((isolated || loaded > 0) ? loaded : null)

  return (
    <div className="trail-causation">
      <div className="context-panel-section-label">
        Same transaction
        {chip !== null && <span className="section-count">{chip}</span>}
      </div>

      <p className="trail-causation-hint">{hint}</p>

      {offerControl && (
        <button
          type="button"
          className="btn btn-ghost btn-sm trail-causation-all"
          onClick={() => onShowTransaction(event.causation_id)}
          title={`Search for transaction ${event.causation_id}, so every row it wrote is loaded `
               + 'whatever kind of entity it touched. Clears the entity and action filters and '
               + 'shows deleted entities, each of which would hide part of one act.'}
        >
          Show whole transaction
        </button>
      )}

      <ul className="trail-causation-list">
        {siblings.map(s => {
          // Same three falls as the lane label; a sibling may itself have been purged.
          const name = entityNames.get(s.entity_id) || snapshotIdentity(s)?.label
          return (
            <li key={s.event_id}>
              <button
                type="button"
                className="trail-causation-item"
                onClick={() => onSelect(s.event_id)}
                title={`Open this change to ${name || s.entity_id}`}
                /* Explicit, because the computed name would read the spans in order without saying
                   that activating it opens the row. */
                aria-label={`Open this change to ${name || s.entity_id}`}
              >
                <span className="trail-causation-kind">{entityKind(s.entity_type)}</span>
                <span className="trail-causation-name">
                  {name || <span className="mono">{shortId(s.entity_id)}</span>}
                </span>
                <span className="trail-causation-action">{s.event_type}</span>
                <span className="trail-causation-chevron" aria-hidden="true"><IconChevronRight size={14} /></span>
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
  // These acts are one-sided (INSERT, DELETE, SCHEMA_REJECTION, TOKEN_MINTED, BACKUP_REQUESTED,
  // BACKUP_TAKEN): `old_data` is NULL by construction, and a Previous column would invite a search
  // for a prior state that does not exist.
  const oneSided = action === 'INSERT' || action === 'DELETE' || action === 'SCHEMA_REJECTION'
    || action === 'TOKEN_MINTED' || action === 'BACKUP_REQUESTED' || action === 'BACKUP_TAKEN'
    || action === 'PERSON_ADDED'

  return (
    <div className="trail-diff">
      <div className="context-panel-section-label">
        {action === 'INSERT' ? 'Initial properties'
          : action === 'DELETE' ? 'Final properties'
            : action === 'SCHEMA_REJECTION' ? 'Rejected payload'
              : action === 'FLOW_DEPLOYED' ? 'Deployed flow'
              : action === 'BACKUP_REQUESTED' ? 'Backup asked for'
              : action === 'BACKUP_TAKEN' ? 'Backup written'
              : action === 'BACKUP_PRUNED' ? 'Backup removed'
              : action === 'TOKEN_MINTED' ? 'Token issued'
              : action === 'PERSON_ADDED' ? 'Person added'
                // Two-sided, unlike TOKEN_MINTED: a revocation carries the original mint in
                // `old_data` so the row stays readable after the denylist entry is pruned.
                : action === 'TOKEN_REVOKED' ? 'Token withdrawn'
                  : 'Changed properties'}
      </div>

      {diff.length === 0 ? (
        /* Either an UPDATE whose only changed column was on the noise denylist, or a row without
           snapshots. Neither is an error. */
        <div className="trail-diff-none">
          No property changes recorded outside the ignored timestamp columns.
        </div>
      ) : (
        <table className={`trail-diff-table${oneSided ? ' trail-diff-onesided' : ''}`}>
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
                    : action === 'PERSON_ADDED' ? 'Added'
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
                    <td className="trail-diff-before" title={before || undefined}>
                      {before === null ? <EmptyValue label="Not set" /> : before}
                    </td>
                  )}
                  <td className="trail-diff-after" title={(action === 'DELETE' ? before : after) || undefined}>
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
    <details className="trail-raw">
      <summary className="trail-raw-summary">Raw audit payload</summary>
      <div className="trail-raw-body">
        <div className="trail-raw-label">old_data</div>
        <pre className="trail-raw-json">{event.old_data ? dump(event.old_data) : 'null'}</pre>
        <div className="trail-raw-label">new_data</div>
        <pre className="trail-raw-json">{event.new_data ? dump(event.new_data) : 'null'}</pre>
      </div>
    </details>
  )
}

/**
 * `initialEntity` is a handover from another page: `{ id, type }`. Applied to the ordinary filters,
 * so every control still works and Clear filters clears it. The id goes into the name filter, which
 * matches ids as well as names.
 */
export function AuditTrailTab({ userRole, initialEntity, onClearEntity, showToast }) {
  // The kinds this role may ask for. The database policy decides what comes back; this decides
  // what is offered, so the two agree on which lanes exist for a Shopfloor_Manager.
  const entityTypes = useMemo(() => auditTrailEntityTypesFor(userRole), [userRole])
  const allowedKinds = useMemo(() => new Set(entityTypes.map(e => e.kind)), [entityTypes])
  // Raw, from the API. `events` below is the displayed set, and every consumer reads that one so
  // the purged filter applies everywhere.
  const [allEvents, setAllEvents]     = useState([])
  // Whether to include events whose entity is no longer in the database. Hidden by default, and
  // phrased as Show so the resting control is unlit, like the Gateways and Cells toggles.
  const [showPurged, setShowPurged]   = useState(false)
  // Set once the entity lookups have landed; until then every id looks absent. Stays false if they
  // fail: unable to tell purged from live means hide nothing.
  const [lookupsLoaded, setLookupsLoaded] = useState(false)
  // The subset of DELETABLE_KINDS whose lookup actually landed, which is the set that may be called
  // deleted and hidden. Narrower than the constant whenever a tolerated lookup failed.
  const [loadedKinds, setLoadedKinds] = useState(EMPTY_KINDS)
  const [loading, setLoading]         = useState(true)
  const [entityTypeFilter, setEntityTypeFilter] = useState(handoverKindFilter(initialEntity?.type))
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
  // Empty for a role that may not ask, which is also a role that cannot see the lane.
  const [userAccounts, setUserAccounts] = useState([])
  // Principal id -> `machine_principals` row, for the same roles as the accounts above.
  const [machinePrincipals, setMachinePrincipals] = useState(() => new Map())
  const [selectedEventId, setSelectedEventId] = useState(null)

  /* A runtime override, falling back to the constant above, which is what a stack whose Settings
     were never touched runs on. */
  const pollSeconds = useSetting('ui.audit_trail_poll_seconds', DEFAULT_POLL_SECONDS)

  useEffect(() => {
    // Cells, gateways, devices and schemas are joined here so the log can be searched by name; the
    // audit row stores only `entity_id`. Absence from this map is also what marks an entity as
    // deleted, so every audited table must be fetched.
    //
    // A TOLERATED LOOKUP RESOLVES TO null WHEN IT FAILED, which `[]` cannot say: an empty list and
    // a refused request are the same value and opposite facts, and reading the second as the first
    // would call every live entity of that kind deleted and then hide it. `loadedKinds` below
    // admits only the kinds whose own lookup landed.
    // A thunk rather than a promise, so a lookup that throws before it returns one (an api method
    // the build does not have) is tolerated the same way as one that rejects.
    const tolerated = (f) => Promise.resolve().then(f).then(r => r || []).catch(() => null)
    Promise.all([
      api.get('/api/v1/devices'),
      api.get('/api/v1/gateways'),
      api.get('/api/v1/cells'),
      // Tolerated rather than required: this page must not fail to load because one lookup did,
      // and the uuid fallback below is exactly the behaviour that was there before.
      tolerated(() => api.get('/api/v1/schemas')),
      tolerated(() => api.get('/api/v1/areas')),
      // A role-assignment row is about a person: `log_role_assignment()` keys it by `user_id`, and
      // this is the only way to turn that into anybody. It refuses a Shopfloor_Manager or an
      // Operator, who cannot see the lane either, so the empty list they fall back to names
      // nothing they were going to be shown.
      tolerated(() => api.listUserAccounts()),
      // The names Administrators gave the machine identities they created on the Access Control
      // page. Same readers as the accounts above, same fallback.
      tolerated(() => api.listMachinePrincipalNames()),
    ])
      .then(([d, g, c, sc, ar, us, mp]) => {
        setDevices(d); setGateways(g); setCells(c); setSchemas(sc || []); setAreas(ar || [])
        setUserAccounts(us || [])
        setMachinePrincipals(mp instanceof Map ? mp : new Map())
        // Subtracted from the constant, never listed again. The required three landed or this
        // branch did not run, so only the tolerated lookups can take a kind away.
        const unanswerable = new Set([!sc && 'SCHEMA', !ar && 'AREA'].filter(Boolean))
        setLoadedKinds(new Set([...DELETABLE_KINDS].filter(k => !unanswerable.has(k))))
        setLookupsLoaded(true)
      })
      .catch(() => {})
  }, [])

  /**
   * entity_id -> `{ name, qualifier }`, across every audited table this page can look one up in.
   *
   * Structured rather than composed: a schema's `version` is what separates one member of a lineage
   * from another, and at the end of a composed string a fixed-width label ellipsises it away. The
   * lane draws it as its own element; `entityNames` below composes it for every other reader.
   *
   * What is in here also decides deletion: `DELETABLE_KINDS` reads it to tell an absence that means
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
    // The email, which is all `auth.users` carries here. An account without one falls through to
    // the id.
    for (const u of userAccounts) if (u?.user_id && u.email) m.set(u.user_id, { name: u.email })
    // Machine identities come from two places: the pinned ones are named by the dashboard's own
    // registry, and one created on the Access Control page has a `machine_principals` row. An id
    // in neither keeps its uuid, so unknown ones are not all drawn as one lane.
    for (const [id, meta] of Object.entries(KNOWN_PRINCIPALS)) {
      if (meta?.name) m.set(id, { name: meta.name })
    }
    for (const [id, row] of machinePrincipals) {
      if (row?.name && !m.has(id)) m.set(id, { name: row.name })
    }
    return m
  }, [areas, cells, gateways, devices, schemas, userAccounts, machinePrincipals])

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

  // Deleted entities: in the log, absent from every live table. The list endpoints do not filter
  // `is_archived`, so absent means gone rather than retired. The server counts them over everything
  // the filters select, not over the page; null means it did not say, which must not render as zero.
  const [serverPurgedCount, setServerPurgedCount] = useState(null)
  // How many events match the current filters in total, so the page can say what fraction of them
  // it is holding. Null when the response carries none: the counts then name the loaded events.
  const [totalMatching, setTotalMatching] = useState(null)
  // Whether the row limit bit, which the page cannot tell otherwise.
  const [truncated, setTruncated] = useState(false)

  /**
   * How many deleted entities the current filters cover. The server's count wins; a response without
   * one (an older API, or a bare-array fixture) falls back to counting the page, never to zero,
   * which would hide the control that reveals them.
   */
  const purgedEntityCount = useMemo(() => {
    if (serverPurgedCount !== null) return serverPurgedCount
    if (!lookupsLoaded) return 0
    // Distinct entities, not events, and scoped to `loadedKinds` like the filter: a kind nothing can
    // answer for is unnamed, not deleted, and counting it would draw a control that reveals
    // nothing.
    const seen = new Set()
    for (const e of allEvents) {
      if (loadedKinds.has(entityKind(e.entity_type)) && !entityNames.has(e.entity_id)) {
        seen.add(e.entity_id)
      }
    }
    return seen.size
  }, [serverPurgedCount, allEvents, entityNames, lookupsLoaded, loadedKinds])

  /**
   * What the page renders. Deleted entities are hidden by default. `audit_trail_page()` applies
   * the same rule as a predicate before the row limit; this client-side filter covers a response
   * that was not filtered.
   */
  const events = useMemo(() => {
    if (showPurged || !lookupsLoaded) return allEvents
    // The same set that decides the "deleted" flag, so the two cannot disagree about a kind.
    return allEvents.filter(e => loadedKinds.has(entityKind(e.entity_type))
      ? entityNames.has(e.entity_id)
      : true)
  }, [allEvents, entityNames, showPurged, lookupsLoaded, loadedKinds])

  /**
   * The counts the page renders, derived here so the foot and the Export button cannot end up
   * describing different sets.
   */
  const eventRatio = countRatio(events.length, totalMatching)
  const hasMoreToLoad = isPartial(events.length, totalMatching)

  /**
   * The search, sent as the typed text. `p_search` reads the same fields the lane label falls back
   * to, so a deleted entity is found by its name. It is a database predicate rather than a filter
   * over the page, so the row limit applies to rows that will be shown, as with the action filter
   * and the time range.
   */
  const search = nameFilter.trim()

  /** Where the next page starts; null at the end, which is the only end-of-data signal. */
  const [nextCursor, setNextCursor] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)

  /** What the foot counts against: the whole match, or, without one, another page while a cursor exists. */
  const footTotal = typeof totalMatching === 'number'
    ? totalMatching
    : events.length + (nextCursor ? PAGE_SIZE : 0)

  /**
   * The loaded events, mirrored into a ref so the poll can merge without putting `allEvents` in
   * `load`'s dependencies, which would restart the interval on every fetch.
   */
  const allEventsRef = useRef([])
  useEffect(() => { allEventsRef.current = allEvents }, [allEvents])

  const buildUrl = useCallback((cursor) => {
    let url = `/api/v1/audit-trail?limit=${PAGE_SIZE}`
    if (entityTypeFilter) url += `&entity_type=${encodeURIComponent(entityTypeFilter)}`
    if (actionFilter)     url += `&action=${encodeURIComponent(actionFilter)}`
    if (search)           url += `&search=${encodeURIComponent(search)}`
    // Evaluated here, not held in state: see timeWindow's note on a rolling window going stale
    // under auto-refresh.
    const { since, until } = timeWindow(rangePreset, customStart, customEnd)
    if (since) url += `&since=${encodeURIComponent(since)}`
    if (until) url += `&until=${encodeURIComponent(until)}`
    if (showPurged) url += '&include_purged=true'
    // Both halves or neither: `recorded_at` is not unique (one transaction's rows share a
    // `now()`), so the id is what makes the position exact.
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

  // A later handover -- clicking Audit Trail on a second device without leaving the page --
  // replaces the filter rather than being ignored because state was already initialised.
  useEffect(() => {
    if (!initialEntity?.id) return
    setEntityTypeFilter(handoverKindFilter(initialEntity.type))
    setNameFilter(initialEntity.id)
    // A handover from a tombstone names an entity the live tables no longer hold; the page would
    // otherwise hide every row of it and read as empty.
    if (initialEntity.purged) setShowPurged(true)
  }, [initialEntity?.id, initialEntity?.type, initialEntity?.purged])

  const rangeIsFiltering =
    rangePreset === 'custom' ? !!(customStart || customEnd) : rangePreset !== 'all'

  /** The controls in the Filters popover that are off their default; its own Clear resets them. */
  const popoverFilterCount = (entityTypeFilter ? 1 : 0) + (actionFilter ? 1 : 0)

  const activeFilterCount = popoverFilterCount + (nameFilter ? 1 : 0) +
    // Showing deleted entities is the deviation, so Clear filters returns them to hidden.
    (rangeIsFiltering ? 1 : 0) + (showPurged ? 1 : 0)

  const clearPopoverFilters = () => { setEntityTypeFilter(''); setActionFilter('') }

  /**
   * Load every row one transaction wrote, by searching its id.
   *
   * The entity and action filters are cleared because one act crosses both: an approval writes an
   * UPDATE on the entity it changed and a PROPOSAL_APPLIED row, and either filter would hide half
   * of it. Deleted entities are shown for the same reason: a delete's own row is about an entity
   * no live table holds, and `transaction_rows` counts it. The time range is kept: the rows share
   * one `recorded_at`, so a range holding this event holds its siblings.
   */
  const showWholeTransaction = (causationId) => {
    setNameFilter(String(causationId))
    setEntityTypeFilter('')
    setActionFilter('')
    setShowPurged(true)
  }

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

  /**
   * Every lane, grouped into sections. A known kind keeps its order and icon when this role may ask
   * for it; a lane of a known kind outside `allowedKinds` is dropped, because the role could not
   * have read its rows. Every other kind gets a section of its own with the fallback icon. Empty
   * sections are omitted.
   */
  const sections = useMemo(() => {
    const known = SECTIONS
      .filter(s => allowedKinds.has(s.kind))
      .map(s => ({ ...s, lanes: lanes.filter(l => l.kind === s.kind) }))
      .filter(s => s.lanes.length > 0)

    const claimed = new Set(SECTIONS.map(s => s.kind))
    const leftovers = [...new Set(lanes.map(l => l.kind).filter(k => !claimed.has(k)))]
      .sort()
      .map(kind => ({
        kind,
        // The raw kind, uppercased: it reads as a gap to close rather than a considered label.
        label: kind,
        Icon: FALLBACK_SECTION_ICON,
        lanes: lanes.filter(l => l.kind === kind)
      }))

    return [...known, ...leftovers]
  }, [lanes, allowedKinds])

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
  // its members' positions. THE ONE FORMULA for everything placed along the time axis: markers,
  // badges, ticks and gridlines all go through it, so a tick and the line under it cannot drift
  // apart.
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
    for (const lane of lanes) {
      m.set(lane.key, clusterEvents(lane.events, (e) => fractionFor(e.timestamp), trackWidth))
    }
    return m
  }, [lanes, fractionFor, trackWidth])

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
  // The drawer's title icon: the selected entity's section glyph.
  const SelectedIcon = selected
    ? (SECTION_ICONS[entityKind(selected.entity_type)] || FALLBACK_SECTION_ICON)
    : null

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

  /**
   * ← and → step the drawer while it has a selected event. Bound here rather than in App.jsx: the
   * keys mean nothing without a selection, and the index they move lives here. One listener per
   * selection, reading the current position through a ref, so it is not re-installed every render.
   *
   * Stands down for an editable target and for a modified keystroke, the guard the `?` handler in
   * App.jsx uses: the filter bar's selects and date inputs consume arrow keys natively, and a
   * focused select must not both change its value and step the drawer. No wrap: stepTo() ignores
   * an out-of-range index, matching the disabled buttons.
   */
  const navRef = useRef({ selectedIndex, stepTo })
  navRef.current = { selectedIndex, stepTo }
  const hasSelection = !!selected
  useEffect(() => {
    if (!hasSelection) return
    const onKey = (e) => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
      e.preventDefault()
      const { selectedIndex: i, stepTo: step } = navRef.current
      step(e.key === 'ArrowLeft' ? i - 1 : i + 1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [hasSelection])

  /** Whether the loaded set already IS one transaction, which is what lets the drawer stop hedging. */
  const isTransactionIsolated = !!selected?.causation_id
    && nameFilter.trim() === String(selected.causation_id)

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
      // The UI's words, not the database's: these are `audit_trail.id` and `causation_id`, and
      // the drawer calls them Mutation ID and Transaction ID. One name per thing, across all three.
      mutation_id:    e.event_id,
      transaction_id: e.causation_id ?? '',
      // How many rows the transaction wrote in all, so a reader of the export can tell a
      // single-row act from a group the filters cut. Empty where the row has no transaction.
      transaction_rows: e.transaction_rows ?? '',
      action:         e.event_type,
      classification: MARKERS[a.kind].label,
      actor:          actorLabel(e, machinePrincipals),
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
    /* `page-fill` and `card-fill`: the page fills the viewport and the timeline scrolls inside the
       card, so the axis row has a scroller to pin to. See .page-fill in App.css. */
    <div className="page-layout page-fill">
      <div className="page-main">
        {/* Export sits in the header with the other actions and states the filtered count it will
            write. */}
        <div className="card card-fill">
          <CardHeading
            icon={<IconHistory size={15} />}
            title="Audit Trail"
            description="Every attributed change to the stack's entities, in order and with its cause. Rows cannot be edited; an owner retires whole months."
            actions={(
              /* Export writes the events the page is holding, not everything that matches, and
                 the tooltip says so. */
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => downloadCSV(exportRows(), 'audit-trail-export.csv')}
                title={hasMoreToLoad
                  ? `Download the ${events.length} events loaded here as CSV. ${totalMatching} match `
                    + 'the current filters -- load the rest first to export them all.'
                  : 'Download the events matching the current filters as CSV'}
              >
                <IconDownload size={13} /> Export CSV ({eventRatio})
              </button>
            )}
          />

          <div className="card-body">

        <div className="filter-bar">
          <SearchInput
            value={nameFilter}
            onChange={setNameFilter}
            placeholder="Search a name or any ID…"
            ariaLabel="Search by name, entity ID, mutation ID or transaction ID"
          />

          {/* All time is the default (see timeWindow). The window is a query parameter, so a
              narrower range does not spend the row budget outside it. */}
          <select
            className="form-control control-sm"
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

          {/* The secondary filters: the kind of entity and the action. Search, the range and the
              deleted-entities toggle stay in the bar. */}
          <FiltersPopover activeCount={popoverFilterCount} onClear={clearPopoverFilters}>
            <select
              className="form-control"
              value={entityTypeFilter}
              onChange={e => setEntityTypeFilter(e.target.value)}
              title="Show only events against one kind of entity"
            >
              <option value="">All entities</option>
              {/* Every kind this role may ask for, from the same table the sections are built from,
                  so a kind cannot be drawable and unfilterable. */}
              {entityTypes.map(({ kind, label }) => (
                <option key={kind} value={kind}>{label}</option>
              ))}
            </select>

            <select
              className="form-control"
              value={actionFilter}
              onChange={e => setActionFilter(e.target.value)}
              title="Filter by the database action recorded on the audit row, as the event drawer's badge shows it. The markers below are a separate classification; see the key above the timeline."
            >
              <option value="">Any action</option>
              {Object.entries(AUDIT_TRAIL_ACTIONS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </FiltersPopover>

          {/* Shown only when something is deleted. The tooltip says no longer in the database,
              because absence from the lookups is all the test sees. */}
          {purgedEntityCount > 0 && (
            <button
              className={`btn btn-sm ${showPurged ? 'btn-primary' : 'btn-ghost'}`}
              aria-pressed={showPurged}
              onClick={() => setShowPurged(v => !v)}
              title="Include events for entities that are no longer in the database. The records are kept either way -- this only changes what is listed."
            >
              <IconTrash size={13} /> Show deleted entities ({purgedEntityCount})
            </button>
          )}

          <ClearFilters count={activeFilterCount} onClear={resetFilters} />
        </div>
          </div>{/* .card-body */}

        {/* A second `.card-body`, so the controls and the trace get a divider from one rule.
            `trail-timeline` is the one part of the card that gives way when the viewport is short; its own
            scroller is `trail-scroll`. */}
        <div className="card-body card-fill-scroll trail-timeline">
          {/* One row above the timeline, always drawn so the card keeps its shape: the key. How
              much of the trail is loaded is stated at the foot, beside Show more. */}
          <div className="trail-header">
            {/* The legend for a derived classification: nothing else on the page says what a
                triangle means. The same marker the track draws. */}
            <div className="trail-legend">
              {Object.entries(MARKERS).map(([kind, m]) => (
                <span key={kind} className="trail-legend-item" title={m.hint}>
                  <TrailMarker kind={kind} />
                  {m.label}
                </span>
              ))}

              {/* Shown only while a badge is on screen. The sample is a real `.trail-cluster`,
                  reading `n` as a placeholder for each badge's count. */}
              {clusterCount > 0 && (
                <span
                  className="trail-legend-item"
                  title={`Events too close together to draw separately are ONE badge carrying the count — `
                       + `${clusterCount} on this timeline. Hover one for the breakdown, or narrow the `
                       + `time range and they separate back into individual markers.`}
                >
                  <span className="trail-cluster trail-legend-cluster" aria-hidden="true">n</span>
                  Grouped ({clusterCount})
                </span>
              )}
            </div>
          </div>

          {loading ? (
            <LoadingState label="the Audit Trail" />
          ) : events.length === 0 ? (
            <EmptyState
              icon={<IconHistory size={36} />}
              message={
                /* A search naming something deleted comes back with no events and a non-zero
                   deleted count, so that case says what is behind the toggle. */
                !showPurged && purgedEntityCount > 0
                  ? `Nothing here matches, but ${purgedEntityCount === 1
                      ? 'one deleted entity does'
                      : `${purgedEntityCount} deleted entities do`}. Their records are kept; this view just hides them.`
                  : rangeIsFiltering
                    ? 'No audit trail events in this time range. Widen it, or switch back to All time.'
                    : 'No audit trail events match the filter criteria.'
              }
            >
              {!showPurged && purgedEntityCount > 0 && (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => setShowPurged(true)}
                  title="Include events for entities that are no longer in the database"
                >
                  <IconTrash size={13} /> Show deleted entities ({purgedEntityCount})
                </button>
              )}
            </EmptyState>
          ) : (
            <>
              <div className="trail-scroll">
                <div className="trail-swimlanes">
                  <div className="trail-lane trail-axis">
                    {/* The corner is a spacer now: it holds the lane labels' width so the ticks
                        line up with the tracks beside them, and nothing else. */}
                    <div className="trail-lane-label trail-axis-corner" aria-hidden="true" />
                    <div className="trail-track trail-axis-track" ref={axisTrackRef}>
                      {ticks.map(t => (
                        <span
                          key={t.f}
                          className="trail-tick"
                          style={{ left: offsetForFraction(t.f) }}
                          title={t.title}
                        >
                          {t.label}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Everything under the axis. Its own box, so the gridlines can span exactly the
                      rows and nothing above them. */}
                  <div className="trail-body">
                    {sections.map(section => (
                      <React.Fragment key={section.kind}>
                        <div className="trail-section" role="separator" aria-label={`${section.label} lanes`}>
                          {/* A row of the grid: the heading in the label column and an empty track
                              beside it, so it takes the row's rule and the row's rhythm. */}
                          <div className="trail-lane-label">
                            <section.Icon size={12} className="trail-section-icon" />
                            <span className="trail-section-name">{section.label}</span>
                          </div>
                          <div className="trail-track" aria-hidden="true" />
                        </div>

                        {section.lanes.map(lane => (
                          <div className="trail-lane" key={lane.key}>
                            {/* No type badge and no icon: the section heading carries the kind and
                                is pinned in view, so the width goes to the name. The UUID is
                                copyable in the drawer's Entity ID field. */}
                            <div
                              className="trail-lane-label"
                              title={[
                                lane.name
                                  ? `${lane.name}${lane.qualifier ? ` ${lane.qualifier}` : ''}`
                                  : null,
                                lane.entityId,
                              ].filter(Boolean).join(' — ')}
                            >
                              {lane.name
                                ? <strong className="trail-lane-name">{lane.name}</strong>
                                /* Neither the join nor a snapshot could name it: the shortened id,
                                   monospaced. */
                                : <span className="trail-lane-name trail-lane-unnamed mono">{shortId(lane.entityId)}</span>}
                              {/* Must survive truncation: a schema lineage shares its name and differs only
                                  here. */}
                              {lane.qualifier && (
                                <span className="trail-lane-qualifier">{lane.qualifier}</span>
                              )}
                              {/* `gone`, not `fromSnapshot`: a name from a snapshot says where the
                                  label came from, and a settings or backup lane is named that way
                                  while existing perfectly well. */}
                              {lane.gone && (
                                <span
                                  className="trail-lane-gone"
                                  title={lane.fromSnapshot
                                    ? 'This entity no longer exists — the name is the one recorded in its final audit snapshot'
                                    : 'This entity no longer exists, and its audit rows carry no name to recover'}
                                >
                                  deleted
                                </span>
                              )}
                            </div>

                            <div className="trail-track">
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
                                      className={`trail-cluster${isSelected ? ' trail-node-selected' : ''}`}
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
                                    className={`trail-node trail-node-${kind}${isSelected ? ' trail-node-selected' : ''}`}
                                    style={{ left: offsetForFraction(item.xOffset) }}
                                    onClick={() => setSelectedEventId(e.event_id)}
                                    /* A plain `title`, as elsewhere: what, who, when. The rest is in
                                       the drawer. */
                                    title={`${e.event_type} · ${MARKERS[kind].label}\n${actorLabel(e, machinePrincipals)}\n${new Date(e.timestamp).toLocaleString()}`}
                                    aria-label={`${e.event_type} on ${lane.name || lane.entityId} at ${new Date(e.timestamp).toLocaleString()}`}
                                    aria-pressed={isSelected}
                                  >
                                    <TrailMarker kind={kind} selected={isSelected} />
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </React.Fragment>
                    ))}

                    {/* Faint dotted verticals from each tick down the whole grid, so an event on
                        one lane can be read against the same instant on another. Drawn once,
                        behind the rows, rather than once per lane; placed last so the first
                        section stays the body's first child. Positioned by the same helper as
                        the ticks and the markers. Nothing here is content. */}
                    <div className="trail-gridlines" aria-hidden="true">
                      {ticks.map(t => (
                        <span key={t.f} className="trail-gridline" style={{ left: offsetForFraction(t.f) }} />
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* `totalMatching` is the whole match; without it the foot claims only what is known:
                  another page while a cursor exists, otherwise the rows held. */}
              {truncated && !nextCursor ? (
                /* Cut off with no way forward: the response was limited and named no next page, so
                   the view is incomplete and the reader is told so. */
                <div className="list-foot">
                  <span className="list-foot-end">
                    Showing the newest {allEvents.length}
                    {typeof totalMatching === 'number' && ` of ${totalMatching}`} events — there are
                    older ones this view cannot reach.
                  </span>
                </div>
              ) : (
                <ListFoot
                  shown={events.length}
                  total={footTotal}
                  step={PAGE_SIZE}
                  onMore={loadMore}
                  pending={loadingMore}
                  /* "200 of 242" beside Show more, only against the server's own total: without
                     one, `footTotal` is an estimate. */
                  counted={typeof totalMatching === 'number'}
                />
              )}
            </>
          )}
        </div>{/* .card-body — the timeline */}
      </div>{/* .card */}
      </div>

      <ContextPanel
        open={!!selected}
        onClose={() => setSelectedEventId(null)}
        type={selected ? entityKind(selected.entity_type) : ''}
        icon={SelectedIcon && <SelectedIcon size={15} />}
        onCopy={showToast}
        title={selected
          ? (entityNames.get(selected.entity_id) || snapshotIdentity(selected)?.label || selected.entity_id)
          : ''}
        subtitle={selected && (
          /* One flex item laid out internally as rows; `.context-panel-subtitle` is a wrapping row
             shared with other pages. */
          <div className="trail-drawer-nav">
            {/* Above the thing it changes. The subtitle slot is the only one ContextPanel offers
                above the metadata. */}
            <div className="trail-drawer-nav-pos" title="Position in this entity's history, oldest first">
              Event {selectedIndex + 1} of {selectedLaneEvents.length}
              {' · '}
              {entityNames.get(selected.entity_id)
                || snapshotIdentity(selected)?.label
                || shortId(selected.entity_id)}
            </div>

            <div className="trail-drawer-nav-btns">
              {/* Previous is older. Disabled rather than hidden at the ends, so the row does not
                  reflow under the cursor. */}
              <button
                className={`btn btn-ghost btn-sm trail-nav-btn${selectedIndex <= 0 ? ' btn-disabled' : ''}`}
                onClick={() => stepTo(selectedIndex - 1)}
                disabled={selectedIndex <= 0}
                title={selectedIndex <= 0
                  ? 'This is the oldest recorded change to this entity'
                  : 'Step back to the previous change to this entity (←)'}
              >
                ◀ Previous
              </button>
              <button
                className={`btn btn-ghost btn-sm trail-nav-btn${selectedIndex >= selectedLaneEvents.length - 1 ? ' btn-disabled' : ''}`}
                onClick={() => stepTo(selectedIndex + 1)}
                disabled={selectedIndex >= selectedLaneEvents.length - 1}
                title={selectedIndex >= selectedLaneEvents.length - 1
                  ? 'This is the most recent change to this entity'
                  : 'Step forward to the next change to this entity (→)'}
              >
                Next ▶
              </button>
            </div>

            <div className="trail-drawer-nav-badges">
              <span className="badge badge-warning" title="Audit event type">{selected.event_type}</span>
              <span className={`badge trail-badge-${selectedAnalysis?.kind}`} title={MARKERS[selectedAnalysis?.kind]?.hint}>
                {MARKERS[selectedAnalysis?.kind]?.label}
              </span>
            </div>
          </div>
        )}
        fields={selected ? [
          { label: 'Recorded', value: new Date(selected.timestamp).toLocaleString(), title: selected.timestamp },
          {
            label: 'Actor',
            value: actorLabel(selected, machinePrincipals),
            title: actorTitle(selected, machinePrincipals)
          },
          // Only when the row names a principal: a user's id, or the machine identity's name
          // (its id where nothing here names it).
          ...(selected.changed_by
            ? [isMachineRow(selected, machinePrincipals)
              ? {
                label: 'Machine identity',
                value: selected.changed_by,
                display: entityNames.get(selected.changed_by),
                copyable: true,
                mono: true,
                title: 'The machine identity that made this change'
              }
              : { label: 'User ID', value: selected.changed_by, copyable: true, mono: true, title: 'The signed-in user who made this change' }]
            : []),
          {
            label: 'Entity ID',
            value: selected.entity_id,
            copyable: true,
            mono: true,
            title: 'The entity this change was made to',
            help: ENTITY_ID_HELP
          },
          // The audit row's own id. It identifies THIS mutation rather than the entity it touched,
          // which is what you need to quote when two edits a second apart are being told apart.
          {
            label: 'Mutation ID',
            value: String(selected.event_id),
            copyable: true,
            mono: true,
            title: 'Audit row ID for this single change',
            help: MUTATION_ID_HELP
          },
          // Only when there is one: rows written before causation existed carry none.
          ...(selected.causation_id
            ? [{
                label: 'Transaction ID',
                value: String(selected.causation_id),
                copyable: true,
                mono: true,
                title: 'The database transaction that wrote this row. Every audit row sharing it '
                     + 'was written by ONE act. Unique within this database only.',
                help: TRANSACTION_ID_HELP
              }]
            : []),
          { label: 'Description', value: selected.description, full: true }
        ] : []}
        beforeActions={selected && selectedAnalysis && (
          <>
            {/* Above the diff, for the reason the subtitle nav is: a control that changes what the
                drawer shows belongs above it. */}
            <CausationGroup
              event={selected}
              siblings={selectedSiblings}
              entityNames={entityNames}
              onSelect={setSelectedEventId}
              onShowTransaction={showWholeTransaction}
              isolated={isTransactionIsolated}
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
