import React from 'react'
import { render, renderHook, screen, fireEvent, act, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  Toast, ToastStack, toastDuration,
  TOAST_MIN_MS, TOAST_MAX_MS, TOAST_NOTICE_MS, TOAST_MS_PER_CHAR, TOAST_RESUME_MIN_MS
} from '../components/common/Toast'
import {
  useToast, readStoredHistory, clearStoredHistory,
  HISTORY_LIMIT, HISTORY_STORAGE_KEY, MAX_VISIBLE_TOASTS
} from '../hooks/useToast'
import { grafanaAlertUrl } from '../constants'
import { identityUrl } from '../routes'
import { alertToastUrl } from '../hooks/usePlatformAlerts'

/**
 * The toast and the history behind it. What is pinned: each toast owns its timer, so a second one
 * never inherits what was left of the first; how long a toast stays depends on its type and length,
 * and an error stays until dismissed; hover and focus hold it; both live regions exist before any
 * message arrives; and every `showToast` call lands in a capped, per-tab history.
 */

let hook
function Harness() {
  hook = useToast()
  return <ToastStack toasts={hook.toasts} onDismiss={hook.dismissToast} onExpire={hook.expireToast} />
}

const renderStack = () => render(<Harness />)
const show = (msg, type) => act(() => { hook.showToast(msg, type) })
const advance = (ms) => act(() => { vi.advanceTimersByTime(ms) })
const toastFor = (text) => screen.getByText(text).closest('.toast')

beforeEach(() => {
  window.sessionStorage.clear()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.sessionStorage.clear()
})

describe('toastDuration', () => {
  it('gives a short success or info message the type floor', () => {
    expect(toastDuration('Saved', 'success')).toBe(TOAST_MIN_MS.success)
    expect(toastDuration('Saved', 'info')).toBe(TOAST_MIN_MS.info)
    expect(TOAST_MIN_MS.success).toBe(4000)
  })

  it('gives a warning twice as long as a success', () => {
    expect(toastDuration('Cap reached', 'warning')).toBe(8000)
  })

  it('never times an error out', () => {
    expect(toastDuration('Save failed', 'error')).toBeNull()
  })

  it('grows with the length of the message past the floor, up to the ceiling', () => {
    const long = 'x'.repeat(150)
    expect(toastDuration(long, 'success')).toBe(TOAST_NOTICE_MS + 150 * TOAST_MS_PER_CHAR)
    expect(toastDuration(long, 'success')).toBeGreaterThan(TOAST_MIN_MS.success)
    expect(toastDuration('x'.repeat(2000), 'warning')).toBe(TOAST_MAX_MS)
  })

  it('treats an unknown type as info', () => {
    expect(toastDuration('Saved', 'notice')).toBe(TOAST_MIN_MS.info)
  })
})

