/**
 * The per-device telemetry inspector and its CSV export, which together replaced the standalone
 * Telemetry page.
 *
 * The inspector has moved twice since -- row accordion, then context panel, now a modal -- for the
 * same reason each time: it is a four-column table and kept being given somewhere too narrow to be
 * one. None of that changes what it MEANS, which is what these pin.
 *
 * The behaviour worth pinning is the metric list: DECLARED UNION OBSERVED. Observed-only would
 * drop a metric the moment it stopped reporting -- which is precisely the fault an operator is
 * looking for, so a silent sensor would vanish from the list rather than show as stale.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TelemetryModal } from '../components/modals/TelemetryModal'
import { TelemetryExportModal } from '../components/modals/TelemetryExportModal'
import { PERMISSION_UUIDS, } from '../constants'
import { api, TELEMETRY_EXPORT_MAX_ROWS } from '../api'
import { downloadCSV } from '../utils/downloadCSV'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../utils/downloadCSV', () => ({ downloadCSV: vi.fn() }))

const NOW = Date.parse('2026-08-02T12:00:00Z')

const device = (overrides = {}) => ({
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  asset_name: 'Simulated_CNC_01',
  last_birth_metrics: ['Systems/TEMPERATURE', 'Controller/EXECUTION', 'OEE/AVAILABILITY'],
  ...overrides
})

const observed = [
  { time: new Date(NOW - 60_000).toISOString(), asset_id: 'dev1', metric_name: 'Systems/TEMPERATURE', val_double: 42.5, val_string: null, val_bool: null },
  { time: new Date(NOW - 30_000).toISOString(), asset_id: 'dev1', metric_name: 'Controller/EXECUTION', val_double: null, val_string: 'ACTIVE', val_bool: null }
]

// No expand step: a modal has no collapsed state to defer the request to, and opening it is
// already the deliberate act the accordion used its first expand for.
const showDrawer = async (props = {}) => {
  render(<TelemetryModal device={device()} hasPermission={() => true} onExport={vi.fn()} onClose={vi.fn()} {...props} />)
  await waitFor(() => expect(api.get).toHaveBeenCalled())
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockResolvedValue(observed)
})

describe('device telemetry drawer', () => {
  it('names the device it is showing, and reads on open', async () => {
    render(<TelemetryModal device={device()} hasPermission={() => true} onClose={vi.fn()} />)

    expect(screen.getByText(/Telemetry — Simulated_CNC_01/)).toBeInTheDocument()
    await waitFor(() => expect(api.get).toHaveBeenCalled())
  })

  it('closes on Escape and on the X, so it is never a trap', async () => {
    const onClose = vi.fn()
    render(<TelemetryModal device={device()} hasPermission={() => true} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /close telemetry/i }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('queries only this device, not the whole fleet', async () => {
    await showDrawer()

    const path = api.get.mock.calls[0][0]
    expect(path).toContain(`/api/v1/devices/${device().asset_id}/telemetry/latest`)
  })

  it('lists a declared metric that has never reported, as "no data" rather than omitting it', async () => {
    await showDrawer()

    // Declared and observed.
    await waitFor(() => expect(screen.getByText('Systems/TEMPERATURE')).toBeInTheDocument())
    expect(screen.getByText('42.5')).toBeInTheDocument()
    expect(screen.getByText('ACTIVE')).toBeInTheDocument()

    // Declared, never published -- the case that matters.
    expect(screen.getByText('OEE/AVAILABILITY')).toBeInTheDocument()
    expect(screen.getByText('— no data —')).toBeInTheDocument()
  })

  it('includes an observed metric the device never declared', async () => {
    api.get.mockResolvedValue([
      ...observed,
      { time: new Date(NOW).toISOString(), asset_id: 'dev1', metric_name: 'Undeclared/DRIFT', val_double: 7, val_string: null, val_bool: null }
    ])
    await showDrawer()

    await waitFor(() => expect(screen.getByText('Undeclared/DRIFT')).toBeInTheDocument())
  })

  it('renders a false boolean as a value, not as missing', async () => {
    // val_bool false is falsy; a truthiness test would report a real reading as "no data".
    api.get.mockResolvedValue([
      { time: new Date(NOW).toISOString(), asset_id: 'dev1', metric_name: 'Controller/ESTOP', val_double: null, val_string: null, val_bool: false }
    ])
    render(<TelemetryModal device={device({ last_birth_metrics: [] })} hasPermission={() => true} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('false')).toBeInTheDocument())
  })

  it('surfaces a failed query instead of an empty table', async () => {
    api.get.mockRejectedValue(new Error('relation "telemetry" does not exist'))
    await showDrawer()

    await waitFor(() => expect(screen.getByText(/Telemetry query failed/)).toBeInTheDocument())
    expect(screen.getByText(/relation "telemetry" does not exist/)).toBeInTheDocument()
  })

  it('gates on telemetry:read, and says so rather than showing an empty list', async () => {
    render(
      <TelemetryModal
        device={device()}
        hasPermission={(p) => p !== PERMISSION_UUIDS.TELEMETRY_READ}
      />
    )

    await waitFor(() =>
      expect(screen.getByText(/role does not include telemetry access/i)).toBeInTheDocument()
    )
    // An empty table would read as "this device has never reported anything".
    expect(screen.queryByText('Systems/TEMPERATURE')).not.toBeInTheDocument()
  })
})

describe('metric selection and export hand-off', () => {
  it('offers Export CSV only once something is ticked', async () => {
    await showDrawer()
    await waitFor(() => expect(screen.getByText('Systems/TEMPERATURE')).toBeInTheDocument())

    expect(screen.queryByRole('button', { name: /Export CSV/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Select Systems/TEMPERATURE'))
    expect(screen.getByRole('button', { name: /Export CSV \(1\)/i })).toBeInTheDocument()
  })

  it('selects and clears every metric from the header checkbox', async () => {
    await showDrawer()
    await waitFor(() => expect(screen.getByText('Systems/TEMPERATURE')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('Select all metrics'))
    expect(screen.getByRole('button', { name: /Export CSV \(3\)/i })).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Select all metrics'))
    expect(screen.queryByRole('button', { name: /Export CSV/i })).not.toBeInTheDocument()
  })

  it('hands the chosen metric names to the export dialog', async () => {
    const onExport = vi.fn()
    await showDrawer({ onExport })
    await waitFor(() => expect(screen.getByText('Systems/TEMPERATURE')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('Select Systems/TEMPERATURE'))
    fireEvent.click(screen.getByLabelText('Select OEE/AVAILABILITY'))
    fireEvent.click(screen.getByRole('button', { name: /Export CSV \(2\)/i }))

    expect(onExport).toHaveBeenCalledTimes(1)
    const [, names] = onExport.mock.calls[0]
    expect(names.sort()).toEqual(['OEE/AVAILABILITY', 'Systems/TEMPERATURE'])
  })
})

describe('telemetry CSV export dialog', () => {
  const openExport = (metricNames = ['Systems/TEMPERATURE']) => {
    const showToast = vi.fn()
    const onClose = vi.fn()
    render(
      <TelemetryExportModal device={device()} metricNames={metricNames}
                            onClose={onClose} showToast={showToast} />
    )
    return { showToast, onClose }
  }

  const runExport = () => fireEvent.click(screen.getByRole('button', { name: /^Export CSV$/i }))

  it('offers the five presets plus a custom range', () => {
    openExport()
    for (const label of ['1 minute', '1 hour', '1 day', '7 days', '30 days', 'Custom range']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('sends absolute bounds derived from the chosen preset', async () => {
    api.get.mockResolvedValue([])
    const { showToast } = openExport()

    fireEvent.click(screen.getByRole('button', { name: '1 hour' }))
    runExport()

    await waitFor(() => expect(api.get).toHaveBeenCalled())
    const url = new URL(api.get.mock.calls[0][0], 'http://x')
    expect(url.searchParams.get('metric_name')).toBe('Systems/TEMPERATURE')
    expect(url.searchParams.get('from')).toBeTruthy()
    expect(url.searchParams.get('to')).toBeTruthy()
    // Nothing to write, so it reports rather than downloading an empty file.
    await waitFor(() => expect(screen.getByText(/No telemetry in that range/)).toBeInTheDocument())
    expect(downloadCSV).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('refuses a custom range whose start is after its end', async () => {
    openExport()
    fireEvent.click(screen.getByRole('button', { name: 'Custom range' }))
    fireEvent.change(screen.getByLabelText('Range start'), { target: { value: '2026-08-02T12:00' } })
    fireEvent.change(screen.getByLabelText('Range end'),   { target: { value: '2026-08-01T12:00' } })
    runExport()

    await waitFor(() =>
      expect(screen.getByText(/start time must be before the end time/i)).toBeInTheDocument()
    )
    expect(api.get).not.toHaveBeenCalled()
  })

  it('pages until a short page arrives, then writes one CSV', async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      time: new Date(NOW - i * 1000).toISOString(), asset_id: 'dev1',
      metric_name: 'Systems/TEMPERATURE', val_double: i, val_string: null, val_bool: null
    }))
    api.get.mockResolvedValueOnce(full).mockResolvedValueOnce(full.slice(0, 10))

    const { showToast, onClose } = openExport()
    runExport()

    await waitFor(() => expect(downloadCSV).toHaveBeenCalledTimes(1))
    const [rows, filename] = downloadCSV.mock.calls[0]
    expect(rows).toHaveLength(510)
    expect(filename).toContain('Simulated_CNC_01-telemetry-')
    // Flattened: one `value` column, not three val_* columns with two empty on every row.
    expect(Object.keys(rows[0])).toEqual(['time', 'asset_id', 'metric_name', 'value', 'value_type'])
    expect(showToast).toHaveBeenCalledWith('Exported 510 rows', 'success')
    expect(onClose).toHaveBeenCalled()
  })

  it('runs one paged sequence per selected metric', async () => {
    api.get.mockResolvedValue([
      { time: new Date(NOW).toISOString(), asset_id: 'dev1', metric_name: 'x', val_double: 1, val_string: null, val_bool: null }
    ])
    openExport(['Systems/TEMPERATURE', 'Controller/EXECUTION'])
    runExport()

    await waitFor(() => expect(downloadCSV).toHaveBeenCalled())
    const requested = api.get.mock.calls.map(c => new URL(c[0], 'http://x').searchParams.get('metric_name'))
    expect(requested).toEqual(['Systems/TEMPERATURE', 'Controller/EXECUTION'])
  })

  it('stops at the ceiling, still downloads, and marks the file truncated', async () => {
    // Every page comes back full, so only the ceiling can end this.
    const full = Array.from({ length: 500 }, (_, i) => ({
      time: new Date(NOW - i * 1000).toISOString(), asset_id: 'dev1',
      metric_name: 'Systems/TEMPERATURE', val_double: i, val_string: null, val_bool: null
    }))
    api.get.mockResolvedValue(full)

    const { showToast } = openExport()
    runExport()

    await waitFor(() => expect(downloadCSV).toHaveBeenCalled(), { timeout: 10000 })
    const [rows] = downloadCSV.mock.calls[0]

    // The data rows, plus one prepended marker line.
    expect(rows.length).toBe(TELEMETRY_EXPORT_MAX_ROWS + 1)
    expect(rows[0].time).toContain('TRUNCATED')
    // Carried in the FILE, not only in a dialog that is gone once dismissed.
    expect(rows[0].asset_id).toContain('narrow the range')
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('truncated'), 'error')
  }, 20000)
})
