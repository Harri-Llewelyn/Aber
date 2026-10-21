/**
 * The help panel's Expand: the toggle in its header, the browser's copy of the choice, and the
 * page's drawer giving way to expanded help at every width. The Shell is the App's wiring
 * (App.jsx): the hook's state, the drawer context around the page, help beside it.
 */
import React from 'react'
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ContextPanel, HelpDrawerContext, ONE_DRAWER_QUERY } from '../components/common/ContextPanel'
import { HelpPanel } from '../components/common/HelpPanel'
import { useHelpExpanded, HELP_EXPANDED_KEY } from '../hooks/useHelpExpanded'

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8').replace(/\r\n/g, '\n')

// Stable, as the App's closeHelp is: a page's drawer re-runs its check when the function changes.
const noop = () => {}

function Shell({ initialHelp = true, onCloseHelp = noop }) {
  const [help, setHelp] = React.useState(initialHelp)
  const [selected, setSelected] = React.useState(null)
  const closeHelp = React.useCallback(() => { onCloseHelp(); setHelp(false) }, [onCloseHelp])
  const { expanded, setExpanded } = useHelpExpanded()
  const helpDrawer = React.useMemo(() => ({ close: closeHelp, expanded }), [closeHelp, expanded])
  return (
    <>
      <button type="button" onClick={() => setHelp(v => !v)}>Help for this page</button>
      <button type="button" onClick={() => setSelected('Line 1 Gateway')}>Select Line 1</button>
      <button type="button" onClick={() => setSelected('Line 2 Gateway')}>Select Line 2</button>
      <div className="app-body">
        <HelpDrawerContext.Provider value={helpDrawer}>
          <main className="content">
            <ContextPanel open={!!selected} type="Gateway" title={selected || ''} onClose={() => setSelected(null)} />
          </main>
        </HelpDrawerContext.Provider>
        <HelpPanel open={help} tabId="gateways" onClose={closeHelp} expanded={expanded} onExpandedChange={setExpanded} />
      </div>
    </>
  )
}

