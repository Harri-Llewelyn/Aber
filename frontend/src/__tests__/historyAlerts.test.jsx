/**
 * History's Alerts tab: every occurrence that overlapped the window, newest first, each with its
 * subject linked to its drawer, when it ended, how long it fired and who acknowledged it; the
 * window, the assets and the search in the address; the empty states; and the Device tab's charts
 * shaded with the same read. uPlot draws on a canvas jsdom does not have, so a stand-in records
 * what each chart was built with. In London's zone on Monday 2 November 2026 at 12:00.
 */
import React from 'react'
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { ALERT_HISTORY_LIMIT, api } from '../api'
import { tooltipOf } from '../test/tooltips'

const MACHINE_TZ = process.env.TZ
process.env.TZ = 'Europe/London'
afterAll(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ
  else process.env.TZ = MACHINE_TZ
})

const { plots } = vi.hoisted(() => ({ plots: [] }))

vi.mock('uplot', () => {
  class FakePlot {
    constructor(opts, data, target) {
      this.opts = opts
      this.over = document.createElement('div')
      this.over.className = 'u-over'
      target.appendChild(this.over)
      plots.push(this)
    }
    setSize() {}
    destroy() { this.destroyed = true; this.over.remove() }
  }
  FakePlot.paths = { stepped: () => () => null }
  return { default: FakePlot }
})

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), readCarriedTelemetry: vi.fn(), readAlertOccurrences: vi.fn() } }
})

const LATHE = '2b3e0c4a-1111-4000-8000-000000000001'
const LATHE_ID = 'dev2b3e0c4a1111400080000'
const PRESS = '2b3e0c4a-2222-4000-8000-000000000002'
const PRESS_ID = 'dev2b3e0c4a2222400080000'
const GATEWAY = '7c000000-0000-4000-8000-000000000007'
const GATEWAY_ID = 'gwy7c0000000000400080000'

const devices = [
  { asset_id: LATHE, asset_name: 'Lathe 3', last_birth_metrics: ['Spindle/LOAD'] },
  { asset_id: PRESS, asset_name: 'Press 1', last_birth_metrics: [] },
]
const gateways = [{ gateway_id: GATEWAY, gateway_name: 'Line 4 edge' }]

const occurrence = (id, over = {}, { ended_at = null, replaced = false } = {}) => ({
  occurrence: {
    id, fingerprint: `fp-${id}`, entity_type: 'device', entity_id: LATHE, sparkplug_id: LATHE_ID,
    alert_name: 'Spindle Overload', severity: 'warning', status: ended_at && !replaced ? 'resolved' : 'firing',
    summary: 'Load over 110 %', starts_at: '2026-11-02T10:00:00Z', ends_at: replaced ? null : ended_at,
    acknowledged_at: null, acknowledged_by: null, acknowledged_by_email: null,
    acknowledgement_reason: null, acknowledgement_note: null, ...over,
  },
  ended_at,
  replaced,
})

/** The read as alert_occurrences() answers it: newest first. */
const ROWS = [
  occurrence('firing', { alert_name: 'Coolant Low', severity: 'critical', starts_at: '2026-11-02T11:00:00Z' }),
  occurrence('replaced', { starts_at: '2026-11-02T10:30:00Z' }, { ended_at: '2026-11-02T10:50:00Z', replaced: true }),
  occurrence('gateway', {
    entity_type: 'gateway', entity_id: GATEWAY, sparkplug_id: GATEWAY_ID, alert_name: 'Gateway Stale', severity: 'info',
    starts_at: '2026-11-02T09:40:00Z', acknowledged_at: '2026-11-02T09:45:00Z', acknowledged_by: 'u1',
    acknowledged_by_email: 'op@aber.local', acknowledgement_reason: 'planned_work', acknowledgement_note: 'belt change',
  }, { ended_at: '2026-11-02T10:15:00Z' }),
  occurrence('platform', {
    entity_type: 'platform', entity_id: null, sparkplug_id: null, alert_name: 'Backup Stale', starts_at: '2026-11-01T20:00:00Z',
  }, { ended_at: '2026-11-02T08:00:00Z' }),
]

