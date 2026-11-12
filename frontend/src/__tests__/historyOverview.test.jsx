/**
 * History's Overview: a lane per device, grouped as the Site Map places devices, each a strip of
 * blocks darker where more readings arrived, read from telemetry_coverage() (0245). Its groups and
 * what this browser remembers of them, the shades and the words, the block widths a selection may
 * take, what the rollups have not counted yet, the selection box with Chart, Zoom and Export, the tick
 * boxes, the address, the default tab, and a thousand lanes. In London's zone on Monday 2 November
 * 2026 at 15:20.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { placeReadout, placeSelection } from '../components/tabs/HistoryOverview'
import { ARROW_INSET } from '../components/common/Tooltip'
import { api, COVERAGE_SMALL_SELECTION } from '../api'
import { deviceHistoryUrl } from '../routes'
import { groupDevicesByCell, SOURCE_SIMULATED, SOURCE_SITE_WIDE, SOURCE_UNASSIGNED } from '../utils/cellResolution'
import { pathSegments } from '../hooks/useUrlState'
import {
  AREA_WIDE_GROUP, COVERAGE_KEY, DEFAULT_HISTORY_WINDOW, OVERVIEW_GROUPS_KEY, OVERVIEW_OPEN_LANES_MAX,
  TOO_LONG_FOR_MANY, UNFILED_GROUP, boxWords, coverageBlock, coverageCounts, coverageRuns, coverageSteps, groupIsOpen,
  historyPath, overviewAddress, overviewGroups, readOverviewGroups, readingsStopWords, telemetryKey, uncountedStretches,
  intervalMinutes, readWidth, uncountedWords, writeOverviewGroups,
} from '../utils/history'

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

const MACHINE_TZ = process.env.TZ
process.env.TZ = 'Europe/London'
afterAll(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ
  else process.env.TZ = MACHINE_TZ
})

const { polls } = vi.hoisted(() => ({ polls: [] }))
vi.mock('../hooks/usePolling', () => ({
  usePolling: (callback, intervalMs, enabled) => { polls.push({ callback, intervalMs, enabled }) },
}))
vi.mock('uplot', () => {
  class FakePlot { constructor() { this.over = document.createElement('div') } setSize() {} destroy() {} }
  FakePlot.paths = { stepped: () => () => null }
  return { default: FakePlot }
})
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), readCoverage: vi.fn(), readCarriedTelemetry: vi.fn(), exportTelemetry: vi.fn() } }
})

const uuid = (n) => `2b3e0c4a-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`
const place = (n, name, location, extra = {}) => ({
  asset_id: uuid(n), asset_name: name, status: 'ONLINE', last_birth_metrics: ['Spindle/LOAD', 'Spindle/SPEED'], ...location, ...extra,
})
const inCell = (cell) => ({ location_source: 'explicit', effective_cell_id: cell })
const LATHE = place(1, 'Lathe 3', inCell('c1'))
const PRESS = place(2, 'Press 1', inCell('c1'), { status: 'OFFLINE' })
const MILL = place(3, 'Mill 2', inCell('c2'))
const ROBOT = place(4, 'Robot 5', { location_source: 'area_wide', effective_area_id: 'a1' })
const SPARE = place(5, 'Spare rig', inCell('c3'))
const MOBILE = place(6, 'Forklift', { location_source: SOURCE_SITE_WIDE })
const SIM = place(7, 'Simulator', { location_source: SOURCE_SIMULATED })
const LONELY = place(8, 'Unfiled pump', { location_source: SOURCE_UNASSIGNED })
const OLD = place(9, 'Old lathe', inCell('c1'), { is_archived: true })
const STRANGER = place(10, 'Stranger', { location_source: SOURCE_UNASSIGNED }, { is_quarantined: true })
const DEVICES = [LATHE, PRESS, MILL, ROBOT, SPARE, MOBILE, SIM, LONELY, OLD, STRANGER]
const CELLS = [
  { cell_id: 'c1', cell_name: 'Turning', name: 'Turning', area_id: 'a1' },
  { cell_id: 'c2', cell_name: 'Milling', name: 'Milling', area_id: 'a1' },
  { cell_id: 'c3', cell_name: 'Spare bay', name: 'Spare bay', area_id: null },
  { cell_id: 'c4', cell_name: 'Empty', name: 'Empty', area_id: 'a1' },
]
const AREAS = [{ area_id: 'a1', area_name: 'Hall B', name: 'Hall B' }, { area_id: 'a2', area_name: 'Annex', name: 'Annex', is_archived: true }]

let fleet = DEVICES
let counted = { computed_from: '-infinity', computed_to: 'infinity', complete: true }
/** Where the 5-minute rollup reaches back to: a window older than this comes back in hours, as 0245 reads it. */
let fiveMinuteReach = -Infinity
/** A row per device: 6 readings in every block but the last third, where Press has none. */
const coverage = ({ from, to, blockMinutes: asked, assetIds }) => {
  const blockMinutes = asked < 60 && Date.parse(from) < fiveMinuteReach ? 60 : asked
  const width = blockMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  const blocks = Math.ceil((Date.parse(to) - first) / width)
  return Promise.resolve(assetIds.map(id => ({
    asset_id: id, first_block: new Date(first).toISOString(),
    block_width: `${String(Math.floor(blockMinutes / 60)).padStart(2, '0')}:${String(blockMinutes % 60).padStart(2, '0')}:00`,
    counts: Array.from({ length: blocks }, (_, i) => (id === telemetryKey(PRESS) && i > blocks * 0.6 ? 0 : 6)),
    ...counted,
  })))
}
const routeGet = (path) => {
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(fleet)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(CELLS)
  if (path.startsWith('/api/v1/areas')) return Promise.resolve(AREAS)
  return Promise.resolve([])
}

