import { DERIVED_TAG_TITLE } from '../components/common/DerivedTag'
import { KNOWN_PRINCIPALS } from './serviceIdentities'
import { SCHEMA_STATUS } from './schemaVersion'

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
const KIND_ORDER = new Map(ENTITY_KINDS.map((k, i) => [k.kind, i]))

/** A kind's one-record name, or its own word for a kind this build does not know. */
export const kindLabel = (kind) => ENTITY_KINDS[KIND_ORDER.get(kind)]?.label ?? String(kind ?? '')

/** Where a kind comes in the page's order: last, for one this build does not know. */
export const kindRank = (kind) => KIND_ORDER.get(kind) ?? ENTITY_KINDS.length

/** One row's key among every row of the page. A deleted entity's id is not used again, and a test's may be. */
export const entityKey = (row) => `${row.state}:${row.kind}:${row.id}`

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

/** What is wrong with a row, as a drawer's `warnings`. */
export function entityWarnings(row) {
  if (row?.variant === 'quarantined') {
    return [{ id: 'quarantined', tone: 'warning', text: 'Quarantined: nobody has admitted this device yet, so its readings are held. Approve or reject it on the Devices page.' }]
  }
  if (row?.variant === 'withdrawn') {
    return [{ id: 'withdrawn', tone: 'warning', text: 'Withdrawn: the API refuses every token that names this machine identity.' }]
  }
  return []
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
