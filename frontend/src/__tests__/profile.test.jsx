/**
 * The Profile page: the person's own account and appearance, laid out as the Settings page's table
 * so the two pages read alike, and saying it applies to the person on any browser. Each Appearance
 * field writes through the callbacks App wires to useUserSettings, the same ones the account menu's
 * toggle and the rail's foot control use.
 */
import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProfileTab, PROFILE_SECTIONS } from '../components/tabs/ProfileTab'
import { MIN_PASSWORD_LENGTH } from '../utils/passwords'
import { tabLink, tabLinks } from '../test/tabBar'

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

  it('has two tabs, Account then Appearance, with the ids the routing names', () => {
    renderProfile()
    expect(tabLinks().map(t => t.textContent)).toEqual(['Account', 'Appearance'])
    expect(PROFILE_SECTIONS.map(s => s.id)).toEqual(['account', 'appearance'])
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
    expect(button).toHaveAttribute('title', 'Machine identities have no password to change.')
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
