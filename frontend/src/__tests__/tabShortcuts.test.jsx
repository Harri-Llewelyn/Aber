import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import App from '../App'
import { ShortcutsModal, shortcutGroups } from '../components/modals/ShortcutsModal'

/**
 * `[` and `]` move to the open page's previous and next tab, from anywhere on the page, found by
 * where the tab bar sits as `/` finds the search box. They stand down where `?` and `/` do, AltGr
 * excepted, and the person's Single-key shortcuts setting turns all four off while Ctrl K stays.
 */

const { page } = vi.hoisted(() => ({ page: { tabs: true } }))

// The landing page stands in for every tabbed page: a tab bar over a toolbar, or a toolbar alone.
vi.mock('../components/tabs/SiteMapTab', async () => {
  const { SearchInput: Search } = await import('../components/common/SearchInput')
  const { TabStrip: Strip } = await import('../components/common/TabStrip')
  const { useState } = await import('react')
  const Page = () => {
    const [tab, setTab] = useState('registered')
    const [query, setQuery] = useState('')
    return (
      <div className="card">
        {page.tabs && (
          <Strip
            ariaLabel="Devices view"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'registered', label: 'Registered' },
              { id: 'quarantine', label: 'Quarantine', attention: 3 },
              { id: 'retired', label: 'Retired' },
            ]}
          />
        )}
        <div className="filter-bar">
          <Search value={query} onChange={setQuery} placeholder="Search…" ariaLabel="Search this page" />
        </div>
        <p data-testid="shown">{tab}</p>
      </div>
    )
  }
  return { SiteMapTab: Page }
})

