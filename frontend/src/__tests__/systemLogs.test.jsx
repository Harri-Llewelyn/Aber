/**
 * System › Logs: a service's newest lines, read through service-logs with parameters, never a
 * query. What is held here is the tab's half: what it asks for (a filter only once typing settles,
 * so a word is one read and one Audit Trail row; a rolling window as its range and any other as its
 * bounds, so a refresh repeats a fixed window exactly), and that it shows a line strictly as text,
 * with the ceilings and the store's absence said in words. The window is the shared time control's,
 * with Day and Week only; its words are London's, so they are fixed.
 */
import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FILTER_SETTLE_MS, SystemLogs } from '../components/tabs/SystemLogs'
import { LOG_LINES_MAX, LOG_RANGES, defaultLogService, formatLogTime, logWindowParams } from '../utils/serviceLogs'
import { rollingWindow } from '../utils/timeWindow'
import { api } from '../api'

const MACHINE_TZ = process.env.TZ
process.env.TZ = 'Europe/London'
afterAll(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ
  else process.env.TZ = MACHINE_TZ
})

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
const bar = () => document.querySelector('.filter-bar')
const control = () => within(bar()).getByRole('group', { name: 'Time window' })
const words = () => control().querySelector('.time-window-pick')
const arrow = (name) => within(control()).getByRole('button', { name })
const span = (name) => within(control()).queryByRole('radio', { name })
const choices = () => screen.getByRole('dialog', { name: 'Choose a time window' })
const query = () => Object.fromEntries(new URLSearchParams(window.location.search))

describe('the first read', () => {
  it('lists the services, then reads ingestion\'s last hour, the most lines a read returns', async () => {
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(table()).toBeTruthy())
    expect(api.readServiceLogs.mock.calls[0][0]).toEqual({ range: '1h' })
    expect(reads()).toEqual([{ service: 'ingestion', level: 'any', filter: '', range: '1h', limit: LOG_LINES_MAX }])
    expect(screen.getByRole('combobox', { name: 'Service' })).toHaveValue('ingestion')
    expect([...screen.getByRole('combobox', { name: 'Service' }).options].map(o => o.value)).toEqual(SERVICES)
  })

  it('opens on the service, level, filter and range the address names', async () => {
    window.history.pushState({}, '', '/system/logs?service=auth&level=error&search=dev01&range=24h')
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(reads()).toEqual([{ service: 'auth', level: 'error', filter: 'dev01', range: '24h', limit: LOG_LINES_MAX }]))
    expect(words()).toHaveTextContent('Last 24 hours')
  })

  it('keeps a service the address names and the store does not list, says so, and reads nothing for it', async () => {
    window.history.pushState({}, '', '/system/logs?service=gone')
    render(<SystemLogs showToast={vi.fn()} />)
    expect(await screen.findByText('No lines from gone in the last 7 days.')).toBeInTheDocument()
    expect(reads()).toEqual([])
    const select = screen.getByRole('combobox', { name: 'Service' })
    expect(select).toHaveValue('gone')
    expect(select.selectedOptions[0]).toHaveTextContent('gone (no lines in the last 7 days)')
    expect(window.location.search).toBe('?service=gone')

    fireEvent.change(select, { target: { value: 'auth' } })
    await waitFor(() => expect(reads().map(r => r.service)).toEqual(['auth']))
    expect(defaultLogService(['auth', 'mosquitto'])).toBe('auth')
    expect(defaultLogService([])).toBe('')
  })
})

