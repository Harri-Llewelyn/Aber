/**
 * What the search bar can find, and how it ranks it. Pages are derived from the nav, never listed
 * here. Cards are the sections inside a page, listed below; a guard test asserts every entry names
 * a real page. Assets are resolved from a UUID against the database at search time. Headings in the
 * help are matched by the help panel's own index (help/searchIndex.js), not here. Matching is substring and initials, not fuzzy: everything here is a
 * short label from a closed set, and a fuzzy matcher returns things the typed letters do not appear
 * in.
 */
import { COLD_STORAGE_DIALOG_KEYS } from './utils/coldStorage'
import { BACKUP_OFFSITE_SETTING_KEYS } from './utils/backupOffsite'
import { pageTabsOf } from './navigation'

/** Settings a page's own destination dialog edits, with the page a search for one opens. */
const EDITED_ON = new Map([
  ...COLD_STORAGE_DIALOG_KEYS.map(k => [k, { tabId: 'cold-storage', page: 'Cold Storage' }]),
  ...BACKUP_OFFSITE_SETTING_KEYS.map(k => [k, { tabId: 'backups', page: 'Backups' }])
])

/**
 * Words that should find a page but are not in its name: the vocabulary of the job rather than of
 * the UI.
 */
export const PAGE_KEYWORDS = {
  'site-map':       ['dashboard', 'home', 'shopfloor', 'map', 'site map', 'overview', 'status'],
  // Every word somebody would reach for while holding the thing rather than its name: an
  // operator searches "request" or "ask", an approver searches "approve" or "pending".
  'approvals':      ['proposal', 'proposals', 'approve', 'reject', 'pending', 'queue', 'request',
                     'change', 'review', 'publish'],
  // 'building' and 'floor' are what many sites call an area: ordinary shopfloor words for one.
  'areas':          ['building', 'buildings', 'floor', 'isa-95', 'isa95', 'site', 'hierarchy', 'uns'],
  // 'zone' is what many sites call a cell.
  'cells':          ['zone', 'work center', 'work centre', 'shopfloor', 'location'],
  'gateways':       ['edge', 'node', 'edge node', 'mqtt', 'sparkplug', 'broker', 'bundle', 'enrolment', 'enrollment'],
  'devices':        ['asset', 'machine', 'equipment', 'work unit', 'sensor', 'robot', 'quarantine', 'nameplate'],
  // 'archives' is still the page id and the route, so the old name has to stay findable here:
  // the label moved to "Archived Entities" but nobody's habits did.
  'archives':       ['archives', 'archived', 'decommissioned', 'restore', 'retired', 'purge', 'out of commission'],
  'schemas':        ['contract', 'registry', 'model', 'version', 'draft', 'create version', 'fork', 'publish'],
  // Keeps catalog/catalogue: the catalogue was part of the Schemas page and is searched for by
  // that name as often as by its own.
  'metrics':        ['metric', 'catalog', 'catalogue', 'data point', 'data points', 'tag', 'tags', 'units', 'datatype', 'semantic id', 'deprecate'],
  'vocabulary':     ['standard', 'standards', 'mtconnect', 'iso 22400', 'opc ua', 'ashrae', 'semantic'],
  // 'directory' is the page's old name, which habits keep, as with 'archives' above.
  'system':         ['directory', 'services', 'endpoints', 'urls', 'links', 'grafana', 'node-red', 'liveness', 'image versions'],
  'audit-trail':    ['audit', 'history', 'trace', 'provenance', 'events', 'changes', 'who changed'],
  'capture':        ['record', 'recording', 'replay', 'playback', 'shadow'],
  'cold-storage':   ['parquet', 'tiered', 'object storage', 'minio', 'telemetry archive', 's3'],
  'access-control': ['users', 'roles', 'permissions', 'principals', 'credentials', 'rbac', 'identities'],
  'backups':        ['backup', 'dump', 'pg_dump', 'restore', 'snapshot', 'retention', 'disaster recovery'],
  'settings':       ['configuration', 'config', 'retention', 'tuning', 'site settings'],
  // The person's own page: what somebody types looking for their own choices.
  'profile':        ['account', 'my account', 'preferences', 'me', 'my settings', 'user']
}

/**
 * The sections inside each page. One entry per section somebody would type, usually the heading the
 * page renders; the Site Map's lanes have entries of their own. 'floors', 'buildings' and 'zones'
 * below are what many sites call an area or a cell. A section that is one tab of its page carries
 * `section`, that tab's id, and the search opens the page on that tab; its label is the tab's own,
 * from navigation.jsx, so a renamed tab is found by its new name.
 */
const tabCard = (page, section) => ({ label: pageTabsOf(page).find(t => t.id === section).label, tab: page, section })

