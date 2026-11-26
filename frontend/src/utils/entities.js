import { DERIVED_TAG_TITLE } from '../components/common/DerivedTag'
import { KNOWN_PRINCIPALS } from './serviceIdentities'
import { SCHEMA_STATUS } from './schemaVersion'
import { formatDate, formatDay, plural } from './format'
import { isSparkplugId } from './sparkplugId'
import { inferSemanticIdType } from './standards'

/**
 * What the Entities page lists: the rows of entity_directory (0321), and beside them the two it does not
 * hold. A row is `{ kind, id, name, description, state, variant, second_ids, area_id, cell_id, gateway_id,
 * device_id, page_id }`, as the view answers it.
 */

/** The kinds, by `audit_trail.entity_type`'s word for each, in the order the page lists them. */
export const ENTITY_KINDS = [
  { kind: 'areas', label: 'Area', plural: 'Areas' },
  { kind: 'cells', label: 'Cell', plural: 'Cells' },
  { kind: 'gateways', label: 'Gateway', plural: 'Gateways' },
  { kind: 'devices', label: 'Device', plural: 'Devices' },
  { kind: 'schemas', label: 'Schema', plural: 'Schemas' },
  { kind: 'metric_catalog', label: 'Metric', plural: 'Metrics' },
  { kind: 'automations', label: 'Automation', plural: 'Automations' },
  { kind: 'captures', label: 'Capture', plural: 'Captures' },
  { kind: 'backups', label: 'Backup', plural: 'Backups' },
  { kind: 'service_principals', label: 'Machine Identity', plural: 'Machine Identities' },
  { kind: 'user_roles', label: 'Person', plural: 'People' },
]
/** The kinds entity_directory lists: people are read apart. */
export const DIRECTORY_KINDS = ENTITY_KINDS.map(k => k.kind).filter(kind => kind !== 'user_roles')
const KIND_ORDER = new Map(ENTITY_KINDS.map((k, i) => [k.kind, i]))

/** A kind's one-record name, or its own word for a kind this build does not know. */
export const kindLabel = (kind) => ENTITY_KINDS[KIND_ORDER.get(kind)]?.label ?? String(kind ?? '')

/** A kind's name for several, as its group's heading has it, or its own word for a kind this build does not know. */
export const kindPlural = (kind) => ENTITY_KINDS[KIND_ORDER.get(kind)]?.plural ?? String(kind ?? '')

/** How many of a kind, in words: "81 gateways", "1 person". */
export const kindCount = (kind, n) => `${n} ${(n === 1 ? kindLabel(kind) : kindPlural(kind)).toLowerCase()}`

/** Where a kind comes in the page's order: last, for one this build does not know. */
export const kindRank = (kind) => KIND_ORDER.get(kind) ?? ENTITY_KINDS.length

/** Rows as `{ kind, rows }` groups, one for each kind they are of, in the page's order. A group keeps the order its rows came in. */
export function groupByKind(rows) {
  const byKind = new Map()
  for (const row of rows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, [])
    byKind.get(row.kind).push(row)
  }
  return [...byKind].map(([kind, of]) => ({ kind, rows: of })).sort((a, b) => kindRank(a.kind) - kindRank(b.kind))
}

/** How close the auto-purge may come before a row and a drawer warn of it. */
const PURGE_SOON_DAYS = 7

/** True when the purge is due within PURGE_SOON_DAYS, or already overdue. */
export function purgeIsSoon(at, now = Date.now()) {
  return new Date(at).getTime() - now <= PURGE_SOON_DAYS * 24 * 60 * 60 * 1000
}

/** Whether a playback holds an archived gateway whose timer runs: neither the purge nor Permanent Delete removes it. */
export const purgeIsHeld = (row) => Boolean(row?.auto_delete_at) && row.playbacks > 0

