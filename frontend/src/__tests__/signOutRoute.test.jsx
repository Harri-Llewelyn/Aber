import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from '../App'
import { supabase } from '../lib/supabaseClient'
import { signOutOfForge, signOutOfStudio } from '../utils/studioSignOut'
import { signedOutNotice } from '../utils/signOut'

/**
 * `/sign-out`: where the forge's sign-out sends the browser, and a link anyone may follow. It runs
 * the account menu's Sign Out, this browser's sessions only, with no confirmation, then shows the
 * sign-in page with a notice. It works with nobody signed in, and replaces its own address.
 */

const session = {
  user: { id: 'user-admin-123', email: 'admin@aber.local', app_metadata: { role: 'Administrator' } }
}

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

// The doors' cookie clearers, so the test sees both called without a request leaving jsdom.
vi.mock('../utils/studioSignOut', () => ({
  signOutOfStudio: vi.fn(() => Promise.resolve(true)),
  signOutOfForge: vi.fn(() => Promise.resolve(true))
}))

beforeEach(() => {
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  supabase.auth.getSession.mockResolvedValue({ data: { session } })
  supabase.auth.getUser.mockResolvedValue({ data: { user: session.user }, error: null })
  supabase.auth.signOut.mockResolvedValue({ error: null })
  supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
})

/** Arrive at `address`, as the forge's 302 or a followed link does, and wait for the sign-in page. */
const arriveAt = async (address) => {
  window.history.pushState({}, '', address)
  const entries = window.history.length
  const view = render(<App />)
  expect(await screen.findByText('Sign In')).toBeInTheDocument()
  return { entries, view }
}

describe('the /sign-out route', () => {
  it('signs this browser out, clears both doors, and says the person signed out of the forge', async () => {
    await arriveAt('/sign-out?from=forge')

    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1)
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(signOutOfStudio).toHaveBeenCalledTimes(1)
    expect(signOutOfForge).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent(/^You signed out of the forge\.$/)
    // Not asked whether the stored session is alive: it is being ended, not restored.
    expect(supabase.auth.getUser).not.toHaveBeenCalled()
    expect(screen.queryByText('The shopfloor data platform')).toBeNull()
  })

  it('says only that the person signed out when the address names nowhere', async () => {
    await arriveAt('/sign-out')
    expect(screen.getByRole('status')).toHaveTextContent(/^You signed out\.$/)
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('ignores a `from` it does not know, and never shows the query', async () => {
    for (const from of ['grafana', '%3Cb%3Eforge%3C%2Fb%3E', 'Forge', 'forge%20', '']) {
      const { view } = await arriveAt(`/sign-out?from=${from}`)
      expect(screen.getByRole('status')).toHaveTextContent(/^You signed out\.$/)
      expect(document.body.textContent).not.toContain('grafana')
      expect(document.body.querySelector('b')).toBeNull()
      view.unmount()
    }
  })

  it('works with nobody signed in here: the doors are still cleared and the notice still shows', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
    await arriveAt('/sign-out?from=forge')

    expect(signOutOfStudio).toHaveBeenCalledTimes(1)
    expect(signOutOfForge).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('You signed out of the forge.')
  })

  it('replaces its own history entry, so Back or a reload does not sign out again', async () => {
    const { entries, view } = await arriveAt('/sign-out?from=forge')

    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('')
    expect(window.history.length).toBe(entries)

    // A reload: the address no longer names the route, so nothing is signed out a second time.
    view.unmount()
    vi.clearAllMocks()
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
    render(<App />)
    expect(await screen.findByText('Sign In')).toBeInTheDocument()
    expect(supabase.auth.signOut).not.toHaveBeenCalled()
    expect(signOutOfForge).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('opens on the stored session, with no notice, when the auth server did not end it', async () => {
    const unreachable = Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 })
    supabase.auth.signOut.mockResolvedValue({ error: unreachable })
    window.history.pushState({}, '', '/sign-out?from=forge')
    render(<App />)

    expect(await screen.findByText('The shopfloor data platform')).toBeInTheDocument()
    expect(screen.queryByText('You signed out of the forge.')).toBeNull()
    expect(window.location.pathname).not.toBe('/sign-out')
  })
})

describe("the account menu's Sign Out", () => {
  it('is the same sign-out: this browser only, and both doors cleared', async () => {
    render(<App />)
    expect(await screen.findByText('The shopfloor data platform')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /account menu/i }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /sign out/i }))

    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    await waitFor(() => expect(signOutOfForge).toHaveBeenCalledTimes(1))
    expect(signOutOfStudio).toHaveBeenCalledTimes(1)
  })
})

describe('signedOutNotice', () => {
  it('names the forge for from=forge and nothing else', () => {
    expect(signedOutNotice('?from=forge')).toBe('You signed out of the forge.')
    expect(signedOutNotice('?from=forge&from=x')).toBe('You signed out of the forge.')
    for (const search of ['', '?from=', '?from=toString', '?from=__proto__', '?from=constructor', '?other=forge']) {
      expect(signedOutNotice(search)).toBe('You signed out.')
    }
  })
})
