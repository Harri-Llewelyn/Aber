/**
 * The nav and the router have to agree about which tabs exist. A tab is declared in `TABS` (what
 * the nav renders) and in `VALID_TABS` (what the router accepts, since `handleNavClick` returns
 * early on an unknown id), and neither can derive from the other without constants.js importing
 * components. A tab in one and not the other is a dead button with no error.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { TABS, pageTabsOf, tabIsVisible } from '../navigation'
import { VALID_TABS } from '../constants'
import { MOVED_PAGES, movedUrl, useAppRouting, tabFromUrl } from '../hooks/useAppRouting'

describe('the nav and the router agree', () => {
  it('accepts every tab the nav renders', () => {
    /* A tab here and not in VALID_TABS is a dead button: the click is silently discarded. */
    const unreachable = TABS.map(t => t.id).filter(id => !VALID_TABS.includes(id))
    expect(unreachable).toEqual([])
  })

  it('renders every tab the router accepts', () => {
    /* The mirror image: an id the router accepts but the nav never offers is a page with no way in,
       usually a tab removed from TABS and left in VALID_TABS. */
    const unreachable = VALID_TABS.filter(id => !TABS.some(t => t.id === id))
    expect(unreachable).toEqual([])
  })

  it('gives every tab a label and an icon', () => {
    // A tab with no label renders as an empty button, which is the same "looks broken, reports
    // nothing" class of failure.
    for (const t of TABS) {
      expect(t.id, `tab ${JSON.stringify(t)} has no id`).toBeTruthy()
      expect(t.label, `tab ${t.id} has no label`).toBeTruthy()
      expect(t.icon, `tab ${t.id} has no icon`).toBeTruthy()
    }
  })

  it('declares no duplicate tab ids', () => {
    expect(new Set(TABS.map(t => t.id)).size).toBe(TABS.length)
    expect(new Set(VALID_TABS).size).toBe(VALID_TABS.length)
  })

  it('hides a role-gated tab from the wrong role and shows it to the right one', () => {
    const accessControl = TABS.find(t => t.id === 'access-control')
    const never = () => false
    expect(tabIsVisible(accessControl, never, 'Administrator')).toBe(true)
    expect(tabIsVisible(accessControl, never, 'Operator')).toBe(false)
    // Null while the permission fetch is in flight. The nav hiding it briefly is harmless; what
    // must NOT happen is App redirecting on this, which is why that effect waits for loadingPerms.
    expect(tabIsVisible(accessControl, never, null)).toBe(false)
  })

  it('leaves an ungated tab visible to everyone', () => {
    // The Site Map is where App sends a user whose current tab became invisible, so it must never be
    // gated -- a redirect target that can itself be hidden is a redirect loop.
    const siteMap = TABS.find(t => t.id === 'site-map')
    expect(siteMap.role).toBeUndefined()
    expect(siteMap.permission).toBeUndefined()
    expect(tabIsVisible(siteMap, () => false, null)).toBe(true)
  })

  it('still honours a permission-gated tab, which was dead code until Settings was added', () => {
    /* `tabIsVisible` is what makes the role gate work; this pins that the permission branch
       survives. */
    const archives = TABS.find(t => t.id === 'archives')
    expect(archives.permission).toBeTruthy()
    expect(tabIsVisible(archives, uuid => uuid === archives.permission, 'Operator')).toBe(true)
    expect(tabIsVisible(archives, () => false, 'Operator')).toBe(false)
  })

  it('shows the Settings tab to every role, since every role may read a setting', () => {
    /* The SELECT policy admits every signed-in account to the rows not marked `sensitive`; the
       UPDATE policy is the Administrator gate, and the page is read-only for anyone else. */
    const settings = TABS.find(t => t.id === 'settings')
    expect(settings).toBeTruthy()
    expect(settings.role).toBeUndefined()
    expect(settings.permission).toBeUndefined()
    for (const role of ['Administrator', 'Shopfloor_Manager', 'Operator', 'Auditor']) {
      expect(tabIsVisible(settings, () => false, role), role).toBe(true)
    }
  })
})

describe('an unknown address', () => {
  afterEach(() => window.history.replaceState({}, '', '/'))

  it('opens the Site Map and rewrites the address without its query', () => {
    window.history.replaceState({}, '', '/no-such-page?x=1')
    const { result } = renderHook(() => useAppRouting())
    expect(result.current.tab).toBe('site-map')
    expect(window.location.pathname + window.location.search).toBe('/site-map')
  })

  it('tests for the sign-in callback\'s own parameters by name, not by substring', () => {
    // supabase-js reads `code` and `state` from the address, so those stay where they are.
    window.history.replaceState({}, '', '/?code=abc&state=xyz')
    renderHook(() => useAppRouting())
    expect(window.location.search).toBe('?code=abc&state=xyz')

    // A parameter that merely contains the word is not the callback.
    window.history.replaceState({}, '', '/no-such-page?show_state=1')
    renderHook(() => useAppRouting())
    expect(window.location.pathname + window.location.search).toBe('/site-map')
  })
})

