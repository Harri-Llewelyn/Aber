/**
 * Export CSV on History's Area and Metric tabs, in the dialog the Device, Overview and Cell tabs open.
 * The Area tab saves the machines behind its charts (every machine of the area's cells that reports the
 * metric), never the cells' means or totals; the Metric tab saves every device it lists under its filters,
 * all pages. Both are for an Administrator or a Shopfloor Manager, say before the dialog opens when the
 * window or the selection is more than one export may carry, keep raw as the default, and toast with a
 * link to the Audit Trail row. uPlot draws on a canvas jsdom does not have, so a stand-in is mounted.
 */
import React from 'react'
import { render, screen, waitFor, within, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { api } from '../api'
import { downloadCSV } from '../utils/downloadCSV'
import { telemetryKey } from '../utils/history'

const { polls } = vi.hoisted(() => ({ polls: [] }))

vi.mock('../hooks/usePolling', () => ({
  usePolling: (callback, intervalMs, enabled) => { polls.push({ callback, intervalMs, enabled }) },
}))

vi.mock('../utils/downloadCSV', () => ({ downloadCSV: vi.fn() }))

vi.mock('uplot', () => {
  class FakePlot {
    constructor(opts, data, target) {
      this.over = document.createElement('div')
      this.over.className = 'u-over'
      target.appendChild(this.over)
    }
    setSize() {}
    destroy() { this.over.remove() }
  }
  FakePlot.paths = { stepped: () => () => null }
  return { default: FakePlot }
})

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), readCarriedByGroup: vi.fn(), readCarriedTelemetry: vi.fn(), readTelemetryChanges: vi.fn(), readHourOfDay: vi.fn(),
      readAlertOccurrences: vi.fn(), exportTelemetry: vi.fn(), readDerivedSeries: vi.fn(),
    },
  }
})

const id = (n) => `2b3e0c4a-${n}${n}${n}${n}-4000-8000-00000000000${n}`
const LATHE3 = id(1)
const LATHE4 = id(2)
const MILL = id(3)
const ROBOT = id(4)
const WELD = id(5)
const METER = id(6)
const HALLC = id(7)
const keyOf = (asset_id) => telemetryKey({ asset_id })
const inCell = (cell) => ({ effective_cell_id: cell, location_source: 'inherited', status: 'ONLINE' })

// Boardroom has four cells. Turning and Milling hold the three machines that report Spindle/LOAD, Welding
// holds one that reports another metric, Robots one that reports a text metric. The Area-Wide meter
// reports Spindle/LOAD and is in no cell. Hall C is another area, whose machine reports it too.
const devices = [
  { asset_id: LATHE3, asset_name: 'Lathe 3', last_birth_metrics: ['Spindle/LOAD', 'Spindle/SPEED'], ...inCell('c1') },
  { asset_id: LATHE4, asset_name: 'Lathe 4', last_birth_metrics: ['Spindle/LOAD'], ...inCell('c1') },
  { asset_id: MILL, asset_name: 'Mill 2', last_birth_metrics: ['Spindle/LOAD', 'Coolant/TEMP'], ...inCell('c2'), status: 'OFFLINE' },
  { asset_id: WELD, asset_name: 'Weld bot', last_birth_metrics: ['Weld/CURRENT'], ...inCell('c3') },
  { asset_id: ROBOT, asset_name: 'Robot 5', last_birth_metrics: ['Controller/EXECUTION'], ...inCell('c4') },
  { asset_id: METER, asset_name: 'Area meter', last_birth_metrics: ['Spindle/LOAD'], effective_cell_id: null, location_source: 'area_wide', effective_area_id: 'a1', status: 'ONLINE' },
  { asset_id: HALLC, asset_name: 'Hall C mill', last_birth_metrics: ['Spindle/LOAD'], ...inCell('c5') },
]
const cells = [
  { cell_id: 'c1', cell_name: 'Turning', area_id: 'a1' },
  { cell_id: 'c2', cell_name: 'Milling', area_id: 'a1' },
  { cell_id: 'c3', cell_name: 'Welding', area_id: 'a1' },
  { cell_id: 'c4', cell_name: 'Robots', area_id: 'a1' },
  { cell_id: 'c5', cell_name: 'Hall C line', area_id: 'a2' },
]
const areas = [{ area_id: 'a1', area_name: 'Boardroom' }, { area_id: 'a2', area_name: 'Hall C' }]
const catalog = [
  { name: 'Spindle/LOAD', units: 'kW', datatype: 10 }, { name: 'Spindle/SPEED', units: 'rpm', datatype: 10 },
  { name: 'Coolant/TEMP', units: '°C', datatype: 10 }, { name: 'Controller/EXECUTION', datatype: 12 },
  { name: 'Weld/CURRENT', units: 'A', datatype: 10 },
]