const LEFT = 100
let originalRect
beforeEach(() => {
  vi.clearAllMocks()
  polls.length = 0
  fleet = DEVICES
  fiveMinuteReach = -Infinity
  counted = { computed_from: '-infinity', computed_to: 'infinity', complete: true }
  window.localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 2, 15, 20))
  api.get.mockImplementation(routeGet)
  api.readCoverage.mockImplementation(coverage)
  originalRect = Element.prototype.getBoundingClientRect
  // Every track is 1000px wide from x = 100; each row is 30px tall, in the order drawn, and the
  // scroll area ends with the last of them.
  const rowAt = (el) => [...document.querySelectorAll('[data-lanes]')].indexOf(el)
  Element.prototype.getBoundingClientRect = function rect() {
    if (this.classList?.contains('trail-track')) {
      const i = Math.max(0, rowAt(this.parentElement))
      return { left: LEFT, right: LEFT + 1000, width: 1000, top: i * 30, bottom: i * 30 + 28, height: 28 }
    }
    if (this.classList?.contains('trail-scroll')) {
      const n = document.querySelectorAll('[data-lanes]').length
      return { left: 0, right: 1200, width: 1200, top: 0, bottom: n * 30, height: n * 30 }
    }
    if (this.classList?.contains('overview-box-layer')) return { left: LEFT, right: LEFT + 1000, width: 1000, top: 0, bottom: 900, height: 900 }
    if (this.dataset?.lanes !== undefined) {
      const i = rowAt(this)
      return { left: 0, right: 1200, width: 1200, top: i * 30, bottom: i * 30 + 30, height: 30 }
    }
    return originalRect.call(this)
  }
})
afterEach(() => {
  vi.useRealTimers()
  Element.prototype.getBoundingClientRect = originalRect
  window.history.replaceState(null, '', '/')
})

/** An Administrator unless a test says otherwise: Export CSV is for an Administrator or a Shopfloor Manager. */
const visit = async (address, { userRole = 'Administrator' } = {}) => {
  window.history.replaceState(null, '', address)
  const showToast = vi.fn()
  render(<HistoryTab showToast={showToast} userRole={userRole} />)
  await waitFor(() => expect(document.querySelector('.overview-swimlanes, .empty-state, .callout')).toBeTruthy())
  return { showToast }
}
const lanes = () => [...document.querySelectorAll('.overview-lane')]
const laneNamed = (name) => lanes().find(l => within(l).queryByText(name))
const rowOf = (el) => [...document.querySelectorAll('[data-lanes]')].indexOf(el)
const toolbarChart = () => within(document.querySelector('.filter-bar-actions')).getByRole('button', { name: /Chart/ })
const mouse = (clientX, clientY, extra = {}) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX, clientY, ...extra })
const search = () => window.location.search

describe('the groups, as the Site Map places devices', () => {
  it('puts each device where the Site Map does: areas and their cells, the unfiled cells, then the three lanes', () => {
    const groups = overviewGroups(DEVICES, CELLS, AREAS)
    expect(groups.map(g => g.label)).toEqual(['Hall B', UNFILED_GROUP, 'Site-Wide', 'Simulated', 'Unassigned'])
    expect(groups[0].groups.map(g => [g.label, g.devices.map(d => d.asset_name)])).toEqual([
      ['Milling', ['Mill 2']], ['Turning', ['Lathe 3', 'Press 1']], [AREA_WIDE_GROUP, ['Robot 5']],
    ])
    expect(groups[0].devices.map(d => d.asset_name)).toEqual(['Mill 2', 'Lathe 3', 'Press 1', 'Robot 5'])
    expect(groups[1].groups.map(g => g.label)).toEqual(['Spare bay'])
    // Each cell's devices are the Site Map's own grouping (groupDevicesByCell()), archived left off.
    const byCell = groupDevicesByCell(DEVICES.filter(d => !d.is_archived))
    expect(groups[0].groups[1].devices).toEqual(byCell.get('c1'))
    expect(groups.flatMap(g => g.devices).map(d => d.asset_name)).not.toContain('Old lathe')
    // The empty cell and the archived area draw nothing.
    expect(JSON.stringify(groups)).not.toMatch(/"Empty"|"Annex"/)
  })

  it('remembers what this browser opened and closed, and starts closed past 200 lanes', () => {
    expect(readOverviewGroups()).toEqual({})
    writeOverviewGroups({ 'area:a1': false, 'cell:c1': true })
    expect(JSON.parse(window.localStorage.getItem(OVERVIEW_GROUPS_KEY))).toEqual({ 'area:a1': false, 'cell:c1': true })
    expect(readOverviewGroups()).toEqual({ 'area:a1': false, 'cell:c1': true })
    window.localStorage.setItem(OVERVIEW_GROUPS_KEY, '[1,2]')
    expect(readOverviewGroups()).toEqual({})
    window.localStorage.setItem(OVERVIEW_GROUPS_KEY, '{"a":true,"b":"yes"}')
    expect(readOverviewGroups()).toEqual({ a: true })
    expect(groupIsOpen('x', {}, OVERVIEW_OPEN_LANES_MAX)).toBe(true)
    expect(groupIsOpen('x', {}, OVERVIEW_OPEN_LANES_MAX + 1)).toBe(false)
    expect(groupIsOpen('x', { x: true }, 5000)).toBe(true)
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('refused') })
    expect(readOverviewGroups()).toEqual({})
    get.mockRestore()
  })
})

