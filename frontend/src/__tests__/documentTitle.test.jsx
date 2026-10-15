import React from 'react'
import { render, renderHook, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import App from '../App'
import { documentTitle, APP_TITLE } from '../hooks/useDocumentTitle'
import { useAlertFavicon, FAVICON, ALERT_FAVICON } from '../hooks/useAlertFavicon'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The browser tab's title names the current page and leads with the alert pill's count, and its
 * icon carries a red dot while that count is above zero. Both must follow the pill, and must not
 * outlive the session that could read it.
 */

const mockSession = {
  user: { id: 'user-admin-123', email: 'admin@aber.local', app_metadata: { role: 'Administrator' } }
}

const firing = [
  { id: 1, fingerprint: 'fp-1', entity_type: 'device', sparkplug_id: 'dev1', alert_name: 'Thermal Excursion', severity: 'critical', summary: '', starts_at: '2026-09-23T09:00:00Z' },
  { id: 2, fingerprint: 'fp-2', entity_type: 'gateway', sparkplug_id: 'gw1', alert_name: 'Gateway Offline', severity: 'warning', summary: '', starts_at: '2026-09-23T09:01:00Z' }
]

let alertRows = []

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
    from: vi.fn()
  }
}))

import { supabase } from '../lib/supabaseClient'

describe('documentTitle', () => {
  it('names the page after the product', () => {
    expect(documentTitle('Gateways')).toBe('Aber | Gateways')
  })

  it('leads with the count only while something is firing', () => {
    expect(documentTitle('Gateways', 0)).toBe('Aber | Gateways')
    expect(documentTitle('Gateways', 3)).toBe('(3) Aber | Gateways')
  })

  it('falls back to the bare product name when there is no page', () => {
    expect(documentTitle(undefined)).toBe(APP_TITLE)
    expect(documentTitle(undefined, 2)).toBe('(2) Aber')
  })
})

describe('the tab title in the app', () => {
  let authCallback

  beforeEach(() => {
    vi.clearAllMocks()
    alertRows = []
    document.title = APP_TITLE
    window.history.pushState({}, '', '/')
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
    supabase.auth.getUser.mockResolvedValue({ data: { user: mockSession.user }, error: null })
    supabase.auth.signOut.mockResolvedValue({ error: null })
    supabase.auth.onAuthStateChange.mockImplementation((cb) => {
      authCallback = cb
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    })
    supabase.from.mockImplementation((table) => {
      const rows = table === 'platform_alerts_active' ? alertRows : []
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockImplementation(() => Promise.resolve({ data: rows, error: null }))
      }
    })
  })

  it('names the page the URL opened on', async () => {
    window.history.pushState({}, '', '/gateways')
    render(<App />)
    await waitFor(() => expect(document.title).toBe('Aber | Gateways'))
  })

  it('follows a click in the rail, using the rail label', async () => {
    render(<App />)
    await waitFor(() => expect(document.title).toBe('Aber | Site Map'))
    fireEvent.click(screen.getByRole('link', { name: /^Devices$/ }))
    await waitFor(() => expect(document.title).toBe('Aber | Devices'))
  })

  it('carries the same count as the alert pill', async () => {
    alertRows = firing
    render(<App />)
    await waitFor(() => expect(document.title).toBe('(2) Aber | Site Map'))
    expect(screen.getByRole('button', { name: '2 firing alerts' })).toBeInTheDocument()
  })

  it('drops the page and the count on sign-out', async () => {
    alertRows = firing
    render(<App />)
    await waitFor(() => expect(document.title).toBe('(2) Aber | Site Map'))
    act(() => authCallback('SIGNED_OUT', null))
    await waitFor(() => expect(document.title).toBe('Aber | Sign in'))
  })

  it('names the sign-in screen when there is no session', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
    render(<App />)
    await waitFor(() => expect(document.title).toBe('Aber | Sign in'))
    fireEvent.click(screen.getByRole('button', { name: /forgot your password/i }))
    expect(document.title).toBe('Aber | Reset password')
  })
})

describe('the tab icon', () => {
  let authCallback
  let link

  // index.html's own icon link, which the hook swaps rather than adding one.
  beforeEach(() => {
    link = document.createElement('link')
    link.setAttribute('rel', 'icon')
    link.setAttribute('type', 'image/svg+xml')
    link.setAttribute('href', FAVICON)
    document.head.appendChild(link)
  })

  afterEach(() => link.remove())

  it('follows the count: plain at none, the red dot while any fire, plain again at none', () => {
    const { rerender, unmount } = renderHook(({ count }) => useAlertFavicon(count), { initialProps: { count: 0 } })
    expect(link.getAttribute('href')).toBe(FAVICON)
    rerender({ count: 3 })
    expect(link.getAttribute('href')).toBe(ALERT_FAVICON)
    rerender({ count: 1 })
    expect(link.getAttribute('href')).toBe(ALERT_FAVICON)
    rerender({ count: 0 })
    expect(link.getAttribute('href')).toBe(FAVICON)
    rerender({ count: 2 })
    unmount()
    expect(link.getAttribute('href')).toBe(FAVICON)
  })

  it('both icons are files the dashboard serves, the alert one with the danger red', () => {
    const publicDir = path.resolve(__dirname, '../../public')
    expect(fs.existsSync(path.join(publicDir, FAVICON))).toBe(true)
    const alertIcon = fs.readFileSync(path.join(publicDir, ALERT_FAVICON), 'utf8')
    // The light theme's --danger: 3.6:1 or more on light tab strips, and the white ring around it
    // carries it on dark ones.
    const lightTheme = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
      .match(/\[data-theme="light"\]\s*\{([^}]*)\}/)[1]
    const danger = lightTheme.match(/--danger:\s*(#[0-9a-f]{6})\b/i)[1]
    expect(alertIcon).toContain(`fill="${danger}"`)
    expect(fs.readFileSync(path.resolve(publicDir, '../index.html'), 'utf8'))
      .toContain(`<link rel="icon" type="image/svg+xml" href="${FAVICON}" />`)
  })

  describe('in the app', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      alertRows = []
      window.history.pushState({}, '', '/')
      supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
      supabase.auth.getUser.mockResolvedValue({ data: { user: mockSession.user }, error: null })
      supabase.auth.signOut.mockResolvedValue({ error: null })
      supabase.auth.onAuthStateChange.mockImplementation((cb) => {
        authCallback = cb
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      })
      supabase.from.mockImplementation((table) => {
        const rows = table === 'platform_alerts_active' ? alertRows : []
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockImplementation(() => Promise.resolve({ data: rows, error: null }))
        }
      })
    })

    it('stays plain while nothing is firing', async () => {
      render(<App />)
      await waitFor(() => expect(document.title).toBe('Aber | Site Map'))
      expect(link.getAttribute('href')).toBe(FAVICON)
    })

    it('carries the dot from the same list as the title and the pill', async () => {
      alertRows = firing
      render(<App />)
      await waitFor(() => expect(document.title).toBe('(2) Aber | Site Map'))
      expect(link.getAttribute('href')).toBe(ALERT_FAVICON)
    })

    it('goes back to the plain icon on sign-out', async () => {
      alertRows = firing
      render(<App />)
      await waitFor(() => expect(link.getAttribute('href')).toBe(ALERT_FAVICON))
      act(() => authCallback('SIGNED_OUT', null))
      await waitFor(() => expect(document.title).toBe('Aber | Sign in'))
      expect(link.getAttribute('href')).toBe(FAVICON)
    })
  })
})