const help = () => document.querySelector('.context-panel-app')
const details = () => document.querySelector('.content .context-panel')
const expand = () => screen.getByRole('button', { name: 'Expand the help panel' })
const press = (name) => fireEvent.click(screen.getByRole('button', { name }))

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('Expand in the help panel’s header', () => {
  it('sits just before the X, as a toggle that is not pressed', () => {
    render(<Shell />)
    const header = help().querySelector('.context-panel-header')
    const controls = [...header.children].map(c => c.className)
    expect(controls.slice(-2)).toEqual(['context-panel-expand', 'context-panel-close'])
    expect(expand()).toHaveAttribute('aria-pressed', 'false')
    expect(expand()).toHaveAttribute('type', 'button')
    // Hover text is the shared tooltip's, never the browser's.
    expect(expand()).not.toHaveAttribute('title')
  })

  it('toggles the expanded class and aria-pressed, keeping its name', () => {
    render(<Shell />)
    expect(help()).not.toHaveClass('context-panel-expanded')
    fireEvent.click(expand())
    expect(help()).toHaveClass('context-panel-expanded')
    expect(expand()).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(expand())
    expect(help()).not.toHaveClass('context-panel-expanded')
    expect(expand()).toHaveAttribute('aria-pressed', 'false')
  })

  it('says what a press does in the shared tooltip', () => {
    render(<Shell />)
    fireEvent.focus(expand())
    expect(screen.getByRole('tooltip')).toHaveTextContent('Expand the help panel')
    fireEvent.blur(expand())
    fireEvent.click(expand())
    fireEvent.focus(expand())
    expect(screen.getByRole('tooltip')).toHaveTextContent('Shrink the help panel')
    // The bubble restates the name, so it is not also the description.
    expect(expand()).not.toHaveAttribute('aria-describedby')
  })

  it('is drawn only on the open help panel, never on a page’s drawer', () => {
    render(<Shell initialHelp={false} />)
    expect(screen.queryByRole('button', { name: 'Expand the help panel' })).toBeNull()
    press('Select Line 1')
    expect(details().querySelector('.context-panel-expand')).toBeNull()
    // Without the App's handler there is nothing for it to do, so it is not drawn.
    render(<HelpPanel open tabId="cells" onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Expand the help panel' })).toBeNull()
  })

  it('widens only the help panel, to half the window, and the whole width as an overlay', () => {
    expect(APP_CSS).toMatch(/--context-panel-width-expanded:\s*50vw;/)
    // Every other drawer reads --context-panel-width; only help's <aside> redefines it.
    const redefined = [...APP_CSS.matchAll(/\n\s*([^\n{}]+?)\s*\{[^}]*--context-panel-width:/g)].map(m => m[1].trim())
    expect(redefined).toEqual([':root', '.context-panel-app.context-panel-expanded'])
    expect(APP_CSS).toMatch(/\.context-panel-app\.context-panel-expanded \{ --context-panel-width: var\(--context-panel-width-expanded\); \}/)
    const overlay = APP_CSS.match(/@media \(max-width: 800px\) \{([\s\S]*?)\n\}/)[1]
    expect(overlay).toMatch(/\.context-panel-app\.context-panel-expanded\.context-panel-open \{ width: 100%; \}/)
  })

  it('leaves the drawer without an inline width of its own', () => {
    render(<Shell />)
    fireEvent.click(expand())
    expect(help().getAttribute('style')).toBeNull()
    expect(help().querySelector('.context-panel-inner').getAttribute('style')).toBeNull()
  })
})

describe('the choice is this browser’s', () => {
  it('defaults to docked and is kept as aber_help_expanded', () => {
    expect(HELP_EXPANDED_KEY).toBe('aber_help_expanded')
    const { result } = renderHook(() => useHelpExpanded())
    expect(result.current.expanded).toBe(false)
    act(() => result.current.setExpanded(true))
    expect(result.current.expanded).toBe(true)
    expect(localStorage.getItem(HELP_EXPANDED_KEY)).toBe('on')
    act(() => result.current.setExpanded(false))
    expect(localStorage.getItem(HELP_EXPANDED_KEY)).toBe('off')
  })

  it('is read back on the next load, and anything else reads as docked', () => {
    localStorage.setItem(HELP_EXPANDED_KEY, 'on')
    expect(renderHook(() => useHelpExpanded()).result.current.expanded).toBe(true)
    localStorage.setItem(HELP_EXPANDED_KEY, 'true')
    expect(renderHook(() => useHelpExpanded()).result.current.expanded).toBe(false)
  })

  it('ignores a value that is not a boolean', () => {
    const { result } = renderHook(() => useHelpExpanded())
    act(() => result.current.setExpanded('yes'))
    expect(result.current.expanded).toBe(false)
  })

  it('still works where storage is refused', () => {
    const blocked = () => { throw new Error('SecurityError') }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    const { result } = renderHook(() => useHelpExpanded())
    expect(result.current.expanded).toBe(false)
    act(() => result.current.setExpanded(true))
    expect(result.current.expanded).toBe(true)
  })

  it('opens the panel expanded again after a reload', () => {
    const { unmount } = render(<Shell />)
    fireEvent.click(expand())
    unmount()
    render(<Shell />)
    expect(help()).toHaveClass('context-panel-expanded')
    expect(expand()).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('expanded help replaces a page’s drawer at every width', () => {
  // The rule outside any media query; the one below 1440px is contextPanel.test.jsx's.
  const rule = APP_CSS.match(/\n(\.app-body:has\(> \.context-panel-app\.context-panel-expanded[^{]*?) \{ display: none; \}/)
  const hiddenSelector = rule?.[1]
  const hidden = () => details().matches(hiddenSelector)

  it('hides it with a rule of its own, beside the narrow-screen one', () => {
    expect(hiddenSelector).toBe('.app-body:has(> .context-panel-app.context-panel-expanded.context-panel-open) > .content .context-panel-open')
    const narrow = APP_CSS.indexOf(`@media ${ONE_DRAWER_QUERY} {`)
    expect(narrow).toBeGreaterThan(-1)
    expect(APP_CSS.indexOf(hiddenSelector)).toBeGreaterThan(narrow)
  })

  it('hides a wide screen’s open drawer without closing it, and shrinking shows it again', () => {
    // No matchMedia: the wide screen, where docked help sits beside the details.
    const onCloseHelp = vi.fn()
    render(<Shell onCloseHelp={onCloseHelp} />)
    press('Select Line 1')
    expect(onCloseHelp).not.toHaveBeenCalled()
    expect(details()).toHaveClass('context-panel-open')
    expect(hidden()).toBe(false)

    // Expanding is not a page's drawer opening, so help stays and the details give way.
    fireEvent.click(expand())
    expect(onCloseHelp).not.toHaveBeenCalled()
    expect(help()).toHaveClass('context-panel-open')
    expect(details()).toHaveClass('context-panel-open')
    expect(hidden()).toBe(true)

    fireEvent.click(expand())
    expect(hidden()).toBe(false)
    fireEvent.click(expand())
    press('Close help')
    expect(hidden()).toBe(false)
    expect(details()).toHaveClass('context-panel-open')
  })

  it('closes when a row is selected while it is expanded, the first time and on the next row', () => {
    render(<Shell />)
    fireEvent.click(expand())
    press('Select Line 1')
    expect(help()).not.toHaveClass('context-panel-open')
    expect(hidden()).toBe(false)

    press('Help for this page')
    expect(help()).toHaveClass('context-panel-expanded')
    expect(hidden()).toBe(true)
    press('Select Line 2')
    expect(help()).not.toHaveClass('context-panel-open')
    expect(screen.getByText('Line 2 Gateway', { selector: '.content .context-panel-title' })).toBeInTheDocument()
  })

  it('stays open beside the details on a wide screen while docked', () => {
    render(<Shell />)
    press('Select Line 1')
    press('Select Line 2')
    expect(help()).toHaveClass('context-panel-open')
  })
})

describe('the header still closes the expanded panel', () => {
  it('on the X', () => {
    const onCloseHelp = vi.fn()
    render(<Shell onCloseHelp={onCloseHelp} />)
    fireEvent.click(expand())
    press('Close help')
    expect(onCloseHelp).toHaveBeenCalledTimes(1)
    expect(help()).not.toHaveClass('context-panel-open')
    // Closed, Expand is not drawn; the choice is kept for the next opening.
    expect(screen.queryByRole('button', { name: 'Expand the help panel' })).toBeNull()
    press('Help for this page')
    expect(help()).toHaveClass('context-panel-expanded')
  })

  it('on Escape, after Escape has closed Expand’s tooltip', () => {
    const onCloseHelp = vi.fn()
    render(<Shell onCloseHelp={onCloseHelp} />)
    fireEvent.click(expand())
    fireEvent.focus(expand())
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(onCloseHelp).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCloseHelp).toHaveBeenCalledTimes(1)
    expect(help()).not.toHaveClass('context-panel-open')
  })
})

describe('a wide table or command keeps the panel’s width', () => {
  it('scrolls sideways inside its own box, inside a drawer of fixed width', () => {
    expect(APP_CSS.match(/\n\.help-table-wrap \{([^}]*)\}/)[1]).toMatch(/overflow-x:\s*auto/)
    expect(APP_CSS.match(/\n\.help-code pre \{([^}]*)\}/)[1]).toMatch(/overflow-x:\s*auto/)
    // The shell holds the drawer's width, so content wider than it cannot widen the drawer.
    expect(APP_CSS.match(/\n\.context-panel-inner \{([^}]*)\}/)[1]).toMatch(/width:\s*var\(--context-panel-width\)/)
  })
})