const routeGet = (path) => {
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(gateways)
  return Promise.resolve([])
}

const visit = async (address, props = {}) => {
  window.history.pushState({}, '', address)
  render(<HistoryTab hasPermission={() => true} showToast={vi.fn()} userRole="Shopfloor_Manager" {...props} />)
  await waitFor(() => expect(screen.queryByText(/Loading devices/)).not.toBeInTheDocument())
}
const table = () => screen.findByRole('table', { name: /alerts that fired/i })
const bodyRows = async () => within(await table()).getAllByRole('row').slice(1)
const lastRead = () => api.readAlertOccurrences.mock.calls.at(-1)[0]

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-02T12:00:00Z'))
  plots.length = 0
  api.get.mockImplementation(routeGet)
  api.readAlertOccurrences.mockResolvedValue(ROWS)
  api.readCarriedTelemetry.mockImplementation(({ from, metricNames }) => Promise.resolve(metricNames.map(name => ({
    bucket_ts: from, metric_name: name, avg_double: 40, min_double: 39, max_double: 41, last_double: 40,
    last_string: null, last_bool: null, n_rows: 1, is_carried: false,
  }))))
})

afterEach(() => {
  vi.useRealTimers()
  window.history.pushState({}, '', '/')
})

describe('the Alerts tab', () => {
  it('is the last tab, with an address of its own, and opens on Last 24 hours', async () => {
    await visit('/history/alerts')
    const tabs = within(screen.getByRole('navigation', { name: 'History' })).getAllByRole('link')
    expect(tabs.map(t => t.textContent)).toEqual(['Overview', 'Device', 'Alerts'])
    expect(tabs[2]).toHaveAttribute('aria-current', 'page')
    expect(tabs[2]).toHaveAttribute('href', '/history/alerts')
    expect(tabs[1]).toHaveAttribute('href', '/history/device')
    expect(tabs[0]).toHaveAttribute('href', '/history/overview')
    await table()
    expect(lastRead()).toEqual({ from: '2026-11-01T12:00:00.000Z', to: '2026-11-02T12:00:00.000Z', sparkplugIds: null })
  })

  it('lists each occurrence newest first, with its subject, times, length and acknowledgement', async () => {
    await visit('/history/alerts')
    const rows = await bodyRows()
    expect(rows).toHaveLength(4)
    const [firing, replaced, gateway, platform] = rows.map(r => within(r).getAllByRole('cell').map(c => c.textContent))
    expect(firing).toEqual(['Coolant LowLoad over 110 %', 'Critical', 'Lathe 3', '2 Nov 2026, 11:00', 'Firing', '1 h so far', '—'])
    expect(replaced.slice(3, 6)).toEqual(['2 Nov 2026, 10:30', '2 Nov 2026, 10:50 (fired again)', '20 min'])
    expect(gateway.slice(1, 3)).toEqual(['Info', 'Line 4 edge'])
    expect(gateway[6]).toBe(' op@aber.localPlanned work · 2 Nov 2026, 09:45belt change')
    expect(platform.slice(2, 6)).toEqual(['Platform-wide', '1 Nov 2026, 20:00', '2 Nov 2026, 08:00', '12 h'])
    expect(screen.getByText('4 alerts in this window, 1 still firing')).toBeInTheDocument()
  })

  it('says why a replaced occurrence ended when the next began', async () => {
    await visit('/history/alerts')
    const [, replaced] = await bodyRows()
    expect(tooltipOf(within(replaced).getByText(/fired again/).parentElement)).toMatch(/No resolve arrived for this occurrence/)
  })

  it('marks an occurrence a suppression window covered, after its name, with no "until"', async () => {
    const WINDOW = '5a000000-0000-4000-8000-000000000005'
    api.readAlertOccurrences.mockResolvedValue([
      occurrence('quiet-firing', { alert_name: 'Coolant Low', starts_at: '2026-11-02T11:30:00Z', suppression_window_id: WINDOW }),
      occurrence('quiet-past', { suppression_window_id: WINDOW }, { ended_at: '2026-11-02T10:40:00Z' }),
      ...ROWS.slice(2),
    ])
    await visit('/history/alerts')
    const [firing, past, gateway] = await bodyRows()
    const alertCell = (row) => within(row).getAllByRole('cell')[0]
    expect(alertCell(firing).textContent).toBe('Coolant LowSuppressedLoad over 110 %')
    expect(alertCell(past).textContent).toBe('Spindle OverloadSuppressedLoad over 110 %')
    expect(alertCell(gateway).textContent).not.toMatch(/Suppressed/)
    const mark = within(past).getByText('Suppressed').parentElement
    expect(mark.querySelector('svg.alert-pill-suppression-mark')).not.toBeNull()
    expect(tooltipOf(mark)).toMatch(/^A suppression window covered this alert while it fired/)
  })

  it('opens a device or a gateway through the drawer helpers, at its own address', async () => {
    const onSelectDevice = vi.fn()
    const onSelectGateway = vi.fn()
    await visit('/history/alerts', { onSelectDevice, onSelectGateway })
    const [firing, , gateway] = await bodyRows()
    const lathe = within(firing).getByRole('link', { name: 'Lathe 3' })
    expect(lathe).toHaveAttribute('href', `/devices?search=${LATHE_ID}`)
    fireEvent.click(lathe)
    expect(onSelectDevice).toHaveBeenCalledWith(LATHE_ID)
    fireEvent.click(within(gateway).getByRole('link', { name: 'Line 4 edge' }))
    expect(onSelectGateway).toHaveBeenCalledWith(GATEWAY_ID)
  })

  it('names the acknowledger by the email every reader sees', async () => {
    await visit('/history/alerts')
    const [, , gateway] = await bodyRows()
    expect(within(gateway).getByText('op@aber.local')).toBeInTheDocument()
  })

  it('sorts by a column, and goes back to newest first', async () => {
    await visit('/history/alerts')
    await table()
    fireEvent.click(screen.getByRole('button', { name: /^Severity/ }))
    expect((await bodyRows()).map(r => within(r).getAllByRole('cell')[1].textContent)).toEqual(['Critical', 'Warning', 'Warning', 'Info'])
    expect(window.location.search).toBe('?sort=severity')
  })
})