export const CARDS = [
  { id: 'site-map',             label: 'Site Map',             tab: 'site-map',       keywords: ['floors', 'plan', 'pins', 'svg', 'layout', 'areas', 'lanes'] },
  { id: 'site-wide-lane',       label: 'Site-Wide',            tab: 'site-map',       keywords: ['no cell', 'bms', 'agv', 'unassigned lane'] },
  { id: 'simulated-lane',       label: 'Simulated',            tab: 'site-map',       keywords: ['no cell', 'simulator', 'synthetic', 'generated'] },
  { id: 'unassigned-lane',      label: 'Unassigned',           tab: 'site-map',       keywords: ['no cell', 'orphan', 'unplaced'] },

  { id: 'area-list',            label: 'Areas',                tab: 'areas',          keywords: ['buildings', 'unfiled cells', 'area list'] },
  { id: 'shopfloor-cells',      label: 'Cells',                tab: 'cells',          keywords: ['cell list', 'zones'] },
  { id: 'edge-gateways',        label: 'Gateways',             tab: 'gateways',       keywords: ['gateway list', 'nodes'] },
  { id: 'device-list',          label: 'Devices',              tab: 'devices',        keywords: ['device list', 'assets'] },
  { id: 'quarantine-queue',     ...tabCard('devices', 'quarantine'), keywords: ['quarantine queue', 'onboarding', 'approve device', 'unknown device'] },
  /* No 'Archived Entities' card: it would add no keyword the page entry does not have. */

  { id: 'registered-schemas',   label: 'Registered Schemas',   tab: 'schemas',        keywords: ['schema registry', 'versions', 'drafts', 'create version', 'fork'] },
  /* No "Metric Catalog" card: the catalogue is the Metrics page now, and its page entry answers
     every query this card did. */
  { id: 'vocab-mtconnect',      ...tabCard('vocabulary', 'mtconnect'), keywords: ['machine tool', 'data items', 'components'] },
  { id: 'vocab-iso22400',       ...tabCard('vocabulary', 'iso-22400'), keywords: ['kpi', 'oee', 'availability', 'mtbf'] },
  { id: 'vocab-opcua',          ...tabCard('vocabulary', 'opc-ua'), keywords: ['companion', 'machinery', 'robotics'] },
  { id: 'vocab-ashrae',         ...tabCard('vocabulary', 'ashrae-223p'), keywords: ['bms', 'building', 'hvac'] },
  { id: 'system-applications',  ...tabCard('system', 'applications'), keywords: ['grafana', 'node-red', 'studio', 'uis'] },
  { id: 'system-ingestion',     ...tabCard('system', 'ingestion'), keywords: ['mosquitto', 'broker', 'daemon'] },
  { id: 'system-infrastructure', ...tabCard('system', 'infrastructure'), keywords: ['postgres', 'timescale', 'gateway', 'envoy', 'storage'] },

  { id: 'trail-timeline',       label: 'Audit Trail',          tab: 'audit-trail',    keywords: ['timeline', 'events'] },
  { id: 'capture-list',         label: 'Capture',              tab: 'capture',        keywords: ['recordings', 'record broker', 'upload capture'] },
  { id: 'playback',             label: 'Playback',             tab: 'capture',        keywords: ['replay', 'shadow devices', 'speed'] },
  { id: 'cold-telemetry',       label: 'Cold telemetry',       tab: 'cold-storage',   keywords: ['parquet', 'objects', 'tiered'] },

  { id: 'people',               ...tabCard('access-control', 'people'), keywords: ['users', 'accounts', 'add person', 'invite', 'change role', 'remove access', 'restore access', 'set new password', 'lost password'] },
  { id: 'apps',                 ...tabCard('access-control', 'apps'), keywords: ['oauth', 'oauth clients', 'authorized apps', 'connected apps', 'third-party apps', 'consent', 'revoke approval', 'remove app', 'sign in with aber'] },
  { id: 'broker-credentials',   ...tabCard('access-control', 'credentials'), keywords: ['mqtt accounts', 'gateway passwords', 'revoke'] },
  { id: 'machine-identities',   ...tabCard('access-control', 'identities'), keywords: ['machine accounts', 'non-human', 'service accounts', 'principals', 'tokens', 'withdraw', 'cannot sign in'] },
  { id: 'broker-accounts',      ...tabCard('access-control', 'accounts'), keywords: ['mqtt users', 'platform accounts', 'orphaned accounts', 'no gateway'] },
  { id: 'broker-roles',         ...tabCard('access-control', 'roles'), keywords: ['dynamic security', 'mosquitto roles', 'topic access'] },
  { id: 'backup-list',          label: 'Backups',              tab: 'backups',        keywords: ['take a backup', 'stored backups', 'pinned', 'release'] },

  { id: 'profile-account',      ...tabCard('profile', 'account'), keywords: ['email', 'role', 'password', 'change password', 'my role'] },
  { id: 'profile-appearance',   ...tabCard('profile', 'appearance'), keywords: ['theme', 'dark mode', 'light mode', 'dark', 'light', 'sidebar layout', 'collapse sidebar', 'expand sidebar', 'keyboard shortcuts', 'single-key shortcuts', 'speech input'] },
  { id: 'profile-security',     ...tabCard('profile', 'security'), keywords: ['sessions', 'signed in', 'sign out everywhere', 'sign out other sessions', 'other browsers', 'end session', 'lost laptop', 'second factor', 'mfa', 'two-factor', '2fa', 'authenticator', 'totp', 'apps you have allowed', 'authorized apps', 'connected apps', 'revoke app'] }
]