/** What an archived group's heading says of its timers: the soonest purge, and how many a playback holds. Null where none runs. */
export function nextPurge(rows) {
  const due = rows.filter(row => row.auto_delete_at && !purgeIsHeld(row)).map(row => new Date(row.auto_delete_at).getTime())
  const held = rows.filter(purgeIsHeld).length
  return [due.length > 0 && `next purge ${formatDay(Math.min(...due))}`, held > 0 && `${held} held by a playback`]
    .filter(Boolean).join(', ') || null
}

/** What a retired group's heading says: the day of the last deletion. */
export function lastDeleted(rows) {
  const at = Math.max(...rows.map(row => new Date(row.retired_at).getTime()).filter(Number.isFinite))
  return Number.isFinite(at) ? `last deleted ${formatDay(at)}` : null
}

/** One row's key among every row of the page. A deleted entity's id is not used again, and a test's may be. */
export const entityKey = (row) => `${row.state}:${row.kind}:${row.id}`

/** A row's state where it is not in service, as the Entities page's tabs name it, or null. */
export const inactiveState = (row) => ({ archived: 'Archived', retired: 'Retired' })[row?.state] ?? null

/** The badge for what sets a row apart within its kind, or null where its kind says it all. */
export function variantBadge(row) {
  switch (row?.variant) {
    case SCHEMA_STATUS.DRAFT: return { label: 'Draft', tone: 'warning', title: 'A version not yet published' }
    case SCHEMA_STATUS.ARCHIVED: return { label: 'Archived version', tone: 'neutral', title: 'A newer version replaced it. A device still on it has a migration to finish.' }
    case 'derived': return { label: 'Derived', tone: 'neutral', title: DERIVED_TAG_TITLE }
    case 'deprecated': return { label: 'Deprecated', tone: 'warning', title: 'Withheld from schema authors. Schemas that model it keep it.' }
    case 'quarantined': return { label: 'Quarantined', tone: 'warning', title: 'Nobody has admitted it yet, so its readings are held' }
    case 'playback': return { label: 'Playback', tone: 'neutral', title: 'What a playback is published as' }
    case 'disabled': return { label: 'Disabled', tone: 'neutral', title: 'Not evaluated until it is turned on' }
    case 'withdrawn': return { label: 'Withdrawn', tone: 'warning', title: 'The API refuses every token naming it' }
    case 'removed': return { label: 'Access removed', tone: 'neutral', title: 'Their role is removed and they cannot sign in' }
    default: return null
  }
}

/** An archived row's auto-purge where a drawer warns of it: held by a playback, or due within a week. Null otherwise. */
export function purgeWarning(row, now = Date.now()) {
  if (row?.state !== 'archived' || !row.auto_delete_at) return null
  if (purgeIsHeld(row)) {
    return {
      id: 'purge-held',
      tone: 'warning',
      text: `Held: ${plural(row.playbacks, 'playback')} ${row.playbacks === 1 ? 'names' : 'name'} this gateway, and each is kept on record. Neither the auto-purge, due ${formatDate(row.auto_delete_at)}, nor Permanent Delete removes the gateway. Restore it, or leave it archived.`,
    }
  }
  if (!purgeIsSoon(row.auto_delete_at, now)) return null
  const due = new Date(row.auto_delete_at).getTime() < now ? 'was due' : 'is due'
  return { id: 'purge-soon', tone: 'danger', text: `The auto-purge ${due} ${formatDate(row.auto_delete_at)}. It deletes the record for good, unless it is restored first.` }
}

/** What is wrong with a row, as a drawer's `warnings`. */
export function entityWarnings(row) {
  return [
    purgeWarning(row),
    row?.variant === 'quarantined'
      && { id: 'quarantined', tone: 'warning', text: 'Quarantined: nobody has admitted this device yet, so its readings are held. Approve or reject it on the Devices page.' },
    row?.variant === 'withdrawn'
      && { id: 'withdrawn', tone: 'warning', text: 'Withdrawn: the API refuses every token that names this machine identity.' },
  ].filter(Boolean)
}