describe('its filters and address', () => {
  it('reads the window the address names', async () => {
    await visit('/history/alerts?from=2026-11-02T08:00&to=2026-11-02T10:00')
    await table()
    expect(lastRead()).toMatchObject({ from: '2026-11-02T08:00:00.000Z', to: '2026-11-02T10:00:00.000Z' })
  })

  it('keeps the assets the address names in the read, and writes a choice back to it', async () => {
    await visit(`/history/alerts?asset=${GATEWAY_ID}`)
    await table()
    await waitFor(() => expect(lastRead().sparkplugIds).toEqual([GATEWAY_ID]))
    fireEvent.click(screen.getByRole('button', { name: /^Asset:/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Lathe 3/ }))
    await waitFor(() => expect(lastRead().sparkplugIds).toEqual([LATHE_ID, GATEWAY_ID]))
    expect(new URLSearchParams(window.location.search).get('asset')).toBe(`${LATHE_ID},${GATEWAY_ID}`)
  })

  it('narrows the rows to what the search names, and says when none match', async () => {
    await visit('/history/alerts?search=belt')
    expect((await bodyRows()).map(r => within(r).getAllByRole('cell')[0].textContent)).toEqual(['Gateway StaleLoad over 110 %'])
    fireEvent.change(screen.getByRole('searchbox', { name: /find an alert/i }), { target: { value: 'nothing like it' } })
    expect(await screen.findByText('No alert in this window matches "nothing like it".')).toBeInTheDocument()
  })

  it('clears the window and the assets together', async () => {
    await visit(`/history/alerts?range=7d&asset=${LATHE_ID}`)
    await table()
    fireEvent.click(await screen.findByRole('button', { name: /Clear filters \(2\)/ }))
    await waitFor(() => expect(window.location.search).toBe(''))
    expect(window.location.pathname).toBe('/history/alerts')
  })

  it('says when the limit held some back', async () => {
    api.readAlertOccurrences.mockResolvedValue(Array.from({ length: ALERT_HISTORY_LIMIT + 1 }, (_, i) =>
      occurrence(`o${i}`, { starts_at: new Date(Date.parse('2026-11-02T11:00:00Z') - i * 1000).toISOString() }, { ended_at: '2026-11-02T11:30:00Z' })))
    await visit('/history/alerts')
    expect(await bodyRows()).toHaveLength(ALERT_HISTORY_LIMIT)
    expect(screen.getByText(/The newest 1,000 alerts in this window\. More fired/)).toBeInTheDocument()
  })
})

