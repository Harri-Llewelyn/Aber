/**
 * System › Logs: a service's newest lines, read through service-logs with parameters, never a
 * query. What is held here is the tab's half: what it asks for (a filter only once typing settles,
 * so a word is one read and one Audit Trail row), and that it shows a line strictly as text, with
 * the ceilings and the store's absence said in words.
 */
import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FILTER_SETTLE_MS, SystemLogs } from '../components/tabs/SystemLogs'
import { LOG_LINES_MAX, defaultLogService, formatLogTime } from '../utils/serviceLogs'
import { api } from '../api'

vi.mock('../api', () => ({ api: { readServiceLogs: vi.fn() } }))

const SERVICES = ['auth', 'ingestion', 'mosquitto']
const DROP = JSON.stringify({ reason: 'quarantined_or_unregistered', device: 'dev01', edge_node: 'gwy01', level: 'WARNING', msg: 'Dropped a DDATA' })
const HOSTILE = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>'

const line = (overrides) => ({ time: '2026-11-03T10:00:00.123Z', ns: '1793700000123000000', level: null, message: null, fields: {}, line: 'plain', cut: false, ...overrides })

const LINES = [
  line({ level: 'WARNING', message: 'Dropped a DDATA', fields: { reason: 'quarantined_or_unregistered', device: 'dev01', edge_node: 'gwy01' }, line: DROP }),
  line({ ns: '2', line: HOSTILE }),
  line({ ns: '3', level: 'ERROR', message: 'crashed\nTraceback (most recent call last):\n  File "x"', line: '{"level":"ERROR"}' }),
]

/** The function's answers: the list without a service, the lines with one. */
function answers({ lines = LINES, more = false, observability = true } = {}) {
  api.readServiceLogs.mockImplementation(async (params = {}) => {
    if (!observability) return { observability: false, details: 'off', services: [], lines: [] }
    if (!params.service) return { observability: true, services: SERVICES, lines: [] }
    return {
      observability: true, services: SERVICES, service: params.service, level: params.level || 'any',
      filter: params.filter || '', range: params.range || '1h', limit: params.limit, lines, more, clamped: [], audit: 'recorded',
    }
  })
}

const reads = () => api.readServiceLogs.mock.calls.map(([params]) => params).filter(p => p.service)

beforeEach(() => {
  vi.clearAllMocks()
  window.history.pushState({}, '', '/system/logs')
  answers()
})

afterEach(() => {
  delete window.pwned
  window.history.pushState({}, '', '/')
})

const table = () => document.querySelector('.table-logs')

describe('the first read', () => {
  it('lists the services, then reads ingestion\'s last hour, the most lines a read returns', async () => {
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(table()).toBeTruthy())
    expect(api.readServiceLogs.mock.calls[0][0]).toEqual({})
    expect(reads()).toEqual([{ service: 'ingestion', level: 'any', filter: '', range: '1h', limit: LOG_LINES_MAX }])
    expect(screen.getByRole('combobox', { name: 'Service' })).toHaveValue('ingestion')
    expect([...screen.getByRole('combobox', { name: 'Service' }).options].map(o => o.value)).toEqual(SERVICES)
  })

  it('opens on the service, level, filter and range the address names', async () => {
    window.history.pushState({}, '', '/system/logs?service=auth&level=error&search=dev01&range=24h')
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(reads()).toEqual([{ service: 'auth', level: 'error', filter: 'dev01', range: '24h', limit: LOG_LINES_MAX }]))
  })

  it('reads the default service when the address names one the store does not list', async () => {
    window.history.pushState({}, '', '/system/logs?service=gone')
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(table()).toBeTruthy())
    expect(reads().map(r => r.service)).toEqual(['ingestion'])
    expect(defaultLogService(['auth', 'mosquitto'])).toBe('auth')
    expect(defaultLogService([])).toBe('')
  })
})

