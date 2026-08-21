import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '../../api'
import { downloadCSV } from '../../utils/downloadCSV'
import { ContextPanel } from '../common/ContextPanel'
import { IconHistory, IconDownload, IconX, IconBuilding2, IconRadio, IconCpu, IconTrash } from '../common/Icons'
import { DIGITAL_THREAD_ACTIONS } from '../../constants'

/**
 * How a machine-originated change is described. `changed_by` names WHICH user and is NULL for
 * every write no person made; `actor_source` (migration 0005) names WHAT KIND of actor it was,
 * so a blank author is no longer ambiguous between "a gateway did this" and "we lost track".
 */
const ACTOR_LABELS = {
  user:      { label: 'User',              title: 'Made by a signed-in operator' },
  ingestion: { label: 'Ingestion daemon',  title: 'Written by the Sparkplug B ingestion daemon' },
  migration: { label: 'Database migration', title: 'Written by a migration or an owner connection' },
  service:   { label: 'Service',           title: 'Written by an automated service on the service-role key' }
}

/** The actor badge's text and hover title, from the pair of columns that describe one actor. */
export function actorLabel(event) {
  if (event.actor_source === 'user' || event.changed_by) return ACTOR_LABELS.user.label
  return ACTOR_LABELS[event.actor_source]?.label || '⚠ Unattributed'
}
function actorTitle(event) {
  if (event.changed_by) return `Changed by user ${event.changed_by}`
  return ACTOR_LABELS[event.actor_source]?.title || 'No actor recorded for this change'
}

/**
 * The trigger writes TG_TABLE_NAME -- 'cells' / 'gateways' / 'devices'. The UI has always spoken
 * in the singular upper case, and a handover from another page arrives already in that form, so
 * both spellings reach this component and both have to normalise to one.
 */
const ENTITY_KIND = { cells: 'CELL', gateways: 'GATEWAY', devices: 'DEVICE' }
export const entityKind = (t) =>
  ENTITY_KIND[String(t || '').toLowerCase()] || String(t || '').toUpperCase()

/**
 * Columns excluded from every diff.
 *
 * Machine churn, not history. Migration 0005 already suppresses the two worst offenders at the
 * source -- an UPDATE where nothing changed, and a heartbeat-only UPDATE -- so what these catch
 * is the residue: a real edit that also happened to bump a timestamp, which would otherwise open
 * every diff with a line nobody came to read.
 *
 * `updated_at` and `last_seen` are not columns of cells, gateways or devices in this schema.
 * They are listed anyway because a denylist that only names what exists today silently stops
 * working the moment someone adds the column, and the failure mode is noise in an audit trail
 * rather than an error anyone would notice.
 */
const NOISE_FIELDS = new Set(['updated_at', 'last_heartbeat', 'last_seen'])

/**
 * Fields whose change is a GOVERNANCE act rather than an operational one -- what this asset is
 * declared to be, as opposed to what it is currently doing. `asset_config` is not a column of
 * these three tables (it is its own table, and is not audited); it is named here because the
 * classification is written in terms of the concept, and the day that binding moves onto the row
 * this keeps saying the right thing.
 */
const GOVERNANCE_FIELDS = new Set([
  'schema_id', 'asset_config', 'asset_type', 'connection_method', 'grafana_url', 'access_url'
])
/* `identity_source` was in this set and has been taken out, on the evidence of a reseeded stack.
   The commonest real event in the audit table is a device's first DBIRTH, which arrives as one
   UPDATE touching `status`, `first_dbirth_at` and `identity_source` together -- so including it
   painted the single most frequent lifecycle event on the page amber. It is provenance written
   by the ingestion daemon, not configuration an operator declared, and it never moves on its
   own. `name` and `icon` are left out for the mirror-image reason: cosmetic, not governance. */

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
 * What actually changed between two row snapshots.
 *
 * `old_data` and `new_data` are `to_jsonb(OLD)` / `to_jsonb(NEW)` -- WHOLE ROWS, not deltas. A
 * one-column rename therefore arrives as two twenty-key objects that agree on nineteen of them,
 * which is why the drawer computes the difference rather than printing what it was given.
 *
 * An INSERT has no `old_data` and a DELETE no `new_data`; those are rendered as one-sided
 * snapshots with their empty columns dropped, because "every null column this row was born with"
 * is not a fact about the creation.
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
 * Which marker an event gets.
 *
 * MOSTLY DERIVED, because the column it would otherwise read barely exists. `digital_thread.action`
 * is written from TG_OP for everything the audit TRIGGER records, so it holds INSERT / UPDATE /
 * DELETE and nothing more -- there is no QUARANTINE action and no ARCHIVE action to key off.
 * Archiving and quarantining are UPDATEs whose boolean flipped, and a schema rebinding is an UPDATE
 * that touched `schema_id`, so the distinction that matters to an operator lives in the diff.
 *
 * THE ONE EXCEPTION IS SCHEMA_REJECTION, written by `record_ingestion_rejection()` (migration 0026)
 * rather than by the trigger. It is not a row mutation at all -- it records a payload the ingestion
 * daemon judged non-conforming -- so there is no diff to classify it from and the action itself is
 * the answer. Governance rather than critical: it says the asset is publishing something its
 * declared model does not account for, which is the same category as a schema being rebound, and
 * NOT a lifecycle event of the kind `critical` is reserved for.
 *
 * An INSERT is always green, including the INSERT of an already-quarantined device -- the arrival
 * of a rogue asset. That follows the taxonomy as specified (INSERT is creation; the flag tests
 * apply to transitions) and is worth knowing about, because that one case is arguably red.
 */
