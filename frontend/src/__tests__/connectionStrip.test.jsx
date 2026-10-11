import React from 'react'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import App from '../App'
import { ConnectionStrip } from '../components/common/ConnectionStrip'
import { documentTitle, APP_TITLE, NOT_UPDATING_PREFIX } from '../hooks/useDocumentTitle'
import { formatClockTime, formatDateTime } from '../utils/format'
import {
  CONNECTION_OK,
  CONNECTION_STALE,
  CONNECTION_SESSION_ENDED,
  STALE_AFTER_MS,
  resetConnectionState
} from '../lib/connectionState'

/**
 * The strip under the top bar that says the page has stopped updating, and the tab title that
 * leads with it. A dashboard that has lost the API must not look live.
 */

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
    from: vi.fn(),
    rpc: vi.fn()
  }
}))

import { supabase } from '../lib/supabaseClient'

const at1402 = new Date(2026, 9, 11, 14, 2, 0).getTime()

describe('ConnectionStrip', () => {
  it('is an empty live region while every refresh works', () => {
    render(<ConnectionStrip status={CONNECTION_OK} since={null} onSignInAgain={vi.fn()} />)
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toBeEmptyDOMElement()
  })

  it('says since when, that it is retrying, and that the values may be out of date', () => {
    render(<ConnectionStrip status={CONNECTION_STALE} since={at1402} onSignInAgain={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Not updating since 14:02. Retrying. Values on this page may be out of date.'
    )
    // An icon as well as the colour, so the colour is never the only signal.
    expect(screen.getByRole('status').querySelector('svg')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('goes away when the status returns to OK', () => {
    const { rerender } = render(<ConnectionStrip status={CONNECTION_STALE} since={at1402} onSignInAgain={vi.fn()} />)
    expect(screen.getByText(/Not updating since/)).toBeInTheDocument()
    rerender(<ConnectionStrip status={CONNECTION_OK} since={null} onSignInAgain={vi.fn()} />)
    expect(screen.queryByText(/Not updating since/)).toBeNull()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('says the session has ended and offers Sign In Again', () => {
    const onSignInAgain = vi.fn()
    render(<ConnectionStrip status={CONNECTION_SESSION_ENDED} since={at1402} onSignInAgain={onSignInAgain} />)
    expect(screen.getByRole('status')).toHaveTextContent('Your session has ended.')
    expect(screen.queryByText(/Not updating since/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign In Again' }))
    expect(onSignInAgain).toHaveBeenCalledTimes(1)
  })
})

describe('formatClockTime', () => {
  it('is the 24-hour time part of formatDateTime', () => {
    expect(formatClockTime(at1402)).toBe('14:02')
    expect(formatDateTime(at1402)).toMatch(/, 14:02$/)
  })

  it('falls back to the dash for a missing time', () => {
    expect(formatClockTime(null)).toBe('—')
  })
})

describe('the tab title', () => {
  it('leads with "Not updating · " while the strip shows', () => {
    expect(NOT_UPDATING_PREFIX).toBe('Not updating · ')
    expect(documentTitle('Devices', 0, true)).toBe('Not updating · Aber | Devices')
  })

  it('leads ahead of the alert count, so a narrow tab still shows it', () => {
    expect(documentTitle('Devices', 2, true)).toBe('Not updating · (2) Aber | Devices')
  })

  it('is unchanged otherwise', () => {
    expect(documentTitle('Devices', 0, false)).toBe('Aber | Devices')
    expect(documentTitle('Devices')).toBe('Aber | Devices')
  })
})

describe('the strip in the signed-in shell', () => {
  const mockSession = {
    user: { id: 'user-admin-123', email: 'admin@aber.local', app_metadata: { role: 'Administrator' } }
  }

  // What every query resolves to. A builder that answers any chain, so every page's reads take the
  // same outcome whatever filters they apply.
  let outcome
  const query = () => {
    const builder = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') return (resolve, reject) => Promise.resolve(outcome).then(resolve, reject)
        return () => builder
      }
    })
    return builder
  }

  const ok = { data: [], error: null, status: 200 }
  const unreachable = { data: null, error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }, status: 0 }
  const expired = { data: null, error: { code: 'PGRST303', message: 'JWT expired', details: null, hint: null }, status: 401 }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetConnectionState()
    outcome = ok
    document.title = APP_TITLE
    window.history.pushState({}, '', '/site-map')
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
    supabase.auth.getUser.mockResolvedValue({ data: { user: mockSession.user }, error: null })
    supabase.auth.signOut.mockResolvedValue({ error: null })
    supabase.auth.onAuthStateChange.mockImplementation(() => ({ data: { subscription: { unsubscribe: vi.fn() } } }))
    supabase.from.mockImplementation(() => query())
    supabase.rpc.mockImplementation(() => query())
  })

  afterEach(() => {
    resetConnectionState()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const signedIn = async () => {
    render(<App />)
    await waitFor(() => expect(document.title).toBe('Aber | Site Map'))
  }

  it('appears once the API has been unreachable for the threshold, and leads the title', async () => {
    await signedIn()
    outcome = unreachable
    // The next poll fails; nothing shows yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(3500) })
    expect(screen.queryByText(/Not updating since/)).toBeNull()
    expect(document.title).toBe('Aber | Site Map')

    await act(async () => { await vi.advanceTimersByTimeAsync(STALE_AFTER_MS) })
    expect(screen.getByText(/Not updating since \d\d:\d\d\. Retrying\. Values on this page may be out of date\./)).toBeInTheDocument()
    expect(document.title).toBe('Not updating · Aber | Site Map')
  })

  it('goes away, with the title prefix, on the next refresh that works', async () => {
    await signedIn()
    outcome = unreachable
    await act(async () => { await vi.advanceTimersByTimeAsync(3500 + STALE_AFTER_MS) })
    expect(screen.getByText(/Not updating since/)).toBeInTheDocument()

    outcome = ok
    // The longest backoff, so every poll has had its next turn.
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(screen.queryByText(/Not updating since/)).toBeNull()
    expect(document.title).toBe('Aber | Site Map')
  })

  // The clock starts at the event, not at the next poll to fail: exactly the threshold after it.
  it('counts from the moment the browser goes offline', async () => {
    await signedIn()
    outcome = unreachable
    act(() => { window.dispatchEvent(new Event('offline')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(STALE_AFTER_MS) })
    expect(screen.getByText(/Not updating since/)).toBeInTheDocument()
  })

  it('turns an expired session into Sign In Again, which leads to the sign-in screen without the strip', async () => {
    await signedIn()
    outcome = expired
    await act(async () => { await vi.advanceTimersByTimeAsync(3500 + STALE_AFTER_MS) })
    expect(screen.getByText('Your session has ended.')).toBeInTheDocument()
    expect(screen.queryByText(/Not updating since/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Sign In Again' }))
    await waitFor(() => expect(document.title).toBe('Aber | Sign in'))
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(screen.getByText(/no longer valid on the server/i)).toBeInTheDocument()
    expect(screen.queryByText('Your session has ended.')).toBeNull()
  })

  // A failure left over from the last session must not greet the next one.
  it('starts clean after signing in again', async () => {
    await signedIn()
    outcome = expired
    await act(async () => { await vi.advanceTimersByTimeAsync(3500 + STALE_AFTER_MS) })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In Again' }))
    await waitFor(() => expect(document.title).toBe('Aber | Sign in'))

    outcome = ok
    supabase.auth.signInWithPassword.mockResolvedValue({ data: { session: mockSession }, error: null })
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'admin@aber.local' } })
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }))
    await waitFor(() => expect(document.title).toBe('Aber | Site Map'))
    expect(screen.queryByText('Your session has ended.')).toBeNull()
  })
})