/** What a kind's further ids are called, first and after, in the words its own drawer uses. */
const SECOND_ID_LABELS = {
  gateways: ['Sparkplug Edge Node ID'],
  devices: ['Sparkplug Device ID', 'Published ID'],
  schemas: ['Semantic ID'],
  metric_catalog: ['Semantic ID', 'Further Semantic ID'],
  automations: ['Automation ID'],
  captures: ['Stored File'],
  backups: ['Stamp'],
  user_roles: ['Email'],
}

/** A row's further ids as `{ label, value }`, each with the name its kind's own page gives it. */
export function secondIdFields(row) {
  const labels = SECOND_ID_LABELS[row.kind] ?? ['Further ID']
  return (row.second_ids ?? []).map((value, i) => ({ label: labels[Math.min(i, labels.length - 1)], value }))
}

/** What a row has where nothing says otherwise. */
const BLANK_ROW = Object.freeze({
  description: null, variant: null, second_ids: [], area_id: null, cell_id: null, gateway_id: null, device_id: null, page_id: null,
})

/** An archived row (`/api/v1/archives`), which names its kind in the singular, with what entity_directory says of it. */
export const archivedRow = (a) =>
  ({ ...BLANK_ROW, page_id: a.entity_id, ...a.directory, ...a, kind: `${a.entity_type}s`, id: a.entity_id, state: 'archived' })

/** A tombstone (`/api/v1/archives/retired`) as entity_directory's own arm for them has it (0321, mirror check 168). */
export function retiredRow(r) {
  const old = r.old_data ?? {}
  const ids = [r.sparkplug_id, old.reported_identity === r.sparkplug_id ? null : old.reported_identity]
  return {
    ...BLANK_ROW,
    ...r,
    kind: `${r.entity_type}s`,
    id: r.entity_id,
    description: old.description ?? null,
    state: 'retired',
    variant: old.shadow_of ? 'replay_lane' : null,
    second_ids: ids.filter(id => id !== null && id !== undefined),
  }
}

/** A person as a row, from list_people() or list_user_accounts(). The email is an id people search by. */
export function personRow(person) {
  return {
    kind: 'user_roles',
    id: person.user_id,
    name: person.display_name || person.email || person.user_id,
    description: null,
    state: 'active',
    variant: person.status === 'removed' ? 'removed' : null,
    second_ids: person.email ? [person.email] : [],
    area_id: null,
    cell_id: null,
    gateway_id: null,
    device_id: null,
    page_id: person.user_id,
  }
}

/** The identities a migration pinned, which no machine_principals row holds (utils/serviceIdentities.js). */
export const PINNED_IDENTITY_ROWS = Object.freeze(Object.entries(KNOWN_PRINCIPALS).map(([id, known]) => ({
  kind: 'service_principals',
  id,
  name: known.name,
  description: known.purpose,
  state: 'active',
  variant: null,
  second_ids: [],
  area_id: null,
  cell_id: null,
  gateway_id: null,
  device_id: null,
  page_id: id,
})))

/** The fewest characters that match as the start of an id: find_entities()' own (mirror check 159). */
export const ID_PREFIX_MIN = 8

/** A search's text as the match compares it. */
export const findText = (text) => String(text ?? '').trim().toLowerCase()

const idsOf = (row) => [row.id, ...(row.second_ids ?? [])].map(id => String(id).toLowerCase())

/** Whether `text` is a whole id of the row's. */
export function isWholeId(row, text) {
  const q = findText(text)
  return q !== '' && idsOf(row).includes(q)
}

/**
 * How well `text` names a row, or null where it does not: 0 a whole id, 1 a whole name, 2 the start of an
 * id, 3 part of a name. find_entities() ranks by the same rule (0321, mirror check 159); this is for the
 * rows no table holds, people and the pinned identities. A person is found by any part of their email
 * too, which is a name they go by as much as an id.
 */
