/**
 * The sidebar lists each page's tabs beneath it, as disclosure navigation: the page's link, a
 * chevron button that shows or hides the tabs, and a list of the tabs' links. Arriving on a page
 * opens its tabs, marks the current one and closes every other page's; pages opened by hand stay
 * open together until then. Collapse all tabs closes every list. A tab's waiting count shows on its
 * entry while the list is on screen, and on the page's entry otherwise, never on both.
 */
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { Sidebar, RAIL_OPEN_DELAY_MS } from '../components/common/Sidebar'
import { TABS, SETTINGS_TABS, tabIsVisible } from '../navigation'
import { navigate } from '../hooks/useUrlState'

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8').replace(/\r\n/g, '\n')

const adminTabs = () => TABS.filter(t => t.group && tabIsVisible(t, () => true, 'Administrator'))
const rail = () => document.querySelector('.sidebar')
const isExpanded = () => rail().classList.contains('sidebar-expanded')
const primary = () => within(rail()).getByRole('navigation', { name: /primary/i })
const chevron = (page) => screen.getByRole('button', { name: `Show the ${page} tabs` })
const tabList = (page) => document.getElementById(chevron(page).getAttribute('aria-controls'))
const entry = (page, name) => within(tabList(page)).getByRole('link', { name })

const QUARANTINE = { tone: 'warning', count: 3, note: '3 devices awaiting zero-touch onboarding approval' }

const renderRail = (props = {}) => render(
  <Sidebar tabs={adminTabs()} currentTab="site-map" mode="expanded" {...props} />
)

/** Fires a click and reports whether the page prevented the browser's own navigation. */
const click = (element, init = {}) => {
  const event = createEvent.click(element, { button: 0, ...init })
  fireEvent(element, event)
  return event.defaultPrevented
}

beforeEach(() => { window.history.replaceState(null, '', '/site-map') })

describe('a page with tabs', () => {
  it('has a chevron after its link, a button of its own that controls the list of tabs', () => {
    renderRail()
    const button = chevron('Devices')
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(tabList('Devices')).toHaveAttribute('hidden')
    // The page's link is separate, and still opens the page.
    expect(within(primary()).getByRole('link', { name: 'Devices' })).toHaveAttribute('href', '/devices')
  })

  it('calls the page that lists the services System, at /system, and nothing in the rail Directory', () => {
    renderRail()
    expect(within(primary()).getByRole('link', { name: 'System' })).toHaveAttribute('href', '/system')
    expect(within(primary()).queryByRole('link', { name: /directory/i })).toBeNull()
    fireEvent.click(chevron('System'))
    expect(entry('System', 'Applications & User Interfaces')).toHaveAttribute('href', '/system')
    expect(entry('System', 'Ingestion & Messaging')).toHaveAttribute('href', '/system/ingestion')
  })

  it('opens the tabs beneath it as links to each tab\'s address, and closes them again', () => {
    renderRail()
    fireEvent.click(chevron('Devices'))
    expect(chevron('Devices')).toHaveAttribute('aria-expanded', 'true')
    expect(tabList('Devices')).not.toHaveAttribute('hidden')
    expect(tabList('Devices').tagName).toBe('UL')
    expect(entry('Devices', 'Registered')).toHaveAttribute('href', '/devices')
    expect(entry('Devices', 'Quarantine')).toHaveAttribute('href', '/devices/quarantine')

    fireEvent.click(chevron('Devices'))
    expect(chevron('Devices')).toHaveAttribute('aria-expanded', 'false')
    expect(tabList('Devices')).toHaveAttribute('hidden')
  })

  it('gives no page without tabs a chevron, and Profile none, since it is not in the rail', () => {
    renderRail()
    for (const page of ['Site Map', 'Areas', 'Cells', 'Gateways', 'Schemas', 'Audit Trail', 'Backups', 'Cold Storage']) {
      expect(screen.queryByRole('button', { name: `Show the ${page} tabs` })).toBeNull()
    }
    expect(screen.queryByRole('button', { name: 'Show the Profile tabs' })).toBeNull()
    for (const page of ['Approvals', 'Devices', 'Metrics', 'Vocabulary', 'Capture', 'Archived Entities', 'System', 'Access Control', 'Settings']) {
      expect(chevron(page)).toBeInTheDocument()
    }
  })

  it('lists the Settings categories before the page has read them, from the list in the frontend', () => {
    renderRail()
    fireEvent.click(chevron('Settings'))
    expect(within(tabList('Settings')).getAllByRole('link').map(a => a.textContent)).toEqual(SETTINGS_TABS.map(t => t.label))
    expect(entry('Settings', 'Cold Storage')).toHaveAttribute('href', '/settings/cold-storage')
  })

  it('puts the chevron in the Tab order after the page\'s link, and the tabs after the chevron', () => {
    renderRail()
    fireEvent.click(chevron('Devices'))
    const order = [...primary().querySelectorAll('a[href], button')]
    const at = (el) => order.indexOf(el)
    const page = within(primary()).getByRole('link', { name: 'Devices' })
    expect(at(chevron('Devices'))).toBe(at(page) + 1)
    expect(at(entry('Devices', 'Registered'))).toBe(at(page) + 2)
    expect(at(entry('Devices', 'Quarantine'))).toBe(at(page) + 3)
  })

  it('makes its chevron a 28px target, above the 24px minimum', () => {
    const rule = APP_CSS.match(/\n\.sidebar-disclosure \{([\s\S]*?)\n\}/)[1]
    expect(rule).toMatch(/width:\s*28px/)
    expect(rule).toMatch(/height:\s*28px/)
  })
})

