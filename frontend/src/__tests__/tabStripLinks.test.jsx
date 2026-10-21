/**
 * The tab bar's tabs are links, because each tab has an address of its own: a plain click changes
 * tab in place, and Ctrl-click, middle-click and "Copy link address" work as they do on any link.
 * The arrow keys do nothing; `[` and `]` step between tabs from anywhere (tabShortcuts.test.jsx).
 */
import React from 'react'
import { act, createEvent, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { TabStrip } from '../components/common/TabStrip'
import { useUrlTab } from '../hooks/useUrlState'
import { stepPageTab } from '../shortcuts'

const TABS = [
  { id: 'registered', label: 'Registered', description: 'Devices admitted to Aber.' },
  { id: 'quarantine', label: 'Quarantine', description: 'Births nobody has registered.', attention: 3 },
]

/** A page's tab bar, wired the way every page wires it: the tab in the path. */
function Page({ keep = [] }) {
  const [view, setView, viewHref] = useUrlTab('devices', TABS.map(t => t.id), 'registered', { keep })
  return (
    <main>
      <TabStrip ariaLabel="Devices" value={view} onChange={setView} hrefFor={viewHref} tabs={TABS} />
      <p data-testid="shown">{view}</p>
    </main>
  )
}

const link = (name) => screen.getByRole('link', { name })

/** Fires a click and reports whether the page prevented the browser's own navigation. */
const click = (element, init = {}) => {
  const event = createEvent.click(element, { button: 0, ...init })
  fireEvent(element, event)
  return event.defaultPrevented
}

beforeEach(() => { window.history.replaceState(null, '', '/devices') })

describe('the tab bar', () => {
  it('is a navigation named for the page, of links to each tab\'s address', () => {
    render(<Page />)
    expect(screen.getByRole('navigation', { name: 'Devices' })).toHaveClass('tab-strip')
    expect(link('Registered')).toHaveAttribute('href', '/devices')
    expect(link('Quarantine, 3 waiting')).toHaveAttribute('href', '/devices/quarantine')
    expect(link('Registered')).toHaveAttribute('aria-current', 'page')
    expect(link('Quarantine, 3 waiting')).not.toHaveAttribute('aria-current')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('keeps the tooltip tied to the link, beside the waiting count in its name', () => {
    render(<Page />)
    expect(link('Quarantine, 3 waiting')).toHaveAccessibleDescription('Births nobody has registered.')
  })

  it('changes tab in place on a plain click, with a history entry, as a click did before', () => {
    render(<Page />)
    const depth = window.history.length
    expect(click(link('Quarantine, 3 waiting')), 'the browser was left to load the page').toBe(true)
    expect(window.location.pathname).toBe('/devices/quarantine')
    expect(window.history.length).toBe(depth + 1)
    expect(screen.getByTestId('shown')).toHaveTextContent('quarantine')
    expect(link('Quarantine, 3 waiting')).toHaveAttribute('aria-current', 'page')
  })

  it('runs the page\'s own onChange on a plain click, so its reset still happens', () => {
    const onChange = vi.fn()
    render(<TabStrip ariaLabel="Devices" value="registered" onChange={onChange} hrefFor={id => `/devices/${id}`} tabs={TABS} />)
    expect(click(link('Quarantine, 3 waiting'))).toBe(true)
    expect(onChange).toHaveBeenCalledWith('quarantine')
    expect(window.location.pathname).toBe('/devices')
  })

  it('goes to the tab\'s address itself when it is given no onChange', () => {
    render(<TabStrip ariaLabel="Devices" value="registered" hrefFor={id => `/devices/${id}`} tabs={TABS} />)
    expect(click(link('Quarantine, 3 waiting'))).toBe(true)
    expect(window.location.pathname).toBe('/devices/quarantine')
  })

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
    ['Shift', { shiftKey: true }],
    ['the middle button', { button: 1 }],
  ])('leaves a click with %s to the browser, which opens the tab elsewhere', (_, init) => {
    const onChange = vi.fn()
    render(<TabStrip ariaLabel="Devices" value="registered" onChange={onChange} hrefFor={id => `/devices/${id}`} tabs={TABS} />)
    expect(click(link('Quarantine, 3 waiting'), init)).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('makes each tab its own Tab-key stop, and does nothing on the arrow keys, Home or End', () => {
    const onChange = vi.fn()
    render(<TabStrip ariaLabel="Devices" value="registered" onChange={onChange} hrefFor={id => `/devices/${id}`} tabs={TABS} />)
    const registered = link('Registered')
    expect([registered, link('Quarantine, 3 waiting')].map(t => t.tabIndex)).toEqual([0, 0])
    act(() => registered.focus())
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      expect(fireEvent.keyDown(registered, { key }), `${key} was taken`).toBe(true)
    }
    expect(onChange).not.toHaveBeenCalled()
    expect(registered).toHaveFocus()
  })

  it('is what `]` steps through: the next link, clicked in place, then focused', () => {
    render(<Page />)
    const step = () => { let moved; act(() => { moved = stepPageTab(1) }); return moved }
    expect(step()).toBe(true)
    expect(window.location.pathname).toBe('/devices/quarantine')
    expect(link('Quarantine, 3 waiting')).toHaveFocus()
    expect(step(), 'stepped past the last tab').toBe(false)
  })
})

describe('useUrlTab\'s hrefFor', () => {
  it('is the bare page for the default tab, and the path segment for the others', () => {
    const { result } = renderHook(() => useUrlTab('devices', ['registered', 'quarantine'], 'registered'))
    const [, , hrefFor] = result.current
    expect(hrefFor('registered')).toBe('/devices')
    expect(hrefFor('quarantine')).toBe('/devices/quarantine')
  })

  it('carries the filters the page keeps across its tabs, and drops the rest, as setTab does', () => {
    window.history.replaceState(null, '', '/capture?stored=1&search=line&sort=-name')
    const { result } = renderHook(() => useUrlTab('capture', ['gateway', 'device'], 'gateway', { keep: ['stored', 'search'] }))
    const [, setTab, hrefFor] = result.current
    expect(hrefFor('device')).toBe('/capture/device?stored=1&search=line')
    act(() => setTab('device'))
    expect(window.location.pathname + window.location.search).toBe(hrefFor('device'))
  })

  it('follows the address, so a link copied after a filter changes carries the new filter', () => {
    window.history.replaceState(null, '', '/capture?search=a')
    const { result } = renderHook(() => useUrlTab('capture', ['gateway', 'device'], 'gateway', { keep: ['search'] }))
    expect(result.current[2]('device')).toBe('/capture/device?search=a')
    act(() => { window.history.replaceState(null, '', '/capture?search=b'); window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(result.current[2]('device')).toBe('/capture/device?search=b')
  })
})
