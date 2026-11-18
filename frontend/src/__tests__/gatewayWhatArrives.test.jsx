import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'
import { pick } from '../test/listFilters'
import {
  ARRIVAL_COLUMNS, ARRIVAL_FRESH_MINUTES, arrivalFigures, arrivalSummary, deviceLastReading,
  hasCount, lastReadings, NOT_OBSERVED,
} from '../utils/gatewayArrivals'

/**
 * What arrives from a gateway: a group of three figures Prometheus holds for its edge node, and
 * the time of each device's last reading beside the device list. The figures and the readings are
 * two reads, so the historian failing leaves the figures standing; a figure with no value reads
 * Not observed, never a zero and never the last value.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(), enrolmentReadiness: vi.fn(),
      gatewayArrivals: vi.fn(), gatewayDevicesLastReading: vi.fn(),
    },
  }
})

const NOW = new Date().toISOString()
const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString()

const device = (n, overrides = {}) => ({
  asset_id: `0000000${n}-0000-4000-8000-000000000000`,
  asset_name: `CNC_${String(n).padStart(2, '0')}`,
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  ...overrides,
})

const gateway = (overrides = {}) => ({
  gateway_id: 'gw-1',
  gateway_name: 'Line_A_Gateway',
  sparkplug_id: 'gwy100000000000400080000',
  sparkplug_group: 'Plant-A',
  status: 'ONLINE',
  deployment: 'host',
  is_simulated: false,
  is_shadow: false,
  is_archived: false,
  cell_id: 'cell-1',
  location_scope: 'cell',
  last_heartbeat: NOW,
  devices: [],
  ...overrides,
})

const FIGURES = {
  messages_per_second: 12.5, sequence_gaps_last_hour: 0, messages_missed_last_hour: 0, observed_at: NOW,
}

const show = async (row, { figures = FIGURES, failing = null } = {}) => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly' }])
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve([row])
    return Promise.resolve([])
  })
  api.enrolmentReadiness.mockResolvedValue({ ready: true, addresses: [] })
  if (failing) api.gatewayArrivals.mockRejectedValue(failing)
  else api.gatewayArrivals.mockResolvedValue(figures)
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} userRole="Shopfloor_Manager" />)
  // The list opens on Active, so an archived row has to be revealed first.
  if (row.is_archived) await waitFor(() => pick('Lifecycle', 'active', 'archived'))
  await waitFor(() => expect(screen.getByText(row.gateway_name)).toBeTruthy())
  fireEvent.click(within(document.querySelector('.page-main')).getByText(row.gateway_name))
}

const group = () => screen.findByRole('button', { name: /^Arriving/ })
const labels = () => [...document.querySelectorAll('.context-panel dt.context-field-label')].map(dt => dt.textContent.trim())
const valueOf = (label) => {
  const dt = [...document.querySelectorAll('.context-panel dt.context-field-label')].find(d => d.textContent.trim() === label)
  return dt?.parentElement.querySelector('dd')
}
const rowOf = (name) => screen.getByText(name).closest('.context-device-row')

beforeEach(() => {
  vi.clearAllMocks()
  api.gatewayDevicesLastReading.mockResolvedValue([])
})
afterEach(() => { delete globalThis.__ABER_CONFIG__ })

describe('the Arriving group', () => {
  it('is closed when the drawer opens, and says the rate and that nothing is missing', async () => {
    await show(gateway())
    const heading = await group()
    expect(heading).toHaveAccessibleName('Arriving, 12.5 messages/s · no gaps')
    expect(heading).toHaveAttribute('aria-expanded', 'false')
    expect(api.gatewayArrivals).toHaveBeenCalledWith('gw-1')
  })

  it('holds the three figures, each read as it is', async () => {
    await show(gateway(), { figures: { ...FIGURES, sequence_gaps_last_hour: 2, messages_missed_last_hour: 5 } })
    fireEvent.click(await group())
    expect(labels()).toEqual(expect.arrayContaining(['Messages Per Second (5m)', 'Sequence Gaps (1h)', 'Messages Missed (1h)']))
    expect(valueOf('Messages Per Second (5m)')).toHaveTextContent('12.5')
    expect(valueOf('Sequence Gaps (1h)')).toHaveTextContent('2')
    expect(valueOf('Messages Missed (1h)')).toHaveTextContent('5')
  })

  it('warns, in words and an icon, when a gap was counted in the last hour', async () => {
    await show(gateway(), { figures: { ...FIGURES, sequence_gaps_last_hour: 1, messages_missed_last_hour: 3 } })
    const heading = await group()
    expect(heading).toHaveAccessibleName('Arriving, 12.5 messages/s · 1 gap')
    expect(heading.closest('.context-field-group')).toHaveClass('context-field-group-warning')
    fireEvent.click(heading)
    expect(valueOf('Sequence Gaps (1h)')).toHaveClass('context-field-warning')
    expect(valueOf('Messages Missed (1h)')).toHaveClass('context-field-warning')
    expect(valueOf('Messages Per Second (5m)')).not.toHaveClass('context-field-warning')
  })

  it('reads a gateway ingestion counted nothing from as zero, not as unobserved', async () => {
    await show(gateway(), { figures: { ...FIGURES, messages_per_second: 0 } })
    const heading = await group()
    expect(heading).toHaveAccessibleName('Arriving, 0 messages/s · no gaps')
  })

  it('says Not observed for a figure with no fresh answer, never a zero or the last value', async () => {
    await show(gateway(), {
      figures: { messages_per_second: null, sequence_gaps_last_hour: null, messages_missed_last_hour: null, observed_at: null },
    })
    const heading = await group()
    expect(heading).toHaveAccessibleName(`Arriving, ${NOT_OBSERVED}`)
    fireEvent.click(heading)
    for (const label of ['Messages Per Second (5m)', 'Sequence Gaps (1h)', 'Messages Missed (1h)']) {
      expect(valueOf(label)).toHaveTextContent(NOT_OBSERVED)
    }
  })

  it('says Not observed when the read itself failed', async () => {
    await show(gateway(), { failing: new Error('relation does not exist') })
    expect(await group()).toHaveAccessibleName(`Arriving, ${NOT_OBSERVED}`)
  })

  it('says Not observed for a gateway with no row, such as one added a minute ago', async () => {
    await show(gateway(), { figures: null })
    expect(await group()).toHaveAccessibleName(`Arriving, ${NOT_OBSERVED}`)
  })

  it('explains a missing figure beside it, in the tip on its label', async () => {
    await show(gateway(), { figures: { ...FIGURES, messages_per_second: null } })
    fireEvent.click(await group())
    const tip = within(valueOf('Messages Per Second (5m)').parentElement).getByRole('button', { name: /What Messages Per Second/ })
    fireEvent.focus(tip)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(`Not observed: Prometheus gave no answer in the last ${ARRIVAL_FRESH_MINUTES} minutes.`)
  })

  it.each([
    ['an archived gateway', { is_archived: true }],
    ['the Playback gateway', { is_simulated: true, is_shadow: true }],
  ])('is not drawn for %s, which is not read either', async (_name, extra) => {
    await show(gateway(extra))
    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Arriving/ })).toBeNull()
    expect(api.gatewayArrivals).not.toHaveBeenCalled()
    expect(api.gatewayDevicesLastReading).not.toHaveBeenCalled()
  })

  it.each([
    ['a Remote gateway', { deployment: 'remote' }],
    ['a Third-party gateway', { deployment: 'third_party' }],
    ['a Simulated gateway', { is_simulated: true }],
  ])('is drawn for %s', async (_name, extra) => {
    await show(gateway(extra))
    expect(await group()).toBeTruthy()
  })
})

describe('the devices\' last readings', () => {
  const devices = [
    device(1),
    device(2),
    device(3),
    device(4, { is_archived: true }),
  ]

  it('shows beside each device when it last sent a reading, or that it has none', async () => {
    api.gatewayDevicesLastReading.mockResolvedValue([
      { device_id: devices[0].asset_id, last_reading_at: ago(125) },
      { device_id: devices[1].asset_id, last_reading_at: null },
      { device_id: devices[2].asset_id, last_reading_at: ago(3 * 3600 + 60) },
    ])
    await show(gateway({ devices }))
    await waitFor(() => expect(within(rowOf('CNC_01')).getByText('Last reading 2m ago')).toBeTruthy())
    expect(within(rowOf('CNC_02')).getByText('No reading yet')).toBeTruthy()
    expect(within(rowOf('CNC_03')).getByText('Last reading 3h ago')).toBeTruthy()
    expect(api.gatewayDevicesLastReading).toHaveBeenCalledWith('gw-1')
  })

  it('leaves an archived device without one', async () => {
    api.gatewayDevicesLastReading.mockResolvedValue([{ device_id: devices[0].asset_id, last_reading_at: ago(30) }])
    await show(gateway({ devices }))
    await waitFor(() => expect(within(rowOf('CNC_01')).getByText('Last reading 30s ago')).toBeTruthy())
    expect(rowOf('CNC_04').querySelector('.context-device-last')).toBeNull()
  })

  it('gives the exact time in the tooltip of a reading', async () => {
    api.gatewayDevicesLastReading.mockResolvedValue([{ device_id: devices[0].asset_id, last_reading_at: '2026-11-10T14:30:00Z' }])
    await show(gateway({ devices }))
    await screen.findByText('CNC_01')
    const text = await within(rowOf('CNC_01')).findByText(/^Last reading/)
    expect(text.getAttribute('aria-describedby')).toBeTruthy()
    fireEvent.focus(text)
    expect((await screen.findByRole('tooltip')).textContent).toMatch(/10 Nov 2026/)
  })

  it('says Not observed for every device when the historian cannot be read, and the figures stand', async () => {
    api.gatewayDevicesLastReading.mockRejectedValue(new Error('could not connect to server'))
    await show(gateway({ devices }))
    const heading = await group()
    expect(heading).toHaveAccessibleName('Arriving, 12.5 messages/s · no gaps')
    await waitFor(() => expect(within(rowOf('CNC_01')).getByText('Last reading not observed')).toBeTruthy())
    expect(within(rowOf('CNC_02')).getByText('Last reading not observed')).toBeTruthy()
    expect(rowOf('CNC_04').querySelector('.context-device-last')).toBeNull()
  })

  it('leaves the readings standing when the figures cannot be read', async () => {
    api.gatewayDevicesLastReading.mockResolvedValue([{ device_id: devices[0].asset_id, last_reading_at: ago(45) }])
    await show(gateway({ devices }), { failing: new Error('down') })
    await waitFor(() => expect(within(rowOf('CNC_01')).getByText('Last reading 45s ago')).toBeTruthy())
  })

  it('draws a gateway with no device as before, with no tip on the label', async () => {
    await show(gateway({ devices: [] }))
    await group()
    expect(screen.getByText('No devices assigned')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /What the last reading beside each device means/ })).toBeNull()
  })
})

describe('the pure readers', () => {
  const settled = (value) => ({ status: 'fulfilled', value })
  const failed = { status: 'rejected', reason: new Error('x') }

  it('keeps the columns the view and the collector name', () => {
    expect(ARRIVAL_COLUMNS).toEqual(['messages_per_second', 'sequence_gaps_last_hour', 'messages_missed_last_hour'])
  })

  it('reads each figure as a number or as none', () => {
    expect(arrivalFigures(settled({ ...FIGURES, messages_missed_last_hour: 'x', sequence_gaps_last_hour: NaN })))
      .toEqual({ perSecond: 12.5, gaps: null, missed: null, observedAt: NOW })
    expect(arrivalFigures(failed)).toEqual({ perSecond: null, gaps: null, missed: null, observedAt: null })
    expect(arrivalFigures(settled(null))).toEqual({ perSecond: null, gaps: null, missed: null, observedAt: null })
    expect(arrivalFigures(undefined)).toEqual({ perSecond: null, gaps: null, missed: null, observedAt: null })
  })

  it('counts a gap only from a whole one: increase() extrapolates', () => {
    expect([0, 0.4, 0.5, 1, 6.98].map(hasCount)).toEqual([false, false, true, true, true])
    expect(hasCount(null)).toBe(false)
  })

  it('summarises in words, with the warning tone only for a gap', () => {
    expect(arrivalSummary({ perSecond: 0.03, gaps: 0 })).toEqual({ text: '0.03 messages/s · no gaps', tone: undefined })
    expect(arrivalSummary({ perSecond: 1204, gaps: 3 })).toEqual({ text: '1,204 messages/s · 3 gaps', tone: 'warning' })
    expect(arrivalSummary({ perSecond: null, gaps: 1 })).toEqual({ text: '1 gap', tone: 'warning' })
    expect(arrivalSummary({ perSecond: null, gaps: null })).toEqual({ text: NOT_OBSERVED, tone: undefined })
  })

  it('keys the devices\' last readings by device, and has none for a read that failed', () => {
    const map = lastReadings(settled([{ device_id: 'a', last_reading_at: NOW }, { device_id: 'b', last_reading_at: null }]))
    expect([...map.entries()]).toEqual([['a', NOW], ['b', null]])
    expect(lastReadings(failed)).toBeNull()
    expect(lastReadings(settled('nope'))).toBeNull()
  })

  it('says what sits beside a device', () => {
    const at = Date.parse('2026-11-10T12:00:00Z')
    const map = new Map([['a', '2026-11-10T11:57:00Z'], ['b', null]])
    expect(deviceLastReading(map, 'a', at)).toMatchObject({ text: 'Last reading 3m ago', kind: 'read' })
    expect(deviceLastReading(map, 'b', at)).toMatchObject({ text: 'No reading yet', kind: 'none' })
    expect(deviceLastReading(map, 'archived', at)).toBeNull()
    expect(deviceLastReading(null, 'a', at)).toMatchObject({ text: 'Last reading not observed', kind: 'unobserved' })
  })
})
