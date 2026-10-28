import React from 'react'
import { render, renderHook, screen, act, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ToastStack, GROUP_ICONS, toastTone, spokenPrefix, TOAST_MIN_MS } from '../components/common/Toast'
import { NotificationHistory } from '../components/common/NotificationHistory'
import { IconCheck, IconInfo, IconAlertTriangle, IconShieldAlert } from '../components/common/Icons'
import { useToast, groupOf, readStoredHistory, TOAST_GROUPS, HISTORY_STORAGE_KEY } from '../hooks/useToast'

/**
 * Messages sort into three groups, Info, Warning and Alert, and the group is not the severity.
 * What is pinned: each type's default group, and an explicit group winning over it; the group
 * stored with the history entry, and an entry stored before groups reading with its type's; the
 * group picking the icon and severity picking its colour; severity still deciding the timer and
 * the live region; a toast shown with `record: false` leaving the history alone; and a Grafana
 * alert, firing or resolved, toasting in Alert without touching the bell's history or badge, with
 * any Alert entry stored before that dropped.
 */

const markup = (Icon) => render(<Icon size={16} />).container.querySelector('svg').innerHTML

let hook
function Harness() {
  hook = useToast()
  return <ToastStack toasts={hook.toasts} onDismiss={hook.dismissToast} onExpire={hook.expireToast} />
}

beforeEach(() => {
  window.sessionStorage.clear()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.sessionStorage.clear()
})

describe('groupOf', () => {
  it('names the three groups', () => {
    expect(TOAST_GROUPS).toEqual(['info', 'warning', 'alert'])
  })

  it.each([
    ['success', 'info'],
    ['info', 'info'],
    ['warning', 'warning'],
    ['error', 'warning']
  ])('puts a %s message in %s by default', (type, group) => {
    expect(groupOf({ type })).toBe(group)
  })

  it('takes the group a caller gives, and the type\'s for one it does not know', () => {
    expect(groupOf({ type: 'error', group: 'alert' })).toBe('alert')
    expect(groupOf({ type: 'success', group: 'alert' })).toBe('alert')
    expect(groupOf({ type: 'error', group: 'shout' })).toBe('warning')
    expect(groupOf({})).toBe('info')
  })
})

describe('showToast and the group', () => {
  it('records the default group, or the one passed, on the toast and the history entry', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast('Saved', 'success') })
    act(() => { result.current.showToast('Save failed', 'error') })
    act(() => { result.current.showToast('Spindle Overtemperature', 'error', { group: 'alert' }) })

    expect(result.current.history.map(e => [e.msg, e.type, e.group])).toEqual([
      ['Spindle Overtemperature', 'error', 'alert'],
      ['Save failed', 'error', 'warning'],
      ['Saved', 'success', 'info']
    ])
    expect(result.current.toasts.map(t => t.group)).toEqual(['info', 'warning', 'alert'])
  })

  it('shows a toast it does not record when told not to', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast('Saved', 'success') })
    act(() => { result.current.showToast('Spindle Overtemperature', 'error', { group: 'alert', record: false }) })
    expect(result.current.toasts.map(t => t.msg)).toEqual(['Saved', 'Spindle Overtemperature'])
    expect(result.current.history.map(e => e.msg)).toEqual(['Saved'])

    // Dismissing it has no entry to mark read, and leaves the others as they were.
    const id = result.current.toasts[1].id
    act(() => { result.current.dismissToast(id) })
    expect(result.current.toasts.map(t => t.msg)).toEqual(['Saved'])
    expect(result.current.history).toEqual([expect.objectContaining({ msg: 'Saved', read: false })])
  })

  it('counts a repeat only within the same group', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast('Line 1 down', 'error') })
    act(() => { result.current.showToast('Line 1 down', 'error', { group: 'alert' }) })
    expect(result.current.history).toHaveLength(2)
  })
})