describe('the toolbar', () => {
  it('puts the search box first, then the time control, the service and the level', async () => {
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(table()).toBeTruthy())
    const controls = [...bar().querySelectorAll('input, select, [role="group"][aria-label="Time window"]')]
      .map(c => c.getAttribute('aria-label'))
    expect(controls).toEqual(['Find text in the log lines, matched exactly', 'Time window', 'Service', 'Level', 'Refresh automatically'])
    expect(bar().querySelector('select[aria-label="Time range"]')).toBeNull()
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

    fireEvent.click(words())
    fireEvent.click(within(choices()).getByRole('button', { name: 'Last 7 days' }))
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

describe('the time window', () => {
  // Monday 2 November 2026, 15:20 in London, where it is GMT: a local midnight is a UTC one.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 2, 15, 20))
  })
  afterEach(() => { vi.useRealTimers() })

  it('is the shared control with Day and Week only, the five rolling ranges and no All time, on Last 1 hour', async () => {
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(reads()).toHaveLength(1))
    expect(words()).toHaveTextContent('Last 1 hour')
    expect(within(control()).getAllByRole('radio').map(r => r.textContent)).toEqual(['Day', 'Week'])
    expect(span('Month')).toBeNull()
    expect(span('Year')).toBeNull()

    fireEvent.click(words())
    const rolling = within(choices()).getByRole('group', { name: 'Rolling' })
    expect(within(rolling).getAllByRole('button').map(b => b.textContent))
      .toEqual(['Last 15 minutes', 'Last 1 hour', 'Last 6 hours', 'Last 24 hours', 'Last 7 days'])
    expect(within(rolling).getByRole('button', { name: 'Last 1 hour' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(choices()).queryByRole('button', { name: 'All time' })).toBeNull()
  })

  it('reads a day, and each step, as its bounds rather than a range, and writes it in the address', async () => {
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(reads()).toHaveLength(1))

    fireEvent.click(span('Day'))
    expect(query()).toEqual({ span: 'day', at: '2026-11-02' })
    await waitFor(() => expect(reads()).toHaveLength(2))
    expect(reads()[1]).toEqual({
      service: 'ingestion', level: 'any', filter: '', from: '2026-11-02T00:00:00.000Z', to: '2026-11-03T00:00:00.000Z', limit: LOG_LINES_MAX,
    })

    fireEvent.click(arrow('Previous day'))
    expect(query()).toEqual({ span: 'day', at: '2026-11-01' })
    await waitFor(() => expect(reads()).toHaveLength(3))
    expect(reads()[2]).toMatchObject({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' })
    expect(reads()[2].range).toBeUndefined()
  })

  it('turns Last 1 hour, stepped back, into the fixed hour before it', async () => {
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(reads()).toHaveLength(1))
    expect(reads()[0]).toMatchObject({ range: '1h' })

    fireEvent.click(arrow('Earlier'))
    expect(query()).toEqual({ from: '2026-11-02T13:20', to: '2026-11-02T14:20' })
    await waitFor(() => expect(reads()).toHaveLength(2))
    expect(reads()[1]).toMatchObject({ from: '2026-11-02T13:20:00.000Z', to: '2026-11-02T14:20:00.000Z' })
  })

  it('opens on the window a link names, so the link shows the same lines', async () => {
    for (const [search, bounds] of [
      ['?span=day&at=2026-10-30', ['2026-10-30T00:00:00.000Z', '2026-10-31T00:00:00.000Z']],
      // The week of the clock change: Monday's midnight is BST's, the next Monday's GMT's.
      ['?span=week&at=2026-10-21', ['2026-10-18T23:00:00.000Z', '2026-10-26T00:00:00.000Z']],
      ['?from=2026-11-02T10:05&to=2026-11-02T14:20', ['2026-11-02T10:05:00.000Z', '2026-11-02T14:20:00.000Z']],
    ]) {
      vi.clearAllMocks()
      answers()
      window.history.pushState({}, '', `/system/logs${search}`)
      const { unmount } = render(<SystemLogs showToast={vi.fn()} />)
      await waitFor(() => expect(reads()).toHaveLength(1))
      expect([reads()[0].from, reads()[0].to], search).toEqual(bounds)
      expect(window.location.search).toBe(search)
      unmount()
    }
  })

  it('reads a span it does not offer, or All time, as Last 1 hour, and tidies the address', async () => {
    for (const search of ['?span=month&at=2026-11-02', '?span=year', '?range=all', '?range=30d']) {
      vi.clearAllMocks()
      answers()
      window.history.pushState({}, '', `/system/logs${search}`)
      const { unmount } = render(<SystemLogs showToast={vi.fn()} />)
      await waitFor(() => expect(reads()).toHaveLength(1))
      expect(reads()[0], search).toMatchObject({ range: '1h' })
      expect(window.location.search, search).toBe('')
      unmount()
    }
  })

  it('repeats a fixed window exactly on Refresh, however the clock has moved, and sends a rolling one as its range again', async () => {
    window.history.pushState({}, '', '/system/logs?span=day&at=2026-11-02')
    const { unmount } = render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(reads()).toHaveLength(1))
    vi.setSystemTime(new Date(2026, 10, 2, 15, 47))
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(reads()).toHaveLength(2))
    expect(reads()[1]).toEqual(reads()[0])
    unmount()

    vi.clearAllMocks()
    answers()
    window.history.pushState({}, '', '/system/logs')
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(reads()).toHaveLength(1))
    vi.setSystemTime(new Date(2026, 10, 2, 16, 5))
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(reads()).toHaveLength(2))
    // The function measures the range back from its own now, so the hour moves with the clock.
    expect(reads().map(r => [r.range, r.from, r.to])).toEqual([['1h', undefined, undefined], ['1h', undefined, undefined]])
  })

  it('counts a window other than Last 1 hour as a filter, and Clear puts Last 1 hour back', async () => {
    window.history.pushState({}, '', '/system/logs?span=week&at=2026-11-02')
    render(<SystemLogs showToast={vi.fn()} />)
    await waitFor(() => expect(reads()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /Clear filters \(1\)/ }))
    expect(window.location.search).toBe('')
    expect(words()).toHaveTextContent('Last 1 hour')
    await waitFor(() => expect(reads()).toHaveLength(2))
    expect(reads()[1]).toMatchObject({ range: '1h' })
  })

  it('says a fixed window held nothing in words of its own', async () => {
    answers({ lines: [] })
    window.history.pushState({}, '', '/system/logs?span=day&at=2026-11-01')
    render(<SystemLogs showToast={vi.fn()} />)
    expect(await screen.findByText('ingestion wrote nothing in this time window.')).toBeInTheDocument()
  })

  describe('the Service list', () => {
    // 10 October, three weeks before now: the backup worker wrote that day and ingestion did not.
    const OLD_DAY = logWindowParams({ kind: 'calendar', span: 'day', at: '2026-10-10' })
    const OLD_SERVICES = ['auth', 'backup-worker']

    /** The function's answers when the list depends on the window, as service-logs's does. */
    function answersOverTime() {
      api.readServiceLogs.mockImplementation(async (params = {}) => {
        const services = params.from === OLD_DAY.from ? OLD_SERVICES : SERVICES
        if (!params.service) return { observability: true, services, lines: [] }
        if (!services.includes(params.service)) throw new Error(`No service called "${params.service}" wrote a line.`)
        return { observability: true, services, service: params.service, level: 'any', filter: '', limit: params.limit, lines: LINES, more: false, clamped: [], audit: 'recorded' }
      })
    }
    const lists = () => api.readServiceLogs.mock.calls.map(([params]) => params).filter(p => !p.service)
    const options = () => [...screen.getByRole('combobox', { name: 'Service' }).options].map(o => o.textContent)

    it('follows a fixed window, read again when the window moves, and keeps a service it lacks', async () => {
      answersOverTime()
      window.history.pushState({}, '', '/system/logs?span=day&at=2026-10-11')
      render(<SystemLogs showToast={vi.fn()} />)
      await waitFor(() => expect(reads()).toHaveLength(1))
      expect(reads()[0]).toMatchObject({ service: 'ingestion' })

      fireEvent.click(arrow('Previous day'))
      expect(await screen.findByText('No lines from ingestion in this time window.')).toBeInTheDocument()
      // The list for the new day was read, alone, between its ends; no lines were asked of ingestion.
      expect(lists().at(-1)).toEqual(OLD_DAY)
      expect(reads()).toHaveLength(1)
      expect(screen.getByRole('combobox', { name: 'Service' })).toHaveValue('ingestion')
      expect(options()).toEqual(['ingestion (no lines in this time window)', ...OLD_SERVICES])
      expect(table()).toBeNull()

      fireEvent.change(screen.getByRole('combobox', { name: 'Service' }), { target: { value: 'backup-worker' } })
      await waitFor(() => expect(reads()).toHaveLength(2))
      expect(reads()[1]).toMatchObject({ service: 'backup-worker', ...OLD_DAY })
      await waitFor(() => expect(table()).toBeTruthy())
      expect(options()).toEqual(OLD_SERVICES)
    })

    it('lists the last 7 days for every rolling range, so a short one does not shrink it', async () => {
      answersOverTime()
      window.history.pushState({}, '', '/system/logs?span=day&at=2026-10-10&service=backup-worker')
      render(<SystemLogs showToast={vi.fn()} />)
      await waitFor(() => expect(reads()).toHaveLength(1))

      fireEvent.click(words())
      fireEvent.click(within(choices()).getByRole('button', { name: 'Last 15 minutes' }))
      expect(await screen.findByText('No lines from backup-worker in the last 7 days.')).toBeInTheDocument()
      expect(lists().at(-1)).toEqual({ range: '15m' })
      expect(options()).toEqual(['backup-worker (no lines in the last 7 days)', ...SERVICES])
      expect(reads()).toHaveLength(1)

      // Another rolling range lists the same 7 days, so it reads lines without asking for the list.
      fireEvent.change(screen.getByRole('combobox', { name: 'Service' }), { target: { value: 'auth' } })
      await waitFor(() => expect(reads()).toHaveLength(2))
      const listed = lists().length
      fireEvent.click(words())
      fireEvent.click(within(choices()).getByRole('button', { name: 'Last 24 hours' }))
      await waitFor(() => expect(reads()).toHaveLength(3))
      expect(reads()[2]).toMatchObject({ service: 'auth', range: '24h' })
      expect(lists()).toHaveLength(listed)
    })
  })

  it('sends a custom window missing an end as the end it has, which the function refuses with the reason', () => {
    expect(logWindowParams(rollingWindow('6h', LOG_RANGES))).toEqual({ range: '6h' })
    expect(logWindowParams({ kind: 'custom', from: '2026-11-02T10:05', to: '' }))
      .toEqual({ from: '2026-11-02T10:05:00.000Z', to: '' })
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
    await waitFor(() => expect(document.querySelector('.log-note[role="status"]'))
      .toHaveTextContent('Showing the newest 3 lines. Older lines in this window are not shown'))
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
