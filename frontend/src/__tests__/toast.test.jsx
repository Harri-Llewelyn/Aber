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
    expect(toastFor('Saved')).toHaveClass('toast-success')
  })

  it.each(['success', 'info', 'warning', 'error'])('styles a %s toast by its own class', (type) => {
    renderStack()
    show(`A ${type} message`, type)
    expect(toastFor(`A ${type} message`)).toHaveClass(`toast-${type}`)
  })

  it('draws a different glyph for each type, and the cross only on the close button', () => {
    const types = ['success', 'info', 'warning', 'error']
    render(<ToastStack toasts={types.map((type, id) => ({ id, msg: `${type} glyph`, type }))} />)
    const glyphs = [...document.querySelectorAll('.toast .toast-icon svg')].map(svg => svg.innerHTML)
    expect(glyphs).toHaveLength(4)
    expect(new Set(glyphs).size).toBe(4)
    const cross = document.querySelector('.toast-dismiss svg').innerHTML
    expect(glyphs).not.toContain(cross)
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

  it('says the type of a warning or an error in words, not only by icon and colour', () => {
    renderStack()
    show('Keep the file', 'warning')
    show('Save failed', 'error')
    expect(toastFor('Keep the file')).toHaveTextContent(/^Warning: Keep the file$/)
    expect(toastFor('Save failed')).toHaveTextContent(/^Error: Save failed$/)
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
    expect(newest).toMatchObject({ msg: 'Save failed', type: 'error', read: false, count: 1 })
    expect(older).toMatchObject({ msg: 'Saved', type: 'success', read: false })
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

  it('marks everything read, and clears', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast('one', 'success') })
    act(() => { result.current.showToast('two', 'warning') })
    act(() => { result.current.markAllRead() })
    expect(result.current.history.every(e => e.read)).toBe(true)

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
    expect(Object.keys(stored[0]).sort()).toEqual(['at', 'count', 'id', 'msg', 'read', 'type'])

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
    expect(readStoredHistory()).toEqual([{ id: 1, msg: 'kept', type: 'success', at: 1, read: false, count: 1 }])
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
  const FULL = `${row.alert_name} — ${row.summary}`

  async function mountAlerts(rows, onOpenAlerts) {
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
      const open = React.useCallback((id) => { onOpenAlerts?.(id); hook.dismissToast(id) }, [])
      usePlatformAlerts(hook.showToast, open)
      return <ToastStack toasts={hook.toasts} onDismiss={hook.dismissToast} onExpire={hook.expireToast} />
    }
    render(<AlertsHarness />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    current = rows
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  }

  it('toasts the alert name only, and the history keeps the summary', async () => {
    await mountAlerts([row])
    expect(screen.getByText('Historian Backup Stale').closest('.toast')).toBeTruthy()
    expect(screen.queryByText(/SELECT 1/)).toBeNull()
    expect(hook.history[0].msg).toBe(FULL)
  })

  it('opens the alerts list on a click or Enter, and dismisses the toast', async () => {
    const onOpen = vi.fn()
    await mountAlerts([row], onOpen)
    const button = screen.getByRole('button', { name: /Historian Backup Stale/ })
    expect(button.tagName).toBe('BUTTON') // a native button answers Enter and Space with a click
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.toast')).toBeNull()
  })

  it('does not open the list from the Dismiss button', async () => {
    const onOpen = vi.fn()
    await mountAlerts([row], onOpen)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onOpen).not.toHaveBeenCalled()
    expect(document.querySelector('.toast')).toBeNull()
  })

  it('leaves other toasts unclickable', () => {
    renderStack()
    show('Saved', 'success')
    expect(within(toastFor('Saved')).queryAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Dismiss'])
  })
})
