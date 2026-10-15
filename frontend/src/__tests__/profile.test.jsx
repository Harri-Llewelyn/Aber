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

const tab = (name) => screen.getByRole('tab', { name })
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
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['Account', 'Appearance'])
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
    expect(tab('Appearance')).toHaveAttribute('aria-selected', 'true')
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
  it('shows the current theme and layout, and writes a change through at once', () => {
    const { onChangeTheme, onChangeSidebarMode } = renderProfile({ theme: 'dark', sidebarMode: 'collapsed' })
    fireEvent.click(tab('Appearance'))

    const theme = screen.getByLabelText('Theme')
    const sidebar = screen.getByLabelText('Sidebar layout')
    expect(theme).toHaveValue('dark')
    expect(sidebar).toHaveValue('collapsed')
    expect(within(row('Sidebar layout')).getByText(/Icons only/)).toBeInTheDocument()

    fireEvent.change(theme, { target: { value: 'light' } })
    expect(onChangeTheme).toHaveBeenCalledWith('light')
    fireEvent.change(sidebar, { target: { value: 'expanded' } })
    expect(onChangeSidebarMode).toHaveBeenCalledWith('expanded')
    // Applied as chosen: there is nothing to save.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
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