describe('arriving on a page', () => {
  it('opens its tabs and marks the current one, and a change of tab moves the mark', () => {
    window.history.replaceState(null, '', '/devices/quarantine')
    renderRail({ currentTab: 'devices' })
    expect(chevron('Devices')).toHaveAttribute('aria-expanded', 'true')
    expect(entry('Devices', 'Quarantine')).toHaveAttribute('aria-current', 'page')
    expect(entry('Devices', 'Registered')).not.toHaveAttribute('aria-current')
    // The page's own entry says it holds the current page, which is the tab.
    expect(within(primary()).getByRole('link', { name: 'Devices' })).toHaveAttribute('aria-current', 'true')

    act(() => navigate('/devices'))
    expect(entry('Devices', 'Registered')).toHaveAttribute('aria-current', 'page')
    expect(entry('Devices', 'Quarantine')).not.toHaveAttribute('aria-current')
  })

  it('stays closed once closed by hand on that page, and opens again on the next arrival', () => {
    window.history.replaceState(null, '', '/devices')
    const { rerender } = renderRail({ currentTab: 'devices' })
    fireEvent.click(chevron('Devices'))
    expect(chevron('Devices')).toHaveAttribute('aria-expanded', 'false')
    act(() => navigate('/devices/quarantine'))
    expect(chevron('Devices')).toHaveAttribute('aria-expanded', 'false')

    // Away, and back again.
    act(() => navigate('/cells'))
    rerender(<Sidebar tabs={adminTabs()} currentTab="cells" mode="expanded" />)
    act(() => navigate('/devices'))
    rerender(<Sidebar tabs={adminTabs()} currentTab="devices" mode="expanded" />)
    expect(chevron('Devices')).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps pages opened by hand open together while the page stays the same', () => {
    window.history.replaceState(null, '', '/devices')
    renderRail({ currentTab: 'devices' })
    fireEvent.click(chevron('Metrics'))
    fireEvent.click(chevron('Settings'))
    // A change of tab is not an arrival.
    act(() => navigate('/devices/quarantine'))
    for (const page of ['Devices', 'Metrics', 'Settings']) {
      expect(chevron(page), page).toHaveAttribute('aria-expanded', 'true')
    }
  })

  it('closes every other page\'s tabs on arriving at a page, those opened by hand included', () => {
    window.history.replaceState(null, '', '/devices')
    const { rerender } = renderRail({ currentTab: 'devices' })
    fireEvent.click(chevron('Metrics'))
    fireEvent.click(chevron('Approvals'))
    act(() => navigate('/vocabulary'))
    rerender(<Sidebar tabs={adminTabs()} currentTab="vocabulary" mode="expanded" />)
    expect(chevron('Vocabulary')).toHaveAttribute('aria-expanded', 'true')
    for (const page of ['Devices', 'Metrics', 'Approvals']) {
      expect(chevron(page), page).toHaveAttribute('aria-expanded', 'false')
      expect(tabList(page), page).toHaveAttribute('hidden')
    }
    // A page without tabs closes them all.
    act(() => navigate('/cells'))
    rerender(<Sidebar tabs={adminTabs()} currentTab="cells" mode="expanded" />)
    expect([...rail().querySelectorAll('.sidebar-disclosure[aria-expanded="true"]')]).toHaveLength(0)
  })
})

