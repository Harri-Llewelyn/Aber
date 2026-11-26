import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { CellsTab } from '../components/tabs/CellsTab'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { AutomationsTab } from '../components/tabs/AutomationsTab'
import { CaptureTab } from '../components/tabs/CaptureTab'
import { AreasTab } from '../components/tabs/AreasTab'
import { VocabularyTab } from '../components/tabs/VocabularyTab'

/**
 * Each list page's table fits its card at every width (frontend/README.md, Table and Row Conventions).
 * jsdom lays nothing out, so what is held here is what the layout is built from: each table takes
 * `table-fit`; each column's header, every cell under it and its `<col>` carry the same `fit-N` step;
 * those steps are the README table's, page by page; and App.css hides each step, below its width, by a
 * query on the scroller, moving the chevron to the last column shown. Whether the columns left fit is
 * measured in a browser at 1920, 1366 and 600px.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(),
      readAutomations: vi.fn(), automationsForEntity: vi.fn(), findEntities: vi.fn(),
      listCaptures: vi.fn(), activeCaptureJob: vi.fn(), recentCaptureJobs: vi.fn(),
      activePlaybackJob: vi.fn(), recentPlaybackJobs: vi.fn(), displayNamesFor: vi.fn(),
      enrolmentReadiness: vi.fn(), gatewayHoldsBrokerCredential: vi.fn(),
    },
  }
})

vi.mock('../lib/supabaseClient', () => ({ supabase: { functions: { invoke: vi.fn() } } }))

import { api } from '../api'

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
const README = fs.readFileSync(path.resolve(__dirname, '../../README.md'), 'utf8')
const STEPS = [1400, 1280, 1100, 880, 700, 520]

const NOW = new Date().toISOString()
const GATEWAY = {
  gateway_id: '70000001-0000-4000-8000-000000000001', gateway_name: 'Line_A_Gateway', id: '70000001-0000-4000-8000-000000000001',
  name: 'Line_A_Gateway', sparkplug_id: 'gwy700000010000400080000', sparkplug_group: 'Aber', cell_id: 'cell-1', area_id: null,
  location_scope: 'cell', status: 'ONLINE', deployment: 'remote', is_simulated: false, is_shadow: false, is_archived: false,
  access_url: null, last_heartbeat: NOW, device_count: 1, devices: [],
}
const DEVICE = {
  asset_id: 'd0000001-0000-4000-8000-000000000001', asset_name: 'CNC_Mill_01', id: 'd0000001-0000-4000-8000-000000000001',
  name: 'CNC_Mill_01', sparkplug_id: 'devd00000010000400080000', status: 'ONLINE', is_quarantined: false, is_archived: false,
  gateway_id: GATEWAY.gateway_id, active_gateway_id: GATEWAY.gateway_id, gateway_name: GATEWAY.gateway_name, cell_id: null,
  area_id: null, location_scope: 'cell', effective_cell_id: 'cell-1', gateway_cell_id: 'cell-1', location_source: 'inherited',
  cell_mismatch: false, effective_area_id: 'area-1', first_dbirth_at: '2026-10-01T08:00:00Z', created_at: '2026-09-20T12:00:00Z',
  submodel_schema_ids: ['schema-1'],
}
GATEWAY.devices = [DEVICE]
const CELL = {
  cell_id: 'cell-1', cell_name: 'Assembly Line 1', icon: 'Factory', description: null, area_id: 'area-1', plan_x: 0.3, plan_y: 0.4,
  is_archived: false, gateways: [GATEWAY], gateway_count: 1,
}
const AREA = { area_id: 'area-1', area_name: 'Welding Hall', description: null, icon: 'Factory', is_archived: false, cells: [], cell_count: 1, plan_path: null }
const SCHEMA = {
  schema_uuid: 'schema-1', schema_name: 'Robot_Arm_Schema', lineage_name: 'Robot_Arm_Schema', description: null, version: 1,
  status: 'active', parent_schema_id: null, change_description: 'Initial release',
  schema_definition: { type: 'object', properties: { 'Axes/X/POSITION': { type: 'number' } } },
}
const CATALOG = [
  { metric_uuid: 'm1', name: 'Axes/X/POSITION', metric_group: 'Axes', datatype: 10, category: 'SAMPLE', units: 'MILLIMETER', standard: 'MTConnect', deprecated: false, further_semantic_ids: [] },
  { metric_uuid: 'm2', name: 'Controller/PART_COUNT', metric_group: 'Controller', datatype: 4, category: 'EVENT', units: 'COUNT', standard: 'MTConnect', deprecated: false, further_semantic_ids: [] },
  { metric_uuid: 'd1', name: 'Controller/PARTS_PER_HOUR', metric_group: 'Controller', datatype: 10, standard: null, deprecated: false, units: 'COUNT/HOUR', derivation: { kind: 'counter_rate', input: 'Controller/PART_COUNT' }, further_semantic_ids: [] },
  { metric_uuid: 'm8', name: 'Controller/OLD_EXECUTION', metric_group: 'Controller', datatype: 12, category: 'EVENT', standard: 'MTConnect', deprecated: true, superseded_by: 'm2', further_semantic_ids: [] },
]
const UNCATALOGUED = [{ metric_name: 'Hydraulic/PRESSURE', device_count: 1, devices: [{ id: DEVICE.asset_id, name: DEVICE.asset_name, quarantined: false }], last_declared_at: '2026-10-02T10:00:00Z', datatypes: [10] }]
const FILE = {
  id: 'v-iso', name: 'ISO 22400 KPIs', source_format: 'aasx', kind: 'published_standard', standard_name: 'ISO 22400-2', standard_edition: '2014',
  standard_publisher: 'ISO', sha256: 'a'.repeat(64), version: '2.1', licence_note: null, definitions_shareable: false, imported_by: 'u-admin',
  imported_at: '2026-11-10T09:30:00Z', concept_count: 2,
}
const LATHE = DEVICE.asset_id
const AUTOMATIONS = {
  automations: [{ id: 'lathe-hot', alias: 'Lathe hot', description: null, enabled: true, triggers: [{ trigger: 'threshold', device: LATHE, metric: 'Spindle/TEMPERATURE', above: 80, for: '5m' }], actions: [{ action: 'alert', severity: 'warning' }] }],
  devices: { [LATHE]: { name: DEVICE.asset_name, place: 'Assembly Line 1' } },
  rows: [{ id: 'row-1', key: 'lathe-hot', updated_at: '2026-11-08T09:00:00Z', automation_triggers: [] }],
  active: [], history: [],
}
const CAPTURE_GATEWAY = { ...GATEWAY, is_archived: false }

const ROUTES = [
  ['/api/v1/gateways', [CAPTURE_GATEWAY]], ['/api/v1/devices', [DEVICE]], ['/api/v1/cells', [CELL]], ['/api/v1/areas', [AREA]],
  ['/api/v1/schemas', [SCHEMA]], ['/api/v1/metric-catalog', CATALOG], ['/api/v1/uncatalogued-metrics', UNCATALOGUED],
  ['/api/v1/site-vocabularies', [FILE]],
]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((p) => Promise.resolve((ROUTES.find(([r]) => p.startsWith(r)) || [null, []])[1]))
  api.readAutomations.mockResolvedValue(AUTOMATIONS)
  api.listCaptures.mockResolvedValue([])
  api.activeCaptureJob.mockResolvedValue(null)
  api.activePlaybackJob.mockResolvedValue(null)
  api.recentCaptureJobs.mockResolvedValue([])
  api.recentPlaybackJobs.mockResolvedValue([])
  api.displayNamesFor.mockResolvedValue(new Map([['u-admin', 'Ada Admin']]))
  api.automationsForEntity.mockResolvedValue([])
})
afterEach(cleanup)

const props = { showToast: vi.fn(), hasPermission: () => true, userRole: 'Shopfloor_Manager' }
/** Each README row's page, at its address. */
const PAGES = {
  'Gateways gateways': ['/gateways', () => <GatewaysTab {...props} />],
  'Cells cells': ['/cells', () => <CellsTab {...props} />],
  'Devices Registered': ['/devices', () => <DevicesTab {...props} />],
  'Schemas schemas': ['/schemas', () => <SchemasTab {...props} />],
  'Metrics Metric Catalog': ['/metrics', () => <MetricsTab {...props} />],
  'Metrics Deprecated Metrics': ['/metrics/deprecated', () => <MetricsTab {...props} />],
  'Metrics Derived': ['/metrics/derived', () => <MetricsTab {...props} />],
  'Metrics Uncatalogued': ['/metrics/uncatalogued', () => <MetricsTab {...props} />],
  'Automations automations': ['/automations', () => <AutomationsTab {...props} />],
  'Capture Gateways': ['/capture', () => <CaptureTab {...props} />],
  'Capture Devices': ['/capture/device', () => <CaptureTab {...props} />],
  'Areas areas': ['/areas', () => <AreasTab {...props} />],
  'Vocabulary Imported': ['/vocabulary/imported', () => <VocabularyTab {...props} />],
}
/** Columns a README row names that the page draws only in a state rendered here without them. */
const ONLY_SOMETIMES = {
  // Drawn only on a list narrowed to one entity (`?entity=`).
  'Automations automations': ['Applies because'],
}