export function classifyEvent(event, diff) {
  const action = String(event.event_type || event.action || '').toUpperCase()
  if (action === 'SCHEMA_REJECTION') return 'governance'
  if (action === 'DELETE') return 'critical'
  if (action === 'INSERT') return 'creation'

  const changed = new Set(diff.map(d => d.field))
  const roseTo = (field) => changed.has(field) && event.new_data?.[field] === true
  if (roseTo('is_archived') || roseTo('is_quarantined')) return 'critical'

  for (const field of changed) if (GOVERNANCE_FIELDS.has(field)) return 'governance'
  return 'operational'
}

/** The range presets, and the window each one means. `ms` of null is an unbounded window. */
export const TIME_PRESETS = [
  { value: 'all', label: 'All time',      ms: null },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: '7d',  label: 'Last 7 days',   ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: 'Last 30 days',  ms: 30 * 24 * 60 * 60 * 1000 }
]

/**
 * The preset (or the custom dates) as the `since` / `until` the API takes.
 *
 * ALL TIME IS THE DEFAULT, and that is a decision about the page's main entry path rather than a
 * shrug. Most arrivals here are a handover -- "Digital Thread" on a device row -- and a device
 * whose last edit was at install time would answer that click with an empty timeline under any
 * rolling default. An operator who asks for one asset's history means all of it.
 *
 * Called at fetch time rather than memoised: a page left on "Last 24 hours" with auto-refresh
 * running would otherwise keep re-requesting the window that was current when the preset was
 * chosen, and drift a full day behind over a shift.
 */