/**
 * The System page was Directory until 1.8. Bookmarks, and links in old help and notes, name
 * `/directory` and its tabs, so each still lands on the same view of System.
 */
describe('a page that moved', () => {
  afterEach(() => window.history.replaceState({}, '', '/'))

  // The bare page, each tab navigation.jsx declares, and the tab the page adds for a stray type.
  const OLD_PATHS = ['/directory', ...pageTabsOf('system').map(t => `/directory/${t.id}`), '/directory/other']
  const renamed = (old) => `/system${old.slice('/directory'.length)}`

  it.each(OLD_PATHS)('sends %s to System, replacing the entry so Back skips it', (old) => {
    window.history.replaceState({}, '', old)
    const push = vi.spyOn(window.history, 'pushState')
    const { result } = renderHook(() => useAppRouting())
    expect(result.current.tab).toBe('system')
    expect(window.location.pathname + window.location.search).toBe(renamed(old))
    expect(push).not.toHaveBeenCalled()
    push.mockRestore()
  })

  it.each(OLD_PATHS)('keeps the query string of %s', (old) => {
    window.history.replaceState({}, '', `${old}?sort=-reach&note=a%20b`)
    const { result } = renderHook(() => useAppRouting())
    expect(result.current.tab).toBe('system')
    expect(window.location.pathname + window.location.search).toBe(`${renamed(old)}?sort=-reach&note=a%20b`)
  })

  it('opens System while the old address is still in the bar, so no other page mounts first', () => {
    expect(tabFromUrl('/directory')).toBe('system')
    expect(tabFromUrl('/directory/ingestion?sort=name')).toBe('system')
  })

  it('moves the first segment only, and nothing that merely resembles it', () => {
    expect(movedUrl('/directory/ingestion?sort=name')).toBe('/system/ingestion?sort=name')
    expect(movedUrl('/system/ingestion')).toBeNull()
    expect(movedUrl('/devices/directory')).toBeNull()
    expect(movedUrl('/directory-old')).toBeNull()
    expect(movedUrl('/constructor')).toBeNull()
    expect(movedUrl('/')).toBeNull()
  })

  it('moves each old name to a page the router accepts, and no live page away', () => {
    for (const [from, to] of MOVED_PAGES) {
      expect(VALID_TABS).toContain(to)
      expect(VALID_TABS).not.toContain(from)
    }
  })
})

describe('the page in the address', () => {
  it('is the first path segment; the rest belongs to the page', () => {
    expect(tabFromUrl('/devices/quarantine?search=x')).toBe('devices')
    expect(tabFromUrl('/access-control/roles')).toBe('access-control')
    expect(tabFromUrl('/settings')).toBe('settings')
    expect(tabFromUrl('/nowhere/devices')).toBe('site-map')
    expect(tabFromUrl('/')).toBe('site-map')
  })

  it('leaves a deep link alone, tab, filters and all', () => {
    window.history.replaceState({}, '', '/devices/quarantine?search=held')
    const { result } = renderHook(() => useAppRouting())
    expect(result.current.tab).toBe('devices')
    expect(window.location.pathname + window.location.search).toBe('/devices/quarantine?search=held')
  })

  it('follows Back, even while the sign-in callback\'s parameters are in the address', async () => {
    window.history.replaceState({}, '', '/devices?code=abc')
    const { result } = renderHook(() => useAppRouting())
    act(() => result.current.setTab('gateways'))
    expect(result.current.tab).toBe('gateways')
    act(() => { window.history.back() })
    await waitFor(() => expect(result.current.tab).toBe('devices'))
  })

  it('opens a page fresh from a nav click, and with its filters from a drill-down', () => {
    window.history.replaceState({}, '', '/devices?search=x')
    const { result } = renderHook(() => useAppRouting())
    act(() => result.current.handleNavClick('gateways'))
    expect(window.location.pathname + window.location.search).toBe('/gateways')
    act(() => result.current.setTab('devices', { schema: 'sch-1' }))
    expect(window.location.pathname + window.location.search).toBe('/devices?schema=sch-1')
  })

  it('rewrites the entry for a redirect the person did not ask for', () => {
    window.history.replaceState({}, '', '/settings')
    const push = vi.spyOn(window.history, 'pushState')
    const { result } = renderHook(() => useAppRouting())
    act(() => result.current.setTab('site-map', {}, { replace: true }))
    expect(push).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe('/site-map')
    push.mockRestore()
  })
})
