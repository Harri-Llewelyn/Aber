/**
 * The nav and the router have to agree about which tabs exist. A tab is declared in `TABS` (what
 * the nav renders) and in `VALID_TABS` (what the router accepts, since `handleNavClick` returns
 * early on an unknown id), and neither can derive from the other without constants.js importing
 * components. A tab in one and not the other is a dead button with no error.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { TABS, tabIsVisible } from '../navigation'
import { VALID_TABS } from '../constants'
import { useAppRouting } from '../hooks/useAppRouting'

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
})