describe('the stored history and the group', () => {
  const store = (entries) => window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries))

  it('reads an entry stored before groups with its type\'s group', () => {
    store([
      { id: 3, msg: 'Save failed', type: 'error', at: 3, read: false, count: 1 },
      { id: 2, msg: 'Cap reached', type: 'warning', at: 2, read: true, count: 1 },
      { id: 1, msg: 'Resolved — Backup Stale', type: 'success', at: 1, read: true, count: 1 }
    ])
    expect(readStoredHistory().map(e => e.group)).toEqual(['warning', 'warning', 'info'])
  })

  it('keeps a stored group it knows and replaces one it does not', () => {
    store([
      { id: 2, msg: 'Quota reached', type: 'warning', group: 'info', at: 2 },
      { id: 1, msg: 'Saved', type: 'success', group: '<img>', at: 1 }
    ])
    expect(readStoredHistory().map(e => e.group)).toEqual(['info', 'info'])
  })

  it('drops a Grafana alert stored before alerts stopped being recorded', () => {
    store([
      { id: 4, msg: 'Resolved — Spindle Overtemperature', type: 'success', group: 'alert', at: 4 },
      { id: 3, msg: 'Saved', type: 'success', group: 'info', at: 3 },
      { id: 2, msg: 'Spindle Overtemperature — CNC_01 at 92 C', type: 'error', group: 'alert', at: 2 },
      { id: 1, msg: 'Save failed', type: 'error', at: 1 }
    ])
    expect(readStoredHistory().map(e => e.msg)).toEqual(['Saved', 'Save failed'])
    const { result } = renderHook(() => useToast())
    expect(result.current.history.map(e => e.msg)).toEqual(['Saved', 'Save failed'])
  })

  it('lists an entry stored before groups with its type\'s icon and colour', () => {
    store([{ id: 1, msg: 'Save failed', type: 'error', at: Date.now(), read: true, count: 1 }])
    const { result } = renderHook(() => useToast())
    render(<NotificationHistory entries={result.current.history} />)
    fireEvent.click(screen.getByRole('button', { name: /^notifications/i }))
    const [row] = within(screen.getByRole('dialog', { name: 'Notifications' })).getAllByRole('listitem')
    expect(row).toHaveClass('signal-tone-danger')
    expect(row.querySelector('.notif-item-icon svg').innerHTML).toBe(markup(IconAlertTriangle))
    expect(row).toHaveTextContent(/^Error: Save failed/)
  })
})

describe('the icon and its colour', () => {
  it('draws one glyph per group, the shield for an alert, and no tick', () => {
    expect(GROUP_ICONS).toEqual({ info: IconInfo, warning: IconAlertTriangle, alert: IconShieldAlert })
    render(<ToastStack toasts={[
      { id: 1, msg: 'Saved', type: 'success' },
      { id: 2, msg: 'Device found', type: 'info' },
      { id: 3, msg: 'Save failed', type: 'error' },
      { id: 4, msg: 'Cap reached', type: 'warning' },
      { id: 5, msg: 'Resolved — Overtemperature', type: 'success', group: 'alert' }
    ]} />)
    const glyph = (text) => screen.getByText(text).closest('.toast').querySelector('.toast-icon svg').innerHTML
    expect(glyph('Saved')).toBe(markup(IconInfo))
    expect(glyph('Device found')).toBe(markup(IconInfo))
    expect(glyph('Save failed')).toBe(markup(IconAlertTriangle))
    expect(glyph('Cap reached')).toBe(markup(IconAlertTriangle))
    expect(glyph('Resolved — Overtemperature')).toBe(markup(IconShieldAlert))
    const tick = markup(IconCheck)
    for (const svg of document.querySelectorAll('.toast-icon svg')) expect(svg.innerHTML).not.toBe(tick)
  })

  it.each([
    ['info', 'success', 'accent'],
    ['info', 'info', 'accent'],
    ['warning', 'warning', 'warning'],
    ['warning', 'error', 'danger'],
    ['alert', 'error', 'danger'],
    ['alert', 'warning', 'warning'],
    ['alert', 'success', 'success']
  ])('colours a %s message of type %s with the %s tone', (group, type, tone) => {
    expect(toastTone(group, type)).toBe(tone)
    render(<ToastStack toasts={[{ id: 1, msg: 'message', type, group }]} />)
    expect(screen.getByText('message').closest('.toast')).toHaveClass(`toast signal-tone-${tone}`)
  })

  it.each([
    ['info', 'success', 'Info: '],
    ['warning', 'warning', 'Warning: '],
    ['warning', 'error', 'Error: '],
    ['alert', 'error', 'Alert: '],
    ['alert', 'success', 'Alert: ']
  ])('reads a %s message of type %s out with "%s" first', (group, type, prefix) => {
    expect(spokenPrefix(group, type)).toBe(prefix)
  })
})

