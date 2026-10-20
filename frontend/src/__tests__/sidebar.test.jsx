import React from 'react'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { Sidebar, RAIL_OPEN_DELAY_MS } from '../components/common/Sidebar'
import { ShortcutsModal, shortcutGroups } from '../components/modals/ShortcutsModal'
import { TABS, tabIsVisible } from '../navigation'

// The rail's pages. Profile has no group: the account menu at the rail's foot is its way in.
const adminTabs = () => TABS.filter(t => t.group && tabIsVisible(t, () => true, 'Administrator'))

const rail = () => document.querySelector('.sidebar')
const isExpanded = () => rail().classList.contains('sidebar-expanded')

const renderRail = (props = {}) => {
  const onNavigate = props.onNavigate || vi.fn()
  render(<Sidebar tabs={adminTabs()} currentTab="site-map" onNavigate={onNavigate} {...props} />)
  return onNavigate
}

// =================================================================================================
describe('the rail expands and, crucially, collapses again', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  const wait = (ms) => act(() => { vi.advanceTimersByTime(ms) })
  const link = (name) => screen.getByRole('link', { name })

  it('is collapsed at rest', () => {
    renderRail()
    expect(isExpanded()).toBe(false)
  })

  it('expands once the pointer rests on it, and collapses the moment it leaves', () => {
    renderRail()
    fireEvent.mouseEnter(rail())
    wait(RAIL_OPEN_DELAY_MS - 1)
    expect(isExpanded(), 'opened before the pointer had rested').toBe(false)
    wait(1)
    expect(isExpanded()).toBe(true)

    fireEvent.mouseLeave(rail())
    expect(isExpanded()).toBe(false)
  })

  /** A pointer passing over the strip to another window, or to the area of a screenshot. */
  it('stays shut for a pointer that only crosses it', () => {
    renderRail()
    fireEvent.mouseEnter(rail())
    wait(RAIL_OPEN_DELAY_MS / 2)
    fireEvent.mouseLeave(rail())
    wait(RAIL_OPEN_DELAY_MS * 10)
    expect(isExpanded()).toBe(false)
  })

  /**
   * The regression this file exists for: clicking a nav item focuses that button, and the rail
   * expanded on focus, so after a click it stayed open across the page it had navigated to. A focus
   * event arriving while the pointer is on the rail is a click and does nothing; the pointer leaving
   * closes the rail.
   */
  it('collapses after a click, once the pointer moves away', () => {
    const onNavigate = renderRail()

    fireEvent.mouseEnter(rail())
    wait(RAIL_OPEN_DELAY_MS)
    const devices = link('Devices')
    // A real click focuses the link it lands on. fireEvent.click does not, so the focus that
    // caused the bug is raised explicitly -- otherwise this test passes against the broken code.
    fireEvent.focus(devices)
    fireEvent.click(devices)
    expect(onNavigate).toHaveBeenCalledWith('devices')

    fireEvent.mouseLeave(rail())
    expect(isExpanded(), 'the rail stayed open over the page it navigated to').toBe(false)
  })

  /**
   * The pointer is on the rail before the panel opens, so the click's focus must be read against
   * the pointer, not against the panel: read against the shut panel it looks like a Tab.
   */
  it('navigates on a click during the wait, and the click does not hold the panel open', () => {
    const onNavigate = renderRail()

    fireEvent.mouseEnter(rail())
    wait(RAIL_OPEN_DELAY_MS / 3)
    fireEvent.focus(link('Devices'))
    fireEvent.click(link('Devices'))
    expect(onNavigate).toHaveBeenCalledWith('devices')
    expect(isExpanded(), 'the click opened the panel as a Tab would').toBe(false)

    fireEvent.mouseLeave(rail())
    wait(RAIL_OPEN_DELAY_MS * 10)
    expect(isExpanded()).toBe(false)
  })

  /**
   * The half that must survive the fix: Tab is the only way to reach the rail without a mouse, and
   * the labels are transparent until it expands. No wait: there is no crossing to filter out.
   */
  it('still expands at once on a keyboard focus, which arrives with no pointer over it', () => {
    renderRail()
    fireEvent.focus(link('Devices'))
    expect(isExpanded()).toBe(true)

    fireEvent.blur(link('Devices'))
    expect(isExpanded()).toBe(false)
  })

  /**
   * A rail link clicked with the mouse keeps focus after navigating. When the browser window is
   * activated again (Alt+Tab, a screenshot overlay closing), the browser focuses that link again,
   * with the pointer elsewhere and nothing as the previous focus. That is not a Tab.
   */
  it('stays shut when the window comes back to a link that was clicked', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    renderRail()
    fireEvent.mouseEnter(rail())
    wait(RAIL_OPEN_DELAY_MS)
    fireEvent.focus(link('Devices'))
    fireEvent.click(link('Devices'))
    fireEvent.mouseLeave(rail())
    expect(isExpanded()).toBe(false)

    // The window loses focus: the link blurs while the document no longer has focus.
    hasFocus.mockReturnValue(false)
    fireEvent.blur(link('Devices'), { relatedTarget: null })
    // It comes back: the same link is focused again, with no keydown and no pointer.
    hasFocus.mockReturnValue(true)
    fireEvent.focus(link('Devices'), { relatedTarget: null })
    expect(isExpanded(), 'the window coming back opened the rail').toBe(false)

    // A Tab from there is keyboard navigation again.
    fireEvent.blur(link('Devices'), { relatedTarget: link('Cells') })
    fireEvent.focus(link('Cells'), { relatedTarget: link('Devices') })
    expect(isExpanded()).toBe(true)
  })

  it('comes back open when the window returns to a link reached with Tab', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    renderRail()
    fireEvent.focus(link('Devices'))
    expect(isExpanded()).toBe(true)

    hasFocus.mockReturnValue(false)
    fireEvent.blur(link('Devices'), { relatedTarget: null })
    expect(isExpanded()).toBe(false)
    hasFocus.mockReturnValue(true)
    fireEvent.focus(link('Devices'), { relatedTarget: null })
    expect(isExpanded()).toBe(true)
  })
})

