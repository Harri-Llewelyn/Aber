import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '../../api'
import { downloadCSV } from '../../utils/downloadCSV'
import { ContextPanel } from '../common/ContextPanel'
import { IconHistory, IconDownload, IconX, IconBuilding2, IconRadio, IconCpu, IconTrash } from '../common/Icons'
import { DIGITAL_THREAD_ACTIONS } from '../../constants'
import { useSetting } from '../../hooks/useSettings'

/**
 * How a machine-originated change is described. `changed_by` names WHICH user and is NULL for
 * every write no person made; `actor_source` (archived migration 0005) names WHAT KIND of actor it was,
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
/*
 * `service_principals` IS NOT A TABLE, unlike the other three. Migrations 0043 and 0044 write it as
 * an entity_type for rows about `auth.users` identities -- auth is GoTrue's schema, there is no
 * public table of them, and `entity_id` carries no foreign key anywhere.
 *
 * IT IS LISTED HERE BECAUSE THE FALLBACK IS NOT GOOD ENOUGH. `entityKind` upper-cases whatever it
 * does not know, which would render this lane as SERVICE_PRINCIPALS -- and 0031's header states the
 * bar these rows have to clear: "a half-legible audit entry is worse than an absent one, because it
 * looks like the feature works."
 */
/*
 * `user_roles`, `system_settings` and `schemas` join it in 0070, which is when the audit trigger
 * first reached them. They are listed for the same reason: the fallback would render ROLE
 * ASSIGNMENT as USER_ROLES and a settings change as SYSTEM_SETTINGS, which clears no bar.
 *
 * `user_roles` reads as ACCESS rather than as the table's name. What the row records is that an
 * account gained or lost a role, and the join table it happens to live in is not the subject.
 */
const ENTITY_KIND = {
  cells: 'CELL',
  gateways: 'GATEWAY',
  devices: 'DEVICE',
  service_principals: 'SERVICE IDENTITY',
  user_roles: 'ACCESS',
  system_settings: 'SETTING',
  schemas: 'SCHEMA',
}
/**
 * The kinds the purge test can answer for -- the three that name a real table.
 *
 * Absence from `entityNames` means DELETED only for these. For anything else it means the lookup
 * never covered it, which is not the same fact and must not be rendered as though it were.
 */
export const ASSET_ENTITY_KINDS = new Set(['CELL', 'GATEWAY', 'DEVICE'])

export const entityKind = (t) =>
  ENTITY_KIND[String(t || '').toLowerCase()] || String(t || '').toUpperCase()

/**
 * Columns excluded from every diff.
 *
 * Machine churn, not history. archived migration 0005 already suppresses the two worst offenders at the
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
 * THE ONE EXCEPTION IS SCHEMA_REJECTION, written by `record_ingestion_rejection()` (archived migration 0026)
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

  // THE DATABASE'S JUDGEMENT FIRST, WHERE THERE IS ONE. `audit_domain` is stamped at insert time
  // by 0070 from one closed classifier, and it is the same question this function was answering
  // by hand -- "is this about who may do what". A security row is governance whatever its verb,
  // which is what stops a service principal's INSERT rendering green as a creation event.
  //
  // OPTIONAL, NOT REQUIRED. This function is also called on rows a test or an older page state
  // supplied without the column, and on the SCHEMA_REJECTION path below whose fixtures predate it.
  // An absent domain falls through to the derivation, which is what it always did.
  if (event.audit_domain === 'security') return 'governance'

  if (action === 'SCHEMA_REJECTION') return 'governance'
  // TOKEN_MINTED is governance for the same reason and a sharper one: it records that somebody was
  // granted a way to reach this stack. It is not `creation` -- no row was created, and the thing
  // that WAS created lives outside the database entirely -- and not `critical`, which is reserved
  // for lifecycle events. Who may do what is precisely what governance means.
  // TOKEN_REVOKED (0074) is the same kind of fact arriving from the other direction, and it is
  // named here rather than left to the `audit_domain === 'security'` line above for the reason
  // that line already gives: fixtures and older page states supply rows without the column, and a
  // credential withdrawal is not an event to classify by accident.
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
 * The range presets, and the window each one means. `ms` of null is an unbounded window.
 *
 * THE SHORT ONES ARE WHY THIS PAGE CAN NOW BE READ AT ALL AT COMMISSIONING RESOLUTION. The
 * causation work made `digital_thread` legible as ACTS rather than rows, and an act is exactly the
 * thing that happens inside one second -- so the page's most interesting content sat at a
 * resolution the range control could not reach. `24h` was the narrowest option and the custom
 * pickers were date-only, which meant the narrowest expressible window was a whole day.
 */