describe('toast timing', () => {
  it('gives a second toast its own timer rather than what was left of the first', () => {
    renderStack()
    show('First save', 'success')
    advance(3000)
    show('Second save', 'success')

    // The first goes at 4 s, its own time; the second is only a second old.
    advance(1000)
    expect(screen.queryByText('First save')).toBeNull()
    expect(screen.getByText('Second save')).toBeInTheDocument()

    // And the second gets its full 4 s from when it arrived, not the 0.2 s the single slot left it.
    advance(2999)
    expect(screen.getByText('Second save')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByText('Second save')).toBeNull()
  })

  it('keeps a warning up for 8 s', () => {
    renderStack()
    show('Cap reached', 'warning')
    advance(7999)
    expect(screen.getByText('Cap reached')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByText('Cap reached')).toBeNull()
  })

  it('keeps an error until it is dismissed', () => {
    renderStack()
    show('Save failed: permission denied', 'error')
    advance(10 * 60 * 1000)
    const toast = toastFor('Save failed: permission denied')
    expect(toast).toBeInTheDocument()

    fireEvent.click(within(toast).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Save failed: permission denied')).toBeNull()
  })

  it('pauses while the pointer is over it, and resumes with at least the resume floor left', () => {
    renderStack()
    show('Saved', 'success')
    advance(3000)
    fireEvent.mouseEnter(toastFor('Saved'))
    advance(60000)
    expect(screen.getByText('Saved')).toBeInTheDocument()

    // One second was left; leaving gives it the floor instead.
    fireEvent.mouseLeave(toastFor('Saved'))
    advance(TOAST_RESUME_MIN_MS - 1)
    expect(screen.getByText('Saved')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('pauses while focus is inside it', () => {
    render(
      <>
        <button>elsewhere</button>
        <Harness />
      </>
    )
    show('Saved', 'success')
    advance(1000)
    act(() => { within(toastFor('Saved')).getByRole('button', { name: 'Dismiss' }).focus() })
    advance(60000)
    expect(screen.getByText('Saved')).toBeInTheDocument()

    // 3 s were left when focus arrived, and they run again once it leaves.
    act(() => { screen.getByRole('button', { name: 'elsewhere' }).focus() })
    advance(2999)
    expect(screen.getByText('Saved')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('stays paused while either the pointer or focus still holds it', () => {
    render(
      <>
        <button>elsewhere</button>
        <Harness />
      </>
    )
    show('Saved', 'success')
    const toast = toastFor('Saved')
    fireEvent.mouseEnter(toast)
    act(() => { within(toast).getByRole('button', { name: 'Dismiss' }).focus() })
    fireEvent.mouseLeave(toast)
    advance(60000)
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })
})

describe('the stack', () => {
  it(`shows at most ${MAX_VISIBLE_TOASTS}, and the oldest leaves when another arrives`, () => {
    renderStack()
    show('one', 'success')
    show('two', 'success')
    show('three', 'success')
    show('four', 'success')

    expect(screen.queryByText('one')).toBeNull()
    for (const msg of ['two', 'three', 'four']) expect(screen.getByText(msg)).toBeInTheDocument()
    expect(document.querySelectorAll('.toast')).toHaveLength(MAX_VISIBLE_TOASTS)
  })

  it('replaces a message already on screen rather than stacking a copy, and restarts its timer', () => {
    renderStack()
    show('Refresh failed', 'warning')
    advance(6000)
    show('Refresh failed', 'warning')

    expect(screen.getAllByText('Refresh failed')).toHaveLength(1)
    advance(7999)
    expect(screen.getByText('Refresh failed')).toBeInTheDocument()
  })

  it('keeps the showToast(msg, type) signature, with success as the default type', () => {
    renderStack()
    act(() => { hook.showToast('Saved') })
    expect(hook.toasts[0]).toMatchObject({ type: 'success', group: 'info' })
    expect(toastFor('Saved')).toHaveClass('signal-tone-accent')
  })
})

describe('announcement', () => {
  it('renders both live regions before any message, empty', () => {
    render(<ToastStack toasts={[]} />)
    const status = screen.getByRole('status')
    const alert = screen.getByRole('alert')
    expect(status).toBeEmptyDOMElement()
    expect(alert).toBeEmptyDOMElement()
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(alert).toHaveAttribute('aria-live', 'assertive')
  })

  it('announces an error assertively and everything else politely', () => {
    renderStack()
    show('Saved', 'success')
    show('Device discovered', 'info')
    show('Cap reached', 'warning')
    show('Save failed', 'error')

    const status = screen.getByRole('status')
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('Save failed')).toBeInTheDocument()
    expect(within(alert).queryByText('Cap reached')).toBeNull()
    expect(within(status).getByText('Cap reached')).toBeInTheDocument()
    expect(within(status).getByText('Device discovered')).toBeInTheDocument()
    expect(within(status).queryByText('Save failed')).toBeNull()
  })

  it('says the group of a message in words, and "Error" for a failure, not only by icon and colour', () => {
    renderStack()
    show('Keep the file', 'warning')
    show('Save failed', 'error')
    show('Saved', 'success')
    expect(toastFor('Keep the file')).toHaveTextContent(/^Warning: Keep the file$/)
    expect(toastFor('Save failed')).toHaveTextContent(/^Error: Save failed$/)
    expect(toastFor('Saved')).toHaveTextContent(/^Info: Saved$/)
    expect(toastFor('Keep the file').querySelector('.sr-only')).toHaveTextContent('Warning:')
  })

  it('gives every toast a close button named Dismiss', () => {
    renderStack()
    show('Saved', 'success')
    show('Save failed', 'error')
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(2)
  })

  it('renders a bare Toast with an expiry callback carrying its id', () => {
    const onExpire = vi.fn()
    render(<Toast id={7} msg="Saved" type="success" onExpire={onExpire} />)
    advance(TOAST_MIN_MS.success)
    expect(onExpire).toHaveBeenCalledWith(7)
  })
})

describe('the history useToast keeps', () => {
  it('records every showToast call, newest first and unread', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast('Saved', 'success') })
    act(() => { result.current.showToast('Save failed', 'error') })

    const [newest, older] = result.current.history
    expect(newest).toMatchObject({ msg: 'Save failed', type: 'error', group: 'warning', read: false, count: 1 })
    expect(older).toMatchObject({ msg: 'Saved', type: 'success', group: 'info', read: false })
    expect(typeof newest.id).toBe('number')
    expect(newest.id).not.toBe(older.id)
    expect(newest.at).toBe(Date.now())
  })

  it(`keeps the latest ${HISTORY_LIMIT}`, () => {
    const { result } = renderHook(() => useToast())
    act(() => {
      for (let i = 1; i <= HISTORY_LIMIT + 5; i++) result.current.showToast(`message ${i}`, 'success')
    })
    expect(result.current.history).toHaveLength(HISTORY_LIMIT)
    expect(result.current.history[0].msg).toBe(`message ${HISTORY_LIMIT + 5}`)
    expect(result.current.history.at(-1).msg).toBe('message 6')
  })

  it('counts a repeat of the newest entry on it rather than adding another', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast('Refresh failed', 'error') })
    act(() => { result.current.showToast('Refresh failed', 'error') })
    act(() => { result.current.showToast('Refresh failed', 'error') })
    expect(result.current.history).toHaveLength(1)
    expect(result.current.history[0].count).toBe(3)

    // Not consecutive, or not the same type: a new entry.
    act(() => { result.current.showToast('Saved', 'success') })
    act(() => { result.current.showToast('Refresh failed', 'error') })
    expect(result.current.history.map(e => e.msg)).toEqual(['Refresh failed', 'Saved', 'Refresh failed'])
  })

  it('treats dismissing a toast as reading it, and a timeout as not', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast('Saved', 'success') })
    act(() => { result.current.showToast('Save failed', 'error') })
    const [failed, saved] = result.current.history

    act(() => { result.current.expireToast(saved.id) })
    act(() => { result.current.dismissToast(failed.id) })

    expect(result.current.toasts).toEqual([])
    expect(result.current.history.find(e => e.id === failed.id).read).toBe(true)
    expect(result.current.history.find(e => e.id === saved.id).read).toBe(false)
  })

  it('marks the entries it is given read, or everything, and clears', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast('one', 'success') })
    act(() => { result.current.showToast('two', 'warning') })
    const [two, one] = result.current.history
    act(() => { result.current.markRead([one.id]) })
    expect(result.current.history.map(e => e.read)).toEqual([false, true])
    act(() => { result.current.markRead() })
    expect(result.current.history.every(e => e.read)).toBe(true)
    expect(two.id).not.toBe(one.id)

    act(() => { result.current.clearHistory() })
    expect(result.current.history).toEqual([])
    expect(window.sessionStorage.getItem(HISTORY_STORAGE_KEY)).toBeNull()
  })

  it('records an unknown type as info', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast('Heads up', 'notice') })
    expect(result.current.history[0].type).toBe('info')
    expect(result.current.toasts[0].type).toBe('info')
  })

  it('survives a reload through sessionStorage, and carries on numbering after it', () => {
    const first = renderHook(() => useToast())
    act(() => { first.result.current.showToast('Saved', 'success') })
    act(() => { first.result.current.showToast('Cap reached', 'warning') })
    const ids = first.result.current.history.map(e => e.id)
    first.unmount()

    const stored = JSON.parse(window.sessionStorage.getItem(HISTORY_STORAGE_KEY))
    expect(stored.map(e => e.msg)).toEqual(['Cap reached', 'Saved'])
    // Message text and its bookkeeping, nothing else.
    expect(Object.keys(stored[0]).sort()).toEqual(['at', 'count', 'group', 'id', 'msg', 'read', 'type'])

    const second = renderHook(() => useToast())
    expect(second.result.current.history.map(e => e.msg)).toEqual(['Cap reached', 'Saved'])
    // Toasts are not replayed: only the history comes back.
    expect(second.result.current.toasts).toEqual([])
    act(() => { second.result.current.showToast('Again', 'success') })
    expect(ids).not.toContain(second.result.current.history[0].id)
  })

  it('ignores a stored value it did not write', () => {
    window.sessionStorage.setItem(HISTORY_STORAGE_KEY, '{not json')
    expect(readStoredHistory()).toEqual([])

    window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ msg: 'not a list' }))
    expect(readStoredHistory()).toEqual([])

    window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([
      { id: 1, msg: 'kept', type: 'success', at: 1 },
      { id: 2, msg: 42, type: 'success', at: 2 },
      { id: 3, msg: 'bad type', type: 'shout', at: 3 },
      null
    ]))
    expect(readStoredHistory()).toEqual([{ id: 1, msg: 'kept', type: 'success', group: 'info', at: 1, read: false, count: 1 }])
  })

  it('carries on in memory when storage throws', () => {
    const blocked = () => { throw new DOMException('blocked', 'SecurityError') }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked)

    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast('Saved', 'success') })
    expect(result.current.history.map(e => e.msg)).toEqual(['Saved'])
    act(() => { result.current.clearHistory() })
    expect(result.current.history).toEqual([])
    expect(() => clearStoredHistory()).not.toThrow()
  })

  it('clearStoredHistory removes what a session left behind', () => {
    window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([{ id: 1, msg: 'x', type: 'info', at: 1 }]))
    clearStoredHistory()
    expect(window.sessionStorage.getItem(HISTORY_STORAGE_KEY)).toBeNull()
  })
})

