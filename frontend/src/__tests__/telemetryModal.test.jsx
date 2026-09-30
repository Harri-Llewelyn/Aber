/**
 * The per-device telemetry inspector and its CSV export. The behaviour worth pinning is the metric
 * list: declared union observed. Observed-only would drop a metric the moment it stopped reporting,
 * which is the fault an operator is looking for.
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

// The modal reads once on open, with no expand step.
const showDrawer = async (props = {}) => {
  render(<TelemetryModal device={device()} hasPermission={() => true} onExport={vi.fn()} onClose={vi.fn()} {...props} />)
  await waitFor(() => expect(api.get).toHaveBeenCalled())
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockResolvedValue(observed)
})

describe('device telemetry modal', () => {
  it('names the device it is showing, and reads on open', async () => {
    render(<TelemetryModal device={device()} hasPermission={() => true} onClose={vi.fn()} />)

    expect(screen.getByText(/Telemetry — Simulated_CNC_01/)).toBeInTheDocument()
    await waitFor(() => expect(api.get).toHaveBeenCalled())
  })

  it('closes on Escape and on the X, so it is never a trap', async () => {
    const onClose = vi.fn()
    render(<TelemetryModal device={device()} hasPermission={() => true} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /^close$/i }))
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
  const DAY = 24 * 60 * 60 * 1000

  /**
   * A stack on the default policies, as `telemetry_horizons` reports them: Dates, because that is
   * what queryTelemetryHorizons parses the rows into before the dialog sees them.
   */
  const HORIZONS = {
    telemetry: new Date(NOW - 90 * DAY),
    telemetry_1m: new Date(NOW - 180 * DAY),
    telemetry_5m: new Date(NOW - 365 * DAY),
    telemetry_1h: new Date(NOW - 5 * 365 * DAY)
  }

  /**
   * The dialog reads `/api/v1/telemetry/horizons` on mount, so every mock here dispatches on the
   * path. A flat `mockResolvedValueOnce` chain would hand the horizons request the first page and
   * leave the export a page short -- silently, since the export would simply write less.
   */
  const mockApi = ({ horizons = HORIZONS, pages = [], fallback = [] } = {}) => {
    const queue = [...pages]
    api.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/v1/telemetry/horizons')) return horizons
      return queue.length ? queue.shift() : fallback
    })
  }

  /** The export requests alone, with the horizons lookup filtered out. */
  const telemetryCalls = () =>
    api.get.mock.calls.map(c => c[0]).filter(p => !p.startsWith('/api/v1/telemetry/horizons'))

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

  beforeEach(() => { mockApi() })

  it('offers the five presets plus a custom range', () => {
    openExport()
    for (const label of ['1 minute', '1 hour', '1 day', '7 days', '30 days', 'Custom range']) {
      expect(screen.getAllByRole('button', { name: label }).length).toBeGreaterThan(0)
    }
  })

  it('sends absolute bounds derived from the chosen preset', async () => {
    const { showToast } = openExport()

    fireEvent.click(screen.getAllByRole('button', { name: '1 hour' })[0])
    runExport()

    await waitFor(() => expect(telemetryCalls()).not.toHaveLength(0))
    const url = new URL(telemetryCalls()[0], 'http://x')
    expect(url.searchParams.get('metric_name')).toBe('Systems/TEMPERATURE')
    expect(url.searchParams.get('from')).toBeTruthy()
    expect(url.searchParams.get('to')).toBeTruthy()
    // Nothing to write, so it reports rather than downloading an empty file. The last hour IS
    // within every horizon, so the plain sentence is the true one here.
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
    expect(telemetryCalls()).toHaveLength(0)
  })

  it('pages until a short page arrives, then writes one CSV', async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      time: new Date(NOW - i * 1000).toISOString(), asset_id: 'dev1',
      metric_name: 'Systems/TEMPERATURE', val_double: i, val_string: null, val_bool: null
    }))
    mockApi({ pages: [full, full.slice(0, 10)] })

    const { showToast, onClose } = openExport()
    runExport()

    await waitFor(() => expect(downloadCSV).toHaveBeenCalledTimes(1))
    const [rows, filename] = downloadCSV.mock.calls[0]
    // 510 data rows plus the provenance line naming the resolution that produced the file.
    expect(rows).toHaveLength(511)
    expect(filename).toContain('Simulated_CNC_01-telemetry-')
    // Flattened: one `value` column, not three val_* columns with two empty on every row.
    expect(Object.keys(rows[1])).toEqual(['time', 'asset_id', 'metric_name', 'value', 'value_type'])
    expect(showToast).toHaveBeenCalledWith('Exported 510 rows', 'success')
    expect(onClose).toHaveBeenCalled()
  })

  it('runs one paged sequence per selected metric', async () => {
    mockApi({ fallback: [
      { time: new Date(NOW).toISOString(), asset_id: 'dev1', metric_name: 'x', val_double: 1, val_string: null, val_bool: null }
    ] })
    openExport(['Systems/TEMPERATURE', 'Controller/EXECUTION'])
    runExport()

    await waitFor(() => expect(downloadCSV).toHaveBeenCalled())
    const requested = telemetryCalls().map(p => new URL(p, 'http://x').searchParams.get('metric_name'))
    expect(requested).toEqual(['Systems/TEMPERATURE', 'Controller/EXECUTION'])
  })

  it('stops at the ceiling, still downloads, and marks the file truncated', async () => {
    // Every page comes back full, so only the ceiling can end this.
    const full = Array.from({ length: 500 }, (_, i) => ({
      time: new Date(NOW - i * 1000).toISOString(), asset_id: 'dev1',
      metric_name: 'Systems/TEMPERATURE', val_double: i, val_string: null, val_bool: null
    }))
    mockApi({ fallback: full })

    const { showToast } = openExport()
    runExport()

    await waitFor(() => expect(downloadCSV).toHaveBeenCalled(), { timeout: 10000 })
    const [rows] = downloadCSV.mock.calls[0]

    // The data rows, plus the provenance line and the truncation marker.
    expect(rows.length).toBe(TELEMETRY_EXPORT_MAX_ROWS + 2)
    expect(rows[0].time).toContain('RESOLUTION')
    expect(rows[1].time).toContain('TRUNCATED')
    // Carried in the FILE, not only in a dialog that is gone once dismissed.
    expect(rows[1].asset_id).toContain('narrow the range')
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('truncated'), 'error')
  }, 20000)
})