export function timeWindow(preset, customStart, customEnd) {
  const iso = (value, endOfDay) => {
    if (!value) return ''
    // Parsed as LOCAL midnight, not UTC: the operator picking a date means their own day.
    const d = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`)
    return Number.isNaN(d.getTime()) ? '' : d.toISOString()
  }

  if (preset === 'custom') return { since: iso(customStart, false), until: iso(customEnd, true) }

  const ms = TIME_PRESETS.find(p => p.value === preset)?.ms
  return { since: ms ? new Date(Date.now() - ms).toISOString() : '', until: '' }
}

/**
 * How many lanes are drawn before the rest are folded behind a toggle.
 *
 * 30, NOT 15. At fifteen the toggle appeared on a seeded demonstrator -- sixteen assets, so the
 * page folded away a single lane and asked for a click to see it. A control that hides one row is
 * pure cost: the reader pays the click and the uncertainty of not knowing what was withheld, and
 * saves 33 pixels on a page that scrolls anyway.
 *
 * The cap exists for a genuinely large estate, where a few hundred lanes would make the initial
 * render the slowest thing on the page. Thirty is roughly a screen of lanes at 33px, so the fold
 * now happens when there is actually something to fold.
 */
const DEFAULT_LANE_LIMIT = 30

/*
 * MARKERS THAT WOULD SIT ON TOP OF EACH OTHER ARE FANNED VERTICALLY.
 *
 * WHY NOT NUDGE THEM ALONG THE TIME AXIS, which is the obvious fix. Two reasons, and the second is
 * worse than the distortion the first describes:
 *
 *   1. It would be ZOOM-DEPENDENT. Over an all-time range of ten hours an 8px nudge reads as about
 *      twelve minutes of separation; over a one-hour range the same nudge reads as one minute. The
 *      same pair of events would appear to be different distances apart depending on a control that
 *      has nothing to do with them.
 *   2. It would ERASE THE CAUSATION SIGNAL. Rows written in one transaction share a timestamp
 *      exactly -- `recorded_at` is transaction start time, which is why causationSiblings() orders
 *      by event_id rather than by time. Perfect overlap is the visual signature of one act, and
 *      nudging turns the clearest case of "these happened together" into "these happened near
 *      each other".
 *
 * THE VERTICAL AXIS INSIDE A LANE ENCODES NOTHING. Every marker is otherwise pinned to the lane's
 * centre line, so displacing along it costs no information and distorts no claim: x stays exactly
 * where the timestamp puts it. The dilemma only exists if the displacement has to be sideways.
 */
// EIGHT, NOT NINE, AND THE PIXEL MATTERS. A fan of three spans (2 x step) + 15px for the marker
// and its ring; at 9px that is 33px in a 32px track, so the outer two clip at the lane boundary.
// Caught by the span assertion in digitalThreadDodge.test.js rather than by looking at it.
export const DODGE_STEP_PX = 8
/**
 * Three, because that is what fits. The track is 32px and a marker is 13px plus a 2px ring, so a
 * fan of three spans 31px -- any more would clip at the lane boundary. A cluster larger than this
 * cycles back through the slots and overlaps again; the drawer's entity trail is the path that
 * enumerates a dense burst properly, and it is already ordered.
 */
export const DODGE_SLOTS = 3

/**
 * @param {Array}    events      one lane's events
 * @param {Function} xOf         event -> 0..1 along the track
 * @param {number}   trackWidth  measured px; 0 disables dodging entirely
 * @param {number}   markerPx    how close in px counts as a collision
 * @returns {Map} event_id -> vertical offset in px from the lane's centre line
 */
export function dodgeOffsets(events, xOf, trackWidth, markerPx = 15) {
  const offsets = new Map()
  // NO MEASUREMENT, NO DODGE. Guessing a width would move markers by an amount unrelated to
  // whether they actually collide, and not dodging is the status quo rather than a new fault.
  if (!trackWidth) {
    for (const e of events) offsets.set(e.event_id, 0)
    return offsets
  }

  let cluster = []
  let lastX = null
  const flush = () => {
    // Centred on the lane rule rather than growing downwards, so a fan reads as one group sitting
    // on the line instead of as markers that have slipped off it.
    const span = Math.min(cluster.length, DODGE_SLOTS)
    cluster.forEach((e, i) => {
      offsets.set(e.event_id, ((i % DODGE_SLOTS) - (span - 1) / 2) * DODGE_STEP_PX)
    })
    cluster = []
  }

  // CHAINED, not measured from the first of the cluster: a run of events each 10px from the last
  // is one continuous pile, and testing against the cluster's start would break it into groups
  // that still overlap at their seams.
  for (const e of [...events].sort((a, b) => xOf(a) - xOf(b))) {
    const x = xOf(e) * trackWidth
    if (lastX !== null && x - lastX < markerPx) cluster.push(e)
    else { flush(); cluster = [e] }
    lastX = x
  }
  flush()
  return offsets
}

/** The sections, in the order a plant is organised: a cell holds gateways, which hold devices. */
const SECTIONS = [
  { kind: 'CELL',    label: 'Cells',    Icon: IconBuilding2 },
  { kind: 'GATEWAY', label: 'Gateways', Icon: IconRadio },
  { kind: 'DEVICE',  label: 'Devices',  Icon: IconCpu }
]
const SECTION_ICON = Object.fromEntries(SECTIONS.map(s => [s.kind, s.Icon]))

/** A UUID shortened to something a person can compare at a glance, when there is no name. */
export const shortId = (id) => {
  const s = String(id || '')
  return s.length > 13 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s
}

/**
 * The identity an audit row carries in its own payload, for an entity no longer in the database.
 *
 * TWO FALLS, AND THE SECOND IS THE ONE THAT SURVIVES A RENAME. `name` is what an operator
 * remembers, so it comes first -- but it is mutable, and a device that was renamed shortly before
 * being purged leaves snapshots under a name nobody recognises. `sparkplug_id` is the immutable
 * wire identity: it is what the historian keyed its telemetry by, what the gateway was configured
 * with, and what appears in every Grafana panel and alert about the asset. When the two disagree
 * it is the one that can still be matched against something outside this table.
 *
 * `old_data` is preferred over `new_data` for neither -- both are checked, newest first -- because
 * an INSERT has only `new_data` and a DELETE only `old_data`, and a purged entity's final row is
 * the DELETE.
 *
 * Cells carry no `sparkplug_id`, so for those this falls through to null and the caller shortens
 * the uuid. That is correct rather than a gap: a cell has no second identity to recover.
 */
export function snapshotIdentity(event) {
  const name = event?.new_data?.name || event?.old_data?.name
  if (name) return { label: String(name), field: 'name' }

  const wireId = event?.new_data?.sparkplug_id || event?.old_data?.sparkplug_id
  if (wireId) return { label: String(wireId), field: 'sparkplug_id' }

  return null
}

/**
 * The name to put on a lane, in three falls.
 *
 * The audit row stores only `entity_id`; names live on the entity and carry no identity of their
 * own, so the first fall is a client-side join. The SECOND is what makes a deleted entity legible
 * at all: its row is gone from `/api/v1/cells`, so the join can never resolve it -- but the audit
 * snapshot it left behind holds the identity it had when it died. A truncated id is the last
 * resort rather than the usual case it was.
 *
 * THE JOIN CAN FAIL FOR TWO DIFFERENT REASONS and this deliberately does not distinguish them: the
 * entity was hard-purged from the Archives tab, or it is merely absent from the page the caller
 * fetched. Both want the snapshot, and guessing which one it was would put a claim on screen that
 * the data does not support.
 */
export function resolveLaneName(entityId, laneEvents, entityNames) {
  const joined = entityNames.get(entityId)
  if (joined) return { name: joined, fromSnapshot: false }

  for (const e of laneEvents) {
    const snapshot = snapshotIdentity(e)
    if (snapshot) {
      return { name: snapshot.label, fromSnapshot: true, identityField: snapshot.field }
    }
  }
  return { name: null, fromSnapshot: false }
}

/**
 * The axis label format, chosen from the span it has to distinguish.
 *
 * ONE RULE DECIDES IT: two adjacent ticks must never print the same string. Five ticks across ten
 * minutes all read `14:03` without seconds; five across six months all read `Aug 2026` with only
 * a month. Either way the axis stops being an axis and becomes decoration, so each band is the
 * coarsest format that still separates its own ticks.
 */
export function tickFormatter(spanMs) {
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR

  // Under ten minutes the minute is constant across several ticks; seconds are the only thing
  // telling them apart.
  if (spanMs < 10 * MIN) {
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
  /* Past thirty days, `MMM YYYY` is the tempting label and it is the one that breaks: five ticks
     across a 31-day span sit about eight days apart and would all read `Aug 2026`, which is the
     same repeated-header failure the ten-minute band exists to avoid. An ISO date never repeats
     at any span this rule covers, and is built from local parts rather than toISOString() --
     which would report the previous day for anyone west of UTC. */
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
 * The other audit rows written by the same transaction as `event`.
 *
 * WHY THIS IS A DIFFERENT AXIS FROM THE PREVIOUS/NEXT BUTTONS, and why it needed its own control
 * rather than folding into them. Those step through ONE ASSET over time -- they never leave the
 * lane. A transaction goes the other way: one operator action crosses assets, and the rows it
 * produced are related to each other by cause, not by subject. Approving a quarantined device
 * updates the device and rebinds its schema; the schema-version rebinding at 0001:779 touches
 * every device on the superseded version in one statement. Read one row at a time, those look like
 * unrelated edits that happen to share a second.
 *
 * ORDERED BY `event_id` ASCENDING -- the order the rows were WRITTEN, which inside one transaction
 * is the order the act performed them. Not by timestamp: `recorded_at` is `NOW()`, which is the
 * TRANSACTION start time in PostgreSQL and is therefore identical across every row here. Sorting
 * by it would produce an arbitrary order that looked meaningful.
 *
 * DRAWN FROM THE FETCHED, FILTERED SET, exactly as `selectedLaneEvents` is, and the consequence is
 * stated on the control itself rather than left to be discovered: a sibling excluded by the current
 * filter or time window is not counted. The alternative -- refetching by causation_id -- would let
 * the drawer step to an event the timeline behind it is not drawing, which is the same trap that
 * paragraph warns about.
 */
export function causationSiblings(event, events) {
  // NULL is not a group. Every row written before migration 0026 carries no causation, and there
  // is no honest backfill for a transaction that is long over -- so a NULL must never match
  // another NULL, which would collect the entire pre-0026 history into one imaginary act.
  if (!event?.causation_id) return []

  return events
    .filter(e => e.causation_id === event.causation_id
              && String(e.event_id) !== String(event.event_id))
    .slice()
    .sort((a, b) => Number(a.event_id) - Number(b.event_id))
}

/**
 * "This change was part of a larger act -- here is the rest of it."
 *
 * RENDERED ONLY WHEN THERE ARE SIBLINGS, and the silence is deliberate. Most operator edits touch
 * exactly one row, so a permanent "0 related changes" line would occupy space on almost every event
 * to say nothing -- and, worse, it would be a CLAIM. Because the set is filtered (see above), the
 * page cannot actually tell "this was a single-row act" from "the others are outside your filter",
 * and a control that asserted the first would be wrong some of the time with no way to notice.
 * Absence asserts nothing.
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
          // Same three falls as the lane label: the live join, then the audit snapshot, then a
          // shortened id. A sibling can perfectly well be an entity that has since been purged --
          // a cell deletion cascading to its gateways is exactly this shape.
          const name = entityNames.get(s.entity_id) || snapshotIdentity(s)?.label
          return (
            <li key={s.event_id}>
              <button
                type="button"
                className="dt-causation-item"
                onClick={() => onSelect(s.event_id)}
                title={`Open this change to ${name || s.entity_id}`}
                /* EXPLICIT, because the computed name would be the three spans read in order --
                   "DEVICE Press_02 UPDATE" -- which names the row without saying that activating
                   it does anything. Same reason the timeline markers carry one. */
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
 * The property diff, rendered INSIDE the Digital Thread page rather than inside ContextPanel.
 *
 * ContextPanel is presentational by contract -- it renders `fields` and `actions` and knows
 * nothing about cells, gateways, devices or audit payloads (see its header). Teaching it to read
 * `old_data` would make it a fifth thing with exactly one caller, so the panel receives this
 * finished node through its `beforeActions` slot instead: a FACT about the selected event, shown
 * with the metadata it belongs to.
 */
function EventDiff({ event, diff }) {
  const action = String(event.event_type || event.action || '').toUpperCase()
  // SCHEMA_REJECTION joins the one-sided set because it records an OBSERVATION, not a mutation:
  // `old_data` is NULL by construction (migration 0026), and rendering a "Previous" column that
  // can never hold anything invites the reader to look for a prior state that does not exist.
  const oneSided = action === 'INSERT' || action === 'DELETE' || action === 'SCHEMA_REJECTION'

  return (
    <div className="dt-diff">
      <div className="context-panel-section-label">
        {action === 'INSERT' ? 'Initial properties'
          : action === 'DELETE' ? 'Final properties'
            : action === 'SCHEMA_REJECTION' ? 'Rejected payload'
              : 'Changed properties'}
      </div>

      {diff.length === 0 ? (
        /* Reachable in two ways, and they are different: an UPDATE whose only changed column was
           on the noise denylist, or a row whose snapshots were never recorded. Neither is an
           error, and neither should look like a rendering failure. */
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
 * The unabridged snapshots, collapsed.
 *
 * The diff above is the answer to "what changed"; this is the answer to "prove it". Auditing a
 * disputed change means reading the row as it was actually stored, denylist and all -- so it has
 * to be here, and it has to be shut by default or it is the JSON dump this page was rebuilt to
 * stop being.
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
 * `initialEntity` is a handover from another page's "Digital Thread" action: `{ id, type }`.
 *
 * It is applied to the ordinary filters rather than held as a separate mode, so the page an
 * operator lands on is the page they already know -- every control still works, Clear Filters
 * really does clear, and the export covers what is on screen. The id goes into the name filter
 * because that filter already matches on id as well as name (see namedEntityIds), which makes the
 * handover exact: two devices may share a name, but the id is the row.
 */
export function DigitalThreadTab({ initialEntity, onClearEntity, showToast }) {
  // RAW, straight from the API. `events` below is the DISPLAYED set, derived from this one.
  // Every consumer on this page -- the lanes, the domain, the drawer, the causation siblings, the
  // CSV -- reads `events`, so deriving it is what keeps the purged filter from applying to some of
  // them and not others. A filter applied at each call site would have eight chances to be missed.
  const [allEvents, setAllEvents]     = useState([])
  // Whether to INCLUDE events whose asset is no longer in the database (issue #44).
  //
  // HIDDEN IS THE DEFAULT, and the control is phrased as "Show" rather than "Hide" so that the
  // default state renders unlit -- matching `Has quarantined devices` on Gateways and `Empty` on
  // Cells, both of which are off at rest and light up when engaged. A bar that loaded with a
  // primary-coloured button already pressed would read as a filter someone had left on.
  const [showPurged, setShowPurged]   = useState(false)
  // Set once the three asset lookups have landed. Until then EVERY entity_id looks absent, so the
  // purged test would classify the whole page as deleted. It also stays false if the lookups fail,
  // which is the fail-safe direction: unable to tell purged from live means hide nothing.
  const [lookupsLoaded, setLookupsLoaded] = useState(false)
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
  const [selectedEventId, setSelectedEventId] = useState(null)
  const [showAllLanes, setShowAllLanes] = useState(false)

  useEffect(() => {
    // Cells and gateways join devices here so the audit log can be searched by the NAME an
    // operator knows an asset by. The log itself stores only entity_id -- names live on the
    // entity, and deliberately carry no identity of their own (they are editable), so resolving
    // one is a client-side join rather than something the audit row could have recorded.
    Promise.all([
      api.get('/api/v1/devices'),
      api.get('/api/v1/gateways'),
      api.get('/api/v1/cells')
    ])
      .then(([d, g, c]) => { setDevices(d); setGateways(g); setCells(c); setLookupsLoaded(true) })
      .catch(() => {})
  }, [])

  /** entity_id -> display name, across all three audited tables. */
  const entityNames = useMemo(() => {
    const m = new Map()
    for (const c of cells)    m.set(c.cell_id, c.cell_name)
    for (const g of gateways) m.set(g.gateway_id, g.gateway_name)
    for (const d of devices)  m.set(d.asset_id, d.asset_name)
    return m
  }, [cells, gateways, devices])

  /**
   * Events whose asset has been PURGED -- the row is in the audit log, the asset is not in any of
   * the three live tables (issue #44).
   *
   * ABSENCE FROM THE LOOKUP IS THE TEST, and it is exact rather than a heuristic: the three list
   * endpoints do NOT filter `is_archived`, so an archived asset is still present here. Absent
   * therefore means genuinely gone, not merely retired -- which matters, because archiving is
   * reversible and the audit page must not imply otherwise.
   *
   * A DELETE event in the loaded page would have been the obvious alternative test and is worse:
   * the query is capped at 200 rows inside a time window, so an asset purged before the window
   * would read as live.
   */
  const purgedAssetCount = useMemo(() => {
    if (!lookupsLoaded) return 0
    // DISTINCT ASSETS, not events. Counting rows answered a question nobody asked -- the button
    // read "(54)" beside a page whose own header said 16 assets, so the number could only be
    // parsed as a count of something else entirely. What the control acts on is assets.
    const seen = new Set()
    for (const e of allEvents) if (!entityNames.has(e.entity_id)) seen.add(e.entity_id)
    return seen.size
  }, [allEvents, entityNames, lookupsLoaded])

  /**
   * What the page actually renders.
   *
   * PURGED ASSETS ARE HIDDEN BY DEFAULT. The records are never removed -- `digital_thread` is
   * append-only and 0026 revoked DELETE even from `service_role` -- so this is a question about
   * the resting view rather than about retention, and the resting view should be the live plant.
   * A deleted Test gateway is noise on every visit; the button restores it in one click and
   * carries a count, so nothing is hidden without saying so.
   */
  const events = useMemo(() => {
    if (showPurged || !lookupsLoaded) return allEvents
    return allEvents.filter(e => entityNames.has(e.entity_id))
  }, [allEvents, entityNames, showPurged, lookupsLoaded])

  /**
   * A name search resolves to the ids that match it, rather than filtering the fetched page.
   *
   * The row limit is applied by the database, so filtering after the fact would page through 200
   * mixed rows and then show whichever fraction happened to match -- the same reason the action
   * filter and the time range are SQL predicates. Resolving to ids first keeps the limit
   * meaningful.
   */
  const namedEntityIds = useMemo(() => {
    const q = nameFilter.trim().toLowerCase()
    if (!q) return null
    return [...entityNames.entries()]
      .filter(([id, name]) =>
        String(name || '').toLowerCase().includes(q) || String(id).toLowerCase().includes(q))
      .map(([id]) => id)
  }, [nameFilter, entityNames])

  const load = useCallback((isInitial = false) => {
    if (isInitial) setLoading(true)
    let url = '/api/v1/digital-thread?limit=200'
    if (entityTypeFilter) url += `&entity_type=${encodeURIComponent(entityTypeFilter)}`
    if (actionFilter)     url += `&action=${encodeURIComponent(actionFilter)}`
    if (namedEntityIds)   url += `&entity_ids=${encodeURIComponent(namedEntityIds.join(','))}`
    // Evaluated here, not held in state: see timeWindow's note on a rolling window going stale
    // under auto-refresh.
    const { since, until } = timeWindow(rangePreset, customStart, customEnd)
    if (since) url += `&since=${encodeURIComponent(since)}`
    if (until) url += `&until=${encodeURIComponent(until)}`
    api.get(url)
      .then(d => { setAllEvents(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [entityTypeFilter, actionFilter, namedEntityIds, rangePreset, customStart, customEnd])

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
    // SHOWING the purged assets is the deviation, because hiding them is the default. Clear
    // filters therefore returns them to hidden, which is the same contract every other control in
    // this bar has: clearing restores the resting view.
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
   * A fixed 60-second poll, replacing the auto-refresh control (issue #42).
   *
   * `load(false)`, NOT `load(true)`. The flag raises the loading state, which swaps the timeline
   * for a spinner -- acceptable on first paint, and a flicker every minute otherwise. This is the
   * same distinction the removed control needed a wrapper for: it wired onRefresh straight to
   * onClick, so passing `load` directly handed the click event in as `isInitial` and blanked the
   * timeline on every press.
   *
   * SAFE WITH THE DRAWER OPEN. `selected` is resolved from `events` by id on every render rather
   * than held, so a refresh that returns the same event leaves the drawer exactly as it was, and
   * one that no longer contains it closes it -- which is the correct outcome either way.
   *
   * The interval is rebuilt whenever `load` changes identity, i.e. whenever a filter changes. That
   * is deliberate: the timer should measure from the most recent fetch, not keep firing on a
   * schedule set by a query that is no longer running.
   */
  useEffect(() => {
    const timer = setInterval(() => load(false), 60_000)
    return () => clearInterval(timer)
  }, [load])

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
   * One lane per audited entity, busiest first.
   *
   * Busiest rather than most recent: a lane is worth its row of vertical space in proportion to
   * how much it has to say, and the top of the list is where the eye starts. Ties break on the
   * label so the order is stable between refreshes -- lanes that reshuffle under the cursor are
   * the reason the old flat list was easier to read than an unstable timeline would be.
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
      .map(lane => ({ ...lane, ...resolveLaneName(lane.entityId, lane.events, entityNames) }))
      .sort((a, b) =>
        b.events.length - a.events.length ||
        String(a.name || a.entityId).localeCompare(String(b.name || b.entityId)))
  }, [events, entityNames])

  const visibleLanes = showAllLanes ? lanes : lanes.slice(0, DEFAULT_LANE_LIMIT)
  const hiddenLaneCount = lanes.length - visibleLanes.length

  /**
   * The visible lanes, cut into Cells / Gateways / Devices.
   *
   * The CAP IS APPLIED FIRST and the sections are cut from what survives it, not the other way
   * round. Fifteen lanes per section would be forty-five rows on a page whose whole point is that
   * an asset's history is comparable against its neighbours' at a glance; and a per-section cap
   * would also spend rows on a quiet section while a busy one stayed folded. Ordering by activity
   * across the whole set and then grouping keeps the cap meaning what it says.
   *
   * A section with nothing in it is omitted rather than drawn empty -- "Cells (0)" is a heading
   * that promises a row and then does not deliver one.
   */
  const sections = useMemo(() =>
    SECTIONS
      .map(s => ({ ...s, lanes: visibleLanes.filter(l => l.kind === s.kind) }))
      .filter(s => s.lanes.length > 0),
  [visibleLanes])

  /**
   * The x-axis extent, taken from the events themselves rather than from the range control.
   *
   * The default range is unbounded, so there is frequently no requested window to scale to; and
   * even when there is, scaling to it would push a day of dense activity into the left-hand inch
   * of a thirty-day track. The events decide the domain; the filter decides the events.
   */
  const domain = useMemo(() => {
    const stamps = events
      .map(e => new Date(e.timestamp).getTime())
      .filter(Number.isFinite)
    if (stamps.length === 0) return null
    let min = Math.min(...stamps)
    let max = Math.max(...stamps)
    // A single event, or a burst that all landed in the same millisecond, has no extent to
    // divide by. Give it an hour of padding so the marker lands in the middle of the track
    // rather than producing a division by zero.
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

  // The track carries 14px of padding at each end so a marker at either extreme is not clipped
  // in half by the lane's edge; positions are therefore a calc against the padded width rather
  // than a bare percentage.
  const offsetFor = (timestamp) => `calc(14px + (100% - 28px) * ${fractionFor(timestamp)})`

  /*
   * The track's rendered width, needed to know which markers actually COLLIDE.
   *
   * MEASURED RATHER THAN ASSUMED, because the collision threshold is in pixels and the track is
   * `flex: 1` over a `min-width: 380px` -- so the same two timestamps overlap at one viewport
   * width and are comfortably apart at another. A hardcoded fraction would dodge markers that do
   * not overlap on a wide screen and miss ones that do on a narrow one.
   *
   * The axis track is measured because it always exists, and every track shares its width. In
   * jsdom `offsetWidth` is 0, which disables dodging -- the right default for an environment with
   * no layout, and what makes `dodgeOffsets` testable directly instead of through the DOM.
   */
  const axisTrackNode = useRef(null)
  const [trackWidth, setTrackWidth] = useState(0)

  /*
   * A CALLBACK REF, NOT A `useEffect` ON MOUNT, and the difference is the whole thing working.
   *
   * The timeline does not exist on first paint -- the page renders a spinner until the fetch lands,
   * so the axis track is absent -- and an effect with `[]` deps measures a null ref, records 0, and
   * NEVER RUNS AGAIN. The dodge would then be silently disabled forever, on a page that looked
   * exactly as it does now. A callback ref fires when the node actually attaches, which is the
   * moment there is something to measure.
   */
  const axisTrackRef = useCallback((node) => {
    axisTrackNode.current = node
    if (node) setTrackWidth(node.offsetWidth || 0)
  }, [])

  useEffect(() => {
    const measure = () => setTrackWidth(axisTrackNode.current?.offsetWidth || 0)
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const ticks = useMemo(() => {
    if (!domain) return []
    const format = tickFormatter(domain.span)
    return [0, 0.25, 0.5, 0.75, 1].map(f => {
      const at = new Date(domain.min + domain.span * f)
      // The full timestamp is always one hover away, whatever the axis had room to print.
      return { f, label: format(at), title: at.toLocaleString() }
    })
  }, [domain])

  // Resolved fresh every render rather than held as an object: a refresh replaces every event
  // object, and a stored one would leave the drawer showing a row that is no longer in the set.
  // If the selected event drops out of the filter, the drawer simply closes.
  const selected = events.find(e => String(e.event_id) === String(selectedEventId)) || null
  const selectedAnalysis = selected ? analysis.get(selected.event_id) : null

  /**
   * The selected entity's own events, OLDEST FIRST -- the order the drawer steps through.
   *
   * Ascending, against the descending order the list is fetched in, because this is the one place
   * on the page that reads as a story rather than as a feed: Previous goes back in time and Next
   * goes forward, which is the only mapping that survives someone thinking about it. The feed
   * order is right for "what just happened"; it is wrong for "and then what".
   *
   * Drawn from the FILTERED set, not refetched. Stepping through events the timeline is not
   * drawing would move the highlight to a marker that is not on screen -- the drawer and the
   * lane behind it have to be describing the same set.
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
   * The export rows, built explicitly rather than by handing the raw events to the CSV writer.
   *
   * The raw rows carry `old_data` and `new_data` as whole-row JSONB, which is both unreadable in
   * a spreadsheet and -- until the fix in downloadCSV -- exported as `[object Object]` on every
   * line. What an audit export is actually for is answering "who changed what, when", so the
   * diff this page already computes is flattened into a column that says exactly that.
   */
  const exportRows = () => events.map(e => {
    const a = analysis.get(e.event_id) || { diff: [], kind: 'operational' }
    return {
      recorded_at:    e.timestamp,
      entity_type:    entityKind(e.entity_type),
      // FALLS BACK THE SAME WAY THE LANE LABEL DOES. This was `entityNames.get(...) || ''`, so
      // every row about a purged entity exported with an EMPTY name column -- exactly the rows an
      // audit export exists to carry, since a live entity can be looked up afterwards and a
      // deleted one cannot. `entity_name_source` says which fall produced the value, because a
      // spreadsheet that silently mixes current names with historical ones is worse than one that
      // labels them.
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
        {/* Heading and description removed: the top bar names the page. The event count moved onto
            the export button, which is the one control whose behaviour depends on it -- it writes
            exactly these rows.

            Export and auto-refresh used to sit in a `.page-actions` row of their own ABOVE the
            filters, which is backwards: what the export writes is decided by the filters, so the
            button belongs at the end of the row that decides it, not on a separate row before it.
            Folding them in also removes a whole 34px band from the top of the page. */}
        <div className="filter-bar">
          <select
            className="form-control"
            style={{ width: '150px' }}
            value={entityTypeFilter}
            onChange={e => setEntityTypeFilter(e.target.value)}
            title="Show only events against one kind of asset"
          >
            <option value="">All entities</option>
            <option value="CELL">Cells</option>
            <option value="GATEWAY">Gateways</option>
            <option value="DEVICE">Devices</option>
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

          {/* ALL TIME IS THE DEFAULT -- see timeWindow. The window is a query parameter, not a
              client-side filter, so a narrower range does not spend the 200-row budget on rows
              outside it. */}
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

          {/* Shown only in the custom mode rather than sitting empty beside the presets. Two
              controls that do nothing until a fifth option is chosen are two controls whose
              relationship to the preset beside them has to be guessed at. */}
          {rangePreset === 'custom' && (
            <>
              <input
                type="date"
                className="form-control"
                style={{ width: '160px' }}
                value={customStart}
                onChange={e => setCustomStart(e.target.value)}
                title="Range start (from 00:00 local time on this date)"
                aria-label="Range start date"
              />
              <input
                type="date"
                className="form-control"
                style={{ width: '160px' }}
                value={customEnd}
                onChange={e => setCustomEnd(e.target.value)}
                title="Range end (through 23:59 local time on this date)"
                aria-label="Range end date"
              />
            </>
          )}

          {/* SHOWN ONLY WHEN IT WOULD DO SOMETHING, matching Clear filters beside it and the custom
              date inputs above. A permanent control reading "(0)" on the overwhelmingly common
              case -- nothing purged -- is a control whose relationship to the page has to be
              guessed at.

              SAME SHAPE AS `Has quarantined devices` (Gateways) AND `Empty` (Cells): a `btn-sm`
              that carries `btn-primary` when engaged and `btn-ghost` at rest, an icon, and a
              count. It was a bare checkbox, which was the only control of its kind in the app.

              The TOOLTIP says "no longer in the database" where the label says "deleted", because
              absence from the three lookups is all the test can actually see. Purged is the usual
              reason; an asset the caller's own policies hide would look identical. The label has
              to be short enough to read in a filter bar, so the precision lives in the tooltip. */}
          {purgedAssetCount > 0 && (
            <button
              className={`btn btn-sm ${showPurged ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setShowPurged(v => !v)}
              title="Include events for assets that are no longer in the database. The records are kept either way -- this only changes what is listed."
            >
              <IconTrash size={13} /> Show deleted assets ({purgedAssetCount})
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
            {/* AutoRefreshControl removed (issue #42). It was a Refresh button and an interval
                select defaulting to Off, so the page was static until someone noticed the control
                and chose a value -- and the same widget then offered 1s and 5s against an audit
                log that changes when an operator does something. A fixed 60s poll below does what
                the control was there to arrange, without asking. */}
            <button className="btn btn-ghost btn-sm" onClick={() => downloadCSV(exportRows(), 'digital-thread-export.csv')} title="Download audit events as CSV"><IconDownload size={13} /> Export CSV ({events.length})</button>
          </div>
        </div>

        <div className="card" style={{ padding: '16px' }}>
          {loading ? (
            <div className="loading-wrap"><div className="spinner" /> Loading digital thread trace sequence…</div>
          ) : events.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><IconHistory size={36} /></div>
              <div className="empty-text">
                {rangeIsFiltering
                  ? 'No digital thread events in this time range. Widen it, or switch back to All time.'
                  : 'No digital thread events match the filter criteria.'}
              </div>
            </div>
          ) : (
            <>
              {/* The key is a legend for a colour scale that is DERIVED rather than stored, so it
                  is doing more work than a legend usually does: without it there is nothing
                  anywhere -- no column, no filter option -- that says what amber means. */}
              <div className="dt-legend">
                {Object.entries(MARKERS).map(([kind, m]) => (
                  <span key={kind} className="dt-legend-item" title={m.hint}>
                    <span className={`dt-node-dot dt-node-${kind}`} aria-hidden="true" />
                    {m.label}
                  </span>
                ))}
              </div>

              <div className="dt-scroll">
                <div className="dt-swimlanes">
                  <div className="dt-lane dt-axis">
                    <div className="dt-lane-label dt-axis-corner">
                      {lanes.length} {lanes.length === 1 ? 'asset' : 'assets'} · {events.length} events
                    </div>
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
                      {/* The heading carries the count, and the count is what is DRAWN rather than
                          what exists: with the lane cap in play a heading reading "Devices (20)"
                          above thirteen rows would be stating a number the page is not showing.
                          The toggle below names the remainder. */}
                      <div className="dt-section" role="separator" aria-label={`${section.label} lanes`}>
                        <section.Icon size={13} />
                        <span className="dt-section-name">{section.label}</span>
                        <span className="dt-section-count">({section.lanes.length})</span>
                      </div>

                      {section.lanes.map(lane => (
                        <div className="dt-lane" key={lane.key}>
                          {/* NO TYPE BADGE. A pill reading DEVICE on every row of a section headed
                              Devices restates the one thing the heading directly above it has just
                              established -- and it cost 60px of a 210px label that the asset's NAME
                              is a better use of. The icon carries the kind for anyone scrolled past
                              the heading, at a fraction of the width.

                              THE ID IS NO LONGER COPYABLE HERE. It moved to the drawer's Entity ID
                              field, which is copyable and always present: an operator who wants the
                              UUID is one click from it, and a 36-character button on every lane left
                              no room for the name that made the lane recognisable. */}
                          <div
                            className="dt-lane-label"
                            title={lane.name ? `${lane.name} — ${lane.entityId}` : lane.entityId}
                          >
                            {React.createElement(SECTION_ICON[lane.kind] || IconCpu, {
                              size: 12, className: 'dt-lane-icon'
                            })}
                            {lane.name
                              ? <strong className="dt-lane-name">{lane.name}</strong>
                              /* Neither the join nor any snapshot could name it. The shortened id
                                 is the last resort, monospaced so the halves it keeps stay
                                 comparable between lanes. */
                              : <span className="dt-lane-name dt-lane-unnamed mono">{shortId(lane.entityId)}</span>}
                            {/* A name recovered from the audit payload rather than from a live row
                                means the entity is GONE. Saying so is the difference between "this
                                asset" and "this asset, as it was named when it was deleted". */}
                            {lane.fromSnapshot && (
                              <span className="dt-lane-gone" title="This entity no longer exists — the name is the one recorded in its final audit snapshot">
                                deleted
                              </span>
                            )}
                          </div>

                          <div className="dt-track">
                            {(() => {
                              /* Per lane, because a collision is only a collision within one row --
                                 two assets acting at the same instant are two markers on different
                                 lanes and were never in each other's way. */
                              const dodge = dodgeOffsets(
                                lane.events, (e) => fractionFor(e.timestamp), trackWidth
                              )
                              return lane.events.map(e => {
                              const kind = analysis.get(e.event_id)?.kind || 'operational'
                              const isSelected = String(e.event_id) === String(selectedEventId)
                              const dy = dodge.get(e.event_id) || 0
                              return (
                                <button
                                  key={e.event_id}
                                  type="button"
                                  className={`dt-node dt-node-${kind}${isSelected ? ' dt-node-selected' : ''}`}
                                  style={{
                                    left: offsetFor(e.timestamp),
                                    // `top` rather than a transform: .dt-node already carries
                                    // `translate(-50%, -50%)` to centre itself, and overriding that
                                    // to add the offset would undo the centring.
                                    ...(dy ? { top: `calc(50% + ${dy}px)` } : null)
                                  }}
                                  onClick={() => setSelectedEventId(e.event_id)}
                                  /* A plain `title`, which is what the rest of this app uses for a
                                     hover hint. Three lines -- what, who, when -- is what the hover
                                     is for; everything else is a click away in the drawer. */
                                  title={`${e.event_type} · ${MARKERS[kind].label}\n${actorLabel(e)}\n${new Date(e.timestamp).toLocaleString()}`}
                                  aria-label={`${e.event_type} on ${lane.name || lane.entityId} at ${new Date(e.timestamp).toLocaleString()}`}
                                  aria-pressed={isSelected}
                                />
                              )
                              })
                            })()}
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
              {showAllLanes && lanes.length > DEFAULT_LANE_LIMIT && (
                <button
                  className="btn btn-ghost btn-sm dt-lane-toggle"
                  onClick={() => setShowAllLanes(false)}
                  title={`Collapse back to the ${DEFAULT_LANE_LIMIT} busiest assets`}
                >
                  Show fewer lanes
                </button>
              )}
            </>
          )}
        </div>
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
          /* One flex ITEM, laid out internally as rows. `.context-panel-subtitle` is a wrapping
             flex row shared with three other pages, so multi-line content has to bring its own
             container rather than expect that one to stack it. */
          <div className="dt-drawer-nav">
            {/* WHERE THIS SITS IS THE POINT. A control that changes what the drawer is showing
                belongs above the thing it changes -- put below the fields it would be a footer
                you discover after reading the record you did not want. It is in the subtitle
                slot because that is the only slot ContextPanel offers above the metadata, and
                widening that shared component for one caller is the trade this avoids. */}
            <div className="dt-drawer-nav-pos" title="Position in this asset's history, oldest first">
              Event {selectedIndex + 1} of {selectedLaneEvents.length}
              {' · '}
              {entityNames.get(selected.entity_id)
                || snapshotIdentity(selected)?.label
                || shortId(selected.entity_id)}
            </div>

            <div className="dt-drawer-nav-btns">
              {/* Previous is OLDER. Disabled rather than hidden at the ends: a control that
                  disappears at the boundary makes the row reflow under the cursor, and the
                  second click of a double-step lands on whatever moved into its place. */}
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
          // Only when there is one. `changed_by` is NULL for every machine-originated write, and
          // an empty "Not set" row against a change the ingestion daemon made would read as a
          // gap rather than as the ordinary case it is.
          ...(selected.changed_by
            ? [{ label: 'User ID', value: selected.changed_by, copyable: true, mono: true, title: 'The signed-in user who made this change' }]
            : []),
          { label: 'Entity ID', value: selected.entity_id, copyable: true, mono: true, title: 'The asset this change was made to' },
          // The audit row's own id. It identifies THIS mutation rather than the asset it touched,
          // which is what you need to quote when two edits a second apart are being told apart.
          { label: 'Mutation ID', value: String(selected.event_id), copyable: true, mono: true, title: 'Audit row ID for this single change' },
          // Only when there is one, for the same reason `User ID` is conditional: every row written
          // before migration 0026 carries no causation, and there is no honest value to backfill
          // for a transaction that is long over. A "Not set" row against a year of history would
          // read as a gap in the record rather than as the boundary of a feature.
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
            {/* ABOVE THE DIFF, and that placement follows the rule the subtitle nav is written to:
                a control that changes what the drawer is showing belongs above the thing it
                changes. Below the diff it would be a footer you find after reading the record you
                did not want -- and the whole point of this control is that the row you are looking
                at may not be the one that explains what happened. */}
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
