import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import App from '../App'
import { SearchInput, focusPageSearch, PAGE_SEARCH_SELECTOR } from '../components/common/SearchInput'
import { ShortcutsModal, shortcutGroups } from '../components/modals/ShortcutsModal'

/**
 * `/` focuses the search box in the open page's toolbar. It is found by where it sits, a
 * SearchInput in a `.filter-bar` inside `main`, so a page needs no wiring of its own, and it stands
 * down where `?` does, while a dialog is open, and on a page with no box.
 */

const { page } = vi.hoisted(() => ({ page: { search: true } }))

// The landing page stands in for every page: a toolbar with a search box, or one without.
vi.mock('../components/tabs/SiteMapTab', async () => {
  const { SearchInput: Search } = await import('../components/common/SearchInput')
  const { useState } = await import('react')
  const Page = () => {
    const [query, setQuery] = useState('')
    return (
      <div className="card">
        <div className="filter-bar">
          {page.search && <Search value={query} onChange={setQuery} placeholder="Search…" ariaLabel="Search this page" />}
          <select className="form-control" aria-label="Status"><option>Any status</option></select>
        </div>
      </div>
    )
  }
  return { SiteMapTab: Page }
})

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

const session = {
  user: { id: 'user-admin-123', email: 'admin@aber.local', app_metadata: { role: 'Administrator' } }
}

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

/** Presses `/` on `target` and says whether the app kept the character from being typed. */
const slash = (target = document.body, init = {}) => !fireEvent.keyDown(target, { key: '/', ...init })

describe('`/` in the app', () => {
  const renderApp = async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Aber')).toBeInTheDocument())
    await waitFor(() => expect(document.querySelector('main .filter-bar')).toBeInTheDocument())
  }
  const pageSearch = () => screen.getByRole('searchbox', { name: 'Search this page' })

  beforeEach(() => {
    vi.clearAllMocks()
    page.search = true
    window.history.pushState({}, '', '/')
    supabase.auth.getSession.mockResolvedValue({ data: { session } })
    supabase.auth.getUser.mockResolvedValue({ data: { user: session.user }, error: null })
    supabase.auth.signOut.mockResolvedValue({ error: null })
    supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
  })

  it('focuses the page\'s search box, and the slash is not typed into it', async () => {
    await renderApp()
    expect(slash()).toBe(true)
    expect(pageSearch()).toHaveFocus()
    expect(pageSearch()).toHaveValue('')
  })

  it('listens for the character, so a layout that types it with Shift works too', async () => {
    await renderApp()
    // A German keyboard types `/` as Shift+7.
    slash(document.body, { code: 'Digit7', shiftKey: true })
    expect(pageSearch()).toHaveFocus()
  })

  it('never takes the top bar\'s search, which Ctrl K owns', async () => {
    await renderApp()
    slash()
    expect(screen.getByRole('combobox', { name: /Search pages/ })).not.toHaveFocus()
  })

  it('does nothing while the cursor is in a text field, so a slash can be typed there', async () => {
    await renderApp()
    const topSearch = screen.getByRole('combobox', { name: /Search pages/ })
    topSearch.focus()
    expect(slash(topSearch)).toBe(false)
    expect(topSearch).toHaveFocus()
  })

  it('does nothing from a select', async () => {
    await renderApp()
    const status = screen.getByRole('combobox', { name: 'Status' })
    status.focus()
    expect(slash(status)).toBe(false)
    expect(status).toHaveFocus()
  })

  it('does nothing with Ctrl, Cmd or Alt held', async () => {
    await renderApp()
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      expect(slash(document.body, { [modifier]: true })).toBe(false)
      expect(pageSearch()).not.toHaveFocus()
    }
  })

  it('does nothing while a dialog is open, rather than reaching the page behind it', async () => {
    await renderApp()
    fireEvent.keyDown(document.body, { key: '?' })
    expect(screen.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeInTheDocument()
    expect(slash()).toBe(false)
    expect(pageSearch()).not.toHaveFocus()
  })

  it('does nothing on a page with no search box', async () => {
    page.search = false
    await renderApp()
    expect(document.querySelector('.search-input-field')).toBeNull()
    const before = document.activeElement
    expect(slash()).toBe(false)
    expect(document.activeElement).toBe(before)
  })
})

