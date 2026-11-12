/**
 * The Profile page: the person's own account and appearance, laid out as the Settings page's table
 * so the two pages read alike, and saying it applies to the person on any browser. Each Appearance
 * field writes through the callbacks App wires to useUserSettings, the same ones the account menu's
 * toggle and the rail's foot control use. Account also copies the person's access token and the
 * publishable key, for calling the API as themselves.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProfileTab, PROFILE_SECTIONS } from '../components/tabs/ProfileTab'
import { SUPABASE_GATEWAY_KEY as PUBLISHABLE_KEY } from '../config'
import { MIN_PASSWORD_LENGTH } from '../utils/passwords'
import { PERSON_ROLES } from '../utils/people'
import { tabLink, tabLinks } from '../test/tabBar'

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'https://api.site.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: { auth: { getSession: vi.fn() } },
}))

import { supabase } from '../lib/supabaseClient'

// Unanswered unless a test answers it, so a test about another row gets no late update from the
// Access token row's read.
beforeEach(() => {
  supabase.auth.getSession.mockReset()
  supabase.auth.getSession.mockReturnValue(new Promise(() => {}))
})

const renderProfile = (props = {}) => {
  const handlers = {
    onChangePassword: vi.fn(),
    onChangeTheme: vi.fn(),
    onChangeSidebarMode: vi.fn(),
  }
  render(
    <ProfileTab
      email="operator@site.test"
      userRole="Shopfloor_Manager"
      theme="dark"
      sidebarMode="hover"
      settingsSource="account"
      {...handlers}
      {...props}
    />
  )
  return handlers
}

/** The page again with other props, as App renders it once a save has landed. */
const renderProfileWith = (props = {}) => {
  const handlers = { onChangePassword: vi.fn(), onChangeTheme: vi.fn(), onChangeSidebarMode: vi.fn() }
  const element = (more) => (
    <ProfileTab email="operator@site.test" userRole="Shopfloor_Manager" theme="dark" sidebarMode="hover"
      settingsSource="account" {...handlers} {...props} {...more} />
  )
  const view = render(element())
  return { ...handlers, rerender: (more) => view.rerender(element(more)) }
}

const tab = (name) => tabLink(name)
const row = (label) => screen.getByText(label, { selector: '.setting-label' }).closest('tr')
const headers = () => screen.getAllByRole('columnheader').map(h => h.textContent)

describe('the page', () => {
  it('says what it applies to', () => {
    renderProfile()
    expect(screen.getByRole('heading', { name: /^Profile/ })).toBeInTheDocument()
    expect(document.querySelector('.card-heading-note')).toHaveTextContent('Applies to you, on any browser.')
  })

  it('has six tabs, Account, Appearance, Notifications, Sessions, MFA then Allowed Apps, with the ids the routing names', () => {
    renderProfile()
    expect(tabLinks().map(t => t.textContent)).toEqual(['Account', 'Appearance', 'Notifications', 'Sessions', 'MFA', 'Allowed Apps'])
    expect(PROFILE_SECTIONS.map(s => s.id)).toEqual(['account', 'appearance', 'notifications', 'sessions', 'mfa', 'allowed-apps'])
  })

  /* The user's rule: every tab has the header row, even a tab of one or two rows. */
  it("gives each tab the Settings table's four columns and its header row", () => {
    renderProfile()
    expect(headers()).toEqual(['Setting', 'Description', 'Value', 'Actions'])
    fireEvent.click(tab('Appearance'))
    expect(headers()).toEqual(['Setting', 'Description', 'Value', 'Actions'])
    fireEvent.click(tab('Notifications'))
    expect(headers()).toEqual(['Setting', 'Description', 'Value', 'Actions'])
  })

  it('keeps its tab in the path, so /profile/appearance opens Appearance', () => {
    window.history.replaceState({}, '', '/profile/appearance')
    renderProfile()
    expect(tab('Appearance')).toHaveAttribute('aria-current', 'page')
    fireEvent.click(tab('Account'))
    expect(window.location.pathname).toBe('/profile')
  })
})

