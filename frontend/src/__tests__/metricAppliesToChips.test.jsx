import React from 'react'
import { render, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { api } from '../api'
import { deviceUrl, metricHistoryUrl } from '../routes'
import { queryTabLink } from '../test/tabBar'
import { getByTooltip, helpTipText } from '../test/tooltips'

/**
 * A derived metric's Applies To, in the Metrics drawer: a chip for each device that reports every
 * input, which opens the device on the Devices page, as the Schemas drawer's Devices field does. The
 * inputs are said once, in the field's help. With no device, the field says what none reports yet.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const metric = (id, name, extra = {}) => ({
  metric_uuid: id, name, metric_group: name.split('/')[0], datatype: 10, standard: null, deprecated: false, derivation: null, ...extra
})

const CATALOG = [
  metric('m1', 'Controller/PART_COUNT', { units: 'COUNT' }),
  metric('m2', 'Controller/EXECUTION', { datatype: 12 }),
  metric('m3', 'Power/PHASE_A', { units: 'KILOWATT' }),
  metric('m4', 'Power/PHASE_B', { units: 'KILOWATT' }),
  metric('d1', 'Controller/PARTS_PER_HOUR', { units: 'COUNT/HOUR', derivation: { kind: 'counter_rate', input: 'Controller/PART_COUNT' } }),
  metric('d2', 'Controller/UPTIME', { derivation: { kind: 'time_in_state', input: 'Controller/EXECUTION', states: ['ACTIVE'] } }),
  metric('d3', 'Power/TOTAL', {
    units: 'KILOWATT',
    derivation: { kind: 'sum', inputs: [{ metric: 'Power/PHASE_A', sign: 1 }, { metric: 'Power/PHASE_B', sign: 1 }] }
  }),
]

const GROUPS = [{ group_uuid: 'g1', name: 'Controller', standard: 'MTConnect' }, { group_uuid: 'g2', name: 'Power', standard: null }]

const press = (n, metrics = ['Controller/PART_COUNT']) => ({
  asset_id: `p${n}`, asset_name: `Press ${n}`, last_birth_metrics: metrics, status: 'ONLINE', location_source: 'inherited'
})

let devices = []

beforeEach(() => {
  vi.clearAllMocks()
  devices = []
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
    if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(CATALOG)
    if (path.startsWith('/api/v1/metric-groups')) return Promise.resolve(GROUPS)
    return Promise.resolve([])
  })
})

/** The drawer of the derived metric `name`, opened from its row on the Derived tab. */
const openDrawer = async (name) => {
  render(<MetricsTab showToast={vi.fn()} hasPermission={() => false} />)
  await waitFor(() => expect(queryTabLink('Derived')).toBeTruthy())
  fireEvent.click(queryTabLink('Derived'))
  await waitFor(() => expect(document.querySelector('.card table')).toBeTruthy())
  fireEvent.click(within(document.querySelector('.card table')).getByText(name))
  const drawer = document.querySelector('.context-panel')
  await waitFor(() => expect(within(drawer).getByText('Applies To')).toBeTruthy())
  return drawer
}

const field = (drawer) => within(drawer).getByText('Applies To').closest('.context-field')
const chips = (drawer) => [...field(drawer).querySelectorAll('.context-device-list > a.chip.chip-link')]

describe("a derived metric's Applies To", () => {
  it('lists one device as a chip that opens it on the Devices page', async () => {
    devices = [press(1)]
    const drawer = await openDrawer('Controller/PARTS_PER_HOUR')
    const [chip, ...rest] = chips(drawer)
    expect(rest).toHaveLength(0)
    expect(chip.textContent).toBe('Press 1')
    expect(chip.getAttribute('href')).toBe(deviceUrl('p1'))
    expect(chip.querySelector('svg')).toBeTruthy()
    expect(getByTooltip('Open Press 1 on the Devices page', field(drawer))).toBe(chip)
    fireEvent.click(chip)
    expect(window.location.pathname + window.location.search).toBe(deviceUrl('p1'))
  })

  it('lists forty devices, every one a chip in name order, with no count of the rest', async () => {
    devices = Array.from({ length: 40 }, (_, i) => press(40 - i))
    const drawer = await openDrawer('Controller/PARTS_PER_HOUR')
    const listed = chips(drawer)
    expect(listed.map(a => a.textContent)).toEqual(Array.from({ length: 40 }, (_, i) => `Press ${i + 1}`))
    expect(listed.map(a => a.getAttribute('href'))).toEqual(Array.from({ length: 40 }, (_, i) => deviceUrl(`p${i + 1}`)))
    expect(field(drawer).querySelector('button.chip')).toBeNull()
    expect(field(drawer).textContent).not.toMatch(/\bmore\b/)
  })

  it('cuts a long name with an ellipsis that slides on hover or focus, inside the chip', async () => {
    devices = [press(1)]
    const drawer = await openDrawer('Controller/PARTS_PER_HOUR')
    const [chip] = chips(drawer)
    expect(chip.querySelector('.chip-name.overflow-text').textContent).toBe('Press 1')
  })

  it('says once, in its help, what the devices report, and only names them beside it', async () => {
    devices = [press(1), press(2)]
    const drawer = await openDrawer('Controller/PARTS_PER_HOUR')
    expect(helpTipText('What Applies To means', drawer)).toBe(
      'The devices in service that report Controller/PART_COUNT. Each opens on the Devices page. Nothing is stored: the value is computed when it is drawn.'
    )
    expect(field(drawer).querySelector('.context-field-value').textContent).toBe('Press 1Press 2')
  })

  it("names every input of a sum in its help, and lists only the devices that report all of them", async () => {
    devices = [press(1, ['Power/PHASE_A']), press(2, ['Power/PHASE_A', 'Power/PHASE_B'])]
    const drawer = await openDrawer('Power/TOTAL')
    expect(helpTipText('What Applies To means', drawer)).toMatch(/^The devices in service that report Power\/PHASE_A and Power\/PHASE_B\. /)
    expect(chips(drawer).map(a => a.textContent)).toEqual(['Press 2'])
  })

  it('says no device yet, and what none reports, when there is none', async () => {
    devices = [press(1, ['Other/X'])]
    const drawer = await openDrawer('Controller/UPTIME')
    expect(chips(drawer)).toHaveLength(0)
    expect(field(drawer).querySelector('.context-field-value').textContent).toBe('No device yet: none reports Controller/EXECUTION')
  })

  it('keeps View in History, which compares the devices on one scale', async () => {
    devices = [press(1), press(2)]
    const drawer = await openDrawer('Controller/PARTS_PER_HOUR')
    expect(within(drawer).getByRole('link', { name: /View in History/ }).getAttribute('href')).toBe(metricHistoryUrl('Controller/PARTS_PER_HOUR'))
  })
})
