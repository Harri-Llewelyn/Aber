/**
 * History's Overview: a lane per device, grouped as the Site Map places devices, each a strip of
 * blocks darker where more readings arrived, read from telemetry_coverage() (0245). Its groups and
 * what this browser remembers of them, the shades and the words, the block widths a selection may
 * take, what the rollups have not counted yet, the selection box with Chart and Zoom, the tick
 * boxes, the address, the default tab, and a thousand lanes. In London's zone on Monday 2 November
 * 2026 at 15:20.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { api, COVERAGE_SMALL_SELECTION } from '../api'
import { deviceHistoryUrl } from '../routes'
import { groupDevicesByCell, SOURCE_SIMULATED, SOURCE_SITE_WIDE, SOURCE_UNASSIGNED } from '../utils/cellResolution'
import { pathSegments } from '../hooks/useUrlState'
import {
  AREA_WIDE_GROUP, CHART_SEVERAL_REASON, COVERAGE_KEY, DEFAULT_HISTORY_WINDOW, OVERVIEW_GROUPS_KEY, OVERVIEW_OPEN_LANES_MAX,
  TOO_LONG_FOR_MANY, UNFILED_GROUP, boxWords, coverageBlock, coverageCounts, coverageRuns, coverageSteps, groupIsOpen,
  historyPath, overviewAddress, overviewGroups, readOverviewGroups, readingsStopWords, telemetryKey, uncountedStretches,
  uncountedWords, writeOverviewGroups,
} from '../utils/history'

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
  return { ...actual, api: { get: vi.fn(), readCoverage: vi.fn(), readCarriedTelemetry: vi.fn() } }
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
/** A row per device: 6 readings in every block but the last third, where Press has none. */
const coverage = ({ from, to, blockMinutes, assetIds }) => {
  const width = blockMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  const blocks = Math.ceil((Date.parse(to) - first) / width)
  return Promise.resolve(assetIds.map(id => ({
    asset_id: id, first_block: new Date(first).toISOString(), block_width: `00:${String(blockMinutes).padStart(2, '0')}:00`,
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
  counted = { computed_from: '-infinity', computed_to: 'infinity', complete: true }
  window.localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 2, 15, 20))
  api.get.mockImplementation(routeGet)
  api.readCoverage.mockImplementation(coverage)
  originalRect = Element.prototype.getBoundingClientRect
  // Every strip is 1000px wide from x = 100; each row is 30px tall, in the order drawn.
  Element.prototype.getBoundingClientRect = function rect() {
    if (this.classList?.contains('overview-strip')) return { left: LEFT, right: LEFT + 1000, width: 1000, top: 0, bottom: 12, height: 12 }
    if (this.classList?.contains('overview-layer')) return { left: LEFT, right: LEFT + 1000, width: 1000, top: 0, bottom: 900, height: 900 }
    if (this.dataset?.lanes !== undefined) {
      const i = [...document.querySelectorAll('[data-lanes]')].indexOf(this)
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

const visit = async (address) => {
  window.history.replaceState(null, '', address)
  render(<HistoryTab hasPermission={() => true} showToast={vi.fn()} />)
  await waitFor(() => expect(document.querySelector('.overview-plot, .empty-state, .callout')).toBeTruthy())
}
const lanes = () => [...document.querySelectorAll('.overview-lane')]
const laneNamed = (name) => lanes().find(l => within(l).queryByText(name))
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
    expect(within(tabs).getAllByRole('link').map(a => a.textContent)).toEqual(['Overview', 'Device'])
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
    // Export CSV is the Device tab's; Overview has none.
    expect(screen.queryByRole('button', { name: /Export CSV/ })).not.toBeInTheDocument()
  })

  it('closes a group to one strip of its devices merged, and remembers it', async () => {
    await visit('/history/overview?span=day&at=2026-11-02')
    fireEvent.click(screen.getByRole('button', { name: /Turning/ }))
    expect(laneNamed('Lathe 3')).toBeUndefined()
    expect(document.querySelector('.overview-summary .overview-strip').getAttribute('aria-label')).toMatch(/^Turning, 2 devices merged/)
    expect(readOverviewGroups()).toEqual({ 'cell:c1': false })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(lanes()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(lanes()).toHaveLength(8)
  })

  it('charts one ticked device from the toolbar, and says why several cannot be', async () => {
    await visit('/history/overview?span=day&at=2026-11-02')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Lathe 3' }))
    expect(new URLSearchParams(search()).get('device')).toBe(telemetryKey(LATHE))
    const chart = within(document.querySelector('.filter-bar-actions')).getByRole('button', { name: /Chart/ })
    expect(chart).not.toHaveAttribute('aria-disabled')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Mill 2' }))
    const several = within(document.querySelector('.filter-bar-actions')).getByRole('button', { name: /Chart/ })
    expect(several).toHaveAttribute('aria-disabled', 'true')
    fireEvent.focus(several)
    await waitFor(() => expect(screen.getByText(CHART_SEVERAL_REASON)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Mill 2' }))
    fireEvent.click(within(document.querySelector('.filter-bar-actions')).getByRole('button', { name: /Chart/ }))
    expect(window.location.pathname).toBe(`/history/device/${telemetryKey(LATHE)}`)
    expect(search()).toBe('?span=day&at=2026-11-02')
  })

  it('draws a box across lanes and time that says its size, charts one device and zooms the window', async () => {
    await visit('/history/overview?span=day&at=2026-11-02')
    const strips = [...document.querySelectorAll('.overview-lane .overview-strip')]
    const rowY = (name) => [...document.querySelectorAll('[data-lanes]')].indexOf(laneNamed(name)) * 30 + 15
    // 10:00 to 14:00 of the day, across Milling's and Turning's three lanes.
    const x = (hour) => LEFT + (1000 * hour) / 24
    fireEvent.pointerDown(strips[0], mouse(x(10), rowY('Mill 2')))
    fireEvent.pointerMove(strips[0], mouse(x(14), rowY('Press 1')))
    expect(document.querySelector('.overview-box')).toBeTruthy()
    fireEvent.pointerUp(strips[0], mouse(x(14), rowY('Press 1')))
    const bar = screen.getByRole('group', { name: 'Selection' })
    expect(within(bar).getByRole('status')).toHaveTextContent('3 devices · 10:00 – 14:00, 4 h')
    expect(within(bar).getByRole('button', { name: /Chart/ })).toHaveAttribute('aria-disabled', 'true')
    // Escape clears it.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Selection' })).not.toBeInTheDocument()

    // One lane: Chart opens its Device tab at the box's window.
    fireEvent.pointerDown(strips[0], mouse(x(10), rowY('Lathe 3')))
    fireEvent.pointerMove(strips[0], mouse(x(12), rowY('Lathe 3')))
    fireEvent.pointerUp(strips[0], mouse(x(12), rowY('Lathe 3')))
    const one = screen.getByRole('group', { name: 'Selection' })
    expect(within(one).getByRole('status')).toHaveTextContent('1 device · 10:00 – 12:00, 2 h')
    const push = vi.spyOn(window.history, 'pushState')
    fireEvent.click(within(one).getByRole('button', { name: /Zoom/ }))
    expect(search()).toBe('?from=2026-11-02T10%3A00&to=2026-11-02T12%3A00')
    expect(push).toHaveBeenCalled()
    await waitFor(() => expect(api.readCoverage.mock.calls.at(-1)[0].from).toBe(new Date(2026, 10, 2, 10).toISOString()))
    expect(screen.queryByRole('group', { name: 'Selection' })).not.toBeInTheDocument()

    fireEvent.pointerDown(strips[0], mouse(x(10), rowY('Lathe 3')))
    fireEvent.pointerMove(strips[0], mouse(x(11), rowY('Lathe 3')))
    fireEvent.pointerUp(strips[0], mouse(x(11), rowY('Lathe 3')))
    fireEvent.click(within(screen.getByRole('group', { name: 'Selection' })).getByRole('button', { name: /Chart/ }))
    expect(window.location.pathname).toBe(`/history/device/${telemetryKey(LATHE)}`)
  })

  it('a press outside the box clears it', async () => {
    await visit('/history/overview?span=day&at=2026-11-02')
    const strip = document.querySelector('.overview-lane .overview-strip')
    fireEvent.pointerDown(strip, mouse(LEFT + 100, 15))
    fireEvent.pointerMove(strip, mouse(LEFT + 300, 15))
    fireEvent.pointerUp(strip, mouse(LEFT + 300, 15))
    expect(screen.getByRole('group', { name: 'Selection' })).toBeInTheDocument()
    fireEvent.pointerDown(document.querySelector('.history-header'), mouse(5, 600))
    expect(screen.queryByRole('group', { name: 'Selection' })).not.toBeInTheDocument()
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
    expect(document.querySelectorAll('.overview-layer .overview-uncounted')).toHaveLength(2)
    expect(screen.getByText(COVERAGE_KEY.uncounted)).toBeInTheDocument()
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
    expect(document.querySelectorAll('.overview-summary')).toHaveLength(1)
    const t0 = performance.now()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    const ms = performance.now() - t0
    expect(lanes()).toHaveLength(1000)
    // jsdom is slower than a browser; the bound catches a render that grows out of hand.
    console.log(`1,000 lanes rendered in ${Math.round(ms)} ms (jsdom)`)
    expect(ms).toBeLessThan(15000)
  })
})
