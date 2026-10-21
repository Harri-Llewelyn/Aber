import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Every table in the dashboard can be sorted by its columns (#801), except the few listed here
 * with the reason they keep one order. Read from the source: a page that adds a table without
 * adopting `hooks/useTableSort.js` fails here rather than shipping a table nobody can sort.
 *
 * Each file names how many of its tables sort, and why each of the others does not. A sortable
 * table takes one of the hooks below, so the file holds one hook call per sortable table.
 */
const TABLES = {
  'components/common/HelpMarkdown.jsx': {
    sortable: 0,
    fixed: ['A table in a help page: its rows in the order the page writes them, as GitHub shows them.']
  },
  'components/modals/AssetConfigModal.jsx': { sortable: 2 },
  'components/modals/ServiceTokenInventoryModal.jsx': { sortable: 1 },
  'components/modals/StartPlaybackModal.jsx': {
    sortable: 0,
    fixed: ['A form: each device in the capture, in the capture\'s order, mapped onto a target device.']
  },
  'components/modals/TelemetryModal.jsx': { sortable: 1 },
  'components/tabs/AccessControlTab.jsx': { sortable: 4 },
  'components/tabs/ApprovalsTab.jsx': {
    sortable: 1,
    fixed: ['A proposal\'s changes: its fields in the order its form lists them, beside their values.']
  },
  'components/tabs/ArchivesTab.jsx': { sortable: 2 },
  'components/tabs/AreasTab.jsx': { sortable: 1 },
  'components/tabs/AuditTrailTab.jsx': {
    sortable: 0,
    fixed: ['An event\'s changes: its properties beside their old and new values. The trail itself is lanes, paged from the server.']
  },
  'components/tabs/BackupsTab.jsx': {
    sortable: 0,
    fixed: ['Paged from the server, 30 runs at a time, newest first: a sort in the browser would sort only the runs on screen.']
  },
  'components/tabs/CaptureTab.jsx': { sortable: 1 },
  'components/tabs/CellsTab.jsx': { sortable: 1 },
  'components/tabs/ColdStorageTab.jsx': { sortable: 1 },
  'components/tabs/DevicesTab.jsx': { sortable: 2 },
  'components/tabs/DirectoryTab.jsx': { sortable: 1 },
  'components/tabs/GatewaysTab.jsx': { sortable: 1 },
  'components/tabs/MetricsTab.jsx': { sortable: 3 },
  'components/tabs/PeopleSection.jsx': { sortable: 1 },
  'components/tabs/ProfileTab.jsx': {
    sortable: 0,
    fixed: ['A form: each setting in its tab\'s order, with its own Save and Discard.']
  },
  'components/tabs/SchemasTab.jsx': { sortable: 1 },
  'components/tabs/SettingsTab.jsx': {
    sortable: 0,
    fixed: ['A form: each setting in its category\'s order, with its own Save and Discard.']
  }
}

const SRC = path.resolve(__dirname, '..')
const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name)
  if (e.isDirectory()) return e.name === '__tests__' || e.name === 'test' ? [] : sources(p)
  return /\.jsx?$/.test(e.name) ? [p] : []
})
const relative = (p) => path.relative(SRC, p).split(path.sep).join('/')
const count = (text, pattern) => (text.match(pattern) || []).length

// Comments are blanked first, so a table mentioned in one is not counted.
const code = (p) => fs.readFileSync(p, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (c, lead) => lead + ' '.repeat(c.length - lead.length))

const SORT_HOOK = /\buse(?:Local)?(?:SortableRows|TableSort)\(/g

describe('every table can be sorted, or says why it keeps one order', () => {
  const withTables = sources(SRC)
    .map(p => ({ file: relative(p), text: code(p) }))
    .filter(f => count(f.text, /<table\b/g) > 0)

  it('lists every file that draws a table', () => {
    expect(withTables.map(f => f.file).sort()).toEqual(Object.keys(TABLES).sort())
  })

  it.each(Object.entries(TABLES))('%s: its tables are the sortable ones and the listed exceptions', (file, spec) => {
    const text = code(path.join(SRC, file))
    const fixed = spec.fixed || []
    expect(count(text, /<table\b/g)).toBe(spec.sortable + fixed.length)
    expect(count(text, SORT_HOOK)).toBe(spec.sortable)
    if (spec.sortable > 0) expect(text).toMatch(/<SortHeader\b/)
    for (const reason of fixed) expect(reason.length).toBeGreaterThan(20)
  })
})
