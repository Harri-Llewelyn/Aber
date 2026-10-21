import React from 'react'
import { render, renderHook, screen, fireEvent, act, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ToastStack, destinationTitle } from '../components/common/Toast'
import { NotificationHistory } from '../components/common/NotificationHistory'
import { useToast, readStoredHistory, isSafeDestination, HISTORY_STORAGE_KEY } from '../hooks/useToast'
import { GRAFANA_URL, grafanaAlertUrl } from '../constants'
import { tabUrl, unmappedMetricsUrl } from '../routes'

/**
 * A message links to what it is about. What is pinned: `showToast(..., { to })` takes a path from
 * routes.js or a Grafana URL and nothing else, on the way in and again on the way out of storage;
 * the toast and its history row become links, in-app ones through RouteLink and Grafana in a new
 * tab; following a toast's link dismisses it; a plain click on a row's link closes the list; and
 * the quarantine and export messages carry their destinations.
 */

let hook
function Harness() {
  hook = useToast()
  return <ToastStack toasts={hook.toasts} onDismiss={hook.dismissToast} onExpire={hook.expireToast} />
}
const toastFor = (text) => screen.getByText(text).closest('.toast')

beforeEach(() => {
  window.sessionStorage.clear()
  window.history.pushState({}, '', '/site-map')
})
afterEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
})

describe('isSafeDestination', () => {
  it.each([
    '/devices/quarantine',
    '/metrics?unmapped=1',
    '/devices?search=dev123',
    grafanaAlertUrl('Spindle Overtemperature'),
    `${GRAFANA_URL}/alerting/list`,
    GRAFANA_URL
  ])('takes %s', (to) => {
    expect(isSafeDestination(to)).toBe(true)
  })

  it.each([
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a protocol-relative URL', '//evil.example/devices'],
    ['a backslash the browser reads as a slash', '/\\evil.example'],
    ['a tab the browser strips', '/\t/evil.example'],
    ['a newline', '/devices\n'],
    ['another site', 'https://evil.example/alerting'],
    ['a host that only starts with Grafana\'s', `${GRAFANA_URL}.evil.example/x`],
    ['a relative path', 'devices'],
    ['an empty string', ''],
    ['a number', 42],
    ['an object', { to: '/devices' }],
    ['undefined', undefined]
  ])('refuses %s', (_, to) => {
    expect(isSafeDestination(to)).toBe(false)
  })
})

describe('showToast with a destination', () => {
  it('records it on the toast and the history entry, and stores it as text', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast('Exported', 'warning', { to: '/metrics?unmapped=1' }) })
    expect(result.current.toasts[0].to).toBe('/metrics?unmapped=1')
    expect(result.current.history[0].to).toBe('/metrics?unmapped=1')
    const stored = JSON.parse(window.sessionStorage.getItem(HISTORY_STORAGE_KEY))
    expect(stored[0].to).toBe('/metrics?unmapped=1')
  })

  it('ignores a destination that fails the check, and keeps the message', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast('Bad link', 'info', { to: 'javascript:alert(1)' }) })
    expect(result.current.history[0]).toMatchObject({ msg: 'Bad link' })
    expect(result.current.history[0]).not.toHaveProperty('to')
    expect(result.current.toasts[0]).not.toHaveProperty('to')
  })

  it('no longer takes a function to call', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast('Exported', 'warning', { onOpen: vi.fn(), openTitle: 'x' }) })
    expect(Object.keys(result.current.toasts[0]).sort()).toEqual(['at', 'group', 'id', 'msg', 'type'])
  })
})

describe('the stored destination, read back', () => {
  const store = (entries) => window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries))

  it('keeps an in-app path and a Grafana URL', () => {
    store([
      { id: 2, msg: 'Spindle Overtemperature', type: 'error', group: 'warning', to: grafanaAlertUrl('Spindle Overtemperature'), at: 2 },
      { id: 1, msg: 'New device', type: 'info', to: '/devices/quarantine', at: 1 }
    ])
    expect(readStoredHistory().map(e => e.to)).toEqual([grafanaAlertUrl('Spindle Overtemperature'), '/devices/quarantine'])
  })

  it('drops one that fails the check, and keeps the entry as plain text', () => {
    store([
      { id: 3, msg: 'one', type: 'info', to: 'javascript:alert(document.cookie)', at: 3 },
      { id: 2, msg: 'two', type: 'info', to: '//evil.example', at: 2 },
      { id: 1, msg: 'three', type: 'info', to: { href: '/devices' }, at: 1 }
    ])
    const entries = readStoredHistory()
    expect(entries.map(e => e.msg)).toEqual(['one', 'two', 'three'])
    for (const e of entries) expect(e).not.toHaveProperty('to')
  })

  it('renders a planted destination as text, not as a link', () => {
    render(<NotificationHistory entries={[{ id: 1, msg: 'planted', type: 'info', to: 'javascript:alert(1)', at: Date.now(), read: true, count: 1 }]} />)
    fireEvent.click(screen.getByRole('button', { name: /^notifications/i }))
    expect(within(screen.getByRole('dialog', { name: 'Notifications' })).queryByRole('link')).toBeNull()
  })
})

