/**
 * The nav and the router have to agree about which tabs exist. A tab is declared in `TABS` (what
 * the nav renders) and in `VALID_TABS` (what the router accepts, since `handleNavClick` returns
 * early on an unknown id), and neither can derive from the other without constants.js importing
 * components. A tab in one and not the other is a dead button with no error.
 */
import { describe, it, expect } from 'vitest'
import { TABS, tabIsVisible } from '../App'
import { VALID_TABS } from '../constants'

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
    const settings = TABS.find(t => t.id === 'settings')
    const never = () => false
    expect(tabIsVisible(settings, never, 'Administrator')).toBe(true)
    expect(tabIsVisible(settings, never, 'Operator')).toBe(false)
    // Null while the permission fetch is in flight. The nav hiding it briefly is harmless; what
    // must NOT happen is App redirecting on this, which is why that effect waits for loadingPerms.
    expect(tabIsVisible(settings, never, null)).toBe(false)
  })

  it('leaves an ungated tab visible to everyone', () => {
    // Overview is where App sends a user whose current tab became invisible, so it must never be
    // gated -- a redirect target that can itself be hidden is a redirect loop.
    const overview = TABS.find(t => t.id === 'overview')
    expect(overview.role).toBeUndefined()
    expect(overview.permission).toBeUndefined()
    expect(tabIsVisible(overview, () => false, null)).toBe(true)
  })

  it('still honours a permission-gated tab, which was dead code until Settings was added', () => {
    /* `tabIsVisible` is what makes the role gate work; this pins that the permission branch
       survives. */
    const archives = TABS.find(t => t.id === 'archives')
    expect(archives.permission).toBeTruthy()
    expect(tabIsVisible(archives, uuid => uuid === archives.permission, 'Operator')).toBe(true)
    expect(tabIsVisible(archives, () => false, 'Operator')).toBe(false)
  })

  it('gates the Settings tab on the Administrator role rather than a permission', () => {
    /* The settings UPDATE policy is `has_role(ARRAY['Administrator'])`, so gating the UI on a
       permission uuid would put two predicates on the same question. */
    const settings = TABS.find(t => t.id === 'settings')
    expect(settings).toBeTruthy()
    expect(settings.role).toBe('Administrator')
    expect(settings.permission).toBeUndefined()
  })
})