export const TIME_PRESETS = [
  { value: 'all', label: 'All time',       ms: null },
  { value: '15m', label: 'Last 15 minutes', ms: 15 * 60 * 1000 },
  { value: '1h',  label: 'Last 1 hour',     ms: 60 * 60 * 1000 },
  { value: '24h', label: 'Last 24 hours',   ms: 24 * 60 * 60 * 1000 },
  { value: '7d',  label: 'Last 7 days',     ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: 'Last 30 days',    ms: 30 * 24 * 60 * 60 * 1000 }
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
  /**
   * A custom bound as an ISO instant.
   *
   * TWO SHAPES, BECAUSE THE INPUT CHANGED UNDER IT. `datetime-local` yields `YYYY-MM-DDTHH:mm`,
   * which names an instant; the `date` input it replaces yielded `YYYY-MM-DD`, which names a DAY
   * and has to be widened to one of its ends. Both are still handled -- a value persisted from the
   * older control, or typed by hand, must not silently produce an invalid date.
   *
   * PARSED AS LOCAL, NOT UTC, in both shapes. An operator choosing 16:11 means 16:11 where they
   * are standing. `new Date('2026-08-22T16:11')` is local by specification; appending a `Z` -- or
   * building the string with toISOString() -- would shift the window by the timezone offset and
   * quietly return the wrong hour's events.
   */
  const iso = (value, endOfRange) => {
    if (!value) return ''
    const hasTime = String(value).includes('T')
    const d = hasTime
      ? new Date(value)
      : new Date(`${value}T${endOfRange ? '23:59:59.999' : '00:00:00.000'}`)
    if (Number.isNaN(d.getTime())) return ''
    // `datetime-local` has minute granularity, so an end bound of 16:11 would exclude everything
    // that happened during 16:11. Widened to the end of that minute -- the same widening the
    // date-only path does to the end of the day, one unit down.
    if (hasTime && endOfRange) d.setSeconds(59, 999)
    return d.toISOString()
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

/**
 * The poll interval, in seconds, when no setting overrides it.
 *
 * Named rather than inlined at the setInterval below, because it is now the FALLBACK half of a
 * declared setting (`ui.digital_thread_poll_seconds`, archived migration 0031) and the two have to be
 * findable from each other. The migration names this constant in its `fallback_source`.
 */
const DEFAULT_POLL_SECONDS = 60

/*
 * MARKERS TOO CLOSE TO DRAW SEPARATELY BECOME ONE BADGE THAT SAYS HOW MANY THERE ARE.
 *
 * WHAT THIS REPLACED, and why the replacement is better rather than merely different. The first
 * answer to the reported overlap was a VERTICAL FAN -- colliding markers displaced up and down off
 * the lane's centre line. It fixed the reported case (a Created and an Operational two seconds
 * apart) and then failed at exactly the point where this page is most interesting:
 *
 *   * IT HELD THREE. The track is 32px and a marker is 15px with its ring, so the fan had three
 *     slots; a fourth event cycled back into the first and overlapped anyway. A commissioning burst
 *     is routinely five or six rows, so the densest moments on the page were the ones it could not
 *     draw -- and it gave no sign of that, which is the same fault as the original overlap.
 *   * IT COULD NOT BE COUNTED. Three fanned dots and five fanned dots look alike. The reader's
 *     actual question is "how much happened here", and a fan answers "some".
 *
 * A badge answers it: `6` is a claim the page can honour at any density, and the hover breaks it
 * down by classification.
 *
 * WHY NOT NUDGE ALONG THE TIME AXIS, which is the other obvious fix and stays ruled out:
 *
 *   1. It would be ZOOM-DEPENDENT. Over an all-time range of ten hours an 8px nudge reads as about
 *      twelve minutes of separation; over a one-hour range the same nudge reads as one minute. The
 *      same pair of events would appear to be different distances apart depending on a control that
 *      has nothing to do with them.
 *   2. It would ERASE THE CAUSATION SIGNAL. Rows written in one transaction share a timestamp
 *      exactly -- `recorded_at` is transaction start time, which is why causationSiblings() orders
 *      by event_id rather than by time. Perfect overlap is the visual signature of one act.
 *
 * CLUSTERING KEEPS BOTH PROPERTIES. Every badge sits where its events' timestamps put it, so x
 * still tells the truth; and a transaction that wrote six rows becomes one badge reading `6` whose
 * hover SAYS they were one act -- stating the causation signal outright instead of leaving it to be
 * inferred from a pile of dots that happen to be exactly on top of each other.
 */

/**
 * How close, in pixels, is too close to draw separately.
 *
 * A marker is 13px plus a 2px ring, so at 14px apart two of them still touch. Below that the reader
 * cannot tell how many dots are there, which is the whole complaint.
 *
 * PIXELS, NOT TIME, AND THAT IS THE ENTIRE RULE. A time-based threshold -- "group anything inside a
 * minute" -- is wrong in both directions: it would hold a burst grouped on a 15-minute range where
 * its events are 200px apart and plainly separate, and it would leave two events a quarter of an
 * hour apart overlapping on an all-time range spanning a month. "Do these overlap" is a question
 * about pixels. Which is also what makes the range control a ZOOM: narrow the range and clusters
 * dissolve into their members, because the same events are now further apart on screen.
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
  // CHRONOLOGICAL, and the tiebreak is the interesting half. `xOf` is monotone in the timestamp, so
  // ordering by it is ordering by time -- except for events sharing a timestamp exactly, which is
  // precisely the transaction case. Those fall back to `event_id`, the order the rows were WRITTEN,
  // for the same reason causationSiblings() does: inside one act that is the order it performed
  // them, and it is therefore the row a click on the badge should open first.
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

  // NO MEASUREMENT, NO CLUSTERING. Guessing a width would fold together markers that do not touch,
  // and drawing them all singly is the status quo rather than a new fault. This is also the jsdom
  // path -- `offsetWidth` is 0 with no layout engine -- which is what makes this function testable
  // directly rather than only through the DOM.
  if (!trackWidth) return ordered.map(e => item([e]))

  const groups = []
  let current = []
  let lastX = null

  // CHAINED, not measured from the first of the group: a run of events each 10px from the last is
  // one continuous pile, and testing against the group's start would split it into badges that
  // still overlap at their seams.
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
 * What a cluster badge says on hover.
 *
 * THE BREAKDOWN IS BY CLASSIFICATION, in `MARKERS` order so it reads in the same order as the
 * legend above the timeline, and in the legend's own words rather than a second set of names for
 * the same four things.
 *
 * THE SECOND LINE IS THE ONE THAT EARNS ITS PLACE. Collapsing events into a count loses exactly the
 * thing a pile of dots used to show by accident: whether these happened TOGETHER or merely near
 * each other. A shared non-null `causation_id` across every member says one act wrote them;
 * identical timestamps without one say only that they landed in the same instant. Those are
 * different claims and this does not conflate them.
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

  // UNDER AN HOUR, SECONDS ARE SHOWN. Widened from ten minutes when the 15-minute and 1-hour
  // presets arrived: within a commissioning burst the minute is constant across several ticks and
  // the seconds are the only thing telling them apart. Above an hour they are always `:00` on a
  // round tick and are noise on a label that is already unambiguous.
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
  // NULL is not a group. Every row written before archived migration 0026 carries no causation, and there
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
  // `old_data` is NULL by construction (archived migration 0026), and rendering a "Previous" column that
  // can never hold anything invites the reader to look for a prior state that does not exist.
  // TOKEN_MINTED joins them for the same reason: `old_data` is NULL by construction (0043), because
  // signing a token does not change a prior state -- there was no token, and now there is one more.
  const oneSided = action === 'INSERT' || action === 'DELETE' || action === 'SCHEMA_REJECTION'
    || action === 'TOKEN_MINTED'

  return (
    <div className="dt-diff">
      <div className="context-panel-section-label">
        {action === 'INSERT' ? 'Initial properties'
          : action === 'DELETE' ? 'Final properties'
            : action === 'SCHEMA_REJECTION' ? 'Rejected payload'
              : action === 'TOKEN_MINTED' ? 'Token issued'
                // TWO-SIDED, UNLIKE TOKEN_MINTED, and that is not an oversight. 0074 carries the
                // original mint in `old_data` precisely so the row stays readable after the
                // denylist entry is pruned -- which happens the moment the token expires. So there
                // IS a prior state here, and it is the thing being withdrawn.
                : action === 'TOKEN_REVOKED' ? 'Token withdrawn'
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

  /*
   * RUNTIME OVERRIDES (archived migration 0031), each falling back to the constant above.
   *
   * The constants are not dead: they are what applies on a stack whose administrator has never
   * touched Settings, which is every fresh install and every local boot. That is the whole point
   * of the fallback contract -- a setting that has never been changed behaves exactly as the page
   * behaved before settings existed.
   */
  const laneLimit = useSetting('ui.digital_thread_lane_limit', DEFAULT_LANE_LIMIT)
  const pollSeconds = useSetting('ui.digital_thread_poll_seconds', DEFAULT_POLL_SECONDS)

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
  // FROM THE SERVER, AND COUNTED OVER EVERYTHING THE FILTERS SELECT rather than over the page.
  // Derived from the page it would fall to zero the moment the purge filter became a predicate --
  // and the control it gates would disappear exactly when it was needed, leaving no way back.
  // Null until a response says otherwise: `null` means "the server did not tell us", which is not
  // the same as "there are none" and must not render as zero.
  const [serverPurgedCount, setServerPurgedCount] = useState(null)
  // Whether the row limit bit. The page cannot tell otherwise, and "showing the newest 200" is the
  // difference between a quiet view and a quietly incomplete one -- which is how this was missed.
  const [truncated, setTruncated] = useState(false)

  /**
   * What the page actually renders.
   *
   * PURGED ASSETS ARE HIDDEN BY DEFAULT. The records are never removed -- `digital_thread` is
   * append-only and 0026 revoked DELETE even from `service_role` -- so this is a question about
   * the resting view rather than about retention, and the resting view should be the live plant.
   * A deleted Test gateway is noise on every visit; the button restores it in one click and
   * carries a count, so nothing is hidden without saying so.
   */
  /**
   * How many deleted assets the current filters cover.
   *
   * THE SERVER'S ANSWER WINS, because it is counted over everything the filters select rather than
   * over the page that fitted -- which is the whole reason the count moved (0039). The fallback
   * covers the case where the response carried no count at all: an older API, or a test fixture
   * that resolves a bare array and models neither deletion nor truncation. Deriving zero there
   * would unrender the control that reveals them, so "we were not told" falls back to "count what
   * is in front of us" rather than to "there are none".
   */
  const purgedAssetCount = useMemo(() => {
    if (serverPurgedCount !== null) return serverPurgedCount
    if (!lookupsLoaded) return 0
    // DISTINCT ASSETS, not events. Counting rows answered a question nobody asked -- the button
    // read "(54)" beside a page whose own header said 16 assets.
    const seen = new Set()
    for (const e of allEvents) if (!entityNames.has(e.entity_id)) seen.add(e.entity_id)
    return seen.size
  }, [serverPurgedCount, allEvents, entityNames, lookupsLoaded])

  /**
   * What the page actually renders.
   *
   * PURGED ASSETS ARE HIDDEN BY DEFAULT (issue #44) -- the records are never removed, so this is a
   * question about the resting view rather than about retention, and the resting view should be
   * the live plant.
   *
   * A NO-OP AGAINST A CURRENT SERVER, AND KEPT ANYWAY. `digital_thread_page()` (0039) applies the
   * same rule as a PREDICATE, before the row limit, which is what actually fixed the bug: this
   * filter was never wrong in itself, it was wrong as the ONLY one, because the 200-row budget was
   * spent on rows it then discarded -- four assets listed on a stack of twenty-six, and an empty
   * Gateways section on a fleet of four healthy gateways.
   *
   * It stays because it costs nothing when the server has already done it and it is the only thing
   * standing between an operator and a page full of deleted `Test` gateways if they ever talk to a
   * build without the RPC.
   */
  const events = useMemo(() => {
    if (showPurged || !lookupsLoaded) return allEvents
    // SCOPED TO THE ASSET TYPES, mirroring 0045's fix to the server-side predicate. "Purged" means
    // a row was deleted from cells, gateways or devices -- `entityNames` is built from exactly
    // those three -- so an entity type with no table behind it is absent for a reason that has
    // nothing to do with deletion. Applied universally, it hid every service-principal row.
    return allEvents.filter(e => ASSET_ENTITY_KINDS.has(entityKind(e.entity_type))
      ? entityNames.has(e.entity_id)
      : true)
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
    if (showPurged) url += '&include_purged=true'
    api.get(url)
      // `d` IS THE EVENT ARRAY, carrying the page-level counts as properties -- see api.js for why
      // the resource stayed the return value. A fixture that resolves a bare array reports no
      // deleted assets and no truncation, which is the honest answer for one that models neither.
      .then(d => {
        setAllEvents(Array.isArray(d) ? d : [])
        setServerPurgedCount(typeof d?.purgedAssets === 'number' ? d.purgedAssets : null)
        setTruncated(Boolean(d?.truncated))
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [entityTypeFilter, actionFilter, namedEntityIds, rangePreset, customStart, customEnd, showPurged])

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
    // Guarded: a setting of 0 or a negative would otherwise become an interval that fires as fast
    // as the event loop allows, which is a settings page turning into a denial of service against
    // the reader's own browser.
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

  const visibleLanes = showAllLanes ? lanes : lanes.slice(0, laneLimit)
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
  //
  // TAKES A FRACTION, not a timestamp, because a cluster badge does not have one: it sits at the
  // MEAN of its members' positions (see clusterEvents), which is not any single event's time.
  const offsetForFraction = (f) => `calc(14px + (100% - 28px) * ${f})`

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

  /**
   * lane.key -> the items its track draws: single markers and cluster badges, left to right.
   *
   * COMPUTED HERE RATHER THAN INSIDE THE LANE'S RENDER, where the fan used to be worked out. Two
   * consumers now need it and only one of them is a lane: the legend states how many badges are on
   * the timeline, and it cannot count something each row computes privately while drawing itself.
   *
   * PER LANE, because a collision is only a collision within one row -- two assets acting at the
   * same instant are two markers on different lanes and were never in each other's way.
   */
  const laneClusters = useMemo(() => {
    const m = new Map()
    for (const lane of visibleLanes) {
      m.set(lane.key, clusterEvents(lane.events, (e) => fractionFor(e.timestamp), trackWidth))
    }
    return m
  }, [visibleLanes, fractionFor, trackWidth])

  /**
   * How many badges are drawn, which is what the legend's "Grouped" entry counts.
   *
   * BADGES, NOT THE EVENTS INSIDE THEM. "Grouped (9)" beside three purple pills is a number the
   * reader cannot reconcile with what is on screen; "Grouped (3)" is the thing they can point at.
   * How many events any one badge holds is written on the badge itself.
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
        {/* THE HEADING IS BACK, AND THE REASON IS NOT THE ONE THAT REMOVED IT. It went on the
            grounds that "the top bar names the page", which is true and is still true. What it did
            not account for is that a card is a COMPOSITION -- title, description, actions, filters
            -- and a page whose card has none of the first three is a different shape from every
            page whose card does. The title is the redundant part and it is cheap; the DESCRIPTION
            is the part the top bar cannot carry, and this page needs one more than most, because
            what the digital thread does and does not record is not guessable from a list of rows.

            EXPORT IS AN ACTION, SO IT SITS WITH THE ACTIONS. It was kept in the filter bar on the
            grounds that what it writes is decided by the filters, so it belonged at the end of the
            row that decides it. That is an argument about proximity; the stronger one is about what
            the control IS -- it does not filter anything, and every other card keeps its actions in
            the header at title height. The COUNT stays the filtered count, which is the half of the
            proximity argument worth keeping: the button still says how many rows it will write. */}
        <div className="card">
          <div className="card-header">
            <h3 className="section-title">
              Digital Thread <span className="section-count">{events.length}</span>
            </h3>
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => downloadCSV(exportRows(), 'digital-thread-export.csv')}
              title="Download the events matching the current filters as CSV"
            >
              <IconDownload size={13} /> Export CSV ({events.length})
            </button>
          </div>

          <div className="card-body">
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: '0 0 12px' }}>
              Every attributed change to a cell, gateway or device, in the order it happened and
              with what caused it. Append-only and unprunable by any application role — which is
              what makes it evidence rather than a log. It records asset lifecycle, not privileged
              acts: a role grant leaves no row here.
            </p>

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
            {/* A FOURTH LANE, not an action on one of the three. 0043 and 0044 write rows about
                machine identities -- who may reach this stack -- and without an option here they
                were reachable only by clearing the filter entirely. */}
            <option value="SERVICE IDENTITY">Service identities</option>
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
              {/* `datetime-local`, NOT `date`. The narrowest window a date pair can express is a
                  whole day, which on a stack commissioned this morning makes All time and today
                  the same picture. Minute granularity is what lets an operator frame the burst
                  itself. `timeWindow()` widens the end bound to :59.999 so the closing minute is
                  included rather than cut in half. */}
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
          </div>
        </div>
          </div>{/* .card-body */}

        {/* The timeline is a second `.card-body` rather than the card's own inline padding, which
            is what it used to carry. Two bodies get a divider between them from one rule, so the
            controls and the trace read as separate registers of the same card. */}
        <div className="card-body">
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

                {/* SHOWN ONLY WHEN THERE IS NOTATION TO EXPLAIN, which follows the rule the purged
                    toggle and the custom date inputs already follow on this page. A key entry for
                    a mark that is not on screen is a reader looking for a purple pill that does
                    not exist -- and at a narrow enough range there are none, which is the feature
                    rather than an edge case.

                    THE SAMPLE IS A REAL `.dt-cluster`, exactly as the four dots above are real
                    `.dt-node-<kind>` fills: the key cannot drift away from what it describes. It
                    reads `n` rather than a specific number so it is plainly a placeholder for the
                    count each badge carries, not a claim that every group holds two. */}
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
                        {/* The icon, name and count are one BADGE now rather than three loose
                            items on a row, so a section reads as a heading over the track cards
                            below it rather than as another lane. The rule to its right is what
                            carries the eye across; it is drawn by CSS so it cannot be mistaken for
                            content. */}
                        <span className="dt-section-badge">
                          <section.Icon size={12} />
                          <span className="dt-section-name">{section.label}</span>
                          <span className="dt-section-count">{section.lanes.length}</span>
                        </span>
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
                            {(laneClusters.get(lane.key) || []).map(item => {
                              /* THE RING FOLLOWS THE DRAWER, and for a badge that means "the
                                 drawer is showing one of MY events" rather than "the drawer is
                                 showing the one I open on click". That is what keeps the highlight
                                 in place while Previous/Next steps through a burst: the badge is
                                 where those events are, so the badge is what stays lit. */
                              const isSelected = item.events
                                .some(e => String(e.event_id) === String(selectedEventId))

                              if (item.isCluster) {
                                return (
                                  <button
                                    key={`cluster-${item.event.event_id}`}
                                    type="button"
                                    className={`dt-cluster${isSelected ? ' dt-node-selected' : ''}`}
                                    style={{ left: offsetForFraction(item.xOffset) }}
                                    /* THE FIRST, i.e. the oldest -- see clusterEvents on why the
                                       tiebreak is event_id. Opening a burst at its start is the
                                       only choice that makes Next mean "and then what"; opening
                                       it in the middle would leave half the group behind the
                                       Previous button with nothing saying so. */
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
                                  /* A plain `title`, which is what the rest of this app uses for a
                                     hover hint. Three lines -- what, who, when -- is what the hover
                                     is for; everything else is a click away in the drawer. */
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
          // before archived migration 0026 carries no causation, and there is no honest value to backfill
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