describe('its empty states', () => {
  it('says no alert fired, to an Administrator, who reads every alert', async () => {
    api.readAlertOccurrences.mockResolvedValue([])
    await visit('/history/alerts', { userRole: 'Administrator' })
    expect(await screen.findByText('No alert fired in this window.')).toBeInTheDocument()
  })

  it('says none the viewer may see fired, to any other role', async () => {
    api.readAlertOccurrences.mockResolvedValue([])
    await visit('/history/alerts', { userRole: 'Operator' })
    expect(await screen.findByText(/^No alert you may see fired in this window\. Alerts about a machine identity are listed for Administrators only\.$/)).toBeInTheDocument()
  })

  it('says none fired on the assets chosen', async () => {
    api.readAlertOccurrences.mockResolvedValue([])
    await visit(`/history/alerts?asset=${PRESS_ID}`)
    expect(await screen.findByText('No alert fired on the assets chosen in this window.')).toBeInTheDocument()
  })

  it('says when the window starts before the oldest alert kept', async () => {
    api.readAlertOccurrences.mockResolvedValue([])
    await visit('/history/alerts?span=year&at=2026-01-05')
    expect(await screen.findByText('Alerts are kept for 90 days, so none older is listed.')).toBeInTheDocument()
  })

  it('says what the read refused', async () => {
    api.readAlertOccurrences.mockRejectedValue(new Error('the database is out'))
    await visit('/history/alerts')
    expect(await screen.findByText('The alerts could not be read: the database is out')).toBeInTheDocument()
  })
})

describe("the Device tab's shading", () => {
  it('reads the device\'s alerts over the charts\' window and shades every chart with them', async () => {
    await visit(`/history/device/${LATHE}`)
    await waitFor(() => expect(api.readAlertOccurrences).toHaveBeenCalled())
    expect(lastRead()).toEqual({ from: '2026-11-01T12:00:00.000Z', to: '2026-11-02T12:00:00.000Z', sparkplugIds: [LATHE_ID] })
    await waitFor(() => expect(plots.at(-1).opts.plugins).toHaveLength(1))
    const [plugin] = plots.at(-1).opts.plugins
    expect(Object.keys(plugin.hooks).sort()).toEqual(['destroy', 'draw', 'drawClear', 'init', 'setCursor'])
  })

  it('keys the shading in words, with a link to the alerts on the Alerts tab', async () => {
    await visit(`/history/device/${LATHE}?range=7d`)
    const link = await screen.findByRole('link', { name: '4 alerts in this window' })
    expect(link.closest('.history-alert-key')).toHaveTextContent('Shaded while an alert was firing: 4 alerts in this window')
    expect(link).toHaveAttribute('href', `/history/alerts?range=7d&asset=${LATHE_ID}`)
  })

  it('shades nothing, and keys nothing, where no alert fired or the read fails', async () => {
    api.readAlertOccurrences.mockRejectedValue(new Error('no'))
    await visit(`/history/device/${LATHE}`)
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    await act(async () => {})
    expect(plots.at(-1).opts.plugins).toEqual([])
    expect(screen.queryByText(/Shaded while an alert was firing/)).not.toBeInTheDocument()
  })
})
