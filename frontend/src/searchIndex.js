/**
 * ==================================================================================================
 * WHAT THE SEARCH BAR CAN FIND, AND HOW IT RANKS IT.
 * ==================================================================================================
 *
 * Three kinds of thing, and they are three because they are found in three different ways rather
 * than because three felt like a good number:
 *
 *   PAGES  -- derived from the nav, never listed here. Anything else drifts: a page added to
 *             `navigation.jsx` and forgotten here would be navigable from the rail and invisible to
 *             the search, which is the failure a user reports as "search is broken".
 *   CARDS  -- the sections INSIDE a page, listed below. These cannot be derived, because a card is
 *             a heading in a 90KB component with no registry behind it. A guard test asserts every
 *             entry names a real page; nothing can assert the heading still exists, so the entries
 *             carry the label verbatim and the test that reads them is the reminder.
 *   ASSETS -- resolved from a UUID against the database at search time. Not in this file at all.
 *
 * MATCHING IS SUBSTRING AND INITIALS, DELIBERATELY NOT FUZZY. A fuzzy matcher scores "cold storage"
 * against "Access Control" and cannot be talked out of it, so the palette's second result becomes
 * noise the eye has to reject on every keystroke. Everything here is a short label from a closed
 * set of about thirty; substring plus initials covers "metr", "mc" and "cat" without ever returning
 * something the typed letters do not appear in.
 */

/**
 * Words that should find a page but are not in its name.
 *
 * These are what somebody types when they know what they want and not what it is called -- the
 * vocabulary of the job rather than the vocabulary of the UI. "MQTT" finds Gateways because that is
 * what a gateway speaks; "audit" finds Digital Thread because that is what it is FOR, and nobody
 * arriving at this stack for the first time guesses the phrase "digital thread".
 */
export const PAGE_KEYWORDS = {
  'overview':       ['dashboard', 'home', 'shopfloor', 'map', 'kpi', 'status'],
  // Every word somebody would reach for while holding the thing rather than its name: an
  // operator searches "request" or "ask", an approver searches "approve" or "pending".
  'approvals':      ['proposal', 'proposals', 'approve', 'reject', 'pending', 'queue', 'request',
                     'change', 'review', 'publish'],
  'cells':          ['zone', 'area', 'shopfloor', 'location'],
  'gateways':       ['edge', 'node', 'mqtt', 'sparkplug', 'broker', 'bundle', 'enrolment', 'enrollment'],
  'devices':        ['asset', 'machine', 'equipment', 'sensor', 'robot', 'quarantine', 'nameplate'],
  'archives':       ['archived', 'decommissioned', 'restore', 'retired', 'out of commission'],
  'schemas':        ['contract', 'metric', 'catalog', 'catalogue', 'registry', 'model', 'version'],
  'vocabulary':     ['standard', 'standards', 'mtconnect', 'iso 22400', 'opc ua', 'ashrae', 'semantic'],
  'directory':      ['services', 'endpoints', 'urls', 'links', 'grafana', 'node-red', 'liveness'],
  'digital-thread': ['audit', 'history', 'trace', 'provenance', 'events', 'changes', 'who changed'],
  'capture':        ['record', 'recording', 'replay', 'playback', 'shadow'],
  'cold-storage':   ['parquet', 'tiered', 'object storage', 'minio', 'telemetry archive', 's3'],
  'access-control': ['users', 'roles', 'permissions', 'principals', 'credentials', 'rbac', 'identities'],
  'settings':       ['configuration', 'config', 'retention', 'preferences', 'tuning']
}

/**
 * The sections inside each page, by the heading they actually render.
 *
 * ONE ENTRY PER HEADING A READER COULD BE LOOKING FOR, not one per card. The Overview KPI ribbon is
 * four figures with no heading and no anchor to land on; listing it would produce a result that
 * navigates somewhere indistinguishable from clicking Overview. A card earns an entry when its name
 * is a thing somebody would type -- which is exactly the case the request was raised about, where
 * "Metric Catalog" is on the Schemas page and nothing about the word "Schemas" says so.
 */
