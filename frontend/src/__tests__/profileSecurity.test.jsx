/**
 * Profile > Security: the Sessions section. It lists every session the person holds, the one in
 * use first and marked, each by its browser or its service. End ends any other one after a dialog
 * that names it and says when it was last active, and Sign Out of All Other Sessions ends them all
 * after a dialog that says what that ends. Each act says what it did in a toast that links back
 * here, and reads the list again.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProfileTab } from '../components/tabs/ProfileTab'
import { endSessionQuestion } from '../components/tabs/SessionsSection'
import { tabLink } from '../test/tabBar'

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'https://api.site.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: { auth: { getSession: vi.fn(() => new Promise(() => {})) } },
}))

vi.mock('../api', () => ({
  api: { listMySessions: vi.fn(), endMySession: vi.fn(), signOutOtherSessions: vi.fn() },
}))

import { api } from '../api'

const NOW = new Date('2026-10-25T12:00:00Z')
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString()
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0'

const THIS = { id: 's-this', service_name: null, user_agent: CHROME, created_at: ago(3 * DAY), last_active_at: ago(HOUR), not_after: null, is_current: true }
const FIREFOX_SESSION = { id: 's-firefox', service_name: null, user_agent: FIREFOX, created_at: ago(5 * DAY), last_active_at: ago(2 * DAY), not_after: null, is_current: false }
const GRAFANA = { id: 's-grafana', service_name: 'Aber Grafana', user_agent: 'Node-oauth', created_at: ago(DAY), last_active_at: ago(5 * 60 * 1000), not_after: null, is_current: false }
const SCRIPT = { id: 's-script', service_name: null, user_agent: 'Python-urllib/3.14', created_at: ago(4 * DAY), last_active_at: ago(4 * DAY), not_after: null, is_current: false }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  window.history.replaceState({}, '', '/profile/security')
  api.listMySessions.mockReset().mockResolvedValue([FIREFOX_SESSION, SCRIPT, THIS, GRAFANA])
  api.endMySession.mockReset().mockResolvedValue(undefined)
  api.signOutOtherSessions.mockReset().mockResolvedValue(3)
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  window.history.replaceState({}, '', '/')
})

const renderSecurity = (props = {}) => {
  const showToast = vi.fn()
  render(<ProfileTab email="operator@site.test" userRole="Operator" theme="dark" sidebarMode="hover" showToast={showToast} {...props} />)
  return { showToast }
}

const rows = () => screen.getAllByRole('row').slice(1)
const where = (r) => r.querySelector('.session-where').textContent
const rowOf = (label) => rows().find(r => where(r) === label)
const loaded = () => screen.findByText('Chrome on Windows')

describe('the Security tab', () => {
  it('opens from its address, after Appearance', () => {
    renderSecurity()
    expect(tabLink('Security')).toHaveAttribute('aria-current', 'page')
  })

  it('heads its Sessions section, with an About tip and a line on what it cannot show', async () => {
    renderSecurity()
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About sessions' })).toBeInTheDocument()
    expect(document.querySelector('.profile-section-note')).toHaveTextContent(/shows no device\. No address is recorded\./)
    await loaded()
  })

  it('has a header row', async () => {
    renderSecurity()
    await loaded()
    expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Where', 'Started', 'Last active', 'Actions'])
  })
})

describe('the list', () => {
  it('puts this browser first and marks it, then the most recently active', async () => {
    renderSecurity()
    await loaded()
    expect(rows().map(where)).toEqual(['Chrome on Windows', 'Grafana', 'Firefox on Linux', 'A program (Python-urllib)'])
    expect(within(rows()[0]).getByText('This browser')).toBeInTheDocument()
    expect(screen.getAllByText('This browser')).toHaveLength(1)
  })

  it('names a service session by its service, marked as one', async () => {
    renderSecurity()
    await loaded()
    expect(within(rowOf('Grafana')).getByText('Service')).toBeInTheDocument()
    expect(within(rowOf('Firefox on Linux')).queryByText('Service')).toBeNull()
  })

  it('says how long ago each was last active', async () => {
    renderSecurity()
    await loaded()
    expect(within(rowOf('Chrome on Windows')).getByText('1h ago')).toBeInTheDocument()
    expect(within(rowOf('Grafana')).getByText('5m ago')).toBeInTheDocument()
    expect(within(rowOf('Firefox on Linux')).getByText('2d ago')).toBeInTheDocument()
  })

  it('offers End on every session but this one', async () => {
    renderSecurity()
    await loaded()
    expect(within(rowOf('Chrome on Windows')).queryByRole('button')).toBeNull()
    for (const label of ['Grafana', 'Firefox on Linux', 'A program (Python-urllib)']) {
      expect(within(rowOf(label)).getByRole('button', { name: `End the session: ${label}` })).toHaveTextContent('End')
    }
  })

  it("shows the database's sentence when the list cannot be read", async () => {
    api.listMySessions.mockRejectedValue(new Error('insufficient privileges to list sessions: sign in as a person with a role'))
    renderSecurity()
    expect(await screen.findByText(/sign in as a person with a role/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('asks nothing for a machine identity, which has no sessions', () => {
    renderSecurity({ email: null })
    expect(screen.getByText(/A machine identity signs in with a token/)).toBeInTheDocument()
    expect(api.listMySessions).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Sign Out of All Other Sessions/ })).toBeNull()
  })
})

describe('End', () => {
  const askToEnd = async (label) => {
    fireEvent.click(within(rowOf(label)).getByRole('button', { name: `End the session: ${label}` }))
    return screen.findByRole('dialog', { name: 'End Session' })
  }

  it('asks first, naming the session as the list does and when it was last active', async () => {
    renderSecurity()
    await loaded()
    const dialog = await askToEnd('Firefox on Linux')
    expect(dialog).toHaveAccessibleDescription('End the session in Firefox on Linux, last active 2 days ago? That browser has to sign in again.')
    expect(within(dialog).getByRole('button', { name: 'End Session' })).toBeInTheDocument()
    expect(api.endMySession).not.toHaveBeenCalled()
  })

  it('starts on the dialog, not on the button that ends the session', async () => {
    renderSecurity()
    await loaded()
    const dialog = await askToEnd('Grafana')
    expect(document.activeElement).toBe(dialog)
  })

  it('ends nothing when cancelled', async () => {
    renderSecurity()
    await loaded()
    fireEvent.click(within(await askToEnd('Grafana')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.endMySession).not.toHaveBeenCalled()
    expect(rowOf('Grafana')).toBeDefined()
  })

  it('ends that session on End Session, says so with a link back here, and reads the list again', async () => {
    const { showToast } = renderSecurity()
    await loaded()
    api.listMySessions.mockResolvedValue([THIS, GRAFANA, SCRIPT])
    fireEvent.click(within(await askToEnd('Firefox on Linux')).getByRole('button', { name: 'End Session' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Session ended: Firefox on Linux.', 'success', { to: '/profile/security' }))
    expect(api.endMySession).toHaveBeenCalledWith('s-firefox')
    await waitFor(() => expect(rowOf('Firefox on Linux')).toBeUndefined())
    expect(api.listMySessions).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("shows the database's refusal, and reads the list again", async () => {
    api.endMySession.mockRejectedValue(new Error('session s-grafana not found'))
    const { showToast } = renderSecurity()
    await loaded()
    fireEvent.click(within(await askToEnd('Grafana')).getByRole('button', { name: 'End Session' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('session s-grafana not found', 'error'))
    await waitFor(() => expect(api.listMySessions).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe("End's question", () => {
  const now = NOW.getTime()

  it('says a browser has to sign in again', () => {
    expect(endSessionQuestion({ ...FIREFOX_SESSION, last_active_at: ago(5 * 60 * 1000) }, now))
      .toBe('End the session in Firefox on Linux, last active 5 minutes ago? That browser has to sign in again.')
  })

  it('says a program has to sign in again', () => {
    expect(endSessionQuestion(SCRIPT, now))
      .toBe('End the session of a program (Python-urllib), last active 4 days ago? That program has to sign in again.')
  })

  it('says a service has to sign the person in again', () => {
    expect(endSessionQuestion({ ...GRAFANA, last_active_at: ago(HOUR) }, now))
      .toBe('End the session in Grafana, last active 1 hour ago? Grafana has to sign you in again.')
  })

  it('names a browser it does not know, and a session with no user agent', () => {
    expect(endSessionQuestion({ ...FIREFOX_SESSION, user_agent: 'Mozilla/5.0 (X11; Linux x86_64) NewBrowser/1.0' }, now))
      .toBe('End the session in a browser on Linux, last active 2 days ago? That browser has to sign in again.')
    expect(endSessionQuestion({ ...FIREFOX_SESSION, user_agent: null }, now))
      .toBe('End the session with no browser recorded, last active 2 days ago? Whatever used it has to sign in again.')
  })

  it('says just now, a date past 30 days, and nothing when the time is missing', () => {
    expect(endSessionQuestion({ ...FIREFOX_SESSION, last_active_at: ago(20 * 1000) }, now)).toMatch(/, last active just now?/)
    expect(endSessionQuestion({ ...FIREFOX_SESSION, last_active_at: ago(40 * DAY) }, now)).toMatch(/, last active on 15 Sept 2026?/)
    expect(endSessionQuestion({ ...FIREFOX_SESSION, last_active_at: null }, now))
      .toBe('End the session in Firefox on Linux? That browser has to sign in again.')
  })
})

describe('Sign Out of All Other Sessions', () => {
  const button = () => screen.getByRole('button', { name: /Sign Out of All Other Sessions/ })

  it('says what it ends before it ends anything', async () => {
    renderSecurity()
    await loaded()
    fireEvent.click(button())
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/your other browsers and programs, and your Grafana, Node-RED, Studio and forge sign-ins/)
    expect(dialog).toHaveTextContent(/This browser stays signed in to the dashboard\./)
    expect(api.signOutOtherSessions).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.signOutOtherSessions).not.toHaveBeenCalled()
  })

  it('names its button for the act, and starts on the dialog, not on that button', async () => {
    renderSecurity()
    await loaded()
    fireEvent.click(button())
    const dialog = await screen.findByRole('dialog', { name: 'Sign Out of All Other Sessions' })
    expect(within(dialog).getByRole('button', { name: 'Sign Out of All Other Sessions' })).toBeInTheDocument()
    expect(document.activeElement).toBe(dialog)
  })

  it('ends the others, keeps this browser, says how many and reads the list again', async () => {
    const { showToast } = renderSecurity()
    await loaded()
    api.listMySessions.mockResolvedValue([THIS])
    fireEvent.click(button())
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign Out of All Other Sessions' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Signed out of 3 other sessions.', 'success', { to: '/profile/security' }))
    expect(api.signOutOtherSessions).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(rows().map(where)).toEqual(['Chrome on Windows']))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says so when they had already ended', async () => {
    api.signOutOtherSessions.mockResolvedValue(0)
    const { showToast } = renderSecurity()
    await loaded()
    fireEvent.click(button())
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign Out of All Other Sessions' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('You had no other sessions to sign out of.', 'info', { to: '/profile/security' }))
  })

  it("shows the database's refusal, and reads the list again", async () => {
    const refusal = 'Your sign-in names no session of yours to keep, so none was ended. Sign in again.'
    api.signOutOtherSessions.mockRejectedValue(new Error(refusal))
    const { showToast } = renderSecurity()
    await loaded()
    fireEvent.click(button())
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign Out of All Other Sessions' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(refusal, 'error'))
    await waitFor(() => expect(api.listMySessions).toHaveBeenCalledTimes(2))
  })

  it('is disabled, saying why, when this is the only session', async () => {
    api.listMySessions.mockResolvedValue([THIS])
    renderSecurity()
    await loaded()
    expect(button()).toBeDisabled()
    expect(button()).toHaveAccessibleDescription('You have no other sessions.')
  })
})