describe('counts', () => {
  const pageLink = (name) => within(primary()).getAllByRole('link').find(a => a.getAttribute('aria-label')?.startsWith(name) && a.classList.contains('sidebar-item'))
  const numbers = () => [...rail().querySelectorAll('.sidebar-item-count, .sidebar-tab-count')].filter(n => !n.closest('[hidden]'))

  it('show the page\'s total on a closed page, as the rail always has', () => {
    renderRail({ signals: { devices: QUARANTINE } })
    expect(pageLink('Devices')).toHaveAttribute('aria-label', 'Devices — 3 devices awaiting zero-touch onboarding approval')
    expect(pageLink('Devices').querySelector('.sidebar-item-count')).toHaveTextContent('3')
    expect(numbers()).toHaveLength(1)
  })

  it('move to the tab the work is in while the page is open, with the tab bar\'s words, and never show twice', () => {
    renderRail({ signals: { devices: QUARANTINE } })
    fireEvent.click(chevron('Devices'))
    const quarantine = entry('Devices', 'Quarantine, 3 waiting')
    expect(quarantine.querySelector('.sidebar-tab-count')).toHaveTextContent('3')
    expect(quarantine).toHaveClass('sidebar-tab-warning')
    // The page's entry reads plain while its tab carries the number.
    const devices = within(primary()).getByRole('link', { name: 'Devices' })
    expect(devices.querySelector('.sidebar-item-count')).toBeNull()
    expect(devices).not.toHaveClass('sidebar-item-warning')
    expect(numbers()).toHaveLength(1)
  })

  it('put Approvals\' waiting proposals on Awaiting a decision', () => {
    window.history.replaceState(null, '', '/approvals')
    renderRail({ currentTab: 'approvals', signals: { approvals: { tone: 'warning', count: 2, note: '2 proposals waiting for a decision' } } })
    expect(entry('Approvals', 'Awaiting a decision, 2 waiting')).toHaveAttribute('aria-current', 'page')
    expect(entry('Approvals', 'Decided')).not.toHaveClass('sidebar-tab-warning')
  })

  it('stay on the page\'s icon while the hover rail is shut, where the list cannot show', () => {
    window.history.replaceState(null, '', '/devices')
    renderRail({ currentTab: 'devices', mode: 'hover', signals: { devices: QUARANTINE } })
    expect(isExpanded()).toBe(false)
    expect(tabList('Devices')).toHaveAttribute('hidden')
    expect(pageLink('Devices').querySelector('.sidebar-item-count')).toHaveTextContent('3')
  })
})

