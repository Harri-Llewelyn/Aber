import React from 'react'
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { Sidebar, RAIL_OPEN_DELAY_MS } from '../components/common/Sidebar'
import { useSidebarMode, SIDEBAR_MODES, SIDEBAR_MODE_KEY } from '../hooks/useSidebarMode'
import { TABS, tabIsVisible } from '../navigation'

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8').replace(/\r\n/g, '\n')

// The rail's pages. Profile has no group: the account menu at the rail's foot is its way in.
const adminTabs = () => TABS.filter(t => t.group && tabIsVisible(t, () => true, 'Administrator'))
const rail = () => document.querySelector('.sidebar')
const isExpanded = () => rail().classList.contains('sidebar-expanded')

const renderRail = (props = {}) => {
  const onChangeMode = vi.fn()
  render(<Sidebar tabs={adminTabs()} currentTab="site-map" onNavigate={vi.fn()} mode="hover" onChangeMode={onChangeMode} {...props} />)
  return onChangeMode
}

beforeEach(() => localStorage.clear())

describe('the three behaviours', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const rest = () => act(() => { vi.advanceTimersByTime(RAIL_OPEN_DELAY_MS) })

  it('hover: collapsed at rest, open once the pointer rests on it', () => {
    renderRail({ mode: 'hover' })
    expect(isExpanded()).toBe(false)
    fireEvent.mouseEnter(rail())
    expect(isExpanded()).toBe(false)
    rest()
    expect(isExpanded()).toBe(true)
    fireEvent.mouseLeave(rail())
    expect(isExpanded()).toBe(false)
  })

  it('expanded: open at rest, and the pointer leaving changes nothing', () => {
    renderRail({ mode: 'expanded' })
    expect(isExpanded()).toBe(true)
    expect(rail().classList.contains('sidebar-mode-expanded')).toBe(true)
    fireEvent.mouseEnter(rail())
    fireEvent.mouseLeave(rail())
    expect(isExpanded()).toBe(true)
  })

  it('collapsed: the pointer does nothing, however long it rests', () => {
    renderRail({ mode: 'collapsed' })
    fireEvent.mouseEnter(rail())
    rest()
    expect(isExpanded()).toBe(false)
  })

  it('collapsed: keyboard focus still shows the labels, because Tab has no hover', () => {
    renderRail({ mode: 'collapsed' })
    fireEvent.focus(screen.getByRole('link', { name: 'Devices' }))
    expect(isExpanded()).toBe(true)
    fireEvent.blur(screen.getByRole('link', { name: 'Devices' }))
    expect(isExpanded()).toBe(false)
  })
})

/* The layout is chosen in the account menu (navigationShell.test.jsx) and on Profile, not at the
   rail's foot, whose second slot is Collapse all tabs (sidebarTabs.test.jsx). */
describe('the foot of the rail', () => {
  it('holds no layout control, and no menu of layouts', () => {
    renderRail({ mode: 'hover' })
    expect(screen.queryByRole('button', { name: /Sidebar behaviour|Sidebar layout/ })).toBeNull()
    expect(screen.queryByRole('menuitemradio')).toBeNull()
    for (const m of SIDEBAR_MODES) expect(screen.queryByText(m.description)).toBeNull()
  })

  it('is not a navigation item, so the page list stays the page list', () => {
    renderRail()
    const items = document.querySelectorAll('.sidebar-item')
    expect(items).toHaveLength(adminTabs().length)
  })
})

describe('the preference', () => {
  it('defaults to hover and persists per browser', () => {
    const { result } = renderHook(() => useSidebarMode())
    expect(result.current.mode).toBe('hover')
    act(() => result.current.setMode('expanded'))
    expect(result.current.mode).toBe('expanded')
    expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('expanded')
  })

  it('is read back on the next load, and an unknown value falls back to hover', () => {
    localStorage.setItem(SIDEBAR_MODE_KEY, 'collapsed')
    expect(renderHook(() => useSidebarMode()).result.current.mode).toBe('collapsed')
    localStorage.setItem(SIDEBAR_MODE_KEY, 'sideways')
    expect(renderHook(() => useSidebarMode()).result.current.mode).toBe('hover')
  })

  it('ignores a value that is not a mode', () => {
    const { result } = renderHook(() => useSidebarMode())
    act(() => result.current.setMode('sideways'))
    expect(result.current.mode).toBe('hover')
  })
})

describe('the stylesheet', () => {
  it('widens the gutter itself in expanded mode, so the page makes room', () => {
    // Hover mode paints over the page from a rigid 52px gutter; expanded mode is the one case
    // where reflow is wanted, once, when the preference changes.
    const rule = APP_CSS.match(/\n\.sidebar-mode-expanded \{([\s\S]*?)\n\}/)[1]
    expect(rule).toMatch(/flex-basis:\s*232px/)
    const panel = APP_CSS.match(/\n\.sidebar-mode-expanded \.sidebar-panel \{([\s\S]*?)\n\}/)[1]
    expect(panel).toMatch(/box-shadow:\s*none/)
  })

  it('gives the account control the same ground as Collapse all tabs beside it', () => {
    const avatar = APP_CSS.match(/\n\.user-avatar \{([\s\S]*?)\n\}/)[1]
    const account = APP_CSS.match(/\n\.user-menu-button \{([\s\S]*?)\n\}/)[1]
    const collapseAll = APP_CSS.match(/\n\.sidebar-collapse-all \{([\s\S]*?)\n\}/)[1]
    expect(avatar).toMatch(/background:\s*none/)
    expect(account).toMatch(/background:\s*none/)
    expect(collapseAll).toMatch(/background:\s*none/)
  })
})