describe("a strip's shades and words", () => {
  it('steps each block against the busiest, and draws a run of one shade as one box', () => {
    expect(coverageSteps([0, 1, 25, 26, 50, 75, 100])).toEqual([0, 1, 1, 2, 2, 3, 4])
    expect(coverageRuns([0, 4, 4, 0, 1, 1, 2])).toEqual([{ from: 1, to: 3, step: 4 }, { from: 4, to: 6, step: 1 }, { from: 6, to: 7, step: 2 }])
    expect(COVERAGE_KEY).toMatchObject({ fewer: 'Fewer readings', more: 'More readings', none: 'No readings' })
  })

  it('says where the readings stop once a whole block has passed, and only inside what is counted', () => {
    const day = new Date(2026, 10, 2).getTime()
    const starts = Array.from({ length: 24 }, (_, h) => (day + h * 3600000) / 1000)
    const span = { start: day, end: day + 24 * 3600000, now: new Date(2026, 10, 2, 15, 20).getTime() }
    const counts = starts.map((_, h) => (h < 13 ? 5 : 0))
    expect(readingsStopWords(counts, starts, 60, span)).toBe('No readings since 13:00')
    expect(readingsStopWords(starts.map((_, h) => (h <= 14 ? 5 : 0)), starts, 60, span)).toBeNull()
    expect(readingsStopWords(new Array(24).fill(0), starts, 60, span)).toBe('No readings in this window')
    // The rollup has counted only to 13:30: nothing after it is a gap yet.
    expect(readingsStopWords(counts, starts, 60, { ...span, counted: { from: -Infinity, to: day + 13.5 * 3600000 } })).toBeNull()
    const yesterday = starts.map(s => s - 86400)
    expect(readingsStopWords(counts, yesterday, 60, { ...span, start: day - 86400000, end: day })).toBe('No readings since 1 Nov 13:00')
  })

  it("states a box's size in words, as the band's", () => {
    expect(boxWords(3, new Date(2026, 10, 2, 10, 5).getTime(), new Date(2026, 10, 2, 14, 20).getTime()))
      .toBe('3 devices · 10:05 – 14:20, 4 h 15 min')
    expect(boxWords(1, new Date(2026, 10, 2, 10, 5).getTime(), new Date(2026, 10, 2, 10, 40).getTime()))
      .toBe('1 device · 10:05 – 10:40, 35 min')
  })
})

describe('the blocks a selection takes', () => {
  const day = new Date(2026, 10, 2).getTime()
  const h = 3600000
  it('gives a large selection the device rollups\' own widths, and no more than 7 days', () => {
    expect(coverageBlock(day, day + 24 * h, 1550, 1000)).toBe(5)
    expect(coverageBlock(day, day + 26 * h, 1550, 41)).toBe(5)
    expect(coverageBlock(day, day + 7 * 24 * h, 1550, 1000)).toBe(60)
    expect(coverageBlock(day, day + 8 * 24 * h, 1550, 1000)).toBeNull()
  })
  it(`gives ${COVERAGE_SMALL_SELECTION} devices or fewer about one block per 4 px`, () => {
    expect(coverageBlock(day, day + 24 * h, 1550, COVERAGE_SMALL_SELECTION)).toBe(5)
    expect(coverageBlock(day, day + 7 * 24 * h, 1550, 20)).toBe(30)
    expect(coverageBlock(day, day + 30 * 24 * h, 1550, 20)).toBe(120)
    expect(coverageBlock(day, day + 366 * 24 * h, 1550, 20)).toBe(1440)
    // Nothing finer than the 5-minute rollup, however wide the strip.
    expect(coverageBlock(day, day + h, 1550, 1)).toBe(5)
  })
  it('lays the rows on the devices asked for, and keeps the narrowest counted stretch', () => {
    const { counts, counted: c } = coverageCounts([
      { asset_id: 'a', counts: [1, 2, 3], computed_from: '2026-11-01T00:00:00Z', computed_to: '2026-11-02T15:00:00Z', complete: false },
      { asset_id: 'b', counts: [4, 5, 6], computed_from: '2026-10-31T00:00:00Z', computed_to: '2026-11-02T15:10:00Z', complete: true },
    ], ['a', 'b', 'c'], 3)
    expect([...counts]).toEqual([['a', [1, 2, 3]], ['b', [4, 5, 6]], ['c', [0, 0, 0]]])
    expect(c).toEqual({ from: Date.parse('2026-11-01T00:00:00Z'), to: Date.parse('2026-11-02T15:00:00Z'), complete: false })
    const infinite = coverageCounts([{ asset_id: 'a', counts: [1], computed_from: '-infinity', computed_to: 'infinity', complete: true }], ['a'], 1)
    expect(infinite.counted).toEqual({ from: -Infinity, to: Infinity, complete: true })
  })
  it('reads the width a read comes back in', () => {
    expect(intervalMinutes('00:05:00')).toBe(5)
    expect(intervalMinutes('01:00:00')).toBe(60)
    expect(intervalMinutes('24:00:00')).toBe(1440)
    expect(intervalMinutes('1 day 02:00:00')).toBe(1560)
    expect(intervalMinutes('soon')).toBeNull()
    expect(readWidth([{ block_width: '01:00:00' }], 5)).toBe(60)
    expect(readWidth([], 5)).toBe(5)
  })
  it('names the stretch not counted yet, apart from the future', () => {
    const span = { start: day, end: day + 24 * h, now: day + 15 * h }
    expect(uncountedStretches({ from: day + 6 * h, to: day + 14 * h }, span)).toEqual([{ lo: 0, hi: 0.25 }, { lo: 14 / 24, hi: 15 / 24 }])
    expect(uncountedStretches({ from: -Infinity, to: Infinity }, span)).toEqual([])
    expect(uncountedWords({ from: day + 6 * h, complete: false }, day)).toBe('Coverage before 2 Nov is still being computed')
    expect(uncountedWords({ from: day + 6 * h, complete: true }, day)).toBe('Coverage is kept from 2 Nov')
    expect(uncountedWords({ from: day - h, complete: false }, day)).toBeNull()
  })
})