describe('Collapse all tabs', () => {
  const collapseAll = () => within(rail()).getByRole('button', { name: 'Collapse all tabs' })

  it('sits at the rail\'s foot under the account control, shaped like a rail item but not a page', () => {
    renderRail({ account: <div className="user-menu">Account</div> })
    const foot = rail().querySelector('.sidebar-foot')
    expect([...foot.children].map(c => c.className)).toEqual(['user-menu', 'sidebar-collapse-all'])
    expect(collapseAll()).not.toHaveClass('sidebar-item')
    expect(collapseAll().querySelector('.sidebar-item-icon svg')).toBeTruthy()
    expect(collapseAll().querySelector('.sidebar-item-label')).toHaveTextContent('Collapse all tabs')
  })

  it('closes every open list, the current page\'s and those opened by hand', () => {
    window.history.replaceState(null, '', '/devices')
    renderRail({ currentTab: 'devices' })
    fireEvent.click(chevron('Metrics'))
    fireEvent.click(chevron('System'))
    expect(collapseAll()).toHaveAttribute('aria-disabled', 'false')

    fireEvent.click(collapseAll())
    expect([...rail().querySelectorAll('.sidebar-disclosure[aria-expanded="true"]')]).toHaveLength(0)
    expect([...rail().querySelectorAll('.sidebar-tabs:not([hidden])')]).toHaveLength(0)
    // The current page's stays closed through a change of tab, and opens again on the next arrival.
    act(() => navigate('/devices/quarantine'))
    expect(chevron('Devices')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(chevron('Devices'))
    expect(chevron('Devices')).toHaveAttribute('aria-expanded', 'true')
  })

  it('is disabled, and stays in its place, while no list is open', () => {
    renderRail()
    expect(collapseAll()).toHaveAttribute('aria-disabled', 'true')
    // Still a Tab stop, so it says why it does nothing; a click changes nothing.
    expect(collapseAll()).not.toHaveAttribute('disabled')
    fireEvent.click(collapseAll())
    expect(collapseAll()).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(chevron('Capture'))
    expect(collapseAll()).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(collapseAll())
    expect(collapseAll()).toHaveAttribute('aria-disabled', 'true')
  })

  it('counts the current page\'s list as open while the hover rail is shut', () => {
    window.history.replaceState(null, '', '/devices')
    renderRail({ currentTab: 'devices', mode: 'hover' })
    expect(collapseAll()).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(collapseAll())
    expect(chevron('Devices')).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('no tooltips on the tab entries', () => {
  it('gives a tab entry neither a title nor a description', () => {
    window.history.replaceState(null, '', '/devices')
    renderRail({ currentTab: 'devices' })
    for (const link of within(tabList('Devices')).getAllByRole('link')) {
      expect(link).not.toHaveAttribute('title')
      expect(link).not.toHaveAttribute('aria-describedby')
    }
    expect(chevron('Devices')).not.toHaveAttribute('title')
  })
})

describe('the rail\'s modes', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const rest = () => act(() => { vi.advanceTimersByTime(RAIL_OPEN_DELAY_MS) })

  it('hover: shows the open page\'s tabs once the rail opens, after the hover delay', () => {
    window.history.replaceState(null, '', '/devices')
    renderRail({ currentTab: 'devices', mode: 'hover' })
    expect(tabList('Devices')).toHaveAttribute('hidden')
    fireEvent.mouseEnter(rail())
    expect(tabList('Devices')).toHaveAttribute('hidden')
    rest()
    expect(tabList('Devices')).not.toHaveAttribute('hidden')
    fireEvent.mouseLeave(rail())
    expect(tabList('Devices')).toHaveAttribute('hidden')
  })

  it('hover: a chevron clicked with the pointer is not keyboard focus, so the rail still shuts', () => {
    renderRail({ mode: 'hover' })
    fireEvent.mouseEnter(rail())
    rest()
    fireEvent.focus(chevron('Devices'))
    fireEvent.click(chevron('Devices'))
    fireEvent.mouseLeave(rail())
    expect(isExpanded(), 'the chevron\'s click held the rail open').toBe(false)
  })

  it('keeps the rail open while Tab moves between its controls, so the tabs stay under the focus', () => {
    window.history.replaceState(null, '', '/devices')
    renderRail({ currentTab: 'devices', mode: 'hover' })
    const devices = within(primary()).getByRole('link', { name: 'Devices' })
    fireEvent.focus(devices)
    expect(isExpanded()).toBe(true)
    fireEvent.blur(devices, { relatedTarget: chevron('Devices') })
    fireEvent.focus(chevron('Devices'), { relatedTarget: devices })
    expect(isExpanded()).toBe(true)
    fireEvent.blur(chevron('Devices'), { relatedTarget: entry('Devices', 'Registered') })
    expect(isExpanded(), 'the rail shut between two of its own controls').toBe(true)
    expect(tabList('Devices')).not.toHaveAttribute('hidden')
    // Leaving the rail shuts it.
    fireEvent.blur(entry('Devices', 'Registered'), { relatedTarget: document.body })
    expect(isExpanded()).toBe(false)
  })

  it('collapsed: a click on a tabbed page navigates, as any page does, and draws no list', () => {
    const onNavigate = vi.fn()
    renderRail({ mode: 'collapsed', onNavigate })
    fireEvent.mouseEnter(rail())
    expect(click(within(primary()).getByRole('link', { name: 'Devices' }))).toBe(true)
    expect(onNavigate).toHaveBeenCalledWith('devices')
    expect(tabList('Devices')).toHaveAttribute('hidden')
    expect(isExpanded()).toBe(false)
    // Ctrl-click is still the browser's.
    expect(click(within(primary()).getByRole('link', { name: 'Gateways' }), { ctrlKey: true })).toBe(false)
  })

  it('collapsed: keyboard focus widens the rail, and the open page\'s tabs are in place there', () => {
    window.history.replaceState(null, '', '/devices')
    renderRail({ currentTab: 'devices', mode: 'collapsed' })
    expect(tabList('Devices')).toHaveAttribute('hidden')
    fireEvent.focus(within(primary()).getByRole('link', { name: 'Devices' }))
    expect(isExpanded()).toBe(true)
    expect(tabList('Devices')).not.toHaveAttribute('hidden')
  })
})

describe('the stylesheet', () => {
  it('hides the chevron until the rail is wide, and lets `hidden` take a list away', () => {
    expect(APP_CSS.match(/\n\.sidebar-disclosure \{([\s\S]*?)\n\}/)[1]).toMatch(/display:\s*none/)
    expect(APP_CSS).toMatch(/\.sidebar-expanded \.sidebar-disclosure \{ display: inline-flex; \}/)
    expect(APP_CSS.match(/\n\.sidebar-tabs \{([\s\S]*?)\n\}/)[1]).not.toMatch(/display:/)
  })

  it('marks the current tab with a border as well as colour', () => {
    const bar = APP_CSS.match(/\n\.sidebar-tab\.active::before \{([\s\S]*?)\n\}/)[1]
    expect(bar).toMatch(/border-left:\s*2px solid var\(--accent\)/)
  })

  it('has no pop-out beside the collapsed rail', () => {
    expect(APP_CSS).not.toMatch(/sidebar-tabs-popout/)
  })
})