/** The README's table: `{ key, stays, steps: { N: [labels] } }` for each row. */
function readmeRows() {
  const section = README.slice(README.indexOf('\n## Table and Row Conventions\n'))
  const lines = section.split('\n').filter(l => /^\s*\| /.test(l))
  const head = lines.findIndex(l => l.includes('| Page | Table | Stays |'))
  const cells = (l) => l.trim().slice(1, -1).split('|').map(c => c.trim())
  const steps = cells(lines[head]).slice(3).map(c => Number(c.replace(/\D/g, '')))
  return lines.slice(head + 2).filter(l => !l.includes(':---')).map(l => {
    const [page, table, stays, ...rest] = cells(l)
    const list = (c) => (c ? c.split(',').map(s => s.trim()) : [])
    return { key: `${page} ${table}`, stays: list(stays), steps: Object.fromEntries(steps.map((n, i) => [n, list(rest[i])])), headSteps: steps }
  })
}

/** A cell's fit step, or null for a column that stays. */
const stepOf = (el) => {
  const found = [...el.classList].map(c => /^fit-(\d+)$/.exec(c)?.[1]).filter(Boolean)
  return found.length ? Number(found[0]) : null
}
/** The zero-width characters in `text`, which would change what is copied or searched. */
const zeroWidth = (text) => [...text].filter(ch => [0x200b, 0x200c, 0x200d, 0x2060, 0xad].includes(ch.codePointAt(0)))
const labelOf = (th) => th.textContent.trim()

