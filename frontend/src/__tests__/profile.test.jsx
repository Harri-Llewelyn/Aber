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

const tab = (name) => tabLink(name)
const row = (label) => screen.getByText(label, { selector: '.setting-label' }).closest('tr')
const headers = () => screen.getAllByRole('columnheader').map(h => h.textContent)

describe('the page', () => {
  it('says what it applies to', () => {
    renderProfile()
    expect(screen.getByRole('heading', { name: /^Profile/ })).toBeInTheDocument()
    expect(document.querySelector('.card-heading-note')).toHaveTextContent('Applies to you, on any browser.')
  })

  it('has three tabs, Account, Appearance then Security, with the ids the routing names', () => {
    renderProfile()
    expect(tabLinks().map(t => t.textContent)).toEqual(['Account', 'Appearance', 'Security'])
    expect(PROFILE_SECTIONS.map(s => s.id)).toEqual(['account', 'appearance', 'security'])
  })

  /* The user's rule: every tab has the header row, even a tab of one or two rows. */
  it("gives each tab the Settings table's four columns and its header row", () => {
    renderProfile()
    expect(headers()).toEqual(['Setting', 'Description', 'Value', 'Actions'])
    fireEvent.click(tab('Appearance'))
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
    renderProfile({ displayName: null, onSaveDisplayName })
    fireEvent.change(nameBox(), { target: { value: 'Owain' } })
    fireEvent.click(within(row('Display name')).getByRole('button', { name: 'Save' }))
    expect(await within(row('Display name')).findByText(/cannot contain a control character/)).toBeInTheDocument()
    expect(nameBox()).toHaveValue('Owain')
  })

  it('is not offered to a machine identity', () => {
    renderProfile({ email: null, passwordBlocked: 'Machine identities have no password to change.' })
    expect(screen.queryByLabelText('Display name')).toBeNull()
    expect(row('Display name')).toHaveTextContent('a machine identity is named on the Access Control page')
  })
})
