/**
 * What the search bar can find, and how it ranks it. Pages are derived from the nav, never listed
 * here. Cards are the sections inside a page, listed below; a guard test asserts every entry names
 * a real page, and the entries carry the label verbatim. Assets are resolved from a UUID against
 * the database at search time. Matching is substring and initials, not fuzzy: everything here is a
 * short label from a closed set, and a fuzzy matcher returns things the typed letters do not appear
 * in.
 */

/**
 * Words that should find a page but are not in its name: the vocabulary of the job rather than of
 * the UI.
 */
export const PAGE_KEYWORDS = {
  'overview':       ['dashboard', 'home', 'shopfloor', 'map', 'site map', 'overview', 'floor plan', 'status'],
  // Every word somebody would reach for while holding the thing rather than its name: an
  // operator searches "request" or "ask", an approver searches "approve" or "pending".
  'approvals':      ['proposal', 'proposals', 'approve', 'reject', 'pending', 'queue', 'request',
                     'change', 'review', 'publish'],
  'areas':          ['building', 'buildings', 'floor', 'isa-95', 'isa95', 'site', 'hierarchy', 'uns'],
  'cells':          ['zone', 'work center', 'work centre', 'shopfloor', 'location'],
  'gateways':       ['edge', 'node', 'edge node', 'mqtt', 'sparkplug', 'broker', 'bundle', 'enrolment', 'enrollment'],
  'devices':        ['asset', 'machine', 'equipment', 'work unit', 'sensor', 'robot', 'quarantine', 'nameplate'],
  'archives':       ['archived', 'decommissioned', 'restore', 'retired', 'out of commission'],
  'schemas':        ['contract', 'metric', 'catalog', 'catalogue', 'registry', 'model', 'version'],
  'vocabulary':     ['standard', 'standards', 'mtconnect', 'iso 22400', 'opc ua', 'ashrae', 'semantic'],
  'directory':      ['services', 'endpoints', 'urls', 'links', 'grafana', 'node-red', 'liveness'],
  'digital-thread': ['audit', 'history', 'trace', 'provenance', 'events', 'changes', 'who changed'],
  'capture':        ['record', 'recording', 'replay', 'playback', 'shadow'],
  'cold-storage':   ['parquet', 'tiered', 'object storage', 'minio', 'telemetry archive', 's3'],
  'access-control': ['users', 'roles', 'permissions', 'principals', 'credentials', 'rbac', 'identities'],
  'backups':        ['backup', 'dump', 'pg_dump', 'restore', 'snapshot', 'retention', 'disaster recovery'],
  'settings':       ['configuration', 'config', 'retention', 'preferences', 'tuning']
}

/**
 * The sections inside each page, by the heading they render. One entry per heading somebody would
 * type; the Site Map's lanes have no heading and no anchor, so it is not listed.
 */
export const CARDS = [
  { id: 'site-map',             label: 'Site Map',             tab: 'overview',       keywords: ['floor plan', 'floors', 'plan', 'pins', 'svg', 'layout', 'areas', 'lanes'] },
  { id: 'site-wide-lane',       label: 'Site-Wide',            tab: 'overview',       keywords: ['no cell', 'bms', 'agv', 'unassigned lane'] },
  { id: 'unassigned-lane',      label: 'Unassigned',           tab: 'overview',       keywords: ['no cell', 'orphan', 'unplaced'] },

  { id: 'area-list',            label: 'Areas',                tab: 'areas',          keywords: ['buildings', 'unfiled cells', 'area list'] },
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
  { id: 'broker-roles',         label: 'Broker roles',         tab: 'access-control', keywords: ['dynamic security', 'mosquitto roles', 'topic access', 'orphaned accounts'] },
  { id: 'backup-list',          label: 'Backups',              tab: 'backups',        keywords: ['take a backup', 'stored backups', 'pinned', 'release'] },
  { id: 'runtime-configuration', label: 'Runtime configuration', tab: 'settings',     keywords: ['system settings', 'retention', 'thresholds'] }
]

/**
 * Everything this session can reach, as one flat list. Takes the already-filtered pages, so
 * `tabIsVisible` is the only predicate deciding what a session may see. A card inherits its page's
 * visibility.
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
 * How well one target answers one query; 0 means do not show. A word-start beats a mid-word
 * substring, and a name match beats a keyword match.
 */
export function scoreTarget(target, query) {
  const q = norm(query)
  if (!q) return 0

  const label = norm(target.label)
  if (label === q) return 100
  if (label.startsWith(q)) return 80
  /* Initials: mc for Metric Catalog. No minimum length: a single letter that matches the initials
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

/**
 * The ranked results. Pages win ties: a card navigates to the page that holds it, so the two rows
 * go to the same place.
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