describe('a toast with a destination', () => {
  it('is a link in this app that navigates in place on a plain click, and is dismissed', () => {
    render(<Harness />)
    act(() => { hook.showToast('2 metrics carried no semantic id', 'warning', { to: unmappedMetricsUrl() }) })
    const link = within(toastFor('2 metrics carried no semantic id')).getByRole('link', { name: /2 metrics carried no semantic id/ })
    expect(link).toHaveAttribute('href', '/metrics?unmapped=1')
    expect(link).toHaveAccessibleDescription('Go to Metrics')
    expect(link).not.toHaveAttribute('target')

    fireEvent.click(link)
    expect(window.location.pathname + window.location.search).toBe('/metrics?unmapped=1')
    expect(document.querySelector('.toast')).toBeNull()
    expect(hook.history[0].read).toBe(true)
  })

  it('leaves a Ctrl-click to the browser, which opens a new tab', () => {
    render(<Harness />)
    act(() => { hook.showToast('New device', 'info', { to: tabUrl('devices', 'quarantine') }) })
    fireEvent.click(screen.getByRole('link', { name: /New device/ }), { ctrlKey: true })
    expect(window.location.pathname).toBe('/site-map')
  })

  it('opens Grafana in a new tab, marked as leaving the dashboard', () => {
    render(<Harness />)
    act(() => { hook.showToast('Belt Slip', 'warning', { group: 'alert', to: grafanaAlertUrl('Belt Slip'), record: false }) })
    const link = screen.getByRole('link', { name: /Belt Slip/ })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveAccessibleName(/opens Grafana in a new tab/)
    expect(link.querySelector('.message-link-external')).toBeTruthy()
  })

  it('names the page and the tab it goes to', () => {
    expect(destinationTitle('/devices/quarantine')).toBe('Go to Devices › Quarantine')
    expect(destinationTitle('/metrics?unmapped=1')).toBe('Go to Metrics')
    expect(destinationTitle('/cold-storage')).toBe('Go to Cold Storage')
    expect(destinationTitle(grafanaAlertUrl('x'))).toBe('Open in Grafana, in a new tab')
  })
})

describe('a history row with a destination', () => {
  const rows = [
    { id: 2, msg: 'Spindle Overtemperature', type: 'error', group: 'warning', to: grafanaAlertUrl('Spindle Overtemperature'), at: Date.now(), read: true, count: 1 },
    { id: 1, msg: 'New device', type: 'info', group: 'info', to: '/devices/quarantine', at: Date.now(), read: true, count: 1 }
  ]
  const openList = () => {
    render(<NotificationHistory entries={rows} />)
    fireEvent.click(screen.getByRole('button', { name: /^notifications/i }))
    return screen.getByRole('dialog', { name: 'Notifications' })
  }

  it('links its message, and a plain click navigates and closes the list', () => {
    const panel = openList()
    const link = within(panel).getByRole('link', { name: /New device/ })
    expect(link).toHaveAttribute('href', '/devices/quarantine')
    fireEvent.click(link)
    expect(window.location.pathname).toBe('/devices/quarantine')
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull()
  })

  it('stays open for a Ctrl-click, which the browser opens in a new tab', () => {
    const panel = openList()
    fireEvent.click(within(panel).getByRole('link', { name: /New device/ }), { ctrlKey: true })
    expect(window.location.pathname).toBe('/site-map')
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument()
  })

  it('opens a Grafana rule in a new tab and closes the list', () => {
    const panel = openList()
    const link = within(panel).getByRole('link', { name: /Spindle Overtemperature/ })
    expect(link).toHaveAttribute('href', grafanaAlertUrl('Spindle Overtemperature'))
    expect(link).toHaveAttribute('target', '_blank')
    fireEvent.click(link)
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull()
  })
})

describe('a device new to the Quarantine queue', () => {
  it('toasts with a link to the Quarantine tab', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      const { api } = await import('../api')
      const { supabase } = await import('../lib/supabaseClient')
      let queue = []
      vi.spyOn(api, 'get').mockImplementation(() => Promise.resolve(queue))
      vi.spyOn(supabase, 'channel').mockReturnValue({ on() { return this }, subscribe() { return this } })
      vi.spyOn(supabase, 'removeChannel').mockImplementation(() => {})
      const { useQuarantineAlerts } = await import('../hooks/useQuarantineAlerts')
      function QuarantineHarness() {
        hook = useToast()
        useQuarantineAlerts(hook.showToast)
        return null
      }
      render(<QuarantineHarness />)
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      queue = [{ id: 'q1', asset_id: 'q1', sparkplug_id: 'dev123' }]
      // The reconciliation (60 s with Realtime) or the poll (10 s without) finds it.
      await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
      expect(hook.history[0]).toMatchObject({
        msg: "New device 'dev123' discovered in the Quarantine queue",
        group: 'info',
        to: '/devices/quarantine'
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
