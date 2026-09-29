import React from 'react'
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NotificationHistory, relativeTime, worstType } from '../components/common/NotificationHistory'
import { useToast, HISTORY_STORAGE_KEY } from '../hooks/useToast'
import { supabase } from '../lib/supabaseClient'
import App from '../App'

// For the App suite at the end. NotificationHistory and useToast never reach the client.
vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      signOut: vi.fn()
    },
    channel: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }),
    removeChannel: vi.fn(),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null })
    })
  }
}))

/**
 * The top bar's notification history. What is pinned: the unread badge is absent at zero and takes
 * the tone of the worst unread entry; opening the list reads it; the list is newest first with a
 * relative time and the absolute one in its title; Escape and the close button hand focus back to
 * the bell; Clear empties it; and the stored history goes when the session does.
 */

const NOW = Date.parse('2026-09-29T12:00:00Z')

const entry = (over = {}) => ({ id: 1, msg: 'Saved', type: 'success', at: NOW, read: false, count: 1, ...over })

const bell = () => screen.getByRole('button', { name: /^notifications/i })
const badge = () => document.querySelector('.notif-badge')

describe('relativeTime', () => {
  it.each([
    [0, 'just now'],
    [59, 'just now'],
    [60, '1 min ago'],
    [125, '2 min ago'],
    [3600, '1 h ago'],
    [86399, '23 h ago'],
    [86400, 'yesterday'],
    [3 * 86400, '3 days ago']
  ])('%is ago reads as "%s"', (seconds, expected) => {
    expect(relativeTime(NOW - seconds * 1000, NOW)).toBe(expected)
  })

  it('reads an entry stamped after the clock as just now', () => {
    expect(relativeTime(NOW + 5000, NOW)).toBe('just now')
  })
})

describe('worstType', () => {
  it('ranks error over warning over info over success', () => {
    expect(worstType([entry({ type: 'success' }), entry({ type: 'error' }), entry({ type: 'warning' })])).toBe('error')
    expect(worstType([entry({ type: 'info' }), entry({ type: 'warning' })])).toBe('warning')
    expect(worstType([entry({ type: 'success' }), entry({ type: 'info' })])).toBe('info')
    expect(worstType([entry({ type: 'success' })])).toBe('success')
    expect(worstType([])).toBeNull()
  })
})

