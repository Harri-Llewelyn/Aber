/**
 * History says a unit as its symbol: the catalogue holds MTConnect's unit names (`CELSIUS`), and a
 * chart's title, head, hover, summary, valid range and scale read `°C`. A unit with no symbol is
 * said as the code. uPlot draws on a canvas jsdom does not have, so a stand-in records what each
 * chart was built with.
 */
import React from 'react'
import { render, screen, waitFor, within, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { api } from '../api'
import { chartTitle, lowWords, readingWords } from '../utils/history'

const { plots } = vi.hoisted(() => ({ plots: [] }))

vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))

vi.mock('uplot', () => {
  class FakePlot {
    constructor(opts, data, target) {
      this.opts = opts
      this.data = data
      this.over = document.createElement('div')
      this.over.className = 'u-over'
      target.appendChild(this.over)
      plots.push(this)
    }
    setSize(size) { this.size = size }
    destroy() { this.destroyed = true; this.over.remove() }
  }
  FakePlot.paths = { stepped: () => () => null }
  return { default: FakePlot }
})

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), readCarriedTelemetry: vi.fn(), readTelemetryChanges: vi.fn(), readHourOfDay: vi.fn(), readAlertOccurrences: vi.fn() },
  }
})

const MILL = '2b3e0c4a-4444-4000-8000-000000000004'
const METRICS = ['Coolant/TEMP', 'Spindle/LOAD', 'Arm/TORQUE', 'Press/ODDITY']
const devices = [
  { asset_id: MILL, asset_name: 'Mill 2', last_birth_metrics: METRICS, effective_cell_id: 'c1', location_source: 'inherited', status: 'ONLINE', submodel_schema_ids: ['s1'] },
]
const schemas = [{ schema_uuid: 's1', schema_definition: { properties: { 'Coolant/TEMP': { type: 'number', minimum: 0, maximum: 120 } } } }]
const catalog = [
  { name: 'Coolant/TEMP', units: 'CELSIUS', datatype: 10 },
  { name: 'Spindle/LOAD', units: 'PERCENT', datatype: 10 },
  { name: 'Arm/TORQUE', units: 'NEWTON_METER', datatype: 10 },
  // A unit the map has no symbol for: said as it is.
  { name: 'Press/ODDITY', units: 'CUSTOM_UNIT', datatype: 10 },
]

const routeGet = (path) => {
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'c1', cell_name: 'Turning', area_id: 'a1' }])
  if (path.startsWith('/api/v1/areas')) return Promise.resolve([{ area_id: 'a1', area_name: 'Hall B' }])
  if (path.startsWith('/api/v1/schemas')) return Promise.resolve(schemas)
  if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(catalog)
  return Promise.resolve([])
}

/** A reading in each of three buckets, for each metric asked for: 40, 41, and a carried one. */
const readings = ({ from, bucketMinutes, metricNames }) => {
  const width = bucketMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  return Promise.resolve(metricNames.flatMap(name => [0, 1, 2].map(i => ({
    bucket_ts: new Date(first + i * width).toISOString(), asset_id: 'dev2b3e0c4a444440008000', metric_name: name,
    avg_double: 40 + i, min_double: 39, max_double: 45, last_double: 41, last_string: null, last_bool: null,
    n_rows: i === 2 ? 0 : 4, is_carried: i === 2,
  }))))
}

/** The chart plotted for a figure: the plots are made in the order the figures are drawn. */
const plotOf = (title) => plots[screen.getAllByRole('figure').findIndex(f => f.querySelector('.history-chart-title')?.textContent === title)]

const visit = async (address) => {
  window.history.pushState({}, '', address)
  render(<HistoryTab hasPermission={() => true} showToast={vi.fn()} userRole="Administrator" />)
  await waitFor(() => expect(screen.queryByText(/Loading devices/)).not.toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  plots.length = 0
  api.get.mockImplementation(routeGet)
  api.readCarriedTelemetry.mockImplementation(readings)
  api.readTelemetryChanges.mockResolvedValue([])
  api.readHourOfDay.mockResolvedValue([])
  api.readAlertOccurrences.mockResolvedValue([])
  document.documentElement.setAttribute('data-theme', 'dark')
  document.documentElement.style.setProperty('--accent', '#00d4ff')
})

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--accent')
  window.history.pushState({}, '', '/')
})