describe('focusPageSearch', () => {
  const toolbar = (props = {}) => (
    <div className="filter-bar">
      <SearchInput value="" onChange={() => {}} ariaLabel="Search devices" {...props} />
    </div>
  )

  it('finds the box by where it sits, a toolbar in main, with no page wiring', () => {
    render(<main>{toolbar()}</main>)
    expect(focusPageSearch()).toBe(true)
    expect(screen.getByRole('searchbox', { name: 'Search devices' })).toHaveFocus()
  })

  it('selects what is already in the box, so typing replaces it', () => {
    render(<main>{toolbar({ value: 'press' })}</main>)
    focusPageSearch()
    const box = screen.getByRole('searchbox', { name: 'Search devices' })
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 5])
  })

  it('leaves a search box outside main or outside a toolbar alone', () => {
    render(
      <>
        <header>{toolbar({ ariaLabel: 'Outside main' })}</header>
        <main><SearchInput value="" onChange={() => {}} ariaLabel="Not in a toolbar" /></main>
      </>
    )
    expect(focusPageSearch()).toBe(false)
    expect(document.body).toHaveFocus()
  })

  it('skips a box that is hidden, and takes the first one shown', () => {
    render(
      <main>
        <div hidden>{toolbar({ ariaLabel: 'Hidden tab' })}</div>
        {toolbar({ ariaLabel: 'Shown tab' })}
      </main>
    )
    expect(focusPageSearch()).toBe(true)
    expect(screen.getByRole('searchbox', { name: 'Shown tab' })).toHaveFocus()
  })

  it('stands down for an open dialog or popover', () => {
    for (const attrs of [{ role: 'dialog' }, { 'aria-modal': 'true' }]) {
      const { unmount } = render(<><main>{toolbar()}</main><div {...attrs}>Filters</div></>)
      expect(focusPageSearch()).toBe(false)
      expect(screen.getByRole('searchbox', { name: 'Search devices' })).not.toHaveFocus()
      unmount()
    }
  })
})

describe('the `/` hint on the search box', () => {
  const hint = () => document.querySelector('.search-input-kbd')

  it('shows `/` at the box\'s right-hand end while it is empty, hidden from a screen reader', () => {
    render(<SearchInput value="" onChange={() => {}} ariaLabel="Search devices" />)
    expect(hint()).toHaveTextContent('/')
    expect(hint().tagName).toBe('KBD')
    expect(hint()).toHaveAttribute('aria-hidden', 'true')
    // After the field, which is what the `:focus ~` rule below needs.
    expect(screen.getByRole('searchbox').nextElementSibling).toBe(hint())
  })

  it('gives its place to the clear button while the box has text', () => {
    render(<SearchInput value="press" onChange={() => {}} ariaLabel="Search devices" />)
    expect(hint()).toBeNull()
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument()
  })

  it('is drawn only where `/` reaches the box, and goes while the box has focus', () => {
    // jsdom applies no stylesheet, so the rules are read: hidden by default, shown inside the same
    // selector focusPageSearch uses, and hidden again on focus.
    expect(PAGE_SEARCH_SELECTOR).toBe('main .filter-bar .search-input-field')
    expect(APP_CSS).toMatch(/\n\.search-input-kbd \{[^}]*display: none;/)
    expect(APP_CSS).toContain('\nmain .filter-bar .search-input-kbd { display: inline-block; }')
    expect(APP_CSS).toContain('\nmain .filter-bar .search-input-field:focus ~ .search-input-kbd { display: none; }')
  })

  it('is the same key cap as the top bar\'s Ctrl K hint', () => {
    const rule = (selector) => APP_CSS.match(new RegExp(`\\n${selector.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))[1]
    const cap = ['padding', 'border', 'border-radius', 'font-family', 'font-size', 'color']
    const declarations = (body) => Object.fromEntries(body.split(';').map(d => d.trim().split(/:\s*/)).filter(([k]) => cap.includes(k)))
    expect(declarations(rule('.search-input-kbd'))).toEqual(declarations(rule('.global-search-kbd')))
  })
})

describe('the shortcuts list', () => {
  it('lists `/` as focusing this page\'s search box', () => {
    const flat = shortcutGroups().flatMap(g => g.items)
    expect(flat.find(i => i.keys.join('+') === '/')?.description).toBe("Focus this page's search box")

    render(<ShortcutsModal onClose={vi.fn()} />)
    const row = [...document.querySelectorAll('.shortcut-row')]
      .find(r => [...r.querySelectorAll('kbd')].map(k => k.textContent).join(' ') === '/')
    expect(row).toBeTruthy()
    expect(within(row).getByText("Focus this page's search box")).toBeInTheDocument()
  })
})