// =================================================================================================
describe('the grouping', () => {

  it('separates the groups and captions none of them', () => {
    renderRail()
    const groups = [...document.querySelectorAll('.sidebar-group')]

    expect(groups.length).toBeGreaterThanOrEqual(4)
    expect(document.querySelectorAll('.sidebar-divider')).toHaveLength(groups.length - 1)

    /* No captions: a heading would have to hold its box in the collapsed state, leaving blank
       strips in the resting rail. */
    expect(document.querySelector('.sidebar-group-label')).toBeNull()
    for (const caption of ['Assets', 'Modelling', 'History', 'Administration']) {
      expect(screen.queryByText(caption), `the "${caption}" heading came back`).toBeNull()
    }
  })

  it('names every item even while the labels are invisible', () => {
    renderRail()
    const nav = within(rail()).getByRole('navigation', { name: /primary/i })
    for (const tab of adminTabs()) {
      expect(within(nav).getByRole('link', { name: tab.label })).toBeTruthy()
    }
  })
})

// =================================================================================================
describe('the shortcuts dialog', () => {

  it('closes on Escape and on its own button', () => {
    const onClose = vi.fn()
    render(<ShortcutsModal onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /^close$/i }))
    expect(onClose).toHaveBeenCalled()

    onClose.mockClear()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on a click outside it, and not on one inside', () => {
    /* The deviation is deliberate and narrow. Most dialogs here do NOT close this way, because
       most hold input a stray click would discard; this one is a list to read, like the alerts
       popover it was compared to. The inside case is what stops a click on the list dismissing
       the list. */
    const onClose = vi.fn()
    render(<ShortcutsModal onClose={onClose} />)

    fireEvent.click(document.querySelector('.modal'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(document.querySelector('.modal-overlay'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders its keys as <kbd>, which is the element that means this', () => {
    render(<ShortcutsModal onClose={vi.fn()} />)
    const keys = [...document.querySelectorAll('kbd')]
    expect(keys.length).toBeGreaterThan(8)
    expect(keys.every(k => k.textContent.trim().length > 0)).toBe(true)
  })

  it('says Cmd on a Mac and Ctrl everywhere else', () => {
    expect(shortcutGroups({ mac: true })[0].items[0].keys).toContain('Cmd')
    expect(shortcutGroups({ mac: false })[0].items[0].keys).toContain('Ctrl')
  })

  /**
   * Every row is a shortcut that exists. Only the bindings this application installs are checked;
   * Tab, Shift+Tab, Enter and Space are the browser's, listed because the rail's response to Tab
   * cannot be discovered anywhere else.
   */
  it('lists the palette bindings the search box actually installs', () => {
    const flat = shortcutGroups().flatMap(g => g.items)
    const described = flat.map(i => i.keys.join('+'))

    expect(described).toContain('Ctrl+K')
    expect(described).toContain('↑+↓')
    expect(described).toContain('?')
    expect(described.filter(k => k === 'Esc').length).toBeGreaterThan(0)
  })

  it('lists the stepping keys the Audit Trail drawer installs', () => {
    // Bound in AuditTrailTab while an event is selected; auditTrailArrowKeys.test.jsx proves
    // the binding. A row here without that binding would teach a key that does nothing.
    const group = shortcutGroups().find(g => g.title === 'Audit Trail')
    expect(group).toBeTruthy()
    expect(group.items.map(i => i.keys.join('+'))).toContain('←+→')
  })

  it('joins alternative keys with or, and a chord with +', () => {
    /* ↑ ↓ and ← → are each a pair of alternatives, and "← + →" would read as a chord nobody can
       press. The join used to be special-cased to the ↓ key, which the arrow row would have got
       wrong. */
    render(<ShortcutsModal onClose={vi.fn()} />)
    const rows = [...document.querySelectorAll('.shortcut-row')]
    const joinOf = (keys) => rows
      .find(r => [...r.querySelectorAll('kbd')].map(k => k.textContent).join(' ') === keys)
      ?.querySelector('.shortcut-join')?.textContent

    expect(joinOf('↑ ↓')).toBe('or')
    expect(joinOf('← →')).toBe('or')
    expect(joinOf('Ctrl K')).toBe('+')
  })

  it('claims no shortcut this application does not bind', () => {
    // The bindings installed in source, as opposed to the browser's own. If a row ever names one of
    // these modified combinations, it has to be real.
    const flat = shortcutGroups().flatMap(g => g.items)
    const modified = flat.filter(i => i.keys.includes('Ctrl') || i.keys.includes('Cmd'))

    // Exactly one, and it is the palette. A second would need a `keydown` listener to match it.
    expect(modified).toHaveLength(1)
    expect(modified[0].keys).toEqual(['Ctrl', 'K'])
  })

  it('gives every row a description, since a bare key teaches nothing', () => {
    for (const group of shortcutGroups()) {
      expect(group.title).toBeTruthy()
      expect(group.items.length).toBeGreaterThan(0)
      for (const item of group.items) {
        expect(item.keys.length).toBeGreaterThan(0)
        expect(item.description.length).toBeGreaterThan(10)
      }
    }
  })
})