export function findRank(row, text) {
  const q = findText(text)
  if (q === '') return null
  const ids = idsOf(row)
  const names = [row.name, ...(row.kind === 'user_roles' ? row.second_ids : [])].map(n => String(n ?? '').toLowerCase())
  if (ids.includes(q)) return 0
  if (names.includes(q)) return 1
  if (q.length >= ID_PREFIX_MIN && ids.some(id => id.startsWith(q))) return 2
  if (names.some(n => n.includes(q))) return 3
  return null
}

/** The id of the row's that `text` is, or is the start of, or null where the row was found by its name. */
export function idFoundBy(row, text) {
  const rank = findRank(row, text)
  if (rank !== 0 && rank !== 2) return null
  const q = findText(text)
  const ids = [row.id, ...(row.second_ids ?? [])].map(String)
  return ids.find(id => id.toLowerCase() === q) ?? ids.find(id => id.toLowerCase().startsWith(q)) ?? null
}

/** The groups of a UUID, in hexadecimal digits. */
const UUID_GROUPS = [8, 4, 4, 4, 12]

/** Whether `text` is a UUID, or the start of one from the characters a search counts. */
function isUuidStart(text) {
  const groups = text.split('-')
  return text.length >= ID_PREFIX_MIN && groups.length <= UUID_GROUPS.length
    && groups.every((group, i) => /^[0-9a-f]*$/i.test(group)
      && (i === groups.length - 1 ? group.length <= UUID_GROUPS[i] : group.length === UUID_GROUPS[i]))
}

/**
 * Whether a text is an id by its shape, whether or not anything has it: a UUID, the start of one, a
 * Sparkplug id Aber issues, or a semantic id. Any other is known for one by what it names (`idFoundBy`).
 */
export function isIdShaped(text) {
  const q = String(text ?? '').trim()
  return isUuidStart(q) || isSparkplugId(q.toLowerCase()) || inferSemanticIdType(q) !== ''
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** The order the Active tab lists in: by kind, then by name. */
export const byKindThenName = (a, b) =>
  kindRank(a.kind) - kindRank(b.kind) || collator.compare(a.name ?? '', b.name ?? '') || (a.id < b.id ? -1 : 1)

/**
 * The database's rows for a search with the browser's own beside them, best first. The server's rows keep
 * the order they came in among equals.
 */
export function mergeFound(found, local, text) {
  const own = local
    .filter(row => findRank(row, text) !== null)
    .sort((a, b) => collator.compare(a.name ?? '', b.name ?? ''))
  const ranked = [...found, ...own].map((row, i) => ({ row, i, rank: findRank(row, text) ?? 4 }))
  return ranked.sort((a, b) => a.rank - b.rank || a.i - b.i).map(r => r.row)
}

/** In service first. */
const STATE_ORDER = { active: 0, archived: 1, retired: 2 }
const stateRank = (row) => STATE_ORDER[row.state] ?? 3

/**
 * A search's rows as the search bar lists them: best first, at most `perKind` of one kind. A whole id comes
 * first and a whole name next, so a kind's share takes nothing from either. Among equals, what is in service
 * comes before what was taken out; then by name, and by kind: a device before its capture, which goes by its
 * name.
 */
export function shortlist(rows, text, perKind) {
  const ranked = rows
    .map(row => ({ row, rank: findRank(row, text) ?? 4 }))
    .sort((a, b) => a.rank - b.rank || stateRank(a.row) - stateRank(b.row)
      || collator.compare(a.row.name ?? '', b.row.name ?? '') || byKindThenName(a.row, b.row))
  const taken = new Map()
  return ranked.map(r => r.row).filter(row => {
    const n = (taken.get(row.kind) ?? 0) + 1
    taken.set(row.kind, n)
    return n <= perKind
  })
}