/**
 * Everything this session can reach, as one flat list. Takes the already-filtered pages, so
 * `tabIsVisible` is the only predicate deciding what a session may see. A card inherits its page's
 * visibility, and so does a setting.
 *
 * `settings` are rows, not a listed constant -- a migration adds one and nothing here would know --
 * but they are a closed set of a dozen short labels, so they are matched here alongside the pages
 * rather than probed per keystroke like the estate. RLS decides which rows arrive (a `sensitive`
 * one reaches Administrators only), and a row is offered only while the page that shows it is in
 * the rail: Settings for most, the page whose dialog edits it for the rest.
 */
export function buildTargets(visibleTabs, settings = []) {
  const pages = visibleTabs.map(t => ({
    kind: 'page',
    key: `page:${t.id}`,
    label: t.label,
    tabId: t.id,
    icon: t.icon,
    keywords: PAGE_KEYWORDS[t.id] || []
  }))

  const reachable = new Set(visibleTabs.map(t => t.id))
  const cards = CARDS
    .filter(c => reachable.has(c.tab))
    .map(c => ({
      kind: 'card',
      key: `card:${c.id}`,
      label: c.label,
      tabId: c.tab,
      section: c.section,
      // What the row says under the label. A card's page is the ONLY thing a reader needs to be
      // told, and it is the thing they came to the search not knowing.
      page: visibleTabs.find(t => t.id === c.tab)?.label || c.tab,
      keywords: c.keywords || []
    }))

  /* The key is a keyword rather than the label, so `site.name` finds the row somebody read in a
     log or a migration as surely as "Site name" does. The category is what the row says beneath
     its label, because it is the tab the page will open on. */
  // A row a page's own dialog edits is offered only while that page is in the rail.
  const offered = (s) => s && s.key && (!EDITED_ON.has(s.key) || reachable.has(EDITED_ON.get(s.key).tabId))
  const settingRows = reachable.has('settings')
    ? settings.filter(offered).map(s => (EDITED_ON.has(s.key)
      // Edited in a page's destination dialog, not on Settings, so it opens that page.
      ? { kind: 'card', key: `setting:${s.key}`, label: s.label || s.key, ...EDITED_ON.get(s.key),
          keywords: [s.key, s.category].filter(Boolean) }
      : {
        kind: 'setting',
        key: `setting:${s.key}`,
        label: s.label || s.key,
        tabId: 'settings',
        settingKey: s.key,
        page: s.category || 'Settings',
        keywords: [s.key, s.category].filter(Boolean)
      }))
    : []

  return [...pages, ...cards, ...settingRows]
}

const norm = (s) => String(s || '').toLowerCase().trim()

/** The first letter of each word: "Access Control" -> "ac", so `ac` finds it. */
const initials = (label) =>
  norm(label).split(/[^a-z0-9]+/).filter(Boolean).map(w => w[0]).join('')

/**
 * How well one target answers one query; 0 means do not show. A word-start beats a mid-word
 * substring, and a name match beats a keyword match.
 */
export function scoreTarget(target, query) {
  const q = norm(query)
  if (!q) return 0

  const label = norm(target.label)
  if (label === q) return 100
  if (label.startsWith(q)) return 80
  /* Initials: ac for Access Control. No minimum length: a single letter that matches the initials
     also matches the prefix band above, which scores higher. */
  if (initials(target.label).startsWith(q)) return 70
  if (label.split(/[^a-z0-9]+/).some(w => w.startsWith(q))) return 60
  if (label.includes(q)) return 45

  let best = 0
  for (const kw of target.keywords) {
    const k = norm(kw)
    if (k === q) best = Math.max(best, 35)
    else if (k.startsWith(q)) best = Math.max(best, 30)
    else if (k.includes(q)) best = Math.max(best, 20)
  }
  return best
}

/* Breaks a tie on score, least specific first: a card and a setting both navigate to the page
   above them, so the page is the row that answers with the fewest assumptions. A rank rather than
   a chain of conditions, because a comparator that returns 1 for both (a, b) and (b, a) -- which
   an `a.kind === 'page' ? -1 : 1` chain does for card against setting -- sorts arbitrarily. */
const KIND_RANK = { page: 0, card: 1, setting: 2 }

/**
 * The ranked results. Pages win ties: a card or a setting navigates to the page that holds it, so
 * the rows go to the same place.
 */
export function matchTargets(query, targets, limit = 8) {
  return targets
    .map(t => ({ target: t, score: scoreTarget(t, query) }))
    .filter(r => r.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      (KIND_RANK[a.target.kind] ?? 9) - (KIND_RANK[b.target.kind] ?? 9) ||
      a.target.label.localeCompare(b.target.label))
    .slice(0, limit)
    .map(r => r.target)
}