describe('NotificationHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  describe('the bell', () => {
    it('has no badge when nothing is unread', () => {
      render(<NotificationHistory entries={[entry({ read: true })]} />)
      expect(badge()).toBeNull()
      expect(bell()).toHaveAccessibleName('Notifications')
      expect(bell()).toHaveAttribute('aria-expanded', 'false')
    })

    it('counts the unread entries, and says so in its name', () => {
      render(<NotificationHistory entries={[entry({ id: 2 }), entry({ id: 1, read: true }), entry({ id: 0 })]} />)
      expect(badge()).toHaveTextContent('2')
      expect(badge()).toHaveAttribute('aria-hidden', 'true')
      expect(bell()).toHaveAccessibleName('Notifications, 2 unread')
    })

    it.each([
      [['success', 'error', 'warning'], 'error'],
      [['success', 'info', 'warning'], 'warning'],
      [['success', 'info'], 'info'],
      [['success'], 'success']
    ])('takes the tone of the worst unread entry among %j', (types, tone) => {
      render(<NotificationHistory entries={types.map((type, id) => entry({ id, type }))} />)
      expect(badge()).toHaveClass(`notif-badge-${tone}`)
    })

    it('ignores a read error when choosing the tone', () => {
      render(<NotificationHistory entries={[entry({ id: 2, type: 'success' }), entry({ id: 1, type: 'error', read: true })]} />)
      expect(badge()).toHaveClass('notif-badge-success')
      expect(bell().getAttribute('title')).not.toMatch(/error/)
    })

    it('mentions an unread error in its title', () => {
      render(<NotificationHistory entries={[entry({ type: 'error' })]} />)
      expect(bell().getAttribute('title')).toMatch(/1 unread notification, including an error/)
    })
  })

  describe('the list', () => {
    it('opens as a dialog, takes focus, and reads what was unread', () => {
      const onMarkRead = vi.fn()
      render(<NotificationHistory entries={[entry()]} onMarkRead={onMarkRead} />)
      fireEvent.click(bell())

      const panel = screen.getByRole('dialog', { name: 'Notifications' })
      expect(panel).toHaveFocus()
      expect(bell()).toHaveAttribute('aria-expanded', 'true')
      expect(onMarkRead).toHaveBeenCalledTimes(1)
    })

    it('does not mark anything read while it is closed, or when nothing is unread', () => {
      const onMarkRead = vi.fn()
      const { rerender } = render(<NotificationHistory entries={[entry()]} onMarkRead={onMarkRead} />)
      expect(onMarkRead).not.toHaveBeenCalled()
      rerender(<NotificationHistory entries={[entry({ read: true })]} onMarkRead={onMarkRead} />)
      fireEvent.click(bell())
      expect(onMarkRead).not.toHaveBeenCalled()
    })

    it('lists newest first, with its icon, a relative time and the absolute time in the title', () => {
      render(<NotificationHistory entries={[
        entry({ id: 3, msg: 'Save failed', type: 'error', at: NOW - 30 * 1000 }),
        entry({ id: 2, msg: 'Cap reached', type: 'warning', at: NOW - 5 * 60 * 1000, count: 4 }),
        entry({ id: 1, msg: 'Saved', type: 'success', at: NOW - 2 * 3600 * 1000 })
      ]} />)
      fireEvent.click(bell())

      const items = within(screen.getByRole('dialog')).getAllByRole('listitem')
      expect(items.map(li => li.querySelector('.notif-item-msg').lastChild.textContent))
        .toEqual(['Save failed', 'Cap reached', 'Saved'])
      expect(items[0]).toHaveClass('notif-item-error')
      expect(items[0]).toHaveTextContent(/^Error: Save failed/)
      expect(items[0].querySelector('.notif-item-icon svg')).toBeTruthy()

      const time = items[1].querySelector('time')
      expect(time).toHaveTextContent('5 min ago')
      expect(time).toHaveAttribute('dateTime', new Date(NOW - 5 * 60 * 1000).toISOString())
      expect(time.getAttribute('title')).toBe(new Date(NOW - 5 * 60 * 1000).toLocaleString())
      expect(items[1]).toHaveTextContent('4 times in a row')
      expect(items[2].querySelector('time')).toHaveTextContent('2 h ago')
    })

    it('refreshes the relative times while it is open', () => {
      render(<NotificationHistory entries={[entry({ at: NOW - 30 * 1000 })]} />)
      fireEvent.click(bell())
      expect(screen.getByText('just now')).toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(60 * 1000) })
      expect(screen.getByText('1 min ago')).toBeInTheDocument()
    })

    it('says what it is for when empty, and disables Clear', () => {
      render(<NotificationHistory entries={[]} />)
      fireEvent.click(bell())
      const panel = screen.getByRole('dialog')
      expect(within(panel).getByText('No notifications')).toBeInTheDocument()
      expect(within(panel).getByRole('button', { name: 'Clear' })).toBeDisabled()
    })

    it('empties on Clear and keeps focus in the panel', () => {
      const onClear = vi.fn()
      render(<NotificationHistory entries={[entry()]} onClear={onClear} />)
      fireEvent.click(bell())
      const clear = screen.getByRole('button', { name: 'Clear' })
      act(() => { clear.focus() })
      fireEvent.click(clear)
      expect(onClear).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('dialog')).toHaveFocus()
    })

    it('closes on Escape and hands focus back to the bell', () => {
      render(<NotificationHistory entries={[entry()]} />)
      fireEvent.click(bell())
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(bell()).toHaveFocus()
    })

    it('closes on its close button and hands focus back to the bell', () => {
      render(<NotificationHistory entries={[entry()]} />)
      fireEvent.click(bell())
      fireEvent.click(screen.getByRole('button', { name: 'Close notifications' }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(bell()).toHaveFocus()
    })

    it('closes on a second click of the bell and on a click outside', () => {
      render(<><button>outside</button><NotificationHistory entries={[entry()]} /></>)
      fireEvent.click(bell())
      fireEvent.click(bell())
      expect(screen.queryByRole('dialog')).toBeNull()

      fireEvent.click(bell())
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('closes when focus is tabbed out of it', () => {
      render(<><NotificationHistory entries={[entry()]} /><button>next control</button></>)
      fireEvent.click(bell())
      act(() => { screen.getByRole('button', { name: 'next control' }).focus() })
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })
})

/** The two halves wired together the way App wires them. */
describe('toasts feed the list', () => {
  let hook
  function Wired() {
    hook = useToast()
    return <NotificationHistory entries={hook.history} onMarkRead={hook.markAllRead} onClear={hook.clearHistory} />
  }

  beforeEach(() => window.sessionStorage.clear())
  afterEach(() => window.sessionStorage.clear())

  it('counts each showToast call until the list is opened, then clears the badge', () => {
    render(<Wired />)
    act(() => { hook.showToast('Saved', 'success') })
    act(() => { hook.showToast('Save failed', 'error') })
    expect(badge()).toHaveTextContent('2')
    expect(badge()).toHaveClass('notif-badge-error')

    fireEvent.click(bell())
    expect(badge()).toBeNull()
    expect(within(screen.getByRole('dialog')).getAllByRole('listitem')).toHaveLength(2)

    // Arriving while the list is open is arriving in front of the reader.
    act(() => { hook.showToast('Saved again', 'success') })
    expect(badge()).toBeNull()
  })

  it('empties the list and its stored copy on Clear', () => {
    render(<Wired />)
    act(() => { hook.showToast('Saved', 'success') })
    expect(window.sessionStorage.getItem(HISTORY_STORAGE_KEY)).not.toBeNull()
    fireEvent.click(bell())
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(within(screen.getByRole('dialog')).queryAllByRole('listitem')).toHaveLength(0)
    expect(window.sessionStorage.getItem(HISTORY_STORAGE_KEY)).toBeNull()
  })
})

/** Sign-out, through App: the stored history belongs to the session that wrote it. */
describe('the stored history and the session', () => {
  const session = { user: { id: 'user-1', email: 'operator@aber.local', app_metadata: { role: 'Administrator' } } }
  let authCallback

  const seed = () => window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([
    { id: 1, msg: 'Bundle downloaded — keep the file', type: 'warning', at: Date.now(), read: false, count: 1 }
  ]))

  beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
    window.history.pushState({}, '', '/')
    supabase.auth.getSession.mockResolvedValue({ data: { session } })
    supabase.auth.getUser.mockResolvedValue({ data: { user: session.user }, error: null })
    supabase.auth.signOut.mockResolvedValue({ error: null })
    supabase.auth.onAuthStateChange.mockImplementation((cb) => {
      authCallback = cb
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    })
  })

  afterEach(() => window.sessionStorage.clear())

  it('restores the list after a reload, beside the alert pill', async () => {
    seed()
    render(<App />)
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications, 1 unread'))
    const right = document.querySelector('.topbar-right')
    expect(right.querySelector('.alert-pill-wrap').nextElementSibling).toHaveClass('notif-wrap')
  })

  it('clears it when the session ends, so the next person starts empty', async () => {
    seed()
    render(<App />)
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications, 1 unread'))

    act(() => { authCallback('SIGNED_OUT', null) })
    await waitFor(() => expect(screen.queryByRole('button', { name: /^notifications/i })).toBeNull())
    expect(window.sessionStorage.getItem(HISTORY_STORAGE_KEY)).toBeNull()

    act(() => { authCallback('SIGNED_IN', session) })
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications'))
  })

  it('clears it when there is no session to restore', async () => {
    seed()
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
    render(<App />)
    await waitFor(() => expect(window.sessionStorage.getItem(HISTORY_STORAGE_KEY)).toBeNull())
  })
})