/** Many machines that all report Spindle/LOAD, in one cell of Boardroom. */
const crowd = (n) => Array.from({ length: n }, (_, i) => ({
  asset_id: `2b3e0c4a-${String(i + 1).padStart(4, '0')}-4000-8000-000000000000`, asset_name: `Machine ${String(i + 1).padStart(4, '0')}`,
  last_birth_metrics: ['Spindle/LOAD'], ...inCell('c1'),
}))

const routeGet = (list, cat = catalog) => (path) => {
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(list)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(cells)
  if (path.startsWith('/api/v1/areas')) return Promise.resolve(areas)
  if (path.startsWith('/api/v1/schemas')) return Promise.resolve([])
  if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(cat)
  return Promise.resolve([])
}

/** An Administrator unless a test says otherwise: Export CSV is for an Administrator or a Shopfloor Manager. */
const visit = async (address, { userRole = 'Administrator', list = devices, cat = catalog } = {}) => {
  api.get.mockImplementation(routeGet(list, cat))
  window.history.pushState({}, '', address)
  const showToast = vi.fn()
  render(<HistoryTab showToast={showToast} userRole={userRole} />)
  await waitFor(() => expect(screen.queryByText(/Loading devices/)).not.toBeInTheDocument())
  return { showToast }
}

const DENIED = 'Requires Administrator or Shopfloor Manager'
// A derived metric every machine that reports Spindle/LOAD reports the input of: computed when drawn, never exported.
const DERIVED = 'Spindle/LOAD_RATE'
const withDerived = [...catalog, { name: DERIVED, units: 'kW/HOUR', datatype: 10, derivation: { kind: 'counter_rate', input: 'Spindle/LOAD' } }]
const DERIVED_NOTE = 'A derived metric is computed when it is drawn, and is not exported. Export its inputs.'
const toolbar = () => document.querySelector('.filter-bar-actions')
const exportButton = () => within(toolbar()).getByRole('button', { name: /Export CSV/ })
const asked = () => api.exportTelemetry.mock.calls.map(c => c[0])
const keysOf = (...ids) => ids.map(keyOf).sort()

beforeEach(() => {
  vi.clearAllMocks()
  polls.length = 0
  const width = (bucketMinutes) => bucketMinutes * 60000
  api.readCarriedByGroup.mockImplementation(({ from, bucketMinutes, groupKeys }) => Promise.resolve([...new Set(groupKeys)].map(group => ({
    group_key: group, bucket_ts: new Date(Math.floor(Date.parse(from) / width(bucketMinutes)) * width(bucketMinutes)).toISOString(),
    mean_double: 10, total_double: 30, members: 3, with_value: 3, measured: 1,
  }))))
  api.readCarriedTelemetry.mockResolvedValue([])
  api.readTelemetryChanges.mockResolvedValue([])
  api.readHourOfDay.mockResolvedValue([])
  api.readAlertOccurrences.mockResolvedValue([])
  api.readDerivedSeries.mockResolvedValue([])
  api.exportTelemetry.mockResolvedValue({
    audit_id: 41, resolution: 'raw', columns: ['time', 'asset_id', 'metric_name', 'value', 'unit'],
    rows: [LATHE3, LATHE4, MILL].map((asset, i) => ['2026-11-02T10:00:00.000Z', keyOf(asset), 'Spindle/LOAD', 4 + i, 'kW']), row_count: 3,
    max_rows: 50000, truncated: false, read_from: '2026-11-02T00:00:00.000Z', read_to: '2026-11-03T00:00:00.000Z', raw_from: null,
  })
  document.documentElement.setAttribute('data-theme', 'dark')
  document.documentElement.style.setProperty('--accent', '#00d4ff')
})

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--accent')
  window.history.pushState({}, '', '/')
})