vi.mock('../utils/userSettings', () => ({
  readUserSettings: vi.fn(),
  seedUserSettings: vi.fn().mockResolvedValue(undefined),
  saveUserSetting: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
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

import { supabase } from '../lib/supabaseClient'
import { readUserSettings } from '../utils/userSettings'

const session = {
  user: { id: 'user-admin-123', email: 'admin@aber.local', app_metadata: { role: 'Administrator' } }
}

/** Presses `key` on `target` and says whether the app kept the character from being typed. */
const press = (key, target = document.body, init = {}) => !fireEvent.keyDown(target, { key, ...init })

const tab = (name) => screen.getByRole('tab', { name })
const selected = () => screen.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')
const shortcutsButton = () => screen.getByRole('button', { name: 'Keyboard shortcuts' })
const topSearch = () => screen.getByRole('combobox', { name: /Search pages/ })
const pageSearch = () => screen.getByRole('searchbox', { name: 'Search this page' })

const renderApp = async ({ singleKey = true, ready = 'main .filter-bar' } = {}) => {
  readUserSettings.mockResolvedValue({ theme: 'dark', sidebar_mode: 'hover', single_key_shortcuts: singleKey })
  render(<App />)
  await waitFor(() => expect(screen.getByText('Aber')).toBeInTheDocument())
  await waitFor(() => expect(document.querySelector(ready)).toBeInTheDocument())
  // The row has answered once the button names `?`, or stops naming it.
  await waitFor(() => expect(shortcutsButton().hasAttribute('aria-keyshortcuts')).toBe(singleKey))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  page.tabs = true
  window.history.pushState({}, '', '/')
  supabase.auth.getSession.mockResolvedValue({ data: { session } })
  supabase.auth.getUser.mockResolvedValue({ data: { user: session.user }, error: null })
  supabase.auth.signOut.mockResolvedValue({ error: null })
  supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
})
// The native <dialog> fixtures above are appended to <body> itself; a dialog React renders sits in
// its container and is unmounted by the test library, so it must not be pulled out from under it.
afterEach(() => { document.querySelectorAll('body > dialog').forEach(d => d.remove()) })

describe('`[` and `]`', () => {
  it('move to the next and the previous tab, as a click does', async () => {
    await renderApp()
    expect(press(']')).toBe(true)
    expect(selected()).toBe(tab('Quarantine, 3 waiting'))
    expect(screen.getByTestId('shown')).toHaveTextContent('quarantine')
    expect(press('[')).toBe(true)
    expect(selected()).toBe(tab('Registered'))
  })

  it('put focus on the new tab, and keep working from there', async () => {
    await renderApp()
    press(']')
    // Its name is what a screen reader reads: the waiting count included.
    expect(tab('Quarantine, 3 waiting')).toHaveFocus()
    press(']', document.activeElement)
    expect(tab('Retired')).toHaveFocus()
    expect(selected()).toBe(tab('Retired'))
  })

  it('stop at the first and the last tab', async () => {
    await renderApp()
    expect(press('[')).toBe(false)
    expect(selected()).toBe(tab('Registered'))
    press(']')
    press(']')
    expect(press(']')).toBe(false)
    expect(selected()).toBe(tab('Retired'))
  })

  it('do nothing on a page without tabs', async () => {
    page.tabs = false
    await renderApp()
    expect(screen.queryByRole('tablist')).toBeNull()
    const before = document.activeElement
    expect(press(']')).toBe(false)
    expect(press('[')).toBe(false)
    expect(document.activeElement).toBe(before)
  })

  it('do nothing in a text field, where the bracket is typed', async () => {
    await renderApp()
    pageSearch().focus()
    expect(press(']', pageSearch())).toBe(false)
    expect(pageSearch()).toHaveFocus()
    expect(selected()).toBe(tab('Registered'))
  })

  it('do nothing with Ctrl, Cmd or Alt held', async () => {
    await renderApp()
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      expect(press(']', document.body, { [modifier]: true }), modifier).toBe(false)
      expect(selected()).toBe(tab('Registered'))
    }
  })

  it('work with AltGr, which Windows reports as Ctrl+Alt, as German and Nordic layouts need', async () => {
    await renderApp()
    expect(press(']', document.body, { ctrlKey: true, altKey: true, modifierAltGraph: true })).toBe(true)
    expect(selected()).toBe(tab('Quarantine, 3 waiting'))
  })

  it('do nothing while the shared dialog frame is open', async () => {
    await renderApp()
    press('?')
    expect(screen.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeInTheDocument()
    expect(press(']')).toBe(false)
    expect(selected()).toBe(tab('Registered'))
  })

  it('do nothing while a native <dialog> is open', async () => {
    await renderApp()
    const native = document.createElement('dialog')
    native.setAttribute('open', '')
    document.body.appendChild(native)
    expect(press(']')).toBe(false)
    expect(selected()).toBe(tab('Registered'))
  })

  it('are not named on the tab bar, since the tab they open changes', async () => {
    await renderApp()
    expect(screen.getByRole('tablist')).not.toHaveAttribute('aria-keyshortcuts')
    for (const t of screen.getAllByRole('tab')) expect(t).not.toHaveAttribute('aria-keyshortcuts')
  })
})

describe('on a page whose tab is in the address', () => {
  it('moves the address and adds a history entry, as a click does', async () => {
    window.history.pushState({}, '', '/profile')
    await renderApp({ ready: 'main [role="tablist"]' })
    const depth = window.history.length
    press(']')
    expect(window.location.pathname).toBe('/profile/appearance')
    expect(window.history.length).toBe(depth + 1)
    expect(screen.getByRole('tab', { name: 'Appearance' })).toHaveFocus()
    press('[')
    expect(window.location.pathname).toBe('/profile')
  })
})

describe('Ctrl K', () => {
  it('focuses the top bar\'s search box', async () => {
    await renderApp()
    expect(press('k', document.body, { ctrlKey: true })).toBe(true)
    expect(topSearch()).toHaveFocus()
  })

  it('does nothing while a dialog is open, rather than reaching the box behind it', async () => {
    await renderApp()
    press('?')
    const dialog = screen.getByRole('dialog', { name: /keyboard shortcuts/i })
    press('k', document.body, { ctrlKey: true })
    expect(topSearch()).not.toHaveFocus()
    expect(dialog).toBeInTheDocument()
  })

  it('does nothing while a native <dialog> is open', async () => {
    await renderApp()
    const native = document.createElement('dialog')
    native.setAttribute('open', '')
    document.body.appendChild(native)
    press('k', document.body, { metaKey: true })
    expect(topSearch()).not.toHaveFocus()
  })
})

describe('with single-key shortcuts turned off', () => {
  it('leaves ?, /, [ and ] to the browser', async () => {
    await renderApp({ singleKey: false })
    expect(press('?')).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(press('/')).toBe(false)
    expect(pageSearch()).not.toHaveFocus()
    expect(press(']')).toBe(false)
    expect(selected()).toBe(tab('Registered'))
  })

  it('keeps Ctrl K', async () => {
    await renderApp({ singleKey: false })
    press('k', document.body, { ctrlKey: true })
    expect(topSearch()).toHaveFocus()
  })

  it('still opens the list from the top bar, which says the four are off', async () => {
    await renderApp({ singleKey: false })
    fireEvent.click(shortcutsButton())
    const dialog = screen.getByRole('dialog', { name: /keyboard shortcuts/i })
    expect(within(dialog).getByText(/Single-key shortcuts are turned off/)).toBeInTheDocument()
    const off = [...dialog.querySelectorAll('.shortcut-row-off')]
      .map(r => [...r.querySelectorAll('kbd')].map(k => k.textContent).join(' '))
    expect(off.sort()).toEqual(['/', '?', '[ ]'])
    for (const row of dialog.querySelectorAll('.shortcut-row-off')) expect(within(row).getByText('Off')).toBeInTheDocument()
  })

  it('is read from the browser\'s copy first, so the first paint has them off', async () => {
    localStorage.setItem('aber_single_key_shortcuts', 'off')
    readUserSettings.mockReturnValue(new Promise(() => {}))
    render(<App />)
    await waitFor(() => expect(document.querySelector('main .filter-bar')).toBeInTheDocument())
    expect(shortcutsButton()).not.toHaveAttribute('aria-keyshortcuts')
    expect(press(']')).toBe(false)
  })
})

describe('aria-keyshortcuts', () => {
  it('names ?, / and Ctrl K on the controls they reach', async () => {
    await renderApp()
    expect(shortcutsButton()).toHaveAttribute('aria-keyshortcuts', '?')
    await waitFor(() => expect(pageSearch()).toHaveAttribute('aria-keyshortcuts', '/'))
    expect(topSearch()).toHaveAttribute('aria-keyshortcuts', 'Control+K')
  })

  it('leaves out ? and / while they are off, and keeps Ctrl K', async () => {
    await renderApp({ singleKey: false })
    expect(shortcutsButton()).not.toHaveAttribute('aria-keyshortcuts')
    expect(pageSearch()).not.toHaveAttribute('aria-keyshortcuts')
    // The `/` hint goes with it.
    expect(document.querySelector('.search-input-kbd')).toBeNull()
    expect(topSearch()).toHaveAttribute('aria-keyshortcuts', 'Control+K')
  })
})

describe('the shortcuts list', () => {
  it('lists [ or ] as moving between the page\'s tabs, with no modifier', () => {
    const row = shortcutGroups().flatMap(g => g.items).find(i => i.keys.join(' ') === '[ ]')
    expect(row).toMatchObject({ join: 'or', singleKey: true, description: 'Move to the previous or next tab on this page' })

    render(<ShortcutsModal onClose={vi.fn()} />)
    const drawn = [...document.querySelectorAll('.shortcut-row')]
      .find(r => [...r.querySelectorAll('kbd')].map(k => k.textContent).join(' ') === '[ ]')
    expect(drawn.querySelector('.shortcut-join')).toHaveTextContent('or')
    // On, nothing is marked.
    expect(document.querySelector('.shortcut-row-off')).toBeNull()
  })

  it('marks exactly the four single-key shortcuts as the ones the setting covers', () => {
    const marked = shortcutGroups().flatMap(g => g.items).filter(i => i.singleKey).map(i => i.keys.join(' '))
    expect(marked.sort()).toEqual(['/', '?', '[ ]'])
  })
})
