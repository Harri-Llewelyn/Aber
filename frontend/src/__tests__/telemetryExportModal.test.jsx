/**
 * The readings CSV export, as History's Export CSV opens it: the devices, the metrics and the window
 * its entry point hands over (the Device tab, Overview's box, the Cell tab). The dialog has no
 * range of its own. One call to export_telemetry() (0279) does the export: it checks, bounds, reads
 * and records it, and the dialog writes the file and toasts with a link to the Audit Trail row. Raw
 * is the default, and a bucket average is never substituted silently. A window over the setting's
 * limit is said before anything is asked, and the confirm is held.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TelemetryExportModal, exportWords } from '../components/modals/TelemetryExportModal'
import { api, TELEMETRY_EXPORT_MAX_ROWS } from '../api'
import { downloadCSV } from '../utils/downloadCSV'
import { auditEventUrl } from '../routes'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), exportTelemetry: vi.fn() } }
})

vi.mock('../utils/downloadCSV', () => ({ downloadCSV: vi.fn() }))

const NOW = Date.parse('2026-08-02T12:00:00Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const LATHE = { id: 'deva0d172790000400080000', name: 'Simulated_CNC_01' }
const PRESS = { id: 'dev07bb1d1982994a5ca83df', name: 'Press_02' }

/** The dialog over the window [NOW - span, NOW), as an entry point hands it over. */
const windowProps = (span = HOUR, words = 'Last 1 hour') => ({
  from: new Date(NOW - span).toISOString(), to: new Date(NOW).toISOString(), windowWords: words,
})

/** export_telemetry()'s document for `rows` (time, asset_id, metric_name, value, unit). */
const document_ = (rows = [], extra = {}) => ({
  audit_id: 4711, resolution: 'raw', columns: ['time', 'asset_id', 'metric_name', 'value', 'unit'], rows,
  row_count: rows.length, max_rows: TELEMETRY_EXPORT_MAX_ROWS, truncated: false,
  read_from: new Date(NOW - HOUR).toISOString(), read_to: new Date(NOW).toISOString(), raw_from: null, ...extra,
})
const reading = (i) => [new Date(NOW - i * 1000).toISOString(), LATHE.id, 'Systems/TEMPERATURE', 20 + i, '°C']

const HORIZONS = {
  telemetry: new Date(NOW - 90 * DAY),
  telemetry_1m: new Date(NOW - 180 * DAY),
  telemetry_5m: new Date(NOW - 365 * DAY),
  telemetry_1h: new Date(NOW - 5 * 365 * DAY),
}

/** The dialog reads `/api/v1/telemetry/horizons` and the settings on mount, so every mock dispatches on the path. */
const mockApi = ({ horizons = HORIZONS, maxDays = null } = {}) => {
  api.get.mockImplementation(async (path) => {
    if (path.startsWith('/api/v1/telemetry/horizons')) return horizons
    if (path.startsWith('/api/v1/settings')) return maxDays === null ? [] : [{ key: 'history.export_max_days', value: maxDays }]
    return []
  })
}

const open = async ({ devices = [LATHE], metricNames = ['Systems/TEMPERATURE'], span = HOUR } = {}) => {
  const showToast = vi.fn()
  const onClose = vi.fn()
  render(
    <TelemetryExportModal devices={devices} metricNames={metricNames} {...windowProps(span)} onClose={onClose} showToast={showToast} />
  )
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/v1/telemetry/horizons'))
  return { showToast, onClose }
}

const confirm = () => screen.getByRole('button', { name: /^Export CSV$/i })
const runExport = () => fireEvent.click(confirm())
const picker = () => screen.getByRole('group', { name: /export resolution/i })

beforeEach(() => {
  vi.clearAllMocks()
  mockApi()
  api.exportTelemetry.mockResolvedValue(document_([]))
})

