/**
 * The rail's pages and the drill-downs are real links (RouteLink): a plain click navigates in
 * place, and a click the browser means to open elsewhere -- Ctrl, Cmd, Shift, the middle button --
 * is left to the browser.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { Sidebar } from '../components/common/Sidebar'
import { RouteLink } from '../components/common/RouteLink'
import { TABS, tabIsVisible } from '../navigation'

const adminTabs = () => TABS.filter(t => tabIsVisible(t, () => true, 'Administrator'))

/** Fires a click and reports whether the page prevented the browser's own navigation. */
const click = (element, init = {}) => {
  const event = createEvent.click(element, { button: 0, ...init })
  fireEvent(element, event)
  return event.defaultPrevented
}

describe('the rail', () => {
  it('makes every page a link to its address', () => {
    render(<Sidebar tabs={adminTabs()} currentTab="site-map" />)
    const nav = within(document.querySelector('.sidebar')).getByRole('navigation', { name: /primary/i })
    for (const tab of adminTabs()) {
      expect(within(nav).getByRole('link', { name: tab.label })).toHaveAttribute('href', `/${tab.id}`)
    }
  })

  it('links an entry wherever hrefFor says, which is how Devices opens on a waiting queue', () => {
    render(<Sidebar tabs={adminTabs()} currentTab="site-map"
      hrefFor={id => (id === 'devices' ? '/devices/quarantine' : `/${id}`)} />)
    expect(screen.getByRole('link', { name: 'Devices' })).toHaveAttribute('href', '/devices/quarantine')
  })

  it('navigates in place on a plain click', () => {
    window.history.replaceState(null, '', '/site-map?area=a-1')
    render(<Sidebar tabs={adminTabs()} currentTab="site-map" />)
    expect(click(screen.getByRole('link', { name: 'Gateways' }))).toBe(true)
    // The bare page: a rail click starts fresh, with nothing a drill-down set.
    expect(window.location.pathname + window.location.search).toBe('/gateways')
  })

  it('hands a plain click to onNavigate when it is given', () => {
    const onNavigate = vi.fn()
    render(<Sidebar tabs={adminTabs()} currentTab="site-map" onNavigate={onNavigate} />)
    expect(click(screen.getByRole('link', { name: 'Gateways' }))).toBe(true)
    expect(onNavigate).toHaveBeenCalledWith('gateways')
  })

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
    ['Shift', { shiftKey: true }],
    ['the middle button', { button: 1 }],
  ])('leaves a click with %s to the browser, which opens the link elsewhere', (_, init) => {
    window.history.replaceState(null, '', '/site-map')
    const onNavigate = vi.fn()
    render(<Sidebar tabs={adminTabs()} currentTab="site-map" onNavigate={onNavigate} />)
    expect(click(screen.getByRole('link', { name: 'Gateways' }), init)).toBe(false)
    expect(onNavigate).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe('/site-map')
  })
})

describe('a drill-down link', () => {
  it('runs the page\'s own handler on a plain click, and only then', () => {
    const onNavigate = vi.fn()
    render(<RouteLink to="/gateways?search=gw-1" onNavigate={onNavigate}>Line gateway</RouteLink>)
    const link = screen.getByRole('link', { name: 'Line gateway' })
    expect(link).toHaveAttribute('href', '/gateways?search=gw-1')

    expect(click(link, { ctrlKey: true })).toBe(false)
    expect(onNavigate).not.toHaveBeenCalled()
    expect(click(link)).toBe(true)
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('goes to its address itself when no handler is given', () => {
    window.history.replaceState(null, '', '/cells')
    render(<RouteLink to="/gateways?search=gw-1">Line gateway</RouteLink>)
    click(screen.getByRole('link', { name: 'Line gateway' }))
    expect(window.location.pathname + window.location.search).toBe('/gateways?search=gw-1')
  })

  it('lets its own onClick stop the navigation', () => {
    const onNavigate = vi.fn()
    render(<RouteLink to="/cells" onClick={e => e.preventDefault()} onNavigate={onNavigate}>Bay</RouteLink>)
    click(screen.getByRole('link', { name: 'Bay' }))
    expect(onNavigate).not.toHaveBeenCalled()
  })
})