export const CARDS = [
  { id: 'shopfloor-dashboard',  label: 'Shopfloor Dashboard',  tab: 'overview',       keywords: ['map', 'grid', 'zones', 'tiles', 'layout'] },
  { id: 'site-wide-lane',       label: 'Site-Wide',            tab: 'overview',       keywords: ['no cell', 'bms', 'agv', 'unassigned lane'] },
  { id: 'unassigned-lane',      label: 'Unassigned',           tab: 'overview',       keywords: ['no cell', 'orphan', 'unplaced'] },

  { id: 'shopfloor-cells',      label: 'Shopfloor Cells',      tab: 'cells',          keywords: ['cell list', 'zones'] },
  { id: 'edge-gateways',        label: 'Edge Gateways',        tab: 'gateways',       keywords: ['gateway list', 'nodes'] },
  { id: 'device-list',          label: 'Devices',              tab: 'devices',        keywords: ['device list', 'assets'] },
  { id: 'archived-entities',    label: 'Archived Entities',    tab: 'archives',       keywords: ['out of commission', 'restore', 'purge'] },

  { id: 'registered-schemas',   label: 'Registered Schemas',   tab: 'schemas',        keywords: ['schema registry', 'versions', 'drafts', 'fork'] },
  // The entry the request was raised about.
  { id: 'metric-catalog',       label: 'Metric Catalog',       tab: 'schemas',        keywords: ['metrics', 'data points', 'catalogue', 'units', 'semantic id'] },
  { id: 'vocab-mtconnect',      label: 'MTConnect',            tab: 'vocabulary',     keywords: ['machine tool', 'data items', 'components'] },
  { id: 'vocab-iso22400',       label: 'ISO 22400',            tab: 'vocabulary',     keywords: ['kpi', 'oee', 'availability', 'mtbf'] },
  { id: 'vocab-opcua',          label: 'OPC UA',               tab: 'vocabulary',     keywords: ['companion', 'machinery', 'robotics'] },
  { id: 'vocab-ashrae',         label: 'ASHRAE 223P',          tab: 'vocabulary',     keywords: ['bms', 'building', 'hvac'] },
  { id: 'dir-applications',     label: 'Applications & User Interfaces', tab: 'directory', keywords: ['grafana', 'node-red', 'studio', 'uis'] },
  { id: 'dir-ingestion',        label: 'Ingestion & Messaging', tab: 'directory',     keywords: ['mosquitto', 'broker', 'daemon'] },
  { id: 'dir-infrastructure',   label: 'Data & Backend Infrastructure', tab: 'directory', keywords: ['postgres', 'timescale', 'kong', 'storage'] },

  { id: 'thread-timeline',      label: 'Digital Thread',       tab: 'digital-thread', keywords: ['timeline', 'events', 'audit trail'] },
  { id: 'capture-list',         label: 'Capture',              tab: 'capture',        keywords: ['recordings', 'record broker', 'upload capture'] },
  { id: 'playback',             label: 'Playback',             tab: 'capture',        keywords: ['replay', 'shadow devices', 'speed'] },
  { id: 'cold-telemetry',       label: 'Cold telemetry',       tab: 'cold-storage',   keywords: ['parquet', 'objects', 'tiered'] },

  { id: 'broker-credentials',   label: 'Broker credentials',   tab: 'access-control', keywords: ['mqtt accounts', 'gateway passwords', 'revoke'] },
  { id: 'service-identities',   label: 'Service identities',   tab: 'access-control', keywords: ['machine accounts', 'non-human'] },
  { id: 'database-principals',  label: 'Database principals',  tab: 'access-control', keywords: ['auth users', 'cannot sign in', 'service role'] },
  { id: 'broker-principals',    label: 'Broker principals',    tab: 'access-control', keywords: ['acl', 'mosquitto users', 'topic access'] },
  { id: 'runtime-configuration', label: 'Runtime configuration', tab: 'settings',     keywords: ['system settings', 'retention', 'thresholds'] }
]

/**
 * Everything this session can reach, as one flat list the matcher scores.
 *
 * TAKES THE ALREADY-FILTERED PAGES rather than filtering here, so there is exactly one predicate
 * deciding what a session may see -- `tabIsVisible`, in navigation.jsx. A search that indexed the
 * full list and hid results afterwards would be a second copy of that rule, and the day the two
 * disagree the palette offers an Operator a page the rail does not.
 *
 * A CARD INHERITS ITS PAGE'S VISIBILITY and cannot narrow it further. Every card lives on exactly
 * one page, and a card its page can be opened to is a card that session can already see.
 */
export function buildTargets(visibleTabs) {
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
      // What the row says under the label. A card's page is the ONLY thing a reader needs to be
      // told, and it is the thing they came to the search not knowing.
      page: visibleTabs.find(t => t.id === c.tab)?.label || c.tab,
      keywords: c.keywords || []
    }))

  return [...pages, ...cards]
}

const norm = (s) => String(s || '').toLowerCase().trim()

/** The first letter of each word: "Metric Catalog" -> "mc", so `mc` finds it. */
const initials = (label) =>
  norm(label).split(/[^a-z0-9]+/).filter(Boolean).map(w => w[0]).join('')

/**
 * How well one target answers one query. Higher is better; 0 means "do not show this at all".
 *
 * THE ORDER OF THE BANDS IS THE WHOLE DESIGN. A word-start beats a mid-word substring because
 * "cat" should offer "Metric Catalog" above "Access Control" even though both contain the letters,
 * and a name match always beats a keyword match because a keyword is somebody else's guess at what
 * you meant while the label is what the thing is called.
 */
export function scoreTarget(target, query) {
  const q = norm(query)
  if (!q) return 0

  const label = norm(target.label)
  if (label === q) return 100
  if (label.startsWith(q)) return 80
  /*
   * "mc" -> Metric Catalog, "dt" -> Digital Thread, "cs" -> Cold Storage. This is what a SECOND
   * visit types, once the reader knows the name and only wants to get there.
   *
   * A MINIMUM LENGTH WAS TRIED HERE AND REMOVED, because it could never fire. A label's first
   * initial IS its first character, so any single letter that matches the initials also matches
   * the prefix band above -- which scores higher and returns first. Guarding against a one-letter
   * initials match would have looked prudent, read as though it prevented something, and prevented
   * nothing.
   */
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

/**
 * The ranked results for a query.
 *
 * PAGES WIN TIES, and that is not a preference for pages. A card result navigates to the page that
 * holds it, so when a page and one of its own cards score the same the two rows go to the same
 * place -- and the page is the one whose name the user typed.
 */
export function matchTargets(query, targets, limit = 8) {
  return targets
    .map(t => ({ target: t, score: scoreTarget(t, query) }))
    .filter(r => r.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      (a.target.kind === b.target.kind ? 0 : a.target.kind === 'page' ? -1 : 1) ||
      a.target.label.localeCompare(b.target.label))
    .slice(0, limit)
    .map(r => r.target)
}