describe("a device's charts say a unit as its symbol", () => {
  it('titles each chart with the symbol, and the code when there is none', async () => {
    await visit(`/history/device/${MILL}`)
    await screen.findAllByRole('figure')
    for (const name of ['Coolant/TEMP (°C)', 'Spindle/LOAD (%)', 'Arm/TORQUE (N·m)', 'Press/ODDITY (CUSTOM_UNIT)']) {
      expect(screen.getByRole('figure', { name })).toBeInTheDocument()
    }
    expect(screen.queryByRole('figure', { name: /CELSIUS|PERCENT|NEWTON_METER/ })).toBeNull()
  })

  it("heads each chart with its latest reading in the symbol, a percentage against the number", async () => {
    await visit(`/history/device/${MILL}`)
    await screen.findAllByRole('figure')
    const head = (name) => within(screen.getByRole('figure', { name })).getByText(/^Latest /)
    expect(head('Coolant/TEMP (°C)')).toHaveTextContent(/^Latest 41 °C · /)
    expect(head('Spindle/LOAD (%)')).toHaveTextContent(/^Latest 41% · /)
    expect(head('Arm/TORQUE (N·m)')).toHaveTextContent(/^Latest 41 N·m · /)
    expect(head('Press/ODDITY (CUSTOM_UNIT)')).toHaveTextContent(/^Latest 41 CUSTOM_UNIT · /)
  })

  it('says the symbol under the pointer, in the valid range and in the summary a screen reader is given', async () => {
    await visit(`/history/device/${MILL}`)
    await waitFor(() => expect(plots).toHaveLength(4))
    const figure = screen.getByRole('figure', { name: 'Coolant/TEMP (°C)' })
    const { opts } = plotOf('Coolant/TEMP (°C)')
    act(() => { opts.hooks.setCursor[0]({ cursor: { idx: 0 } }) })
    expect(figure.querySelector('.history-chart-hover')).toHaveTextContent(/ · 40 °C \(39 to 45 °C\)$/)
    expect(within(figure).getByText('Valid range 0 to 120 °C')).toBeInTheDocument()
    const summary = screen.getByRole('img', { name: 'Coolant/TEMP (°C)' })
    expect(summary).toHaveAccessibleDescription(/^Coolant\/TEMP \(°C\), .* Latest 41 °C, in the bucket from .* Lowest 39 °C, highest 45 °C\./)
  })

  it('draws a percentage axis with its sign at every tick, and a unit with a space after it with none', async () => {
    await visit(`/history/device/${MILL}`)
    await waitFor(() => expect(plots).toHaveLength(4))
    const ticks = (title) => plotOf(title).opts.axes[1].values(null, [0, 50, 100])
    expect(ticks('Spindle/LOAD (%)')).toEqual(['0%', '50%', '100%'])
    expect(ticks('Coolant/TEMP (°C)')).toEqual(['0', '50', '100'])
  })
})

describe('the Metric tab says a unit as its symbol', () => {
  it("lists each metric's unit as its symbol, and titles the chart with it", async () => {
    await visit('/history/metric')
    const table = screen.getByRole('table', { name: /choose a metric/i })
    const row = (name) => within(table).getByRole('link', { name }).closest('tr')
    expect(within(row('Coolant/TEMP')).getByText('°C')).toBeInTheDocument()
    expect(within(row('Spindle/LOAD')).getByText('%')).toBeInTheDocument()
    expect(within(row('Press/ODDITY')).getByText('CUSTOM_UNIT')).toBeInTheDocument()
    expect(within(table).queryByText('CELSIUS')).toBeNull()
  })
})

describe('the words History says a reading in', () => {
  it('say a code as its symbol and an unknown unit as it is', () => {
    expect(readingWords(18.8, 'CELSIUS')).toBe('18.8 °C')
    expect(readingWords(42, 'PERCENT')).toBe('42%')
    expect(readingWords(90, 'DEGREE')).toBe('90°')
    expect(readingWords(3.5, 'KILOWATT/HOUR')).toBe('3.5 kW/h')
    expect(readingWords(7, 'CUSTOM_UNIT')).toBe('7 CUSTOM_UNIT')
    expect(readingWords(7, null)).toBe('7')
    expect(readingWords(null, 'CELSIUS')).toBe('—')
  })

  it('titles a chart with the symbol, and keeps a time in state a percentage of the time', () => {
    expect(chartTitle('Systems/TEMPERATURE', 'CELSIUS')).toBe('Systems/TEMPERATURE (°C)')
    expect(chartTitle('Systems/AVAILABILITY', null)).toBe('Systems/AVAILABILITY')
    expect(chartTitle('Press/RUNNING', '% of the time')).toBe('Press/RUNNING (% of the time)')
    expect(readingWords(0.42, '% of the time')).toBe('42%')
  })

  it('give the first of a range its sign only where the sign stands against the number', () => {
    expect(lowWords(0, 'PERCENT')).toBe('0%')
    expect(lowWords(0, 'DEGREE')).toBe('0°')
    expect(lowWords(0, 'KILOWATT')).toBe('0')
    expect(lowWords(0, 'CELSIUS')).toBe('0')
  })
})