/**
 * Resolution, and the retention horizon it exists for (issue #160).
 *
 * The fault: an export over a range older than the raw retention window returned nothing and said
 * "No telemetry in that range for the selected metrics." That sentence describes a device that
 * published nothing, when the rows had been dropped by the retention policy and a rollup still
 * held the period. Both halves are pinned here -- the dialog says so, and can act on it.
 */
describe('telemetry export resolution', () => {
  const DAY = 24 * 60 * 60 * 1000
  const HORIZONS = {
    telemetry: new Date(NOW - 90 * DAY),
    telemetry_1m: new Date(NOW - 180 * DAY),
    telemetry_5m: new Date(NOW - 365 * DAY),
    telemetry_1h: new Date(NOW - 5 * 365 * DAY)
  }

  const mockApi = ({ horizons = HORIZONS, fallback = [] } = {}) => {
    api.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/v1/telemetry/horizons')) return horizons
      return fallback
    })
  }

  const telemetryCalls = () =>
    api.get.mock.calls.map(c => c[0]).filter(p => !p.startsWith('/api/v1/telemetry/horizons'))

  const open = async (metricNames = ['Systems/TEMPERATURE']) => {
    const showToast = vi.fn()
    const onClose = vi.fn()
    render(
      <TelemetryExportModal device={device()} metricNames={metricNames}
                            onClose={onClose} showToast={showToast} />
    )
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/v1/telemetry/horizons'))
    return { showToast, onClose }
  }

  const runExport = () => fireEvent.click(screen.getByRole('button', { name: /^Export CSV$/i }))

  /** A custom range starting `days` ago, which is how an old-range export is asked for. */
  const setCustomRangeStarting = (days) => {
    const iso = (t) => new Date(t).toISOString().slice(0, 16)
    fireEvent.click(screen.getByRole('button', { name: 'Custom range' }))
    fireEvent.change(screen.getByLabelText('Range start'), { target: { value: iso(NOW - days * DAY) } })
    fireEvent.change(screen.getByLabelText('Range end'), { target: { value: iso(NOW) } })
  }

  const picker = () => screen.getByRole('group', { name: /export resolution/i })

  beforeEach(() => { mockApi() })

  it('offers all four resolutions, each labelled with how far back it reaches', async () => {
    await open()
    for (const label of ['Raw samples', '1 minute', '5 minutes', '1 hour']) {
      expect(within(picker()).getByText(label)).toBeInTheDocument()
    }
    // The label is the horizon the DATABASE reported, not the retention setting: a young stack
    // holds less than its policy allows.
    await waitFor(() => expect(within(picker()).getAllByText(/back to /).length).toBe(4))
  })

  it('defaults to raw, because an export is an export of observations', async () => {
    await open()
    expect(within(picker()).getByRole('button', { name: /Raw samples/ }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('sends no resolution parameter for raw', async () => {
    await open()
    runExport()
    await waitFor(() => expect(telemetryCalls()).not.toHaveLength(0))
    expect(new URL(telemetryCalls()[0], 'http://x').searchParams.has('resolution')).toBe(false)
  })

  it('warns when the range starts before the chosen resolution reaches, and names the finest that covers it', async () => {
    await open()
    setCustomRangeStarting(120)   // raw stops at 90 days; the 1-minute rollup runs to 180

    await waitFor(() =>
      expect(screen.getByText(/starts before raw telemetry begins/i)).toBeInTheDocument()
    )
    // The FINEST that covers it, not the furthest-reaching -- offering hourly here would throw
    // away 59 buckets in 60 for no reason.
    expect(screen.getByRole('button', { name: /switch to 1 minute/i })).toBeInTheDocument()
  })

  it('does not warn when the range is inside the raw horizon', async () => {
    await open()
    setCustomRangeStarting(30)
    await waitFor(() =>
      expect(screen.queryByText(/starts before raw telemetry/i)).not.toBeInTheDocument()
    )
  })

  it('never warns when the horizons lookup did not answer, rather than refusing on its own ignorance', async () => {
    mockApi({ horizons: {} })
    await open()
    setCustomRangeStarting(5000)
    await waitFor(() => expect(within(picker()).getAllByText(/reach unknown/).length).toBe(4))
    expect(screen.queryByText(/starts before/i)).not.toBeInTheDocument()
  })

  it('the switch button selects that resolution and sends it on the wire', async () => {
    await open()
    setCustomRangeStarting(120)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /switch to 1 minute/i })).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole('button', { name: /switch to 1 minute/i }))
    runExport()

    await waitFor(() => expect(telemetryCalls()).not.toHaveLength(0))
    expect(new URL(telemetryCalls()[0], 'http://x').searchParams.get('resolution')).toBe('1m')
  })

  it('an empty result past the horizon blames the retention policy, not the device', async () => {
    // THE SENTENCE THIS ISSUE IS ABOUT. "No telemetry in that range" sends the reader to look for
    // a fault in a device that was reporting perfectly well.
    await open()
    setCustomRangeStarting(120)
    runExport()

    await waitFor(() =>
      expect(screen.getByText(/dropped by the retention policy/i)).toBeInTheDocument()
    )
    expect(screen.getByText(/1-minute buckets still cover it/i)).toBeInTheDocument()
    expect(screen.queryByText(/^No telemetry in that range/)).not.toBeInTheDocument()
  })

  it('says so plainly when no resolution reaches back that far', async () => {
    await open()
    setCustomRangeStarting(5000)
    runExport()
    await waitFor(() =>
      expect(screen.getByText(/before any resolution still holds data/i)).toBeInTheDocument()
    )
  })

  it('a rollup export carries bucket columns, its own filename and a provenance line', async () => {
    const buckets = Array.from({ length: 3 }, (_, i) => ({
      bucket: new Date(NOW - i * 3600_000).toISOString(), asset_id: 'dev1',
      metric_name: 'Systems/TEMPERATURE', avg_double: 42.5, min_double: 40, max_double: 45,
      last_double: 44, last_string: null, last_bool: null, n_double: 60, n_rows: 60
    }))
    mockApi({ fallback: buckets })
    const { showToast } = await open()

    fireEvent.click(within(picker()).getByRole('button', { name: /1 hour/ }))
    runExport()

    await waitFor(() => expect(downloadCSV).toHaveBeenCalled())
    const [rows, filename] = downloadCSV.mock.calls[0]

    // A rollup row is a different shape, and the CSV must not hide it: `bucket` not `time`, and
    // avg/min/max/last rather than a single value.
    expect(Object.keys(rows[1])).toEqual([
      'bucket', 'asset_id', 'metric_name', 'avg_double', 'min_double', 'max_double',
      'last_double', 'last_string', 'last_bool', 'n_double', 'n_rows'
    ])
    // IN THE FILE, not only in the dialog -- the dialog is gone the moment it is dismissed.
    expect(rows[0].bucket).toContain('1-hour buckets')
    expect(rows[0].bucket).toContain('public.telemetry_1h')
    expect(rows[0].asset_id).toContain('NOT individual readings')
    expect(filename).toContain('-telemetry-1h-')
    expect(showToast).toHaveBeenCalledWith('Exported 3 buckets', 'success')
  })

  it('a raw export says so in the file too, so an absent line never has to be interpreted', async () => {
    mockApi({ fallback: [
      { time: new Date(NOW).toISOString(), asset_id: 'dev1', metric_name: 'x', val_double: 1, val_string: null, val_bool: null }
    ] })
    await open()
    runExport()

    await waitFor(() => expect(downloadCSV).toHaveBeenCalled())
    const [rows] = downloadCSV.mock.calls[0]
    expect(rows[0].time).toContain('raw samples')
    expect(rows[0].time).toContain('public.telemetry')
  })
})