describe('Account', () => {
  it('shows the address and the role, and who can change the role', () => {
    renderProfile()
    expect(within(row('Email address')).getByText('operator@site.test')).toBeInTheDocument()
    expect(within(row('Email address')).getByText('Only an Administrator can change this')).toBeInTheDocument()
    expect(within(row('Role')).getByText('Shopfloor Manager')).toBeInTheDocument()
    expect(within(row('Role')).getByText('Only an Administrator can change this')).toBeInTheDocument()
  })

  it('tells an Administrator that another Administrator changes their address and role, on People', () => {
    renderProfile({ userRole: 'Administrator' })
    for (const label of ['Email address', 'Role']) {
      expect(within(row(label)).getByText('Another Administrator can change this, on Access Control › People')).toBeInTheDocument()
      expect(within(row(label)).queryByText('Only an Administrator can change this')).toBeNull()
    }
  })

  it('says nothing about the role while it is still being read', () => {
    renderProfile({ userRole: undefined })
    expect(within(row('Role')).getByText('Loading…')).toBeInTheDocument()
  })

  it('opens Change Password from the Actions cell of the Password row', () => {
    const { onChangePassword } = renderProfile()
    expect(within(row('Password')).getByText(new RegExp(`${MIN_PASSWORD_LENGTH} characters`))).toBeInTheDocument()
    fireEvent.click(within(row('Password')).getByRole('button', { name: /change password/i }))
    expect(onChangePassword).toHaveBeenCalled()
  })

  it('disables it for a machine identity, saying why', () => {
    renderProfile({ email: null, passwordBlocked: 'Machine identities have no password to change.' })
    const button = within(row('Password')).getByRole('button', { name: /change password/i })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription('Machine identities have no password to change.')
  })
})

/*
 * The person's own access token, for Swagger UI, i3X Explorer or curl: copied, never shown, and
 * never the refresh token. Only Date is faked, so the times read the same on any machine while
 * the promises and timers stay real.
 */