describe('telemetry CSV export dialog', () => {
  it('says what it exports in its first line: the device, the metrics and the window with its bounds', async () => {
    const metricNames = ['Systems/TEMPERATURE', 'OEE/AVAILABILITY']
    await open({ metricNames })
    const words = exportWords({ devices: [LATHE], metricNames, ...windowProps() })
    expect(words).toMatch(/^Simulated_CNC_01 · 2 metrics · Last 1 hour \(\d{1,2} \w{3,4} \d\d:\d\d – \d{1,2} \w{3,4} \d\d:\d\d\)$/)
    expect(screen.getByText(words)).toBeInTheDocument()
    // The entry point's window is the range: the dialog offers none of its own.
    expect(screen.queryByRole('button', { name: 'Custom range' })).toBeNull()
    expect(screen.queryByLabelText('Range start')).toBeNull()
  })

  it("names a tab's own scope and its one metric where the tab gives one, and says what the file leaves out", () => {
    const props = { devices: [LATHE, PRESS], metricNames: ['Spindle/LOAD'], ...windowProps() }
    expect(exportWords({ ...props, scope: 'Boardroom · 2 machines in 1 cell' }))
      .toMatch(/^Boardroom · 2 machines in 1 cell · Spindle\/LOAD · Last 1 hour \(.+ – .+\)$/)
    // Several metrics are counted, as without a scope.
    expect(exportWords({ ...props, metricNames: ['a', 'b'], scope: 'Boardroom · 2 machines in 1 cell' })).toMatch(/^Boardroom · 2 machines in 1 cell · 2 metrics · /)
    render(<TelemetryExportModal {...props} scope="Boardroom · 2 machines in 1 cell" note="Not the cells' means." onClose={vi.fn()} showToast={vi.fn()} />)
    expect(screen.getByText(/^Boardroom · 2 machines in 1 cell · Spindle\/LOAD · /)).toBeInTheDocument()
    expect(screen.getByText("Not the cells' means.")).toBeInTheDocument()
  })

  it('has no note, and counts the devices, for an entry point that gives neither', async () => {
    await open({ devices: [LATHE, PRESS], metricNames: ['Spindle/LOAD'] })
    expect(screen.getByText(/^2 devices · 1 metric · /)).toBeInTheDocument()
    expect(document.querySelector('.telemetry-export-note')).toBeNull()
  })

  it('names several devices by how many, and lists them', async () => {
    await open({ devices: [LATHE, PRESS] })
    expect(exportWords({ devices: [LATHE, PRESS], metricNames: ['a'], ...windowProps() })).toMatch(/^2 devices · 1 metric · /)
    expect(screen.getByRole('dialog', { name: /Export readings — 2 devices/ })).toBeInTheDocument()
    expect(screen.getByText('Devices (2)')).toBeInTheDocument()
    expect(screen.getByText('Press_02')).toBeInTheDocument()
  })

  it('asks for exactly the devices, the metrics, the window and raw it is handed, in one call', async () => {
    await open({ devices: [LATHE, PRESS], metricNames: ['Systems/TEMPERATURE', 'Controller/EXECUTION'] })
    runExport()
    await waitFor(() => expect(api.exportTelemetry).toHaveBeenCalledTimes(1))
    expect(api.exportTelemetry).toHaveBeenCalledWith({
      from: new Date(NOW - HOUR).toISOString(), to: new Date(NOW).toISOString(),
      assetIds: [LATHE.id, PRESS.id], metricNames: ['Systems/TEMPERATURE', 'Controller/EXECUTION'], resolution: 'raw',
    })
  })

  it('writes one CSV of one row per reading: time, device, metric, value and unit', async () => {
    api.exportTelemetry.mockResolvedValue(document_([
      [new Date(NOW - 2000).toISOString(), LATHE.id, 'Systems/TEMPERATURE', 41.5, '°C'],
      [new Date(NOW - 1000).toISOString(), PRESS.id, 'Controller/EXECUTION', 'ACTIVE', null],
      [new Date(NOW).toISOString(), PRESS.id, 'Controller/RUNNING', false, null],
    ]))
    const { showToast, onClose } = await open({ devices: [LATHE, PRESS] })
    runExport()

    await waitFor(() => expect(downloadCSV).toHaveBeenCalledTimes(1))
    const [rows, filename] = downloadCSV.mock.calls[0]
    // The provenance line first, then the readings, with the devices named as the dashboard names them.
    expect(rows[0].time).toContain('RESOLUTION: raw samples')
    expect(rows.slice(1).map(r => Object.keys(r))).toEqual(Array(3).fill(['time', 'device', 'metric', 'value', 'unit']))
    expect(rows.slice(1).map(r => [r.device, r.metric, r.value, r.unit])).toEqual([
      ['Simulated_CNC_01', 'Systems/TEMPERATURE', 41.5, '°C'],
      ['Press_02', 'Controller/EXECUTION', 'ACTIVE', null],
      ['Press_02', 'Controller/RUNNING', false, null],
    ])
    expect(filename).toBe('readings-telemetry-2026-08-02.csv')
    expect(onClose).toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledTimes(1)
  })

  it("toasts with a link to the export's row in the Audit Trail", async () => {
    api.exportTelemetry.mockResolvedValue(document_([reading(0)], { audit_id: 9001 }))
    const { showToast } = await open()
    runExport()
    await waitFor(() => expect(showToast).toHaveBeenCalled())
    expect(showToast).toHaveBeenCalledWith('Exported 1 row of Simulated_CNC_01', 'success', { to: auditEventUrl(9001) })
    expect(auditEventUrl(9001)).toBe('/audit-trail?event=9001')
  })

  it('writes no file and no toast for an export with no rows, and says so', async () => {
    const { showToast, onClose } = await open()
    runExport()
    // The last hour IS within every horizon, so the plain sentence is the true one here.
    await waitFor(() => expect(screen.getByText(/No telemetry in that window/)).toBeInTheDocument())
    expect(downloadCSV).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('says a file that stopped at the cap is short, in the toast and in the file', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => reading(i))
    api.exportTelemetry.mockResolvedValue(document_(rows, { truncated: true, read_to: new Date(NOW - 5 * 60000).toISOString() }))
    const { showToast } = await open()
    runExport()

    await waitFor(() => expect(downloadCSV).toHaveBeenCalled())
    const [file] = downloadCSV.mock.calls[0]
    expect(file[0].time).toContain('RESOLUTION')
    expect(file[1].time).toBe(`# TRUNCATED at ${TELEMETRY_EXPORT_MAX_ROWS} rows`)
    // Carried in the FILE, not only in a dialog that is gone once dismissed.
    expect(file[1].device).toContain('narrow the window')
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('the file stops at'), 'warning', { to: auditEventUrl(4711) })
    expect(showToast.mock.calls[0][0]).toContain(`${TELEMETRY_EXPORT_MAX_ROWS.toLocaleString()} row limit`)
  })

  it('says when even one minute is more than the cap, rather than blaming the device', async () => {
    api.exportTelemetry.mockResolvedValue(document_([], { truncated: true }))
    await open()
    runExport()
    await waitFor(() => expect(screen.getByText(/Even one minute of these readings is more than 50,000 rows/)).toBeInTheDocument())
    expect(downloadCSV).not.toHaveBeenCalled()
  })

  it("shows the database's refusal as it came, and stays open", async () => {
    api.exportTelemetry.mockRejectedValue(new Error('MFA is required for this. Add an authenticator on Profile › MFA, then try again.'))
    const { onClose, showToast } = await open()
    runExport()
    await waitFor(() => expect(screen.getByText(/MFA is required for this/)).toBeInTheDocument())
    expect(onClose).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
    // Still pressable: nothing about the window changed.
    expect(confirm()).not.toBeDisabled()
  })
})