describe("exporting an area's metric", () => {
  const open = async (address = '/history/area/a1?metric=Spindle%2FLOAD', options) => {
    const shown = await visit(address, options)
    await screen.findAllByRole('figure')
    return shown
  }

  it('sits after Clear filters and before the refresh control, as the Cell tab places it', async () => {
    await open('/history/area/a1?metric=Spindle%2FLOAD&agg=total')
    const order = [...toolbar().querySelectorAll('button, [role="group"]')]
      .filter(el => !el.closest('[role="group"]') || el.getAttribute('role') === 'group')
      .map(el => el.getAttribute('aria-label') || el.textContent.trim())
    // The metric and the total are the two filters set.
    expect(order).toEqual(['✕ Clear filters (2)', 'Export CSV', 'Refresh'])
    expect(exportButton()).toHaveClass('btn-primary')
  })

  it('saves the machines behind the charts, across the cells, and says the cells\' means are not in the file', async () => {
    const { showToast } = await open()
    const before = Date.now()
    fireEvent.click(exportButton())
    const dialog = await screen.findByRole('dialog', { name: /Export readings — 3 devices/ })
    expect(within(dialog).getByText(/^Boardroom · 3 machines in 2 cells · Spindle\/LOAD · Last 24 hours \(.+ – .+\)$/)).toBeInTheDocument()
    expect(within(dialog).getByText(/^The cells' means and totals are not in the file\. It holds each machine's own readings\./)).toBeInTheDocument()
    expect(within(dialog).getByText(/1 Area-Wide device is in no cell, so it is not in the file\.$/)).toBeInTheDocument()
    for (const name of ['Lathe 3', 'Lathe 4', 'Mill 2']) expect(within(dialog).getByText(name)).toBeInTheDocument()
    // Weld bot and Robot 5 do not report it, the meter is in no cell and Hall C is another area.
    for (const name of ['Weld bot', 'Robot 5', 'Area meter', 'Hall C mill']) expect(within(dialog).queryByText(name)).toBeNull()
    expect(within(dialog).getByRole('button', { name: /Raw samples/ })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(asked()).toHaveLength(1))
    const [call] = asked()
    expect([...call.assetIds].sort()).toEqual(keysOf(LATHE3, LATHE4, MILL))
    expect(call.metricNames).toEqual(['Spindle/LOAD'])
    expect(call.resolution).toBe('raw')
    expect(Date.parse(call.to) - Date.parse(call.from)).toBe(24 * 60 * 60 * 1000)
    expect(Date.parse(call.to)).toBeGreaterThanOrEqual(before)
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Exported 3 rows of 3 devices', 'success', { to: '/audit-trail?event=41' }))

    // One row a reading, a machine by its name: no cell and no mean is in the file.
    const [file] = downloadCSV.mock.calls[0]
    const [provenance, ...rows] = file
    expect(provenance.time).toMatch(/^# RESOLUTION: raw samples/)
    expect(rows.map(r => r.device).sort()).toEqual(['Lathe 3', 'Lathe 4', 'Mill 2'])
    expect(JSON.stringify(file)).not.toMatch(/Turning|Milling|mean|total/)
  })

  it('leaves the Area-Wide line out of the note where the area has none', async () => {
    await open('/history/area/a2?metric=Spindle%2FLOAD')
    fireEvent.click(exportButton())
    const dialog = await screen.findByRole('dialog', { name: /Export readings — Hall C mill/ })
    expect(within(dialog).getByText(/^Hall C · 1 machine in 1 cell · Spindle\/LOAD · /)).toBeInTheDocument()
    expect(within(dialog).queryByText(/Area-Wide/)).toBeNull()
  })

  it('exports the metric chosen, from the machines that report that one, whether the cells draw the mean or the total', async () => {
    await open('/history/area/a1?metric=Coolant%2FTEMP&agg=total')
    fireEvent.click(exportButton())
    const dialog = await screen.findByRole('dialog', { name: /Export readings — Mill 2/ })
    expect(within(dialog).getByText(/^Boardroom · 1 machine in 1 cell · Coolant\/TEMP · /)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(asked()).toHaveLength(1))
    expect(asked()[0].assetIds).toEqual(keysOf(MILL))
    expect(asked()[0].metricNames).toEqual(['Coolant/TEMP'])
  })

  it('exports the window as the time control holds it, fixed as the dialog opens', async () => {
    await open('/history/area/a1?metric=Spindle%2FLOAD&range=7d')
    fireEvent.click(exportButton())
    const dialog = await screen.findByRole('dialog', { name: /Export readings/ })
    expect(within(dialog).getByText(/ · Last 7 days \(/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(asked()).toHaveLength(1))
    expect(Date.parse(asked()[0].to) - Date.parse(asked()[0].from)).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('is for an Administrator or a Shopfloor Manager, and greyed for the others, saying who may', async () => {
    for (const role of ['Administrator', 'Shopfloor_Manager']) {
      await open(undefined, { userRole: role })
      expect(exportButton()).not.toBeDisabled()
      cleanup()
    }
    for (const role of ['Operator', 'Auditor', null]) {
      await open(undefined, { userRole: role })
      expect(exportButton()).toBeDisabled()
      expect(exportButton()).toHaveClass('btn-disabled')
      expect(exportButton()).toHaveAccessibleDescription(DENIED)
      fireEvent.click(exportButton())
      expect(screen.queryByRole('dialog', { name: /Export readings/ })).toBeNull()
      // The charts stay.
      expect(screen.getAllByRole('figure').length).toBeGreaterThan(0)
      cleanup()
    }
    expect(asked()).toEqual([])
  })

  it('says it is off before anything is asked when the window is over the limit', async () => {
    await open('/history/area/a1?metric=Spindle%2FLOAD&range=30d')
    expect(exportButton()).toBeDisabled()
    expect(exportButton()).toHaveAccessibleDescription('An export can cover at most 14 days, set on Settings › History. This window is 30 days.')
    fireEvent.click(exportButton())
    expect(screen.queryByRole('dialog', { name: /Export readings/ })).toBeNull()
    expect(asked()).toEqual([])
  })

  it('says it is off before anything is asked when the machines are more than one export names', async () => {
    await visit('/history/area/a1?metric=Spindle%2FLOAD', { list: crowd(1001) })
    await waitFor(() => expect(exportButton()).toBeDisabled())
    expect(exportButton()).toHaveAccessibleDescription('An export names at most 1,000 devices, and this selection has 1,001.')
    fireEvent.click(exportButton())
    expect(screen.queryByRole('dialog', { name: /Export readings/ })).toBeNull()
    expect(asked()).toEqual([])
  })

  it('takes exactly the most one export names, every machine of them', async () => {
    await visit('/history/area/a1?metric=Spindle%2FLOAD', { list: crowd(1000) })
    await waitFor(() => expect(exportButton()).not.toBeDisabled())
    fireEvent.click(exportButton())
    const dialog = await screen.findByRole('dialog', { name: /Export readings — 1,?000 devices/ })
    expect(within(dialog).getByText(/^Boardroom · 1,000 machines in 1 cell · Spindle\/LOAD · /)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(asked()).toHaveLength(1))
    expect(new Set(asked()[0].assetIds).size).toBe(1000)
  })

  it('is off for a text or flag metric, which has no mean or total to draw, and points to the Cell tab', async () => {
    await visit('/history/area/a1?metric=Controller%2FEXECUTION')
    await screen.findAllByText(/A mean or a total needs a number/)
    expect(exportButton()).toBeDisabled()
    expect(exportButton()).toHaveAccessibleDescription('Controller/EXECUTION is text or a flag, so this tab draws no mean or total of it and has nothing to export. The Cell tab exports it.')
  })

  it('is off for a derived metric, which is computed when drawn and holds no reading to export', async () => {
    await visit(`/history/area/a1?metric=${encodeURIComponent(DERIVED)}`, { cat: withDerived })
    await waitFor(() => expect(api.readDerivedSeries).toHaveBeenCalled())
    expect(exportButton()).toBeDisabled()
    expect(exportButton()).toHaveAccessibleDescription(DERIVED_NOTE)
  })

  it('is off for an area with no machine in service, which has no metric to export', async () => {
    await visit('/history/area/a1?metric=Spindle%2FLOAD', { list: [] })
    await screen.findByText(/The machines in this area have declared no metrics/)
    expect(exportButton()).toBeDisabled()
    expect(exportButton()).toHaveAccessibleDescription('This area has no metric to export.')
    fireEvent.click(exportButton())
    expect(screen.queryByRole('dialog', { name: /Export readings/ })).toBeNull()
  })

  it('shows the database\'s own refusal in the dialog and keeps it open', async () => {
    api.exportTelemetry.mockRejectedValue(new Error('An export can cover at most 7 days, set on Settings › History. This window is 14 days.'))
    const { showToast } = await open()
    fireEvent.click(exportButton())
    const dialog = await screen.findByRole('dialog', { name: /Export readings/ })
    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    expect(await within(dialog).findByText(/An export can cover at most 7 days/)).toBeInTheDocument()
    expect(showToast).not.toHaveBeenCalled()
    expect(downloadCSV).not.toHaveBeenCalled()
  })
})

describe('exporting a metric across devices', () => {
  const open = async (address = '/history/metric/Spindle%2FLOAD', options) => {
    const shown = await visit(address, options)
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    return shown
  }

  it('sits after Clear filters and before the refresh control, as the Cell tab places it', async () => {
    await open('/history/metric/Spindle%2FLOAD?area=a1&range=7d')
    const order = [...toolbar().querySelectorAll('button, [role="group"]')]
      .filter(el => !el.closest('[role="group"]') || el.getAttribute('role') === 'group')
      .map(el => el.getAttribute('aria-label') || el.textContent.trim())
    expect(order).toEqual(['✕ Clear filters (2)', 'Export CSV', 'Refresh'])
    expect(exportButton()).toHaveClass('btn-primary')
  })

  it('saves every device the tab lists, wherever it sits, as raw, and toasts with the row\'s link', async () => {
    api.exportTelemetry.mockResolvedValue({
      audit_id: 52, resolution: 'raw', columns: ['time', 'asset_id', 'metric_name', 'value', 'unit'],
      rows: [[ '2026-11-02T10:00:00.000Z', keyOf(HALLC), 'Spindle/LOAD', 4, 'kW']], row_count: 1,
      max_rows: 50000, truncated: false, read_from: '2026-11-02T00:00:00.000Z', read_to: '2026-11-03T00:00:00.000Z', raw_from: null,
    })
    const { showToast } = await open()
    const before = Date.now()
    fireEvent.click(exportButton())
    const dialog = await screen.findByRole('dialog', { name: /Export readings — 5 devices/ })
    expect(within(dialog).getByText(/^5 devices · Spindle\/LOAD · Last 24 hours \(.+ – .+\)$/)).toBeInTheDocument()
    // Not paged: nothing to add to the first line.
    expect(within(dialog).queryByText(/not only the/)).toBeNull()
    for (const name of ['Lathe 3', 'Lathe 4', 'Mill 2', 'Area meter', 'Hall C mill']) expect(within(dialog).getByText(name)).toBeInTheDocument()
    expect(within(dialog).queryByText('Weld bot')).toBeNull()
    expect(within(dialog).getByRole('button', { name: /Raw samples/ })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(asked()).toHaveLength(1))
    const [call] = asked()
    expect([...call.assetIds].sort()).toEqual(keysOf(LATHE3, LATHE4, MILL, METER, HALLC))
    expect(call.metricNames).toEqual(['Spindle/LOAD'])
    expect(call.resolution).toBe('raw')
    expect(Date.parse(call.to) - Date.parse(call.from)).toBe(24 * 60 * 60 * 1000)
    expect(Date.parse(call.to)).toBeGreaterThanOrEqual(before)
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Exported 1 row of 5 devices', 'success', { to: '/audit-trail?event=52' }))
    const [file] = downloadCSV.mock.calls[0]
    expect(file[1].device).toBe('Hall C mill')
  })

  it('saves the devices the filters leave, and says how many of those that report the metric', async () => {
    await open('/history/metric/Spindle%2FLOAD?area=a1')
    fireEvent.click(exportButton())
    // Boardroom's three cells' machines and its Area-Wide meter; Hall C's machine is left out.
    const dialog = await screen.findByRole('dialog', { name: /Export readings — 4 devices/ })
    expect(within(dialog).getByText(/^4 of 5 devices · Spindle\/LOAD · /)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(asked()).toHaveLength(1))
    expect([...asked()[0].assetIds].sort()).toEqual(keysOf(LATHE3, LATHE4, MILL, METER))
    cleanup()
    api.exportTelemetry.mockClear()

    // A list of devices, as Overview's selection box sends it.
    await open(`/history/metric/Spindle%2FLOAD?devices=${keysOf(LATHE4, HALLC).join(',')}`)
    fireEvent.click(exportButton())
    const again = await screen.findByRole('dialog', { name: /Export readings — 2 devices/ })
    expect(within(again).getByText(/^2 of 5 devices · Spindle\/LOAD · /)).toBeInTheDocument()
    fireEvent.click(within(again).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(asked()).toHaveLength(1))
    expect([...asked()[0].assetIds].sort()).toEqual(keysOf(LATHE4, HALLC))
  })

  it('saves every page, not only the one shown, and says so in the dialog', async () => {
    const list = crowd(250)
    await open('/history/metric/Spindle%2FLOAD?page=2', { list })
    expect(await screen.findByText(/250 devices are too many to chart at once, so they come 12 to a page: devices 13 to 24\./)).toBeInTheDocument()
    expect(api.readCarriedTelemetry.mock.calls.at(-1)[0].assetIds).toHaveLength(12)
    fireEvent.click(exportButton())
    const dialog = await screen.findByRole('dialog', { name: /Export readings — 250 devices/ })
    expect(within(dialog).getByText(/^250 devices · Spindle\/LOAD · /)).toBeInTheDocument()
    expect(within(dialog).getByText('The file holds all 250 devices the tab lists, not only the 12 on this page.')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(asked()).toHaveLength(1))
    expect([...asked()[0].assetIds].sort()).toEqual(list.map(d => keyOf(d.asset_id)).sort())
  })

  it('is for an Administrator or a Shopfloor Manager, and greyed for the others, saying who may', async () => {
    for (const role of ['Administrator', 'Shopfloor_Manager']) {
      await open(undefined, { userRole: role })
      expect(exportButton()).not.toBeDisabled()
      cleanup()
      vi.clearAllMocks()
      api.readCarriedTelemetry.mockResolvedValue([])
      api.readTelemetryChanges.mockResolvedValue([])
      api.readAlertOccurrences.mockResolvedValue([])
    }
    for (const role of ['Operator', 'Auditor', null]) {
      await open(undefined, { userRole: role })
      expect(exportButton()).toBeDisabled()
      expect(exportButton()).toHaveClass('btn-disabled')
      expect(exportButton()).toHaveAccessibleDescription(DENIED)
      fireEvent.click(exportButton())
      expect(screen.queryByRole('dialog', { name: /Export readings/ })).toBeNull()
      // The charts stay.
      expect(screen.getAllByRole('figure').length).toBeGreaterThan(0)
      cleanup()
    }
    expect(asked()).toEqual([])
  })

  it('says it is off before anything is asked when the window is over the limit', async () => {
    await open('/history/metric/Spindle%2FLOAD?range=30d')
    expect(exportButton()).toBeDisabled()
    expect(exportButton()).toHaveAccessibleDescription('An export can cover at most 14 days, set on Settings › History. This window is 30 days.')
    fireEvent.click(exportButton())
    expect(screen.queryByRole('dialog', { name: /Export readings/ })).toBeNull()
    expect(asked()).toEqual([])
  })

  it('says it is off before anything is asked when the devices are more than one export names', async () => {
    await open('/history/metric/Spindle%2FLOAD', { list: crowd(1001) })
    expect(exportButton()).toBeDisabled()
    expect(exportButton()).toHaveAccessibleDescription('An export names at most 1,000 devices, and this selection has 1,001.')
    fireEvent.click(exportButton())
    expect(screen.queryByRole('dialog', { name: /Export readings/ })).toBeNull()
    expect(asked()).toEqual([])
    cleanup()

    // A filter that brings them under the bound turns it on, and the dialog names the share.
    const list = [...crowd(1001), { ...devices[0], asset_id: id(8), asset_name: 'Lathe 8', effective_cell_id: 'c2' }]
    await open('/history/metric/Spindle%2FLOAD?cell=c2', { list })
    expect(exportButton()).not.toBeDisabled()
  })

  it('takes exactly the most one export names, every device of them, over all the pages', async () => {
    await open('/history/metric/Spindle%2FLOAD', { list: crowd(1000) })
    expect(exportButton()).not.toBeDisabled()
    fireEvent.click(exportButton())
    const dialog = await screen.findByRole('dialog', { name: /Export readings — 1,?000 devices/ })
    expect(within(dialog).getByText(/^1,000 devices · Spindle\/LOAD · /)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(asked()).toHaveLength(1))
    expect(new Set(asked()[0].assetIds).size).toBe(1000)
  })

  it('is off where the filters leave no device, and where no device reports the metric', async () => {
    await visit('/history/metric/Spindle%2FLOAD?area=a1&cell=c5')
    await screen.findAllByText(/No device that reports Spindle\/LOAD is in the area, cell or devices chosen/)
    expect(exportButton()).toBeDisabled()
    expect(exportButton()).toHaveAccessibleDescription('No device that reports Spindle/LOAD is in the area, cell or devices chosen, so there is nothing to export.')
    cleanup()
    await visit('/history/metric/No%2FSuchMetric')
    await screen.findByText('No device in service reports No/SuchMetric.')
    expect(exportButton()).toBeDisabled()
    expect(exportButton()).toHaveAccessibleDescription('No device in service reports No/SuchMetric, so there is nothing to export.')
  })

  it('is off for a derived metric, which is computed when drawn and holds no reading to export', async () => {
    await visit(`/history/metric/${encodeURIComponent(DERIVED)}`, { cat: withDerived })
    await waitFor(() => expect(api.readDerivedSeries).toHaveBeenCalled())
    expect(exportButton()).toBeDisabled()
    expect(exportButton()).toHaveAccessibleDescription(DERIVED_NOTE)
  })

  it('takes a text or flag metric as the Cell tab does', async () => {
    await visit('/history/metric/Controller%2FEXECUTION')
    await waitFor(() => expect(api.readTelemetryChanges).toHaveBeenCalled())
    fireEvent.click(exportButton())
    const dialog = await screen.findByRole('dialog', { name: /Export readings — Robot 5/ })
    expect(within(dialog).getByText(/^1 device · Controller\/EXECUTION · /)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(asked()).toHaveLength(1))
    expect(asked()[0].assetIds).toEqual(keysOf(ROBOT))
    expect(asked()[0].metricNames).toEqual(['Controller/EXECUTION'])
  })
})