async function tableOf(key) {
  const [address, draw] = PAGES[key]
  window.history.replaceState(null, '', address)
  await act(async () => { render(draw()) })
  await waitFor(() => expect(document.querySelector('main, body').querySelector('table.table-fit tbody tr')).toBeTruthy())
  // Open every closed group, so its rows are read too.
  for (const b of document.querySelectorAll('.table-group-button[aria-expanded="false"]')) fireEvent.click(b)
  return document.querySelector('table.table-fit')
}

describe('the README names every list table', () => {
  it('and the steps App.css hides', () => {
    const rows = readmeRows()
    expect(rows.map(r => r.key).sort()).toEqual(Object.keys(PAGES).sort())
    expect(rows[0].headSteps).toEqual(STEPS)
    expect(README).toContain(`The steps are ${STEPS.slice(0, -1).join(', ')} and ${STEPS.at(-1)}`)
  })
})

describe.each(readmeRows().map(r => [r.key, r]))('%s', (key, row) => {
  it('takes table-fit, each column carries the README\'s step, and the name wraps after its separators', async () => {
    const table = await tableOf(key)
    const heads = [...table.querySelector('thead tr').children]
    const named = heads.filter(th => labelOf(th))

    // The README's word for each column, as the page draws it.
    const expected = new Map(row.stays.map(l => [l, null]))
    for (const [n, labels] of Object.entries(row.steps)) for (const l of labels) expected.set(l, Number(n))
    for (const th of named) {
      const label = labelOf(th)
      if (!expected.has(label)) {
        // An icon or a tick-box column has no word; any other column is in the README.
        expect(stepOf(th), `${key}: "${label}" has a step and is not in the README`).toBeNull()
        continue
      }
      expect(stepOf(th), `${key}: "${label}"`).toBe(expected.get(label))
    }
    const drawn = new Set(named.map(labelOf))
    for (const label of expected.keys()) {
      if ((ONLY_SOMETIMES[key] || []).includes(label)) continue
      expect(drawn.has(label), `${key}: the README names "${label}", which the table does not draw`).toBe(true)
    }

    // Every body row's cells, column by column; a group row spans them and is left out.
    const rows = [...table.querySelectorAll('tbody tr')].filter(tr => ![...tr.children].some(td => td.colSpan > 1))
    expect(rows.length).toBeGreaterThan(0)
    for (const tr of rows) {
      expect([...tr.children].map(stepOf)).toEqual(heads.map(stepOf))
    }
    const cols = [...table.querySelectorAll('colgroup > col')]
    if (cols.length) expect(cols.map(stepOf)).toEqual(heads.map(stepOf))

    // The name stays at every width, and wraps after its separators before inside a word, reading
    // as written (breakAfterSeparators).
    expect(row.stays.length).toBeGreaterThan(0)
    expect(stepOf(named[0])).toBeNull()
    const nameCell = rows[0].children[heads.indexOf(named[0])]
    const name = nameCell.querySelector('strong') || nameCell.querySelector('.mono') || nameCell
    if (/[-_./:][^-_./:]/.test(name.textContent)) expect(name.querySelector('wbr'), `${key}: "${name.textContent}"`).toBeTruthy()
    expect(zeroWidth(table.textContent)).toEqual([])
  })
})