describe('the longest window one export may cover', () => {
  it('says before anything is asked when the window is over the limit, and holds the confirm', async () => {
    render(<TelemetryExportModal devices={[LATHE]} metricNames={['m']} {...windowProps(15 * DAY, 'Last 15 days')} onClose={vi.fn()} showToast={vi.fn()} />)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/v1/telemetry/horizons'))
    // From the start, with nothing edited: the person cannot change the window here.
    expect(screen.getByText('An export can cover at most 14 days, set on Settings › History. This window is 15 days.')).toBeInTheDocument()
    expect(confirm()).toBeDisabled()
    expect(confirm()).toHaveClass('btn-disabled')
    fireEvent.click(confirm())
    expect(api.exportTelemetry).not.toHaveBeenCalled()
  })

  it('allows a window of exactly the limit and says the limit in its footnote', async () => {
    render(<TelemetryExportModal devices={[LATHE]} metricNames={['m']} {...windowProps(14 * DAY, 'Last 14 days')} onClose={vi.fn()} showToast={vi.fn()} />)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/v1/telemetry/horizons'))
    expect(confirm()).not.toBeDisabled()
    expect(screen.getByText(/An export covers at most 14 days, set on Settings › History/)).toBeInTheDocument()
  })

  it('follows the setting an Administrator changed', async () => {
    mockApi({ maxDays: 3 })
    render(<TelemetryExportModal devices={[LATHE]} metricNames={['m']} {...windowProps(5 * DAY, 'Last 5 days')} onClose={vi.fn()} showToast={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('An export can cover at most 3 days, set on Settings › History. This window is 5 days.')).toBeInTheDocument())
    expect(confirm()).toBeDisabled()
  })

  it('refuses a window that does not start before it ends, and asks nothing', async () => {
    render(<TelemetryExportModal devices={[LATHE]} metricNames={['m']}
      from={new Date(NOW).toISOString()} to={new Date(NOW - HOUR).toISOString()} windowWords="Custom range" onClose={vi.fn()} showToast={vi.fn()} />)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/v1/telemetry/horizons'))
    expect(screen.getByText('Set both ends of the custom range to export it.')).toBeInTheDocument()
    expect(confirm()).toBeDisabled()
    expect(api.exportTelemetry).not.toHaveBeenCalled()
  })
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
  // A window of 30 days or 120 days: the setting is 14, so these raise the limit to the year.
  beforeEach(() => { mockApi({ maxDays: 366 }) })

  const openOver = async (days) => {
    const showToast = vi.fn()
    render(<TelemetryExportModal devices={[LATHE]} metricNames={['Systems/TEMPERATURE']} {...windowProps(days * DAY, `Last ${days} days`)} onClose={vi.fn()} showToast={showToast} />)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/v1/telemetry/horizons'))
    // The setting settles after the horizons: the confirm opens once it has.
    await waitFor(() => expect(confirm()).not.toBeDisabled())
    return { showToast }
  }

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
    expect(within(picker()).getByRole('button', { name: /Raw samples/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('asks for raw by default, and for the bucket chosen otherwise, never one in the other\'s place', async () => {
    await open()
    runExport()
    await waitFor(() => expect(api.exportTelemetry).toHaveBeenCalledTimes(1))
    expect(api.exportTelemetry.mock.calls[0][0].resolution).toBe('raw')
    for (const [label, key] of [[/5 minutes/, '5m'], [/1 hour/, '1h'], [/1 minute/, '1m'], [/Raw samples/, 'raw']]) {
      fireEvent.click(within(picker()).getByRole('button', { name: label }))
      runExport()
      await waitFor(() => expect(api.exportTelemetry.mock.calls.at(-1)[0].resolution).toBe(key))
    }
  })

  it('warns when the range starts before the chosen resolution reaches, and names the finest that covers it', async () => {
    await openOver(120)
    await waitFor(() => expect(screen.getByText(/starts before raw telemetry begins/i)).toBeInTheDocument())
    // The FINEST that covers it, not the furthest-reaching -- offering hourly here would throw
    // away 59 buckets in 60 for no reason.
    expect(screen.getByRole('button', { name: /switch to 1 minute/i })).toBeInTheDocument()
  })

  it('does not warn when the range is inside the raw horizon', async () => {
    await openOver(30)
    await waitFor(() => expect(screen.queryByText(/starts before raw telemetry/i)).not.toBeInTheDocument())
  })

  it('never warns when the horizons lookup did not answer, rather than refusing on its own ignorance', async () => {
    mockApi({ horizons: {}, maxDays: 366 })
    await openOver(300)
    await waitFor(() => expect(within(picker()).getAllByText(/reach unknown/).length).toBe(4))
    expect(screen.queryByText(/starts before/i)).not.toBeInTheDocument()
  })

  it('the switch button selects that resolution and asks for it', async () => {
    await openOver(120)
    await waitFor(() => expect(screen.getByRole('button', { name: /switch to 1 minute/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /switch to 1 minute/i }))
    runExport()
    await waitFor(() => expect(api.exportTelemetry).toHaveBeenCalled())
    expect(api.exportTelemetry.mock.calls[0][0].resolution).toBe('1m')
  })

  it('an empty result past the horizon blames the retention policy, not the device', async () => {
    // THE SENTENCE THIS ISSUE IS ABOUT. "No telemetry in that range" sends the reader to look for
    // a fault in a device that was reporting perfectly well.
    await openOver(120)
    runExport()
    await waitFor(() => expect(screen.getByText(/dropped by the retention policy/i)).toBeInTheDocument())
    expect(screen.getByText(/1-minute buckets still cover it/i)).toBeInTheDocument()
    expect(screen.queryByText(/^No telemetry in that range/)).not.toBeInTheDocument()
  })

  it('says so plainly when no resolution reaches back that far', async () => {
    // A stack whose every resolution holds only the last day.
    const short = new Date(NOW - DAY)
    mockApi({ horizons: { telemetry: short, telemetry_1m: short, telemetry_5m: short, telemetry_1h: short }, maxDays: 366 })
    await openOver(120)
    await waitFor(() => expect(screen.getByText(/No resolution still holds the whole of it/)).toBeInTheDocument())
    runExport()
    await waitFor(() => expect(screen.getByText(/before any resolution still holds data/i)).toBeInTheDocument())
  })

  it('a rollup export is named in its file, with its own filename, and its rows are its buckets', async () => {
    api.exportTelemetry.mockResolvedValue(document_([
      [new Date(NOW - 3 * HOUR).toISOString(), LATHE.id, 'Systems/TEMPERATURE', 42.5, '°C'],
      [new Date(NOW - 2 * HOUR).toISOString(), LATHE.id, 'Systems/TEMPERATURE', 43.5, '°C'],
      [new Date(NOW - HOUR).toISOString(), LATHE.id, 'Systems/TEMPERATURE', 44.5, '°C'],
    ], { resolution: '1h' }))
    const { showToast } = await open()

    fireEvent.click(within(picker()).getByRole('button', { name: /1 hour/ }))
    runExport()

    await waitFor(() => expect(downloadCSV).toHaveBeenCalled())
    const [rows, filename] = downloadCSV.mock.calls[0]
    // IN THE FILE, not only in the dialog -- the dialog is gone the moment it is dismissed.
    expect(rows[0].time).toContain('1-hour buckets')
    expect(rows[0].time).toContain('public.telemetry_1h')
    expect(rows[0].device).toContain('NOT individual readings')
    // The same five columns, with the bucket's start as its time and its average as its value.
    expect(Object.keys(rows[1])).toEqual(['time', 'device', 'metric', 'value', 'unit'])
    expect(filename).toBe('Simulated_CNC_01-telemetry-1h-2026-08-02.csv')
    expect(showToast).toHaveBeenCalledWith('Exported 3 buckets of Simulated_CNC_01', 'success', { to: auditEventUrl(4711) })
  })

  it('a raw export says so in the file too, so an absent line never has to be interpreted', async () => {
    api.exportTelemetry.mockResolvedValue(document_([reading(0)]))
    await open()
    runExport()
    await waitFor(() => expect(downloadCSV).toHaveBeenCalled())
    const [rows] = downloadCSV.mock.calls[0]
    expect(rows[0].time).toContain('raw samples')
    expect(rows[0].time).toContain('public.telemetry')
  })

  it('says in the file where raw begins when the window starts before it', async () => {
    api.exportTelemetry.mockResolvedValue(document_([reading(0)], { read_from: new Date(NOW - 30 * 60000).toISOString() }))
    await open()
    runExport()
    await waitFor(() => expect(downloadCSV).toHaveBeenCalled())
    const [rows] = downloadCSV.mock.calls[0]
    expect(rows[1].time).toBe(`# STARTS AT ${new Date(NOW - 30 * 60000).toISOString()}`)
  })
})