describe('Access token and Publishable key', () => {
  const base64url = (value) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  /** A session as supabase-js holds it: a signed JWT whose `exp` is `expires`, and a refresh token. */
  const sessionUntil = (expires, n = 1) => ({
    access_token: [
      base64url({ alg: 'HS256', typ: 'JWT' }),
      base64url({ sub: 'user-1', role: 'authenticated', email: 'operator@site.test', exp: Math.floor(expires.getTime() / 1000) }),
      `signature-${n}`,
    ].join('.'),
    refresh_token: `refresh-token-${n}`,
    user: { id: 'user-1', email: 'operator@site.test' },
  })
  const answer = (session) => ({ data: { session }, error: null })

  let writeText
  let original
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 24, 13, 40))
    writeText = vi.fn().mockResolvedValue(undefined)
    original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
  })
  afterEach(() => {
    vi.useRealTimers()
    if (original) Object.defineProperty(navigator, 'clipboard', original)
    else delete navigator.clipboard
  })

  const tokenRow = () => row('Access token')
  const keyRow = () => row('Publishable key')

  it("shows when the session's token stops working, and never the token itself", async () => {
    const session = sessionUntil(new Date(2026, 9, 24, 14, 32))
    supabase.auth.getSession.mockResolvedValue(answer(session))
    renderProfile()

    expect(await within(tokenRow()).findByText('Valid until 14:32')).toBeInTheDocument()
    expect(tokenRow().querySelector('.setting-description')).toHaveTextContent(/acts as you, with your role, until it expires or you sign out/)
    expect(document.body.innerHTML).not.toContain(session.access_token)
    expect(document.body.innerHTML).not.toContain(session.refresh_token)
  })

  it('adds the date when the token stops working on another day', async () => {
    vi.setSystemTime(new Date(2026, 9, 24, 23, 30))
    supabase.auth.getSession.mockResolvedValue(answer(sessionUntil(new Date(2026, 9, 25, 0, 15))))
    renderProfile()
    expect(await within(tokenRow()).findByText('Valid until 25 Oct 2026, 00:15')).toBeInTheDocument()
  })

  it('copies the access token, never the refresh token, and still does not show it', async () => {
    const session = sessionUntil(new Date(2026, 9, 24, 14, 32))
    supabase.auth.getSession.mockResolvedValue(answer(session))
    renderProfile()
    await within(tokenRow()).findByText('Valid until 14:32')

    fireEvent.click(within(tokenRow()).getByRole('button', { name: 'Copy Token' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(session.access_token))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).not.toHaveBeenCalledWith(session.refresh_token)
    expect(await within(tokenRow()).findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain(session.access_token)
    expect(document.body.innerHTML).not.toContain(session.refresh_token)
  })

  it('reads the session again on Copy, so a renewed session copies the new token and shows its time', async () => {
    const first = sessionUntil(new Date(2026, 9, 24, 14, 32), 1)
    const renewed = sessionUntil(new Date(2026, 9, 24, 15, 35), 2)
    supabase.auth.getSession.mockResolvedValueOnce(answer(first)).mockResolvedValue(answer(renewed))
    renderProfile()
    await within(tokenRow()).findByText('Valid until 14:32')

    fireEvent.click(within(tokenRow()).getByRole('button', { name: 'Copy Token' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(renewed.access_token))
    expect(writeText).not.toHaveBeenCalledWith(first.access_token)
    expect(await within(tokenRow()).findByText('Valid until 15:35')).toBeInTheDocument()
    expect(supabase.auth.getSession).toHaveBeenCalledTimes(2)
  })

  it('says so, and copies nothing, when there is no session', async () => {
    supabase.auth.getSession.mockResolvedValue(answer(null))
    renderProfile()
    expect(await within(tokenRow()).findByText('—')).toBeInTheDocument()

    fireEvent.click(within(tokenRow()).getByRole('button', { name: 'Copy Token' }))

    expect(await within(tokenRow()).findByRole('status')).toHaveTextContent('There is no session to copy. Sign in again.')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('copies the publishable key, saying where it goes and that it is public', async () => {
    renderProfile()
    expect(within(keyRow()).getByText(PUBLISHABLE_KEY)).toBeInTheDocument()
    expect(keyRow().querySelector('.setting-description')).toHaveTextContent(/Authorize asks for it as apiKeyAuth/)
    expect(keyRow().querySelector('.setting-description')).toHaveTextContent(/public by design/)

    fireEvent.click(within(keyRow()).getByRole('button', { name: 'Copy Key' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PUBLISHABLE_KEY))
    expect(await within(keyRow()).findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('shows both rows to every person role, Auditor included', () => {
    expect(PERSON_ROLES.map(r => r.name)).toContain('Auditor')
    for (const { name } of PERSON_ROLES) {
      renderProfile({ userRole: name })
      expect(within(tokenRow()).getByRole('button', { name: 'Copy Token' })).toBeInTheDocument()
      expect(within(keyRow()).getByRole('button', { name: 'Copy Key' })).toBeInTheDocument()
      cleanup()
    }
  })
})

describe('Appearance', () => {
  it('shows the current theme and layout, with nothing to save until one changes', () => {
    renderProfile({ theme: 'dark', sidebarMode: 'collapsed' })
    fireEvent.click(tab('Appearance'))

    expect(screen.getByLabelText('Theme')).toHaveValue('dark')
    expect(screen.getByLabelText('Sidebar layout')).toHaveValue('collapsed')
    expect(within(row('Sidebar layout')).getByText(/Icons only/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Discard/ })).toBeNull()
  })

  it('applies a change only on Save, row by row, as Settings does', () => {
    const { onChangeTheme, onChangeSidebarMode } = renderProfile({ theme: 'dark', sidebarMode: 'collapsed' })
    fireEvent.click(tab('Appearance'))

    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } })
    expect(onChangeTheme).not.toHaveBeenCalled()
    // Only the changed row offers Save and Discard.
    expect(within(row('Sidebar layout')).queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.click(within(row('Theme')).getByRole('button', { name: 'Save' }))
    expect(onChangeTheme).toHaveBeenCalledWith('light')
    expect(within(row('Theme')).queryByRole('button', { name: 'Save' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Sidebar layout'), { target: { value: 'expanded' } })
    // The detail line follows the choice before it is saved.
    expect(within(row('Sidebar layout')).getByText(/Labels always shown/)).toBeInTheDocument()
    fireEvent.click(within(row('Sidebar layout')).getByRole('button', { name: 'Save' }))
    expect(onChangeSidebarMode).toHaveBeenCalledWith('expanded')
  })

  it('puts the saved value back on Discard, and saves nothing', () => {
    const { onChangeTheme } = renderProfile({ theme: 'dark' })
    fireEvent.click(tab('Appearance'))

    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } })
    fireEvent.click(within(row('Theme')).getByRole('button', { name: /Discard/ }))
    expect(screen.getByLabelText('Theme')).toHaveValue('dark')
    expect(onChangeTheme).not.toHaveBeenCalled()
    expect(within(row('Theme')).queryByRole('button', { name: /Discard/ })).toBeNull()
  })

  it('offers nothing to save when the choice goes back to the saved value', () => {
    renderProfile({ theme: 'dark' })
    fireEvent.click(tab('Appearance'))
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } })
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'dark' } })
    expect(within(row('Theme')).queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('offers the three sidebar layouts and the two themes, nothing else', () => {
    renderProfile()
    fireEvent.click(tab('Appearance'))
    const options = (label) => [...screen.getByLabelText(label).querySelectorAll('option')].map(o => o.value)
    expect(options('Theme')).toEqual(['dark', 'light'])
    expect(options('Sidebar layout')).toEqual(['hover', 'expanded', 'collapsed'])
  })

  it('says when the account could not be reached and the choices are this browser\'s', () => {
    renderProfile({ settingsSource: 'browser' })
    fireEvent.click(tab('Appearance'))
    expect(screen.getByRole('status')).toHaveTextContent(/could not be read from your account/)
    expect(screen.getByRole('status')).toHaveTextContent(/applies in this browser only/)
  })

  it('says nothing of the kind while the row is in step', () => {
    renderProfile({ settingsSource: 'account' })
    fireEvent.click(tab('Appearance'))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

/* WCAG 2.2 SC 2.1.4: a way to turn the one-character shortcuts off, saved with the account. */
describe('Single-key shortcuts', () => {
  const shortcutsSwitch = () => screen.getByRole('switch', { name: 'Single-key shortcuts' })

  it('is a switch, on unless the person turned it off, naming the keys it covers', () => {
    renderProfile({ onChangeSingleKeyShortcuts: vi.fn() })
    fireEvent.click(tab('Appearance'))
    expect(shortcutsSwitch()).toBeChecked()
    expect(within(row('Single-key shortcuts')).getByText('On')).toBeInTheDocument()
    expect([...row('Single-key shortcuts').querySelectorAll('.setting-description kbd')].map(k => k.textContent)).toEqual(['?', '/', '[', ']'])
    expect(row('Single-key shortcuts').querySelector('.setting-description')).toHaveTextContent(/Ctrl K and the arrow keys stay/)
    expect(within(row('Single-key shortcuts')).queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('shows the saved choice when it is off', () => {
    renderProfile({ singleKeyShortcuts: false, onChangeSingleKeyShortcuts: vi.fn() })
    fireEvent.click(tab('Appearance'))
    expect(shortcutsSwitch()).not.toBeChecked()
    expect(within(row('Single-key shortcuts')).getByText('Off')).toBeInTheDocument()
  })

  it('applies a change only on Save, as the other rows do', () => {
    const onChangeSingleKeyShortcuts = vi.fn()
    renderProfile({ singleKeyShortcuts: true, onChangeSingleKeyShortcuts })
    fireEvent.click(tab('Appearance'))

    fireEvent.click(shortcutsSwitch())
    expect(shortcutsSwitch()).not.toBeChecked()
    expect(onChangeSingleKeyShortcuts).not.toHaveBeenCalled()
    expect(within(row('Theme')).queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.click(within(row('Single-key shortcuts')).getByRole('button', { name: 'Save' }))
    expect(onChangeSingleKeyShortcuts).toHaveBeenCalledWith(false)
    expect(within(row('Single-key shortcuts')).queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('puts the saved value back on Discard, and saves nothing', () => {
    const onChangeSingleKeyShortcuts = vi.fn()
    renderProfile({ singleKeyShortcuts: false, onChangeSingleKeyShortcuts })
    fireEvent.click(tab('Appearance'))

    fireEvent.click(shortcutsSwitch())
    expect(shortcutsSwitch()).toBeChecked()
    fireEvent.click(within(row('Single-key shortcuts')).getByRole('button', { name: /Discard/ }))
    expect(shortcutsSwitch()).not.toBeChecked()
    expect(onChangeSingleKeyShortcuts).not.toHaveBeenCalled()
  })

  it('offers nothing to save when the switch goes back to the saved value', () => {
    renderProfile({ onChangeSingleKeyShortcuts: vi.fn() })
    fireEvent.click(tab('Appearance'))
    fireEvent.click(shortcutsSwitch())
    fireEvent.click(shortcutsSwitch())
    expect(within(row('Single-key shortcuts')).queryByRole('button', { name: 'Save' })).toBeNull()
  })
})

/**
 * Desktop notifications: one switch, off until the person turns it on. Turning it on asks the
 * browser for permission, in the Save click; a browser that refused, that has no such thing, or
 * that serves the page over plain HTTP is told so in words. `Notification` is a stand-in here.
 */
describe('Notifications', () => {
  const desktopSwitch = () => screen.getByRole('switch', { name: 'Desktop notifications' })
  const detail = () => document.getElementById('profile-desktop-detail')
  let requestPermission

  /** A browser's Notification: `permission` is what it holds, and requestPermission answers. */
  const browser = (permission, answer = permission) => {
    const Fake = function Notification() {}
    Fake.permission = permission
    requestPermission = vi.fn((done) => {
      Fake.permission = answer
      done?.(answer)
      return Promise.resolve(answer)
    })
    Fake.requestPermission = requestPermission
    vi.stubGlobal('Notification', Fake)
  }
  const secure = (value) => Object.defineProperty(window, 'isSecureContext', { value, configurable: true })
  const open = () => fireEvent.click(tab('Notifications'))

  beforeEach(() => secure(true))
  afterEach(() => {
    vi.unstubAllGlobals()
    delete window.isSecureContext
  })

  it('is a switch, off unless the person turned it on, and says what it does', () => {
    browser('default')
    renderProfile({ onChangeDesktopNotifications: vi.fn() })
    open()
    expect(desktopSwitch()).not.toBeChecked()
    expect(desktopSwitch()).toBeEnabled()
    expect(within(row('Desktop notifications')).getByText('Off')).toBeInTheDocument()
    expect(row('Desktop notifications').querySelector('.setting-description')).toHaveTextContent(/when an alert starts firing/)
    expect(within(row('Desktop notifications')).queryByRole('button')).toBeNull()
    expect(detail()).toBeNull()
  })

  it('asks the browser when Save turns it on, and saves the choice once it has answered', async () => {
    browser('default', 'granted')
    const onChangeDesktopNotifications = vi.fn()
    renderProfile({ onChangeDesktopNotifications })
    open()

    fireEvent.click(desktopSwitch())
    expect(desktopSwitch()).toBeChecked()
    expect(detail()).toHaveTextContent('Select Save, and the browser will ask')
    // Nothing is asked or saved until Save.
    expect(requestPermission).not.toHaveBeenCalled()
    expect(onChangeDesktopNotifications).not.toHaveBeenCalled()

    fireEvent.click(within(row('Desktop notifications')).getByRole('button', { name: 'Save' }))
    // Asked inside the click, before anything is awaited.
    expect(requestPermission).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onChangeDesktopNotifications).toHaveBeenCalledWith(true))
    await waitFor(() => expect(within(row('Desktop notifications')).queryByRole('button', { name: 'Save' })).toBeNull())
  })

  it('does not ask a browser that has already allowed it', async () => {
    browser('granted')
    const onChangeDesktopNotifications = vi.fn()
    renderProfile({ onChangeDesktopNotifications })
    open()
    fireEvent.click(desktopSwitch())
    fireEvent.click(within(row('Desktop notifications')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onChangeDesktopNotifications).toHaveBeenCalledWith(true))
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('keeps the choice on when the browser refuses, and says so with how to allow it again', async () => {
    browser('default', 'denied')
    const onChangeDesktopNotifications = vi.fn()
    // The parent saves what it is given, as App does.
    const { rerender } = renderProfileWith({ onChangeDesktopNotifications })
    open()
    fireEvent.click(desktopSwitch())
    fireEvent.click(within(row('Desktop notifications')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onChangeDesktopNotifications).toHaveBeenCalledWith(true))
    rerender({ desktopNotifications: true })
    await waitFor(() => expect(detail()).toHaveTextContent('This browser has blocked notifications from this site'))
    expect(detail()).toHaveTextContent('site settings')
    expect(detail()).toHaveTextContent('set Notifications to Allow')
    expect(desktopSwitch()).toHaveAccessibleDescription(/blocked notifications/)
  })

  it('says a saved choice is blocked here when the browser had refused before', () => {
    browser('denied')
    renderProfile({ desktopNotifications: true, onChangeDesktopNotifications: vi.fn() })
    open()
    expect(desktopSwitch()).toBeChecked()
    expect(detail()).toHaveTextContent('has blocked notifications')
  })

  it('offers Allow Notifications where the choice is on and the browser has not been asked', async () => {
    browser('default', 'granted')
    renderProfile({ desktopNotifications: true, onChangeDesktopNotifications: vi.fn() })
    open()
    expect(detail()).toHaveTextContent('has not been asked yet')
    fireEvent.click(within(row('Desktop notifications')).getByRole('button', { name: 'Allow Notifications' }))
    expect(requestPermission).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(detail()).toHaveTextContent('Allowed in this browser'))
    expect(within(row('Desktop notifications')).queryByRole('button', { name: 'Allow Notifications' })).toBeNull()
  })

  it('shows the saved choice as on, saves off on Save, and never asks to turn it off', async () => {
    browser('granted')
    const onChangeDesktopNotifications = vi.fn()
    renderProfile({ desktopNotifications: true, onChangeDesktopNotifications })
    open()
    expect(desktopSwitch()).toBeChecked()
    expect(within(row('Desktop notifications')).getByText('On')).toBeInTheDocument()
    fireEvent.click(desktopSwitch())
    expect(detail()).toBeNull()
    fireEvent.click(within(row('Desktop notifications')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onChangeDesktopNotifications).toHaveBeenCalledWith(false))
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('puts the saved value back on Discard, and saves nothing', () => {
    browser('default')
    const onChangeDesktopNotifications = vi.fn()
    renderProfile({ onChangeDesktopNotifications })
    open()
    fireEvent.click(desktopSwitch())
    fireEvent.click(within(row('Desktop notifications')).getByRole('button', { name: /Discard/ }))
    expect(desktopSwitch()).not.toBeChecked()
    expect(onChangeDesktopNotifications).not.toHaveBeenCalled()
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('is disabled, with its reason, over plain HTTP', () => {
    // The browser may still define Notification there; a secure context is checked first.
    browser('default')
    secure(false)
    renderProfile({ onChangeDesktopNotifications: vi.fn() })
    open()
    expect(desktopSwitch()).toBeDisabled()
    expect(detail()).toHaveTextContent('Browsers allow notifications only over HTTPS or on localhost')
    expect(desktopSwitch()).toHaveAccessibleDescription(/only over HTTPS or on localhost/)
  })

  it('is disabled, with its own reason, in a browser with no Notification API', () => {
    vi.stubGlobal('Notification', undefined)
    renderProfile({ onChangeDesktopNotifications: vi.fn() })
    open()
    expect(desktopSwitch()).toBeDisabled()
    expect(detail()).toHaveTextContent('It does not support desktop notifications')
    expect(detail()).not.toHaveTextContent('HTTPS')
  })

  it('still lets a choice made on another PC be turned off from a browser that cannot raise one', async () => {
    secure(false)
    const onChangeDesktopNotifications = vi.fn()
    renderProfile({ desktopNotifications: true, onChangeDesktopNotifications })
    open()
    expect(desktopSwitch()).toBeChecked()
    expect(desktopSwitch()).toBeEnabled()
    expect(detail()).toHaveTextContent('only over HTTPS or on localhost')
    expect(within(row('Desktop notifications')).queryByRole('button', { name: 'Allow Notifications' })).toBeNull()
    fireEvent.click(desktopSwitch())
    fireEvent.click(within(row('Desktop notifications')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onChangeDesktopNotifications).toHaveBeenCalledWith(false))
  })

  it('says the choices are this browser\'s when the account could not be read', () => {
    browser('default')
    renderProfile({ settingsSource: 'browser', onChangeDesktopNotifications: vi.fn() })
    open()
    expect(document.querySelector('.profile-source')).toHaveTextContent('could not be read from your account')
  })
})

/* The person's own display name (0203): set and cleared here, with Save and Discard as on the other rows. */
describe('Display name', () => {
  const nameBox = () => screen.getByLabelText('Display name')

  it('sits on Account, showing the saved name, with nothing to save until it changes', () => {
    renderProfile({ displayName: 'Owain Operator', onSaveDisplayName: vi.fn() })
    expect(nameBox()).toHaveValue('Owain Operator')
    expect(within(row('Display name')).queryByRole('button', { name: 'Save' })).toBeNull()
    expect(row('Display name').querySelector('.setting-description')).toHaveTextContent(/email address beside it/)
  })

  it('is empty for a person with no name, and waits while it is read', () => {
    renderProfile({ displayName: null, onSaveDisplayName: vi.fn() })
    expect(nameBox()).toHaveValue('')
    expect(nameBox()).toBeEnabled()
    cleanup()
    renderProfile({ displayName: undefined, onSaveDisplayName: vi.fn() })
    expect(nameBox()).toBeDisabled()
  })

  it('saves the trimmed name on Save, and an empty one as no name', async () => {
    const onSaveDisplayName = vi.fn().mockResolvedValue('Owain ap Rhys')
    renderProfile({ displayName: 'Owain Operator', onSaveDisplayName })
    fireEvent.change(nameBox(), { target: { value: '  Owain ap Rhys ' } })
    expect(onSaveDisplayName).not.toHaveBeenCalled()
    fireEvent.click(within(row('Display name')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaveDisplayName).toHaveBeenCalledWith('Owain ap Rhys'))

    fireEvent.change(nameBox(), { target: { value: '   ' } })
    fireEvent.click(within(row('Display name')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaveDisplayName).toHaveBeenLastCalledWith(null))
  })

  // set_display_name() writes DISPLAY_NAME_CHANGED, so Save ends with a toast, worded as Change Name's on People.
  it('says what you are shown as once it is saved, linking to this tab', async () => {
    const showToast = vi.fn()
    const onSaveDisplayName = vi.fn().mockResolvedValueOnce('Owain ap Rhys').mockResolvedValueOnce(null)
    renderProfile({ displayName: 'Owain Operator', onSaveDisplayName, showToast })
    fireEvent.change(nameBox(), { target: { value: 'Owain ap Rhys' } })
    fireEvent.click(within(row('Display name')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('You are now shown as Owain ap Rhys', 'success', { to: '/profile/account' }))

    fireEvent.change(nameBox(), { target: { value: '' } })
    fireEvent.click(within(row('Display name')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(showToast).toHaveBeenLastCalledWith('You are now shown by email alone', 'success', { to: '/profile/account' }))
    expect(showToast).toHaveBeenCalledTimes(2)
  })

  it('puts the saved name back on Discard', () => {
    const onSaveDisplayName = vi.fn()
    renderProfile({ displayName: 'Owain Operator', onSaveDisplayName })
    fireEvent.change(nameBox(), { target: { value: 'Somebody Else' } })
    fireEvent.click(within(row('Display name')).getByRole('button', { name: /Discard/ }))
    expect(nameBox()).toHaveValue('Owain Operator')
    expect(onSaveDisplayName).not.toHaveBeenCalled()
  })

  it('refuses a name the database would refuse, saying why, before saving', () => {
    const onSaveDisplayName = vi.fn()
    renderProfile({ displayName: null, onSaveDisplayName })
    fireEvent.change(nameBox(), { target: { value: 'N'.repeat(81) } })
    expect(within(row('Display name')).getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(row('Display name')).toHaveTextContent('A display name is 80 characters at most.')
    expect(onSaveDisplayName).not.toHaveBeenCalled()
  })

  it("shows the database's sentence when a save is refused, and keeps the draft", async () => {
    const onSaveDisplayName = vi.fn().mockRejectedValue(new Error('A display name cannot contain a control character, such as a line break or a tab.'))
    const showToast = vi.fn()
    renderProfile({ displayName: null, onSaveDisplayName, showToast })
    fireEvent.change(nameBox(), { target: { value: 'Owain' } })
    fireEvent.click(within(row('Display name')).getByRole('button', { name: 'Save' }))
    expect(await within(row('Display name')).findByText(/cannot contain a control character/)).toBeInTheDocument()
    expect(nameBox()).toHaveValue('Owain')
    expect(showToast).not.toHaveBeenCalled()
  })

  it('is not offered to a machine identity', () => {
    renderProfile({ email: null, passwordBlocked: 'Machine identities have no password to change.' })
    expect(screen.queryByLabelText('Display name')).toBeNull()
    expect(row('Display name')).toHaveTextContent('a machine identity is named on the Access Control page')
  })
})