describe('App.css', () => {
  const blockOf = (query) => {
    const at = APP_CSS.indexOf(`@container table (${query}) {`)
    return at < 0 ? '' : APP_CSS.slice(at, APP_CSS.indexOf('\n}\n', at))
  }

  it('makes a list table\'s scroller the container the steps are read from', () => {
    expect(APP_CSS).toMatch(/\n\.table-wrap:has\(> \.table-fit\) \{[^}]*container: table \/ inline-size;/)
  })

  it.each(STEPS)('hides fit-%i below it, and moves the chevron to the last column shown', (n) => {
    const block = blockOf(`max-width: ${n - 1}px`)
    expect(block).toContain(`.table-fit:not(:has(.table-group-row)) .fit-${n} { display: none; }`)
    // A group row spans every column, so there the column stays in the grid at no width or height.
    expect(block).toContain(`.table-fit:has(.table-group-row) .fit-${n} { visibility: hidden; width: 0; padding: 0; font-size: 0; line-height: 0; }`)
    expect(block).toContain(`.table-fit:has(.table-group-row) .fit-${n} > * { display: none; }`)
    const wider = STEPS.filter(s => s >= n).map(s => `.fit-${s}`).join(', ')
    expect(block).toContain(`.table-fit tr.row-selectable > td:nth-last-child(1 of :not(${wider})) { --fit-chevron: ""; position: relative; padding-right: 40px; }`)
    // Where the cells have closed up, the last header shown keeps the room its sort arrow hangs in.
    if (n <= 880) expect(block).toContain(`.table-fit thead th:nth-last-child(1 of :not(${wider})) { padding-right: 16px; }`)
  })

  it('draws the moved chevron only where a step put it', () => {
    expect(APP_CSS).toContain('.table-fit tr.row-selectable > td:not(:last-child)::after {\n  content: var(--fit-chevron, none);')
  })

  it('cuts an id column to its share rather than widen it', () => {
    expect(APP_CSS).toContain('.table-fit td.fit-id { max-width: 0; }')
    expect(APP_CSS).toMatch(/\n\.table-fit \.fit-id \{ width: \d+%; \}/)
  })

  it('gives the Metrics tables no width of their own to scroll by', () => {
    expect(APP_CSS).not.toMatch(/\.metric-table[\w-]* \{[^}]*min-width/)
  })
})