describe('the toolbar', () => {
  it('puts the search box first, then the service, the level and the range', async () => {
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(table()).toBeTruthy())
    const bar = document.querySelector('.filter-bar')
    const controls = [...bar.querySelectorAll('input, select')].map(c => c.getAttribute('aria-label'))
    expect(controls).toEqual(['Find text in the log lines, matched exactly', 'Service', 'Level', 'Time range', 'Refresh automatically'])
    expect([...bar.querySelector('select[aria-label="Time range"]').options].map(o => o.value)).toEqual(['15m', '1h', '6h', '24h', '7d'])
  })

  it('reads a filter once typing settles: one read for a word, not one a letter', async () => {
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(reads()).toHaveLength(1))
    const box = screen.getByRole('searchbox', { name: /find text/i })
    for (const text of ['d', 'de', 'dev', 'dev0', 'dev01']) fireEvent.change(box, { target: { value: text } })
    await act(() => new Promise(r => setTimeout(r, FILTER_SETTLE_MS + 200)))
    await waitFor(() => expect(reads()).toHaveLength(2))
    expect(reads()[1]).toMatchObject({ service: 'ingestion', filter: 'dev01' })
    expect(window.location.search).toBe('?search=dev01')
  })

  it('reads again on a level, a range or a service picked, and says what a level cannot see', async () => {
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(reads()).toHaveLength(1))
    expect(screen.queryByText(/Only lines written as JSON name a level/)).toBeNull()

    fireEvent.change(screen.getByRole('combobox', { name: 'Level' }), { target: { value: 'error' } })
    await waitFor(() => expect(reads().at(-1)).toMatchObject({ level: 'error' }))
    expect(screen.getByText(/Only lines written as JSON name a level/)).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Time range' }), { target: { value: '7d' } })
    await waitFor(() => expect(reads().at(-1)).toMatchObject({ level: 'error', range: '7d' }))

    fireEvent.change(screen.getByRole('combobox', { name: 'Service' }), { target: { value: 'auth' } })
    await waitFor(() => expect(reads().at(-1)).toMatchObject({ service: 'auth', level: 'error', range: '7d' }))
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ service: 'auth', level: 'error', range: '7d' })
  })

  it('reads the same parameters again on Refresh', async () => {
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(reads()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(reads()).toHaveLength(2))
    expect(reads()[1]).toEqual(reads()[0])
  })

  it('reads on an interval once one is chosen, with the same parameters', async () => {
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(reads()).toHaveLength(1))
    fireEvent.change(screen.getByRole('combobox', { name: 'Refresh automatically' }), { target: { value: '10' } })
    await waitFor(() => expect(reads().length).toBeGreaterThanOrEqual(2))
    expect(new Set(reads().map(r => JSON.stringify(r))).size).toBe(1)
  })
})

describe('the lines', () => {
  it('shows time, level and message, a JSON line\'s fields, and "none" for a line with no level', async () => {
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(table()).toBeTruthy())
    const rows = within(table()).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText('WARNING')).toHaveClass('badge-warning')
    expect(within(rows[0]).getByText('Dropped a DDATA')).toBeInTheDocument()
    expect([...rows[0].querySelectorAll('.log-field')].map(f => f.textContent))
      .toEqual(['reason quarantined_or_unregistered', 'device dev01', 'edge_node gwy01'])
    expect(within(rows[1]).getByText('none')).toBeInTheDocument()
    expect(within(rows[2]).getByText('ERROR')).toHaveClass('badge-danger')
    expect(rows[2].querySelector('.log-message').textContent).toContain('Traceback (most recent call last):\n  File "x"')
    expect(rows[0].querySelector('.cell-log-time').textContent).toBe(formatLogTime('2026-11-03T10:00:00.123Z'))
  })

  it('renders a line strictly as text: markup in it is shown, never run', async () => {
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(table()).toBeTruthy())
    expect(screen.getByText(HOSTILE)).toBeInTheDocument()
    expect(table().querySelector('img, script')).toBeNull()
    expect(window.pwned).toBeUndefined()
  })

  it('copies a line as the service wrote it', async () => {
    const writeText = vi.fn().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(table()).toBeTruthy())
    const [first] = within(table()).getAllByRole('button', { name: /^Copy the line from / })
    fireEvent.click(first)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(DROP))
  })

  it('says how many it shows when the read stopped at its limit', async () => {
    answers({ more: true })
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Showing the newest 3 lines. Older lines in this range are not shown'))
  })

  it('tells nothing written from nothing matching', async () => {
    answers({ lines: [] })
    const { unmount } = render(<SystemLogs showToast={vi.fn()} />)
    expect(await screen.findByText('ingestion wrote nothing in the last 1 hour.')).toBeInTheDocument()
    unmount()
    window.history.pushState({}, '', '/system/logs?level=error')
    render(<SystemLogs showToast={vi.fn()} />)
    expect(await screen.findByText('No line from ingestion in the last 1 hour matches the filter.')).toBeInTheDocument()
  })
})

describe('when there is nothing to read', () => {
  it('says observability is off when the deployment has no log store', async () => {
    answers({ observability: false })
    render(<SystemLogs showToast={vi.fn()} />)
    expect(await screen.findByText('Observability is off on this deployment, so there are no logs to read here.')).toBeInTheDocument()
    expect(reads()).toEqual([])
  })

  it('says what the function refused, in its words', async () => {
    api.readServiceLogs.mockImplementation(async (params = {}) => {
      if (!params.service) return { observability: true, services: SERVICES, lines: [] }
      throw new Error('The log store did not answer within 10 seconds. Choose a shorter range or a filter.')
    })
    render(<SystemLogs showToast={vi.fn()} />)
    expect(await screen.findByText(/The logs could not be read: The log store did not answer within 10 seconds/)).toBeInTheDocument()
  })
})
