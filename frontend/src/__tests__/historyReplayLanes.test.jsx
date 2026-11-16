/**
 * History and replay lanes. Overview gains a Replay lanes group after Simulated and before
 * Unassigned, from the devices the Playback gateway serves, and the Device tab's two lists (the
 * picker with no device chosen, and the toolbar's switcher) list the lanes among the machines. All
 * three leave the lanes out until Filters' Show replay lanes is on, as on the Devices page, and offer
 * the check only while a lane exists. A link to a lane's charts turns the check on.
 */
import React from 'react'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { api } from '../api'
import { openFiltersPanel } from '../test/listFilters'
import { DEFAULT_HISTORY_WINDOW, REPLAY_LANES_GROUP, overviewGroups, pickedAddress, telemetryKey } from '../utils/history'
import { REPLAY_LANES_LABEL, REPLAY_LANES_PARAM, isReplayLane } from '../utils/replayLanes'

const { plots } = vi.hoisted(() => ({ plots: [] }))

vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))
vi.mock('uplot', () => {
  class FakePlot {
    constructor(opts, data, target) {
      this.over = document.createElement('div')
      this.over.className = 'u-over'
      target.appendChild(this.over)
      plots.push(this)
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
    api: { get: vi.fn(), readCoverage: vi.fn(), readCarriedTelemetry: vi.fn(), readTelemetryChanges: vi.fn(), exportTelemetry: vi.fn() },
  }
})

const uuid = (n) => `2b3e0c4a-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`
const device = (n, name, extra = {}) => ({
  asset_id: uuid(n), asset_name: name, status: 'ONLINE', last_birth_metrics: ['Spindle/LOAD'],
  location_source: 'explicit', effective_cell_id: 'c1', ...extra,
})
const lane = (n, name, of, extra = {}) => device(n, name, { shadow_of: of, location_source: 'shadow', effective_cell_id: null, ...extra })

const ASSEMBLY = device(1, 'Assembly Device')
const LATHE = device(2, 'Lathe 3')
const SIMULATOR = device(5, 'Simulator', { location_source: 'simulated', effective_cell_id: null })
const LONELY = device(6, 'Unfiled pump', { location_source: 'unassigned', effective_cell_id: null })
const ASSEMBLY_LANE = lane(3, 'Assembly Device (replay)', ASSEMBLY.asset_id)
const LATHE_LANE = lane(7, 'Lathe 3 (replay)', LATHE.asset_id)
const OLD_LANE = lane(4, 'Old rig (replay)', uuid(99), { is_archived: true })
const MACHINES = [ASSEMBLY, LATHE, SIMULATOR, LONELY]
const FLEET = [...MACHINES, ASSEMBLY_LANE, LATHE_LANE, OLD_LANE]
const CELLS = [{ cell_id: 'c1', cell_name: 'Turning', name: 'Turning', area_id: 'a1' }]
const AREAS = [{ area_id: 'a1', area_name: 'Hall B', name: 'Hall B' }]

let fleet = FLEET
const routeGet = (path) => {
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(fleet)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(CELLS)
  if (path.startsWith('/api/v1/areas')) return Promise.resolve(AREAS)
  return Promise.resolve([])
}
const width = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`
/** Three readings in every block, for each device asked for. */
const coverage = ({ from, to, blockMinutes, assetIds }) => {
  const step = blockMinutes * 60000
  const first = Math.floor(Date.parse(from) / step) * step
  const blocks = Math.ceil((Date.parse(to) - first) / step)
  return Promise.resolve(assetIds.map(id => ({
    asset_id: id, first_block: new Date(first).toISOString(), block_width: width(blockMinutes),
    counts: new Array(blocks).fill(3), computed_from: '-infinity', computed_to: 'infinity', complete: true,
  })))
}
const readings = ({ from, bucketMinutes, metricNames }) => {
  const step = bucketMinutes * 60000
  const first = Math.floor(Date.parse(from) / step) * step
  return Promise.resolve(metricNames.flatMap(name => [0, 1, 2].map(i => ({
    bucket_ts: new Date(first + i * step).toISOString(), asset_id: 'dev2b3e0c4a000140008000', metric_name: name,
    avg_double: 40 + i, min_double: 39, max_double: 45, last_double: 41, last_string: null, last_bool: null, n_rows: 4, is_carried: false,
  }))))
}

beforeEach(() => {
  vi.clearAllMocks()
  plots.length = 0
  fleet = FLEET
  api.get.mockImplementation(routeGet)
  api.readCoverage.mockImplementation(coverage)
  api.readCarriedTelemetry.mockImplementation(readings)
  api.readTelemetryChanges.mockResolvedValue([])
})
afterEach(() => {
  window.history.pushState({}, '', '/')
})

const visit = async (address, ready) => {
  window.history.pushState({}, '', address)
  render(<HistoryTab showToast={vi.fn()} userRole="Administrator" />)
  await waitFor(() => expect(screen.queryByText(/Loading devices/)).not.toBeInTheDocument())
  await waitFor(() => expect(document.querySelector(ready)).toBeTruthy())
}
const visitOverview = (address = '/history/overview') => visit(address, '.overview-swimlanes, .empty-state')
const visitPicker = (address = '/history/device') => visit(address, 'table, .empty-state')
const visitDevice = (id, search = '') => visit(`/history/device/${id}${search}`, '.history-device-pick')

const query = () => new URLSearchParams(window.location.search)
const groupNames = () => [...document.querySelectorAll('.trail-section .group-heading-label')].map(el => el.textContent)
const laneNames = () => [...document.querySelectorAll('.overview-lane-name')].map(el => el.textContent)
const pickerNames = () => within(screen.getByRole('table', { name: /choose a device/i })).getAllByRole('link').map(l => l.textContent)
const check = (scope = openFiltersPanel()) => within(scope).queryByRole('checkbox', { name: /^Show replay lanes/ })
const lastCoverageKeys = () => api.readCoverage.mock.calls.at(-1)[0].assetIds
const idOf = (link) => decodeURIComponent(new URL(link.getAttribute('href'), 'http://aber.test').pathname.split('/').pop())
const openSwitcher = (name) => {
  fireEvent.click(screen.getByRole('button', { name: `Device: ${name}` }))
  return screen.getByRole('dialog', { name: 'Choose a device' })
}
const switcherIds = (panel) => within(panel).getAllByRole('link').map(idOf)

describe('the Replay lanes group', () => {
  it('places a replay lane after Simulated and before Unassigned, apart from every area and cell', () => {
    const groups = overviewGroups(FLEET, CELLS, AREAS)
    expect(groups.map(g => g.label)).toEqual(['Hall B', 'Simulated', 'Replay lanes', 'Unassigned'])
    const replay = groups.find(g => g.key === REPLAY_LANES_GROUP)
    expect(replay.devices.map(d => d.asset_name)).toEqual(['Assembly Device (replay)', 'Lathe 3 (replay)'])
    expect(replay.groups).toBeUndefined()
    // A lane is in no area or cell, and an archived one is left off as every archived device is.
    expect(JSON.stringify(groups[0])).not.toContain('replay')
    expect(groups.flatMap(g => g.devices).map(d => d.asset_name)).not.toContain('Old rig (replay)')
  })

  it('is derived from the location source, as Site-Wide and Simulated are, and is left out with no lane', () => {
    const bare = { asset_id: uuid(8), asset_name: 'Tape', location_source: 'shadow' }
    expect(overviewGroups([bare], [], []).map(g => [g.key, g.label])).toEqual([[REPLAY_LANES_GROUP, 'Replay lanes']])
    expect(overviewGroups(MACHINES, CELLS, AREAS).map(g => g.label)).toEqual(['Hall B', 'Simulated', 'Unassigned'])
  })

  it('knows a lane by its source or by the machine it replays', () => {
    expect(isReplayLane(ASSEMBLY_LANE)).toBe(true)
    expect(isReplayLane({ shadow_of: uuid(1) })).toBe(true)
    expect(isReplayLane({ location_source: 'shadow' })).toBe(true)
    expect(isReplayLane(ASSEMBLY)).toBe(false)
    expect(isReplayLane(null)).toBe(false)
  })

  it('keeps the check in a device address only when asked', () => {
    expect(pickedAddress(uuid(1), DEFAULT_HISTORY_WINDOW)).toBe(`/history/device/${uuid(1)}`)
    expect(pickedAddress(uuid(1), DEFAULT_HISTORY_WINDOW, { replay: true })).toBe(`/history/device/${uuid(1)}?${REPLAY_LANES_PARAM}=1`)
  })
})

describe('Overview', () => {
  it('leaves the lanes out, and reads none of them, until Show replay lanes is on', async () => {
    await visitOverview()
    expect(groupNames()).toEqual(['Hall B', 'Turning', 'Simulated', 'Unassigned'])
    expect(laneNames()).toEqual(['Assembly Device', 'Lathe 3', 'Simulator', 'Unfiled pump'])
    await waitFor(() => expect(api.readCoverage).toHaveBeenCalled())
    expect(lastCoverageKeys()).toEqual(expect.not.arrayContaining([telemetryKey(ASSEMBLY_LANE)]))
    expect(query().has(REPLAY_LANES_PARAM)).toBe(false)
  })

  it('offers the check in Filters with the Devices page\'s label, counting the lanes it would add', async () => {
    await visitOverview()
    // Two lanes: the archived one is not on Overview, so it is not counted.
    expect(check()).toBeInTheDocument()
    expect(check()).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: `${REPLAY_LANES_LABEL} 2` })).toBeInTheDocument()
    expect(within(openFiltersPanel()).getByRole('button', { name: 'About show replay lanes' })).toBeInTheDocument()
  })

  it('shows the group after Simulated and before Unassigned with the check on, and reads its lanes', async () => {
    await visitOverview()
    fireEvent.click(check())
    await waitFor(() => expect(groupNames()).toEqual(['Hall B', 'Turning', 'Simulated', 'Replay lanes', 'Unassigned']))
    expect(laneNames()).toEqual(['Assembly Device', 'Lathe 3', 'Simulator', 'Assembly Device (replay)', 'Lathe 3 (replay)', 'Unfiled pump'])
    expect(query().get(REPLAY_LANES_PARAM)).toBe('1')
    await waitFor(() => expect(lastCoverageKeys()).toEqual(expect.arrayContaining([telemetryKey(ASSEMBLY_LANE), telemetryKey(LATHE_LANE)])))
    expect(screen.getByRole('button', { name: /^Filters \(1\)/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Clear filters \(1\)/ })).toBeInTheDocument()
  })

  it('opens with the group shown from the address, and Clear filters hides it again', async () => {
    await visitOverview('/history/overview?replay=1')
    expect(groupNames()).toContain('Replay lanes')
    expect(check()).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }))
    await waitFor(() => expect(groupNames()).not.toContain('Replay lanes'))
    expect(query().has(REPLAY_LANES_PARAM)).toBe(false)
  })

  it('has no Filters, and no check, while no lane exists', async () => {
    fleet = MACHINES
    await visitOverview()
    expect(screen.queryByRole('button', { name: /^Filters/ })).not.toBeInTheDocument()
    expect(groupNames()).toEqual(['Hall B', 'Turning', 'Simulated', 'Unassigned'])
  })

  it('has no check for a lane that is only archived', async () => {
    fleet = [...MACHINES, OLD_LANE]
    await visitOverview('/history/overview?replay=1')
    expect(screen.queryByRole('button', { name: /^Filters/ })).not.toBeInTheDocument()
    expect(groupNames()).not.toContain('Replay lanes')
  })

  it('links a lane to its charts, which open with the check on', async () => {
    await visitOverview('/history/overview?replay=1')
    const link = screen.getByRole('link', { name: 'Assembly Device (replay)' })
    expect(link).toHaveAttribute('href', `/history/device/${ASSEMBLY_LANE.asset_id}`)
  })
})

describe('the Device tab with no device chosen', () => {
  it('lists the machines only, and offers the check in Filters with its count', async () => {
    await visitPicker()
    expect(pickerNames()).toEqual(['Assembly Device', 'Lathe 3', 'Simulator', 'Unfiled pump'])
    // The picker lists every device, an archived lane included, so the count is of all three.
    expect(check()).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: `${REPLAY_LANES_LABEL} 3` })).toBeInTheDocument()
  })

  it('lists the lanes among the machines with the check on, and keeps it in the address', async () => {
    await visitPicker()
    fireEvent.click(check())
    await waitFor(() => expect(pickerNames()).toContain('Assembly Device (replay)'))
    expect(pickerNames()).toEqual([
      'Assembly Device', 'Assembly Device (replay)', 'Lathe 3', 'Lathe 3 (replay)', 'Old rig (replay)', 'Simulator', 'Unfiled pump',
    ])
    expect(query().get(REPLAY_LANES_PARAM)).toBe('1')
    expect(screen.getByRole('button', { name: /^Filters \(1\)/ })).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Filters' })).getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(pickerNames()).not.toContain('Assembly Device (replay)'))
    expect(query().has(REPLAY_LANES_PARAM)).toBe(false)
  })

  it('has no Filters while no lane exists', async () => {
    fleet = MACHINES
    await visitPicker()
    expect(screen.queryByRole('button', { name: /^Filters/ })).not.toBeInTheDocument()
    expect(pickerNames()).toHaveLength(4)
  })

  it('says only lanes are registered, and where to show them, when they are all there is', async () => {
    fleet = [ASSEMBLY_LANE]
    await visitPicker()
    expect(screen.getByText('Only replay lanes are registered. Show them in Filters to chart one.')).toBeInTheDocument()
    fireEvent.click(check())
    await waitFor(() => expect(pickerNames()).toEqual(['Assembly Device (replay)']))
  })
})

describe("the Device tab's switcher", () => {
  it('lists the machines only, and the device charted now, until the check is on', async () => {
    await visitDevice(ASSEMBLY.asset_id)
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    const panel = openSwitcher('Assembly Device')
    expect(switcherIds(panel)).toEqual([ASSEMBLY.asset_id, LATHE.asset_id, SIMULATOR.asset_id, LONELY.asset_id])
    expect(check(panel)).not.toBeChecked()
    expect(query().has(REPLAY_LANES_PARAM)).toBe(false)
    fireEvent.click(check(panel))
    await waitFor(() => expect(switcherIds(panel)).toContain(ASSEMBLY_LANE.asset_id))
    expect(switcherIds(panel)).toEqual([
      ASSEMBLY.asset_id, ASSEMBLY_LANE.asset_id, LATHE.asset_id, LATHE_LANE.asset_id, OLD_LANE.asset_id, SIMULATOR.asset_id, LONELY.asset_id,
    ])
    expect(query().get(REPLAY_LANES_PARAM)).toBe('1')
  })

  it('keeps the check on when it switches to another device', async () => {
    await visitDevice(ASSEMBLY.asset_id, '?replay=1')
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    const panel = openSwitcher('Assembly Device')
    const option = within(panel).getByRole('link', { name: /Lathe 3 \(replay\)/ })
    expect(option).toHaveAttribute('href', `/history/device/${LATHE_LANE.asset_id}?replay=1`)
    fireEvent.click(option)
    await waitFor(() => expect(window.location.pathname).toBe(`/history/device/${LATHE_LANE.asset_id}`))
    expect(query().get(REPLAY_LANES_PARAM)).toBe('1')
  })

  it('has no check while no lane exists', async () => {
    fleet = MACHINES
    await visitDevice(ASSEMBLY.asset_id)
    const panel = openSwitcher('Assembly Device')
    expect(check(panel)).not.toBeInTheDocument()
    expect(switcherIds(panel)).toHaveLength(4)
  })
})

describe("a lane opened by its address", () => {
  const readFor = (id) => api.readCarriedTelemetry.mock.calls.some(([bounds]) => bounds.assetIds?.[0] === id)

  it('charts, with the check turned on in the address and in the switcher', async () => {
    await visitDevice(ASSEMBLY_LANE.asset_id, '?range=1h')
    await waitFor(() => expect(readFor(ASSEMBLY_LANE.asset_id)).toBe(true))
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    await waitFor(() => expect(query().get(REPLAY_LANES_PARAM)).toBe('1'))
    expect(query().get('range')).toBe('1h')
    const panel = openSwitcher('Assembly Device (replay)')
    expect(check(panel)).toBeChecked()
    expect(switcherIds(panel)).toContain(ASSEMBLY_LANE.asset_id)
    expect(within(panel).getByRole('link', { name: /Assembly Device \(replay\)/ })).toHaveAttribute('aria-current', 'true')
  })

  it('stays charted and listed when the check is turned off, and the other lanes go', async () => {
    await visitDevice(ASSEMBLY_LANE.asset_id)
    await waitFor(() => expect(query().get(REPLAY_LANES_PARAM)).toBe('1'))
    const panel = openSwitcher('Assembly Device (replay)')
    fireEvent.click(check(panel))
    await waitFor(() => expect(switcherIds(panel)).not.toContain(LATHE_LANE.asset_id))
    expect(switcherIds(panel)).toEqual([ASSEMBLY.asset_id, ASSEMBLY_LANE.asset_id, LATHE.asset_id, SIMULATOR.asset_id, LONELY.asset_id])
    expect(query().has(REPLAY_LANES_PARAM)).toBe(false)
    expect(plots.length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Device: Assembly Device (replay)' })).toBeInTheDocument()
  })

  it('is never what turns the check on for a machine', async () => {
    await visitDevice(ASSEMBLY.asset_id)
    await waitFor(() => expect(readFor(ASSEMBLY.asset_id)).toBe(true))
    expect(query().has(REPLAY_LANES_PARAM)).toBe(false)
  })
})