describe('a firing platform alert', () => {
  const row = {
    fingerprint: 'f1', alert_name: 'Historian Backup Stale', severity: 'warning',
    summary: 'The last backup is 3 days old; run SELECT 1 FROM backups', starts_at: '2026-10-01T00:00:00Z'
  }

  async function mountAlerts(rows) {
    let current = []
    const { supabase } = await import('../lib/supabaseClient')
    vi.spyOn(supabase.auth, 'getSession').mockResolvedValue({ data: { session: {} } })
    vi.spyOn(supabase, 'from').mockImplementation(() => ({
      select: () => ({ order: () => Promise.resolve({ data: current, error: null }) })
    }))
    vi.spyOn(supabase, 'channel').mockReturnValue({ on() { return this }, subscribe() { return this } })
    vi.spyOn(supabase, 'removeChannel').mockImplementation(() => {})
    const { usePlatformAlerts } = await import('../hooks/usePlatformAlerts')
    function AlertsHarness() {
      hook = useToast()
      usePlatformAlerts(hook.showToast)
      return <ToastStack toasts={hook.toasts} onDismiss={hook.dismissToast} onExpire={hook.expireToast} />
    }
    render(<AlertsHarness />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    // Returns how to change what is firing at the next reconciliation.
    const firing = async (next) => {
      current = next
      await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    }
    await firing(rows)
    return firing
  }

  it('toasts the alert name only, and records nothing in the history', async () => {
    await mountAlerts([row])
    expect(screen.getByText('Historian Backup Stale').closest('.toast')).toBeTruthy()
    expect(screen.queryByText(/SELECT 1/)).toBeNull()
    expect(hook.history).toEqual([])
  })

  it('puts the alert in the Alert group, at the severity Grafana gave it', async () => {
    await mountAlerts([row, { ...row, fingerprint: 'f2', alert_name: 'Spindle Overtemperature', severity: 'critical', summary: '' }])
    expect(hook.toasts.map(t => [t.msg, t.type, t.group])).toEqual([
      ['Historian Backup Stale', 'warning', 'alert'],
      ['Spindle Overtemperature', 'error', 'alert']
    ])
    expect(screen.getByText('Spindle Overtemperature').closest('.toast')).toHaveClass('signal-tone-danger')
    expect(screen.getByText('Historian Backup Stale').closest('.toast')).toHaveClass('signal-tone-warning')
    expect(screen.getByText('Spindle Overtemperature').closest('.toast')).toHaveTextContent(/^Alert: /)
  })

  it('links the toast to its rule in Grafana, in a new tab, and dismisses it when followed', async () => {
    await mountAlerts([row])
    const link = screen.getByRole('link', { name: /Historian Backup Stale/ })
    expect(link).toHaveAttribute('href', grafanaAlertUrl({ alert_name: 'Historian Backup Stale' }))
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveAccessibleDescription('Open in Grafana, in a new tab')
    expect(hook.toasts[0].to).toBe(grafanaAlertUrl({ alert_name: 'Historian Backup Stale' }))
    fireEvent.click(link)
    expect(document.querySelector('.toast')).toBeNull()
    expect(hook.history).toEqual([])
  })

  it('links an alert about a machine identity to the identity on Access Control, firing and resolved', async () => {
    const principal = '5e000000-0204-4000-8000-0000000000a1'
    const token = {
      ...row, fingerprint: 'f3', alert_name: 'Service Token Expiring',
      entity_type: 'service_identity', entity_id: principal, sparkplug_id: null
    }
    const firing = await mountAlerts([token])
    const link = screen.getByRole('link', { name: /Service Token Expiring/ })
    expect(link).toHaveAttribute('href', `/access-control/identities?search=${principal}`)
    expect(link).toHaveAttribute('href', identityUrl(principal))
    expect(link).not.toHaveAttribute('target')
    expect(link).toHaveAccessibleDescription('Go to Access Control › Identities')

    await firing([])
    const resolved = hook.toasts.find(t => t.msg === 'Resolved — Service Token Expiring')
    expect(resolved.to).toBe(identityUrl(principal))
    expect(hook.history).toEqual([])
  })

  it('links any other alert to its rule, whatever entity_id it carries', () => {
    expect(alertToastUrl({ ...row, entity_type: 'gateway', entity_id: 'g-1' })).toBe(grafanaAlertUrl(row))
    expect(alertToastUrl({ ...row, entity_type: 'service_identity', entity_id: null })).toBe(grafanaAlertUrl(row))
  })

  it('links straight to the rule by its uid, firing and resolved', async () => {
    const firing = await mountAlerts([{ ...row, rule_uid: 'aber-backup-stale' }])
    const ruleView = 'http://localhost:3002/alerting/grafana/aber-backup-stale/view'
    expect(screen.getByRole('link', { name: /Historian Backup Stale/ })).toHaveAttribute('href', ruleView)
    await firing([])
    expect(hook.toasts.find(t => t.msg === 'Resolved — Historian Backup Stale').to).toBe(ruleView)
  })

  it('searches by the rule name for a row written before the uid was kept', async () => {
    await mountAlerts([{ ...row, rule_uid: null }])
    expect(screen.getByRole('link', { name: /Historian Backup Stale/ }))
      .toHaveAttribute('href', grafanaAlertUrl({ alert_name: 'Historian Backup Stale' }))
  })

  it('dismisses from the Dismiss button without following the link', async () => {
    await mountAlerts([row])
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(document.querySelector('.toast')).toBeNull()
  })

  it('leaves a toast with no destination as plain text', () => {
    renderStack()
    show('Saved', 'success')
    expect(within(toastFor('Saved')).queryAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Dismiss'])
    expect(within(toastFor('Saved')).queryByRole('link')).toBeNull()
  })
})