describe('severity, not the group, keeps the timer and the live region', () => {
  it('keeps a critical alert until dismissed, in the assertive region', () => {
    render(<Harness />)
    act(() => { hook.showToast('Spindle Overtemperature', 'error', { group: 'alert' }) })
    act(() => { vi.advanceTimersByTime(10 * 60 * 1000) })
    expect(within(screen.getByRole('alert')).getByText('Spindle Overtemperature')).toBeInTheDocument()
  })

  it('times a resolved alert out as a success, read politely', () => {
    render(<Harness />)
    act(() => { hook.showToast('Resolved — Overtemperature', 'success', { group: 'alert' }) })
    expect(within(screen.getByRole('status')).getByText('Resolved — Overtemperature')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(Math.max(TOAST_MIN_MS.success, 1000 + 26 * 60)) })
    expect(screen.queryByText('Resolved — Overtemperature')).toBeNull()
  })
})

/**
 * A Grafana alert through usePlatformAlerts, with the toasts and the bell rendered as App renders
 * them. `current` is what the active view answers on the next poll.
 */
describe('a Grafana alert and the bell', () => {
  const FIRING = { fingerprint: 'f1', alert_name: 'Spindle Overtemperature', severity: 'critical', summary: 'CNC_01 at 92 C', starts_at: '2026-10-01T00:00:00Z' }
  let current

  async function mountAlerts(initial) {
    current = initial
    const { supabase } = await import('../lib/supabaseClient')
    vi.spyOn(supabase.auth, 'getSession').mockResolvedValue({ data: { session: {} } })
    vi.spyOn(supabase, 'from').mockImplementation(() => ({
      select: () => ({
        order: () => Promise.resolve({ data: current, error: null }),
        in: () => Promise.resolve({ data: [], error: null })
      })
    }))
    vi.spyOn(supabase, 'channel').mockReturnValue({ on() { return this }, subscribe() { return this } })
    vi.spyOn(supabase, 'removeChannel').mockImplementation(() => {})
    const { usePlatformAlerts } = await import('../hooks/usePlatformAlerts')
    function AlertsHarness() {
      hook = useToast()
      usePlatformAlerts(hook.showToast)
      return (
        <>
          <NotificationHistory entries={hook.history} onMarkRead={hook.markRead} onClear={hook.clearHistory} />
          <ToastStack toasts={hook.toasts} onDismiss={hook.dismissToast} onExpire={hook.expireToast} />
        </>
      )
    }
    render(<AlertsHarness />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  }
  const poll = async (rows) => {
    current = rows
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  }
  const bell = () => screen.getByRole('button', { name: /^notifications/i })

  it('toasts a firing alert and leaves the bell\'s badge at zero', async () => {
    await mountAlerts([])
    await poll([FIRING])

    expect(screen.getByText('Spindle Overtemperature').closest('.toast')).toHaveClass('signal-tone-danger')
    expect(hook.history).toEqual([])
    expect(bell()).toHaveAccessibleName('Notifications')
    expect(document.querySelector('.notif-badge')).toBeNull()
  })

  it('toasts the resolve in the Alert group with the success tone, and records neither', async () => {
    await mountAlerts([FIRING])
    await poll([])

    expect(screen.getByText('Resolved — Spindle Overtemperature').closest('.toast')).toHaveClass('signal-tone-success')
    expect(hook.history).toEqual([])
    expect(document.querySelector('.notif-badge')).toBeNull()
  })

  it('counts the dashboard\'s own messages beside it', async () => {
    await mountAlerts([])
    await poll([FIRING])
    act(() => { hook.showToast('Save failed', 'error') })

    expect(hook.history.map(e => e.msg)).toEqual(['Save failed'])
    expect(document.querySelector('.notif-badge')).toHaveTextContent('1')
  })
})
