import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

import { Sidebar } from '../components/common/Sidebar'
import { ShortcutsModal, shortcutGroups } from '../components/modals/ShortcutsModal'
import { TABS, tabIsVisible } from '../navigation'

const adminTabs = () => TABS.filter(t => tabIsVisible(t, () => true, 'Administrator'))

const rail = () => document.querySelector('.sidebar')
const isExpanded = () => rail().classList.contains('sidebar-expanded')

const renderRail = (props = {}) => {
  const onNavigate = props.onNavigate || vi.fn()
  render(<Sidebar tabs={adminTabs()} currentTab="site-map" onNavigate={onNavigate} {...props} />)
  return onNavigate
}

// =================================================================================================
describe('the rail expands and, crucially, collapses again', () => {

  it('is collapsed at rest', () => {
    renderRail()
    expect(isExpanded()).toBe(false)
  })

  it('expands under the pointer and collapses when it leaves', () => {
    renderRail()
    fireEvent.mouseEnter(rail())
    expect(isExpanded()).toBe(true)

    fireEvent.mouseLeave(rail())
    expect(isExpanded()).toBe(false)
  })

  /**
   * The regression this file exists for: clicking a nav item focuses that button, and the rail
   * expanded on focus, so after a click it stayed open across the page it had navigated to. A focus
   * event arriving while hovered is a click and does nothing; the pointer leaving closes the rail.
   */
  it('collapses after a click, once the pointer moves away', () => {
    const onNavigate = renderRail()

    fireEvent.mouseEnter(rail())
    const devices = screen.getByRole('button', { name: 'Devices' })
    // A real click focuses the button it lands on. fireEvent.click does not, so the focus that
    // caused the bug is raised explicitly -- otherwise this test passes against the broken code.
    fireEvent.focus(devices)
    fireEvent.click(devices)
    expect(onNavigate).toHaveBeenCalledWith('devices')

    fireEvent.mouseLeave(rail())
    expect(isExpanded(), 'the rail stayed open over the page it navigated to').toBe(false)
  })

  /**
   * The half that must survive the fix: Tab is the only way to reach the rail without a mouse, and
   * the labels are transparent until it expands.
   */
  it('still expands on a keyboard focus, which arrives with no pointer over it', () => {
    renderRail()
    fireEvent.focus(screen.getByRole('button', { name: 'Devices' }))
    expect(isExpanded()).toBe(true)

    fireEvent.blur(screen.getByRole('button', { name: 'Devices' }))
    expect(isExpanded()).toBe(false)
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
      expect(within(nav).getByRole('button', { name: tab.label })).toBeTruthy()
    }
  })
})

// =================================================================================================
describe('the shortcuts dialog', () => {

  it('closes on Escape and on its own button', () => {
    const onClose = vi.fn()
    render(<ShortcutsModal onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /close keyboard shortcuts/i }))
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
