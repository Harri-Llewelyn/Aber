/**
 * The nav and the router have to agree about which tabs exist.
 *
 * THE BUG THIS EXISTS FOR, WHICH SHIPPED. A tab is declared twice: once in `TABS` (App.jsx), which
 * decides what the nav RENDERS, and once in `VALID_TABS` (constants.js), which decides what the
 * router ACCEPTS -- `handleNavClick` returns early on an id it does not recognise.
 *
 * Adding the Settings tab to `TABS` and forgetting `VALID_TABS` produced a tab that rendered in
 * the nav, highlighted on hover, and did nothing at all when clicked. No error, no console
 * warning, no route change, no failing test. It looked shipped and was unreachable, and it was
 * found by a person clicking it rather than by anything in CI.
 *
 * There is no way to make one list derive from the other without moving `TABS` out of App.jsx
 * (it holds JSX icons) or moving the router's allow-list into it (constants.js deliberately
 * imports no components). So the two stay separate and this asserts they match -- which is the
 * same arrangement, and the same reasoning, as the DIGITAL_THREAD_ACTIONS allow-list in
 * constants.js.
 */
import { describe, it, expect } from 'vitest'
import { TABS } from '../App'
import { VALID_TABS } from '../constants'

describe('the nav and the router agree', () => {
  it('accepts every tab the nav renders', () => {
    /*
     * THE DIRECTION THAT FAILED. A tab here and not in VALID_TABS is a dead button: the click is
     * silently discarded by handleNavClick, so nothing anywhere reports it.
     */
    const unreachable = TABS.map(t => t.id).filter(id => !VALID_TABS.includes(id))
    expect(unreachable).toEqual([])
  })

  it('renders every tab the router accepts', () => {
    /*
     * The mirror image, and its failure is quieter still: an id the router accepts but the nav
     * never offers is reachable only by typing the URL, so it is a page with no way in. Worth
     * catching because it usually means a tab was REMOVED from TABS and left in VALID_TABS.
     */
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

  it('gates the Settings tab on the Administrator role rather than a permission', () => {
    /*
     * NOT A STYLE PREFERENCE. Migration 0031's UPDATE policy is
     * `has_role(ARRAY['Administrator'])`, so gating the UI on a permission uuid would put two
     * different predicates on the same question. The day they disagree, the tab is visible and
     * every save fails with a database error the page cannot explain.
     */
    const settings = TABS.find(t => t.id === 'settings')
    expect(settings).toBeTruthy()
    expect(settings.role).toBe('Administrator')
    expect(settings.permission).toBeUndefined()
  })
})
