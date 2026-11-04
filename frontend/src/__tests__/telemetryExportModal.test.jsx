/**
 * The readings CSV export, as History's Export CSV opens it: one device, the metrics the page
 * charts and the page's window as absolute bounds. The dialog has no range of its own. Raw is the
 * default, and a bucket average is never substituted silently.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TelemetryExportModal, exportWords } from '../components/modals/TelemetryExportModal'
import { api, TELEMETRY_EXPORT_MAX_ROWS } from '../api'
import { downloadCSV } from '../utils/downloadCSV'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../utils/downloadCSV', () => ({ downloadCSV: vi.fn() }))

const NOW = Date.parse('2026-08-02T12:00:00Z')
const HOUR = 60 * 60 * 1000

const device = (overrides = {}) => ({
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  asset_name: 'Simulated_CNC_01',
  last_birth_metrics: ['Systems/TEMPERATURE', 'Controller/EXECUTION', 'OEE/AVAILABILITY'],
  ...overrides
})

/** The dialog over the window [NOW - span, NOW), as History hands it over. */
const windowProps = (span = HOUR, words = 'Last 1 hour') => ({
  from: new Date(NOW - span).toISOString(), to: new Date(NOW).toISOString(), windowWords: words,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('telemetry CSV export dialog', () => {
  const DAY = 24 * 60 * 60 * 1000

  /**
   * A stack with a 90-day raw window, as `telemetry_horizons` reports it: Dates, because that is
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

  const openExport = (metricNames = ['Systems/TEMPERATURE'], span = HOUR) => {
    const showToast = vi.fn()
    const onClose = vi.fn()
    render(
      <TelemetryExportModal device={device()} metricNames={metricNames} {...windowProps(span)}
                            onClose={onClose} showToast={showToast} />
    )
    return { showToast, onClose }
  }

  const runExport = () => fireEvent.click(screen.getByRole('button', { name: /^Export CSV$/i }))

  beforeEach(() => { mockApi() })

  it('says what it exports in its first line: the device, the metrics and the window with its bounds', () => {
    openExport(['Systems/TEMPERATURE', 'OEE/AVAILABILITY'])
    const words = exportWords({
      deviceName: 'Simulated_CNC_01', metricNames: ['a', 'b'], windowWords: 'Last 1 hour', ...windowProps(),
    })
    expect(words).toMatch(/^Simulated_CNC_01 · 2 metrics · Last 1 hour \(\d{1,2} \w{3,4} \d\d:\d\d – \d{1,2} \w{3,4} \d\d:\d\d\)$/)
    expect(screen.getByText(words)).toBeInTheDocument()
    // The page's window is the range: the dialog offers none of its own.
    expect(screen.queryByRole('button', { name: 'Custom range' })).toBeNull()
    expect(screen.queryByLabelText('Range start')).toBeNull()
  })

  it('reads exactly the window it is handed, each metric in turn', async () => {
    const { showToast } = openExport()
    runExport()

    await waitFor(() => expect(telemetryCalls()).not.toHaveLength(0))
    const url = new URL(telemetryCalls()[0], 'http://x')
    expect(url.searchParams.get('metric_name')).toBe('Systems/TEMPERATURE')
    expect(url.searchParams.get('from')).toBe(new Date(NOW - HOUR).toISOString())
    expect(url.searchParams.get('to')).toBe(new Date(NOW).toISOString())
    // Nothing to write, so it reports rather than downloading an empty file. The last hour IS
    // within every horizon, so the plain sentence is the true one here.
    await waitFor(() => expect(screen.getByText(/No telemetry in that window/)).toBeInTheDocument())
    expect(downloadCSV).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('refuses a window that does not start before it ends, and reads nothing', async () => {
    render(
      <TelemetryExportModal device={device()} metricNames={['Systems/TEMPERATURE']}
        from={new Date(NOW).toISOString()} to={new Date(NOW - HOUR).toISOString()} windowWords="Custom range"
        onClose={vi.fn()} showToast={vi.fn()} />
    )
    runExport()
    await waitFor(() => expect(screen.getByText(/must start before it ends/i)).toBeInTheDocument())
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
    expect(rows[1].asset_id).toContain('narrow the window')
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

  /** The dialog over a window starting `days` ago, which is how an old-range export is asked for. */
  const open = async ({ metricNames = ['Systems/TEMPERATURE'], days = null } = {}) => {
    const showToast = vi.fn()
    const onClose = vi.fn()
    render(
      <TelemetryExportModal device={device()} metricNames={metricNames} {...windowProps(days === null ? HOUR : days * DAY)}
                            onClose={onClose} showToast={showToast} />
    )
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/v1/telemetry/horizons'))
    return { showToast, onClose }
  }

  const runExport = () => fireEvent.click(screen.getByRole('button', { name: /^Export CSV$/i }))

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
    await open({ days: 120 })

    await waitFor(() =>
      expect(screen.getByText(/starts before raw telemetry begins/i)).toBeInTheDocument()
    )
    // The FINEST that covers it, not the furthest-reaching -- offering hourly here would throw
    // away 59 buckets in 60 for no reason.
    expect(screen.getByRole('button', { name: /switch to 1 minute/i })).toBeInTheDocument()
  })

  it('does not warn when the range is inside the raw horizon', async () => {
    await open({ days: 30 })
    await waitFor(() =>
      expect(screen.queryByText(/starts before raw telemetry/i)).not.toBeInTheDocument()
    )
  })

  it('never warns when the horizons lookup did not answer, rather than refusing on its own ignorance', async () => {
    mockApi({ horizons: {} })
    await open({ days: 5000 })
    await waitFor(() => expect(within(picker()).getAllByText(/reach unknown/).length).toBe(4))
    expect(screen.queryByText(/starts before/i)).not.toBeInTheDocument()
  })

  it('the switch button selects that resolution and sends it on the wire', async () => {
    await open({ days: 120 })
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
    await open({ days: 120 })
    runExport()

    await waitFor(() =>
      expect(screen.getByText(/dropped by the retention policy/i)).toBeInTheDocument()
    )
    expect(screen.getByText(/1-minute buckets still cover it/i)).toBeInTheDocument()
    expect(screen.queryByText(/^No telemetry in that range/)).not.toBeInTheDocument()
  })

  it('says so plainly when no resolution reaches back that far', async () => {
    await open({ days: 5000 })
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
