import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { AreasTab } from '../components/tabs/AreasTab'
import { CellsTab } from '../components/tabs/CellsTab'
import { api } from '../api'
import { helpTipText } from '../test/tooltips'
import {
  UNS_SKIP_REASONS, unsFilterFor, unsPathIndex, unsSkipSentence, unsTopicOf, unsTopicRoot, unsTopicsMoved
} from '../utils/unsPath'

/**
 * Each asset's place in the Unified Namespace, from device_uns_paths (0214): a device shows its
 * topic with a copy button or says why it has none, an area and a cell show the subscription filter
 * for everything beneath them, a gateway shows nothing, and a rename says how many topics it moves.
 * While the bridge is off, which is the chart's default, every row says so and nothing is read.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan-1'),
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), uploadAreaPlan: vi.fn(), removeAreaPlan: vi.fn() }
  }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const AREA = { area_id: 'area-1', area_name: 'North Shop', description: null, icon: 'Factory', cells: [], plan_path: null }
const CELL = { cell_id: 'cell-1', cell_name: 'Bay 1', area_id: 'area-1', icon: 'Factory', is_archived: false, gateways: [] }
const GATEWAY = {
  gateway_id: 'gw-1', gateway_name: 'Line_Gateway', sparkplug_id: 'gwy-1', sparkplug_group: 'Aber',
  cell_id: 'cell-1', location_scope: 'cell', status: 'ONLINE', is_archived: false, devices: []
}
const device = (overrides = {}) => ({
  asset_id: 'dev-1', asset_name: 'CNC_01', sparkplug_id: 'devaaaaaaaa000040008000', status: 'ONLINE',
  is_quarantined: false, is_archived: false, active_gateway_id: 'gw-1', gateway_name: 'Line_Gateway',
  cell_id: null, area_id: null, location_scope: 'cell', effective_cell_id: 'cell-1', gateway_cell_id: 'cell-1',
  location_source: 'inherited', cell_mismatch: false, effective_area_id: 'area-1',
  first_dbirth_at: '2026-07-27T12:00:00Z', created_at: '2026-07-20T12:00:00Z',
  ...overrides
})
const PUBLISHED = { device_id: 'dev-1', area_id: 'area-1', cell_id: 'cell-1', enterprise: 'Aber', uns_path: 'Aber/Cardiff/North Shop/Bay 1/CNC_01', skip_reason: null }
const PRESS = { device_id: 'dev-2', area_id: 'area-1', cell_id: 'cell-1', enterprise: 'Aber', uns_path: 'Aber/Cardiff/North Shop/Bay 1/Press_02', skip_reason: null }

const routeGet = ({ devices = [device()], paths = [PUBLISHED], cells = [CELL] } = {}) => (path) => {
  if (path.startsWith('/api/v1/uns-paths')) return paths instanceof Error ? Promise.reject(paths) : Promise.resolve(paths)
  if (path.startsWith('/api/v1/areas')) return Promise.resolve([{ ...AREA, cells }])
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(cells)
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve([GATEWAY])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
  return Promise.resolve([])
}

const bridge = (settings) => { globalThis.__ABER_CONFIG__ = settings }
const readsPaths = () => api.get.mock.calls.some(([path]) => path.startsWith('/api/v1/uns-paths'))
const panel = () => document.querySelector('.context-panel')
const field = (label) => within(panel()).getByText(label).closest('.context-field')
const open = (name) => fireEvent.click(within(document.querySelector('.page-main')).getByText(name))

const showDevice = async (routes) => {
  api.get.mockImplementation(routeGet(routes))
  render(<DevicesTab showToast={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
  open('CNC_01')
}

const showArea = async (routes) => {
  api.get.mockImplementation(routeGet(routes))
  render(<AreasTab showToast={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(within(document.querySelector('.page-main table')).getByText('North Shop')).toBeTruthy())
  open('North Shop')
}

const showCell = async (routes) => {
  api.get.mockImplementation(routeGet(routes))
  render(<CellsTab showToast={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(within(document.querySelector('.page-main table')).getByText('Bay 1')).toBeTruthy())
  open('Bay 1')
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => { delete globalThis.__ABER_CONFIG__ })

describe('the rules the pages share', () => {
  const index = unsPathIndex([
    PUBLISHED,
    { ...PRESS, enterprise: 'Other', uns_path: 'Other/Cardiff/North Shop/Bay 1/Press_02' },
    { device_id: 'dev-3', area_id: 'area-1', cell_id: null, enterprise: 'Aber', uns_path: 'Aber/Cardiff/North Shop/BMS', skip_reason: null },
    { device_id: 'dev-4', area_id: 'area-1', cell_id: 'cell-2', enterprise: 'Aber', uns_path: null, skip_reason: 'unsafe_name' },
  ])

  it('puts the root before the path, trimmed of slashes as the bridge trims it', () => {
    expect(unsTopicRoot()).toBe('uns')
    bridge({ VITE_UNS_MQTT_TOPIC_ROOT: '/plant/uns/' })
    expect(unsTopicOf(PUBLISHED)).toBe('plant/uns/Aber/Cardiff/North Shop/Bay 1/CNC_01')
    expect(unsTopicOf({ uns_path: null, skip_reason: 'lane' })).toBeNull()
  })

  it('cuts a filter from the paths beneath an area or a cell, + where the groups differ', () => {
    expect(unsFilterFor(index, { areaId: 'area-1' })).toBe('uns/+/Cardiff/North Shop/#')
    expect(unsFilterFor(index, { cellId: 'cell-1' })).toBe('uns/+/Cardiff/North Shop/Bay 1/#')
    expect(unsFilterFor(unsPathIndex([PUBLISHED]), { cellId: 'cell-1' })).toBe('uns/Aber/Cardiff/North Shop/Bay 1/#')
    // A cell whose devices are all skipped has no filter to give.
    expect(unsFilterFor(index, { cellId: 'cell-2' })).toBeNull()
    expect(unsFilterFor(null, { areaId: 'area-1' })).toBeNull()
  })

  it('counts the topics a rename moves: only devices with one, beneath what is renamed', () => {
    expect(unsTopicsMoved(index, { areaId: 'area-1' })).toBe(3)
    expect(unsTopicsMoved(index, { cellId: 'cell-1' })).toBe(2)
    expect(unsTopicsMoved(index, { cellId: 'cell-2' })).toBe(0)
    expect(unsTopicsMoved(index, { deviceId: 'dev-1' })).toBe(1)
  })

  it('says each reason in one sentence, with what fixes it', () => {
    expect(UNS_SKIP_REASONS).toEqual(['site_unset', 'lane', 'unassigned', 'cell_unfiled', 'unsafe_name'])
    for (const reason of UNS_SKIP_REASONS) {
      expect(unsSkipSentence(reason)).toMatch(/^Not in the Unified Namespace: /)
    }
    expect(unsSkipSentence('cell_unfiled')).toBe('Not in the Unified Namespace: its cell is in no area. Put the cell in an area on the Cells page.')
    expect(unsSkipSentence('site_unset')).toMatch(/Settings page, under Site/)
    expect(unsSkipSentence('unassigned')).toMatch(/Edit Details/)
    expect(unsSkipSentence('lane', { source: 'shadow' })).toMatch(/replay lane/)
    expect(unsSkipSentence('lane', { source: 'simulated' })).toMatch(/simulated device/)
  })

  it('names which name a topic cannot carry, and where it is changed', () => {
    expect(unsSkipSentence('unsafe_name', { device: { asset_name: 'CNC/01' } })).toMatch(/its name contains .* Edit Details/)
    expect(unsSkipSentence('unsafe_name', { device: { asset_name: 'CNC' }, cell: { cell_name: 'Bay#1' } })).toMatch(/cell's name .* Cells page/)
    expect(unsSkipSentence('unsafe_name', { device: { asset_name: 'CNC' }, area: { area_name: 'A+B' } })).toMatch(/area's name .* Areas page/)
    expect(unsSkipSentence('unsafe_name', { device: { asset_name: 'CNC' } })).toMatch(/site's name .* Settings page/)
  })
})

describe('the bridge is off by default', () => {
  it('a device says so, and nothing reads the paths', async () => {
    await showDevice()
    expect(field('Unified Namespace Topic')).toHaveTextContent('Not published: the Unified Namespace bridge is off.')
    expect(helpTipText('What Unified Namespace Topic means', panel())).toMatch(/ingestion\.unsMqttEnabled/)
    expect(readsPaths()).toBe(false)
  })

  it('an area and a cell say so', async () => {
    await showArea()
    expect(field('Unified Namespace Filter')).toHaveTextContent('Not published: the Unified Namespace bridge is off.')
    expect(readsPaths()).toBe(false)
  })

  it('a rename says nothing about topics', async () => {
    await showArea()
    fireEvent.click(within(panel()).getByText('Edit Details'))
    fireEvent.change(screen.getByLabelText('Area Name'), { target: { value: 'South Shop' } })
    expect(screen.queryByText(/moves the Unified Namespace topics/)).toBeNull()
  })
})

describe('with the bridge on', () => {
  beforeEach(() => bridge({ VITE_UNS_MQTT_ENABLED: 'true' }))

  it('a device shows its topic, with a copy button, and where each metric goes', async () => {
    await showDevice()
    const row = field('Unified Namespace Topic')
    expect(within(row).getByRole('button', { name: 'Copy Unified Namespace topic uns/Aber/Cardiff/North Shop/Bay 1/CNC_01' })).toBeInTheDocument()
    expect(row).toHaveTextContent('Each metric publishes at <topic>/<metric name>.')
    expect(helpTipText('What Unified Namespace Topic means', panel())).toMatch(/Sparkplug ID stays the device's identity/)
  })

  it("a device's topic is under the chart's root", async () => {
    bridge({ VITE_UNS_MQTT_ENABLED: 'true', VITE_UNS_MQTT_TOPIC_ROOT: 'plant/uns' })
    await showDevice()
    expect(within(field('Unified Namespace Topic')).getByRole('button', { name: /plant\/uns\/Aber\/Cardiff/ })).toBeInTheDocument()
  })

  it('a skipped device says why, and what fixes it', async () => {
    await showDevice({ paths: [{ ...PUBLISHED, uns_path: null, skip_reason: 'cell_unfiled' }] })
    expect(field('Unified Namespace Topic')).toHaveTextContent(
      'Not in the Unified Namespace: its cell is in no area. Put the cell in an area on the Cells page.')
    expect(within(field('Unified Namespace Topic')).queryByRole('button', { name: /^Copy/ })).toBeNull()
  })

  it('a failed read is said, not shown as a skip', async () => {
    await showDevice({ paths: new Error('unreachable') })
    expect(field('Unified Namespace Topic')).toHaveTextContent('Could not be read just now.')
  })

  it('an area shows a filter for everything beneath it, labelled as one', async () => {
    await showArea({ paths: [PUBLISHED, PRESS] })
    const row = field('Unified Namespace Filter')
    expect(within(row).getByRole('button', { name: 'Copy Unified Namespace filter uns/Aber/Cardiff/North Shop/#' })).toBeInTheDocument()
    expect(helpTipText('What Unified Namespace Filter means', panel())).toMatch(/not a topic: nothing publishes to the area itself/)
  })

  it('a cell shows the filter beneath it', async () => {
    await showCell()
    expect(within(field('Unified Namespace Filter')).getByRole('button', { name: 'Copy Unified Namespace filter uns/Aber/Cardiff/North Shop/Bay 1/#' })).toBeInTheDocument()
  })

  it('an area nothing in publishes says so', async () => {
    await showArea({ paths: [{ ...PUBLISHED, uns_path: null, skip_reason: 'site_unset' }] })
    expect(field('Unified Namespace Filter')).toHaveTextContent('No device in this area is in the Unified Namespace yet.')
  })

  it("renaming an area says how many devices' topics it moves, and only once the name changes", async () => {
    await showArea({ paths: [PUBLISHED, PRESS] })
    fireEvent.click(within(panel()).getByText('Edit Details'))
    expect(screen.queryByText(/moves the Unified Namespace topics/)).toBeNull()
    fireEvent.change(screen.getByLabelText('Area Name'), { target: { value: 'South Shop' } })
    expect(screen.getByText(/Renaming it moves the Unified Namespace topics of 2 devices\./)).toHaveTextContent(
      'A program still subscribed to an old topic gets no new readings.')
  })

  it("renaming a cell says how many devices' topics it moves", async () => {
    await showCell({ paths: [PUBLISHED, PRESS, { ...PUBLISHED, device_id: 'dev-9', uns_path: null, skip_reason: 'unsafe_name' }] })
    fireEvent.click(within(panel()).getByText('Edit Details'))
    fireEvent.change(screen.getByLabelText('Cell Name'), { target: { value: 'Bay 9' } })
    expect(screen.getByText(/Renaming it moves the Unified Namespace topics of 2 devices\./)).toBeInTheDocument()
  })

  it('renaming a device says it moves its topic', async () => {
    await showDevice()
    fireEvent.click(within(panel()).getByText('Edit Details'))
    fireEvent.change(screen.getByLabelText('Device Name'), { target: { value: 'CNC_02' } })
    expect(screen.getByText(/Renaming it moves its Unified Namespace topic\./)).toBeInTheDocument()
  })

  it('renaming a skipped device moves no topic, and says nothing', async () => {
    await showDevice({ paths: [{ ...PUBLISHED, uns_path: null, skip_reason: 'unassigned' }] })
    fireEvent.click(within(panel()).getByText('Edit Details'))
    fireEvent.change(screen.getByLabelText('Device Name'), { target: { value: 'CNC_02' } })
    expect(screen.queryByText(/moves its Unified Namespace topic/)).toBeNull()
  })
})