describe("Overview's address", () => {
  it('opens on /history and /history/overview, and keeps the window and the devices ticked', () => {
    expect(historyPath(pathSegments('/history'))).toEqual({ tab: 'overview', deviceId: '' })
    const address = overviewAddress({ kind: 'calendar', span: 'week', at: '2026-11-02' }, { devices: ['dev1', 'dev2'] })
    expect(address).toBe('/history/overview?span=week&at=2026-11-02&device=dev1,dev2')
    expect(historyPath(pathSegments(address))).toEqual({ tab: 'overview', deviceId: '' })
    expect(overviewAddress(DEFAULT_HISTORY_WINDOW)).toBe('/history/overview')
    // The drawers' History action still opens the Device tab with its device.
    expect(historyPath(pathSegments(deviceHistoryUrl(LATHE.asset_id)))).toEqual({ tab: 'device', deviceId: LATHE.asset_id })
  })
})

describe("History's Overview", () => {
  it('is the first tab and the default, and reads every device in service', async () => {
    await visit('/history?span=day&at=2026-11-02')
    const tabs = screen.getByRole('navigation', { name: 'History' })
    expect(within(tabs).getAllByRole('link').map(a => a.textContent)).toEqual(['Overview', 'Device', 'Metric', 'Cell', 'Area', 'Alerts'])
    expect(within(tabs).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
    expect(within(tabs).getByRole('link', { name: 'Device' })).toHaveAttribute('href', '/history/device')
    const asked = api.readCoverage.mock.calls[0][0]
    expect(asked.assetIds.sort()).toEqual([LATHE, PRESS, MILL, ROBOT, SPARE, MOBILE, SIM, LONELY].map(telemetryKey).sort())
    expect(asked.blockMinutes).toBe(10)
    expect(document.querySelector('.history-meta').textContent).toMatch(/^8 devices, in 10-minute blocks/)
    // Every group is open: eight lanes, each with its name, status and metric count.
    expect(lanes()).toHaveLength(8)
    expect(within(laneNamed('Press 1')).getByText('Offline')).toBeInTheDocument()
    expect(within(laneNamed('Lathe 3')).getByText('2 metrics')).toBeInTheDocument()
    expect(within(laneNamed('Press 1')).getByText(/^No readings since /)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Turning/ })).toHaveTextContent('Turning· 2 devices')
    // Export CSV is for the devices ticked or boxed, so there is none before one is picked.
    expect(screen.queryByRole('button', { name: /Export CSV/ })).not.toBeInTheDocument()
  })

  it('closes a group to one strip of its devices merged, and remembers it', async () => {
    await visit('/history/overview?span=day&at=2026-11-02')
    fireEvent.click(screen.getByRole('button', { name: /Turning/ }))
    expect(laneNamed('Lathe 3')).toBeUndefined()
    expect(document.querySelector('.trail-section-closed .overview-track').getAttribute('aria-label')).toMatch(/^Turning, 2 devices merged/)
    expect(readOverviewGroups()).toEqual({ 'cell:c1': false })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(lanes()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(lanes()).toHaveLength(8)
  })

  it('charts one ticked device from the toolbar on the Device tab, and several on the Metric tab', async () => {
    await visit('/history/overview?span=day&at=2026-11-02')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Lathe 3' }))
    expect(new URLSearchParams(search()).get('device')).toBe(telemetryKey(LATHE))
    const chart = toolbarChart()
    expect(chart).not.toHaveAttribute('aria-disabled')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Mill 2' }))
    // Two devices open the Metric tab on the metric both report, narrowed to them, at the window shown.
    expect(toolbarChart()).not.toHaveAttribute('aria-disabled')
    fireEvent.click(toolbarChart())
    expect(window.location.pathname).toBe('/history/metric/Spindle%2FLOAD')
    const asked = new URLSearchParams(search())
    expect(asked.get('span')).toBe('day')
    expect(asked.get('at')).toBe('2026-11-02')
    expect(asked.get('devices').split(',').sort()).toEqual([LATHE, MILL].map(telemetryKey).sort())
  })

  it('charts one ticked device on the Device tab', async () => {
    await visit('/history/overview?span=day&at=2026-11-02')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Lathe 3' }))
    fireEvent.click(toolbarChart())
    expect(window.location.pathname).toBe(`/history/device/${telemetryKey(LATHE)}`)
    expect(search()).toBe('?span=day&at=2026-11-02')
  })

  it('draws a box across lanes and time, named on the axis, with its actions in a popover beside it', async () => {
    await visit('/history/overview?span=day&at=2026-11-02')
    const strips = [...document.querySelectorAll('.overview-lane .overview-track')]
    const rowY = (name) => [...document.querySelectorAll('[data-lanes]')].indexOf(laneNamed(name)) * 30 + 15
    // 10:00 to 14:00 of the day, across Milling's and Turning's three lanes.
    const x = (hour) => LEFT + (1000 * hour) / 24
    fireEvent.pointerDown(strips[0], mouse(x(10), rowY('Mill 2')))
    fireEvent.pointerMove(strips[0], mouse(x(14), rowY('Press 1')))
    expect(document.querySelector('.overview-box')).toBeTruthy()
    // While it is drawn, the axis names it, as the Audit Trail's band does, and nothing else opens.
    expect(document.querySelector('.trail-axis .trail-band-words')).toHaveTextContent('3 devices · 10:00 – 14:00, 4 h')
    expect(document.querySelector('.overview-readout')).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Selection' })).not.toBeInTheDocument()
    fireEvent.pointerUp(strips[0], mouse(x(14), rowY('Press 1')))

    const popover = screen.getByRole('dialog', { name: 'Selection' })
    // In a portal, outside the card, so the card's edge cannot cut it off.
    expect(popover.parentElement).toBe(document.body)
    expect(popover.closest('.card')).toBeNull()
    expect(within(popover).getByRole('status')).toHaveTextContent('3 devices · 10:00 – 14:00, 4 h')
    // The row above the lanes keeps its status line, and no block is read out under the popover.
    expect(document.querySelector('.history-header .history-meta')).toBeInTheDocument()
    expect(document.querySelector('.overview-readout')).toBeNull()
    expect(within(popover).getByRole('button', { name: /Chart/ })).not.toHaveAttribute('aria-disabled')
    // The popover itself takes the focus, so no action's tooltip opens over the box.
    await waitFor(() => expect(popover).toHaveFocus())
    // Escape closes it and clears the box, and focus goes back to the box's first lane.
    fireEvent.keyDown(document.activeElement, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Selection' })).not.toBeInTheDocument()
    expect(document.querySelector('.overview-box')).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Pick Mill 2' })).toHaveFocus()

    // One lane: Chart is on; Zoom sets the window as a new history entry.
    fireEvent.pointerDown(strips[0], mouse(x(10), rowY('Lathe 3')))
    fireEvent.pointerMove(strips[0], mouse(x(12), rowY('Lathe 3')))
    fireEvent.pointerUp(strips[0], mouse(x(12), rowY('Lathe 3')))
    const one = screen.getByRole('dialog', { name: 'Selection' })
    expect(within(one).getByRole('status')).toHaveTextContent('1 device · 10:00 – 12:00, 2 h')
    await waitFor(() => expect(one).toHaveFocus())
    const push = vi.spyOn(window.history, 'pushState')
    fireEvent.click(within(one).getByRole('button', { name: /Zoom/ }))
    expect(search()).toBe('?from=2026-11-02T10%3A00&to=2026-11-02T12%3A00')
    expect(push).toHaveBeenCalled()
    await waitFor(() => expect(api.readCoverage.mock.calls.at(-1)[0].from).toBe(new Date(2026, 10, 2, 10).toISOString()))
    expect(screen.queryByRole('dialog', { name: 'Selection' })).not.toBeInTheDocument()

    fireEvent.pointerDown(strips[0], mouse(x(10), rowY('Lathe 3')))
    fireEvent.pointerMove(strips[0], mouse(x(11), rowY('Lathe 3')))
    fireEvent.pointerUp(strips[0], mouse(x(11), rowY('Lathe 3')))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Selection' })).getByRole('button', { name: /Chart/ }))
    expect(window.location.pathname).toBe(`/history/device/${telemetryKey(LATHE)}`)
  })

  it('closes the popover, and clears the box, on Clear, a press outside or a scroll; Tab stays inside it', async () => {
    await visit('/history/overview?span=day&at=2026-11-02')
    const track = document.querySelector('.overview-lane .overview-track')
    const draw = () => {
      fireEvent.pointerDown(track, mouse(LEFT + 100, 15))
      fireEvent.pointerMove(track, mouse(LEFT + 300, 15))
      fireEvent.pointerUp(track, mouse(LEFT + 300, 15))
      return screen.getByRole('dialog', { name: 'Selection' })
    }
    let popover = draw()
    const [chart, , , clear] = within(popover).getAllByRole('button')
    await waitFor(() => expect(popover).toHaveFocus())
    // Shift+Tab from the popover itself goes to its last action, not out of it.
    fireEvent.keyDown(popover, { key: 'Tab', shiftKey: true })
    expect(clear).toHaveFocus()
    // Tab from the last action comes round to the first, and Shift+Tab from the first to the last.
    clear.focus()
    fireEvent.keyDown(clear, { key: 'Tab' })
    expect(chart).toHaveFocus()
    fireEvent.keyDown(chart, { key: 'Tab', shiftKey: true })
    expect(clear).toHaveFocus()
    // A press inside keeps it.
    fireEvent.mouseDown(within(popover).getByRole('status'))
    expect(screen.getByRole('dialog', { name: 'Selection' })).toBe(popover)
    fireEvent.click(clear)
    expect(screen.queryByRole('dialog', { name: 'Selection' })).not.toBeInTheDocument()
    expect(document.querySelector('.overview-box')).toBeNull()

    draw()
    fireEvent.mouseDown(document.querySelector('.history-header'))
    expect(screen.queryByRole('dialog', { name: 'Selection' })).not.toBeInTheDocument()
    expect(document.querySelector('.overview-box')).toBeNull()

    popover = draw()
    fireEvent.scroll(document.querySelector('.trail-scroll'))
    expect(screen.queryByRole('dialog', { name: 'Selection' })).not.toBeInTheDocument()
    expect(document.querySelector('.overview-box')).toBeNull()
  })

  it('lays each row out as the Audit Trail does: a label column, then its track', async () => {
    await visit('/history/overview?span=day&at=2026-11-02')
    const grid = document.querySelector('.trail-swimlanes')
    // The grid is what scrolls, as the Audit Trail's is; the row above it stays.
    expect(grid.parentElement).toHaveClass('trail-scroll')
    expect(document.querySelector('.history-header').closest('.trail-scroll')).toBeNull()
    const rows = [...grid.querySelectorAll('.trail-lane, .trail-section')]
    // The axis row first, its label an empty corner; then a section row a group, a lane a device.
    expect(rows[0]).toHaveClass('trail-axis')
    expect(rows[0].querySelector('.trail-lane-label')).toBeEmptyDOMElement()
    for (const row of rows) {
      expect([...row.children].map(c => c.className.split(' ')[0])).toEqual(['trail-lane-label', 'trail-track'])
    }
    const sections = [...grid.querySelectorAll('.trail-section')]
    expect(sections.map(sec => sec.querySelector('.trail-lane-label .group-heading .group-heading-label').textContent))
      .toEqual(['Hall B', 'Milling', 'Turning', 'Area-Wide', UNFILED_GROUP, 'Spare bay', 'Site-Wide', 'Simulated', 'Unassigned'])
    // A cell's heading is a step in from its area's.
    expect(sections[1]).toHaveClass('overview-subsection')
    expect(sections[0]).not.toHaveClass('overview-subsection')
    const lathe = laneNamed('Lathe 3')
    const label = lathe.querySelector('.trail-lane-label')
    expect(within(label).getByRole('checkbox', { name: 'Pick Lathe 3' })).toBeInTheDocument()
    expect(label.querySelector('.badge-dot')).toBeTruthy()
    expect(label.querySelector('.trail-lane-qualifier')).toHaveTextContent('2 metrics')
    expect(lathe.querySelector('.trail-track .overview-run')).toBeTruthy()
  })

  it('reads out the block under the pointer in words, below it, or above it on the last lane', async () => {
    await visit('/history/overview?span=day&at=2026-11-02')
    const lathe = laneNamed('Lathe 3')
    const track = lathe.querySelector('.trail-track')
    const row = rowOf(lathe)
    // 10:00, the 61st of 144 ten-minute blocks.
    fireEvent.pointerMove(track, mouse(LEFT + (1000 * 10) / 24 + 1, row * 30 + 15))
    const readout = document.querySelector('.overview-readout')
    expect(readout).toHaveTextContent('10:00–10:10 · 6 readings')
    // The tooltip's bubble, portalled, under the track and centred on the block.
    expect(readout).toHaveClass('tooltip-bubble')
    expect(readout.parentElement).toBe(document.body)
    expect(readout).not.toHaveClass('tooltip-bubble-above')
    expect(readout.style.top).toBe(`${row * 30 + 28 + 8}px`)
    expect(parseFloat(readout.style.left)).toBeCloseTo(LEFT + (1000 * 10) / 24 + 1000 / 288, 5)
    // Press has none after 14:20, before now.
    const press = laneNamed('Press 1').querySelector('.trail-track')
    fireEvent.pointerMove(press, mouse(LEFT + (1000 * 14.5) / 24 + 1, 15))
    expect(document.querySelectorAll('.overview-readout')).toHaveLength(1)
    expect(document.querySelector('.overview-readout')).toHaveTextContent('14:30–14:40 · No readings')
    // The last lane has no room below inside the scroll area, so its readout opens above.
    const last = lanes().at(-1)
    fireEvent.pointerMove(last.querySelector('.trail-track'), mouse(LEFT + 500, rowOf(last) * 30 + 15))
    const above = document.querySelector('.overview-readout')
    expect(above).toHaveClass('tooltip-bubble-above')
    expect(above.style.top).toBe(`${rowOf(last) * 30 - 8}px`)
    // A scroll or the pointer leaving the lanes closes it.
    fireEvent.scroll(document.querySelector('.trail-scroll'))
    expect(document.querySelector('.overview-readout')).toBeNull()
    fireEvent.pointerMove(track, mouse(LEFT + 500, row * 30 + 15))
    fireEvent.pointerLeave(document.querySelector('.trail-swimlanes'))
    expect(document.querySelector('.overview-readout')).toBeNull()
  })

  it('places the readout inside its track and the popover inside the window', () => {
    const track = { left: 100, right: 1100, top: 0, bottom: 28 }
    const area = { top: 0, bottom: 600 }
    // Centred on the block...
    expect(placeReadout({ left: 500, right: 510 }, track, area, { width: 160, height: 30 }))
      .toEqual({ left: 425, top: 36, above: false, arrowX: 80 })
    // ...kept inside the track at its start, the arrow still at the block...
    expect(placeReadout({ left: 100, right: 104 }, track, area, { width: 160, height: 30 }))
      .toEqual({ left: 100, top: 36, above: false, arrowX: ARROW_INSET })
    // ...and above where the scroll area has no room below.
    expect(placeReadout({ left: 500, right: 510 }, { ...track, top: 572, bottom: 600 }, area, { width: 160, height: 30 }).above).toBe(true)
    // The popover below its box, above it near the window's foot, and over a box taller than the window.
    const size = { width: 300, height: 80 }
    expect(placeSelection({ left: 400, right: 600, top: 100, bottom: 200 }, size, 1440, 900))
      .toEqual({ left: 350, top: 208, above: false, over: false, arrowX: 150 })
    expect(placeSelection({ left: 400, right: 600, top: 700, bottom: 850 }, size, 1440, 900))
      .toMatchObject({ top: 612, above: true, over: false })
    expect(placeSelection({ left: 400, right: 600, top: 20, bottom: 880 }, size, 1440, 900))
      .toMatchObject({ top: 812, over: true })
    // Near the window's right side it moves in, its arrow still at the box.
    expect(placeSelection({ left: 1380, right: 1430, top: 100, bottom: 200 }, size, 1440, 900))
      .toMatchObject({ left: 1132, arrowX: 1405 - 1132 })
  })

  it("keeps the row above the lanes to Collapse all, the status line and the key, with the trail's room above and below", async () => {
    await visit('/history/overview?span=day&at=2026-11-02')
    const header = document.querySelector('.history-header')
    expect([...header.children].map(c => c.className)).toEqual([
      expect.stringContaining('btn'), 'history-meta', 'overview-key',
    ])
    expect(within(header).getAllByRole('button').map(b => b.textContent)).toEqual(['Collapse all'])
    // One rule for Overview and the Device tab, with .trail-header's padding: the same above and below.
    const historyPadding = APP_CSS.match(/\n\.history-header \{[^}]*?padding: ([^;]+);/)?.[1]
    const trailPadding = APP_CSS.match(/\n\.trail-header \{[^}]*?padding: ([^;]+);/)?.[1]
    expect(historyPadding).toBe('10px var(--inset)')
    expect(historyPadding).toBe(trailPadding)
  })

  it("re-reads on the refresh timer, and the control's Zoom works here", async () => {
    await visit('/history/overview')
    const poll = polls.at(-1)
    const before = api.readCoverage.mock.calls.length
    await act(async () => { await poll.callback() })
    expect(api.readCoverage.mock.calls.length).toBe(before + 1)
    fireEvent.click(within(screen.getByRole('group', { name: 'Zoom' })).getByRole('button', { name: 'Zoom in' }))
    expect(new URLSearchParams(search()).get('from')).toBe('2026-11-01T21:20')
  })

  it("shades what the rollups have not counted yet, and says so", async () => {
    counted = { computed_from: new Date(2026, 10, 2, 6).toISOString(), computed_to: new Date(2026, 10, 2, 15).toISOString(), complete: false }
    await visit('/history/overview?span=day&at=2026-11-02')
    expect(document.querySelector('.history-meta')).toHaveTextContent('Coverage before 2 Nov is still being computed')
    expect(document.querySelectorAll('.trail-gridlines .overview-uncounted')).toHaveLength(2)
    expect(screen.getByText(COVERAGE_KEY.uncounted)).toBeInTheDocument()
  })

  it('shows an old day in hours, as the read returns it', async () => {
    fleet = Array.from({ length: 60 }, (_, i) => place(100 + i, `Press ${String(i).padStart(2, '0')}`, inCell('c1')))
    fiveMinuteReach = new Date(2026, 4, 6).getTime()
    await visit('/history/overview?span=day&at=2026-04-16')
    expect(api.readCoverage.mock.calls[0][0].blockMinutes).toBe(5)
    expect(document.querySelector('.history-meta').textContent).toMatch(/^60 devices, in 1-hour blocks/)
    // One run of one shade a lane, across the day's 24 hourly blocks.
    expect(lanes()).toHaveLength(60)
    expect(lanes()[0].querySelectorAll('.overview-run')).toHaveLength(1)
  })

  it('reads a long window only for a small selection, and says why otherwise', async () => {
    fleet = Array.from({ length: 60 }, (_, i) => place(100 + i, `Press ${String(i).padStart(2, '0')}`, inCell(i < 30 ? 'c1' : 'c2')))
    await visit('/history/overview?span=month&at=2026-11-02')
    expect(screen.getByText(TOO_LONG_FOR_MANY)).toBeInTheDocument()
    expect(api.readCoverage).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Turning' } })
    await waitFor(() => expect(api.readCoverage).toHaveBeenCalled(), { timeout: 2000 })
    expect(api.readCoverage.mock.calls.at(-1)[0].assetIds).toHaveLength(30)
  })

  it('draws a thousand lanes: closed on a first visit, and open in one render', async () => {
    fleet = Array.from({ length: 1000 }, (_, i) => place(1000 + i, `Device ${i}`, inCell(`c${1 + (i % 2)}`)))
    await visit('/history/overview?span=day&at=2026-11-02')
    expect(lanes()).toHaveLength(0)
    expect(document.querySelectorAll('.trail-section-closed')).toHaveLength(1)
    const t0 = performance.now()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    const ms = performance.now() - t0
    expect(lanes()).toHaveLength(1000)
    // jsdom is slower than a browser; the bound catches a render that grows out of hand.
    console.log(`1,000 lanes rendered in ${Math.round(ms)} ms (jsdom)`)
    expect(ms).toBeLessThan(15000)
  })
})

describe('exporting from Overview', () => {
  const DENIED = 'Requires Administrator or Shopfloor Manager'
  const strips = () => [...document.querySelectorAll('.overview-lane .overview-track')]
  const rowY = (name) => [...document.querySelectorAll('[data-lanes]')].indexOf(laneNamed(name)) * 30 + 15
  /** A box from `from` to `to` (fractions of the window) across the lanes from `first` to `last`. */
  const draw = (from, to, first, last) => {
    const track = strips()[0]
    const x = (f) => LEFT + 1000 * f
    fireEvent.pointerDown(track, mouse(x(from), rowY(first)))
    fireEvent.pointerMove(track, mouse(x(to), rowY(last)))
    fireEvent.pointerUp(track, mouse(x(to), rowY(last)))
    return screen.getByRole('dialog', { name: 'Selection' })
  }
  /** A day's 10:00 to 14:00, across the three lanes from Mill 2 to Press 1. */
  const tenToTwo = () => draw(10 / 24, 14 / 24, 'Mill 2', 'Press 1')
  const exportIn = (popover) => within(popover).getByRole('button', { name: /Export CSV/ })
  const toolbarExport = () => within(document.querySelector('.filter-bar-actions')).queryByRole('button', { name: /Export CSV/ })
  const asked = () => api.exportTelemetry.mock.calls.map(c => c[0])
  const answer = {
    audit_id: 77, resolution: 'raw', columns: ['time', 'asset_id', 'metric_name', 'value', 'unit'], rows: [], row_count: 0,
    max_rows: 50000, truncated: false, read_from: '2026-11-02T00:00:00.000Z', read_to: '2026-11-03T00:00:00.000Z', raw_from: null,
  }
  beforeEach(() => { api.exportTelemetry.mockResolvedValue({ ...answer, rows: [['2026-11-02T10:00:00.000Z', telemetryKey(LATHE), 'Spindle/LOAD', 4, 'kW']], row_count: 1 }) })

  it("is in the selection's popover after Zoom, and exports the box's devices, all their metrics and its window as raw", async () => {
    const { showToast } = await visit('/history/overview?span=day&at=2026-11-02')
    const popover = tenToTwo()
    expect(within(popover).getAllByRole('button').map(b => b.textContent.trim())).toEqual(['Chart', 'Zoom', 'Export CSV', 'Clear'])
    // Under the limit the words are the box's alone.
    expect(within(popover).getByRole('status')).toHaveTextContent(/^3 devices · 10:00 – 14:00, 4 h$/)
    expect(exportIn(popover)).not.toHaveAttribute('aria-disabled')

    fireEvent.click(exportIn(popover))
    const dialog = await screen.findByRole('dialog', { name: /Export readings — 3 devices/ })
    // The box is gone, and the dialog holds what it picked.
    expect(screen.queryByRole('dialog', { name: 'Selection' })).not.toBeInTheDocument()
    expect(within(dialog).getByText(/^3 devices · 2 metrics · /)).toBeInTheDocument()
    expect(within(dialog).getByText('Lathe 3')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /Raw samples/ })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(asked()).toHaveLength(1))
    expect(asked()[0].assetIds.sort()).toEqual([LATHE, PRESS, MILL].map(telemetryKey).sort())
    expect(asked()[0].metricNames).toEqual(['Spindle/LOAD', 'Spindle/SPEED'])
    expect(asked()[0].from).toBe(new Date(2026, 10, 2, 10).toISOString())
    expect(asked()[0].to).toBe(new Date(2026, 10, 2, 14).toISOString())
    expect(asked()[0].resolution).toBe('raw')
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Exported 1 row of 3 devices', 'success', { to: '/audit-trail?event=77' }))
  })

  it('is greyed for a role that may not export, saying who may, and does not open the dialog', async () => {
    await visit('/history/overview?span=day&at=2026-11-02', { userRole: 'Operator' })
    const popover = tenToTwo()
    const button = exportIn(popover)
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveClass('btn-disabled')
    fireEvent.focus(button)
    await waitFor(() => expect(screen.getByText(DENIED)).toBeInTheDocument())
    fireEvent.click(button)
    expect(screen.queryByRole('dialog', { name: /Export readings/ })).not.toBeInTheDocument()
    // The charts stay: Chart and Zoom are as they were.
    expect(within(popover).getByRole('button', { name: /Zoom/ })).not.toHaveAttribute('aria-disabled')
  })

  it("says the window is over the limit as the box is drawn and in its popover, and holds Export, for a role that may export", async () => {
    await visit('/history/overview?span=month&at=2026-11-02')
    const track = strips()[0]
    const x = (f) => LEFT + 1000 * f
    // A box across 80% of a 30-day month is 24 days.
    fireEvent.pointerDown(track, mouse(x(0.1), rowY('Mill 2')))
    fireEvent.pointerMove(track, mouse(x(0.9), rowY('Press 1')))
    expect(document.querySelector('.trail-axis .trail-band-words')).toHaveTextContent(/ · over the 14-day export limit$/)
    fireEvent.pointerUp(track, mouse(x(0.9), rowY('Press 1')))
    const popover = screen.getByRole('dialog', { name: 'Selection' })
    expect(within(popover).getByRole('status')).toHaveTextContent(/ · over the 14-day export limit$/)
    const button = exportIn(popover)
    expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.focus(button)
    await waitFor(() => expect(screen.getByText(/^An export can cover at most 14 days, set on Settings › History\. This window is 2\d days\.$/)).toBeInTheDocument())
    fireEvent.click(button)
    expect(screen.queryByRole('dialog', { name: /Export readings/ })).not.toBeInTheDocument()
    expect(asked()).toEqual([])
  })

  it('says nothing of the limit to a role that may not export', async () => {
    await visit('/history/overview?span=month&at=2026-11-02', { userRole: 'Operator' })
    const popover = draw(0.1, 0.9, 'Mill 2', 'Press 1')
    expect(within(popover).getByRole('status').textContent).not.toMatch(/export limit/)
  })

  it('exports the devices ticked from the toolbar, over the time control\'s window, when there is no box', async () => {
    await visit('/history/overview?span=day&at=2026-11-02')
    expect(toolbarExport()).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Lathe 3' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Mill 2' }))
    expect(toolbarExport()).toHaveClass('btn-primary')
    expect(toolbarExport()).not.toHaveAttribute('aria-disabled')
    fireEvent.click(toolbarExport())
    const dialog = await screen.findByRole('dialog', { name: /Export readings — 2 devices/ })
    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(asked()).toHaveLength(1))
    expect(asked()[0].assetIds.sort()).toEqual([LATHE, MILL].map(telemetryKey).sort())
    expect(asked()[0].from).toBe(new Date(2026, 10, 2).toISOString())
    expect(asked()[0].to).toBe(new Date(2026, 10, 3).toISOString())
  })

  it('is greyed in the toolbar for a role that may not export, and for a window over the limit', async () => {
    await visit('/history/overview?span=day&at=2026-11-02', { userRole: 'Shopfloor_Manager' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Lathe 3' }))
    expect(toolbarExport()).not.toHaveAttribute('aria-disabled')
    cleanup()

    await visit('/history/overview?span=day&at=2026-11-02', { userRole: 'Auditor' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Lathe 3' }))
    expect(toolbarExport()).toHaveAttribute('aria-disabled', 'true')
    fireEvent.focus(toolbarExport())
    await waitFor(() => expect(screen.getByText(DENIED)).toBeInTheDocument())
    cleanup()

    await visit('/history/overview?span=month&at=2026-11-02')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Lathe 3' }))
    expect(toolbarExport()).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(toolbarExport())
    expect(screen.queryByRole('dialog', { name: /Export readings/ })).not.toBeInTheDocument()
  })

  it('says why when the devices declare no metric, and has nothing to export', async () => {
    fleet = [place(1, 'Blank rig', inCell('c1'), { last_birth_metrics: [] })]
    await visit('/history/overview?span=day&at=2026-11-02')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Blank rig' }))
    expect(toolbarExport()).toHaveAttribute('aria-disabled', 'true')
    fireEvent.focus(toolbarExport())
    await waitFor(() => expect(screen.getByText('These devices have declared no metric, so there is nothing to export.')).toBeInTheDocument())
  })
})
