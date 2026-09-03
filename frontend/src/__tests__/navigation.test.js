import { describe, it, expect } from 'vitest'
import { NAV_GROUPS, TABS, tabIsVisible, groupedNav } from '../navigation'
import { VALID_TABS } from '../constants'
import { CARDS, PAGE_KEYWORDS } from '../searchIndex'

/**
 * The navigation model.
 *
 * THIS FILE REPLACES `navDensity.test.js`, WHICH GUARDED A CEILING THAT NO LONGER EXISTS. That
 * suite pinned the top bar's density bands -- the arithmetic that kept thirteen tabs and a wordmark
 * in one 52px row, and which ran out at fourteen. A vertical rail has no such ceiling, so there is
 * no threshold left to get wrong, and the bands, the two media queries behind them and the function
 * that stamped them are all gone.
 *
 * WHAT REPLACED THE CEILING AS THE THING WORTH GUARDING IS THE GROUPING. A page in the wrong group,
 * or in a group that does not exist, is the new version of the old failure: the page is still
 * reachable and is filed where nobody looks for it. None of that is visible in a screenshot, which
 * is exactly why it is asserted here.
 */

describe('the groups', () => {

  it('files every page in a group that exists', () => {
    const known = new Set(NAV_GROUPS.map(g => g.id))
    for (const tab of TABS) {
      expect(tab.group, `${tab.id} declares no group`).toBeTruthy()
      expect(known, `${tab.id} is in an undeclared group "${tab.group}"`).toContain(tab.group)
    }
  })

  it('uses every group it declares', () => {
    // A declared group nothing is filed under renders as nothing at all -- `groupedNav` drops it --
    // so it would be a separator's worth of intent with no way to see it had stopped working.
    const used = new Set(TABS.map(t => t.group))
    for (const group of NAV_GROUPS) {
      expect(used, `the "${group.id}" group holds no pages`).toContain(group.id)
    }
  })

  it('leads with Overview alone', () => {
    // The landing page, and the one page that answers "how is everything right now" rather than
    // belonging to a subject.
    expect(TABS.filter(t => t.group === NAV_GROUPS[0].id).map(t => t.id)).toEqual(['overview'])
  })

  /**
   * THE GROUPS CARRY NO CAPTION, and their absence is a decision rather than an oversight.
   *
   * They were rendered as headings -- Assets, Modelling, History, Administration -- and each had to
   * hold its box in the COLLAPSED rail so the items below it did not jump on hover. So the resting
   * state, which is the state the rail is in almost all of the time, carried four blank strips whose
   * only purpose was to be somewhere for text to appear later. The separator alone says the one
   * thing a reader needs from a rail of icons.
   *
   * Asserted as an absence because a `label` reintroduced here would render nothing -- the Sidebar
   * no longer reads one -- which is the worst of both: data that looks live and is not.
   */
  it('carries no caption to render', () => {
    for (const group of NAV_GROUPS) {
      expect(group.label, `the "${group.id}" group declares a caption nothing renders`).toBeUndefined()
    }
  })

  /**
   * The two placements the grouping was argued over, pinned so the argument is not re-litigated by
   * accident. Both are cases where the OBVIOUS home is the wrong one:
   *
   *   Archives is permission-gated, so it looks like an administration page. It lists archived
   *   cells, gateways and devices -- the same three subjects as the pages above it, at the end of
   *   their life. Grouping by who may SEE a page rather than what it is ABOUT would drag Capture
   *   and Cold Storage in too, and then the group means "restricted" and nothing else.
   *
   *   Digital Thread traces devices, so it looks like it belongs beside them. It traces cells and
   *   gateways equally, so filing it under any one subject is a claim about which it belongs to.
   *   What it shares with Capture and Cold Storage is the TENSE.
   */
  it('files Archives with the assets it archives, not with the admin pages', () => {
    expect(TABS.find(t => t.id === 'archives').group).toBe('assets')
  })

  it('files Digital Thread by tense rather than by subject', () => {
    expect(TABS.find(t => t.id === 'digital-thread').group).toBe('history')
  })
})

describe('groupedNav', () => {

  const admin = () => TABS.filter(t => tabIsVisible(t, () => true, 'Administrator'))
  const operator = () => TABS.filter(t => tabIsVisible(t, () => false, 'Operator'))

  it('keeps the declared order rather than the order pages happen to be in', () => {
    const ids = groupedNav(admin()).map(g => g.id)
    expect(ids).toEqual(NAV_GROUPS.map(g => g.id))
  })

  it('shows an Administrator every page exactly once', () => {
    const flat = groupedNav(admin()).flatMap(g => g.tabs.map(t => t.id))
    expect(flat).toHaveLength(TABS.length)
    expect(new Set(flat).size).toBe(TABS.length)
  })

  /**
   * THE CASE THE FUNCTION EXISTS FOR. An Operator sees neither administration page, so that group
   * has no members -- and a heading with a separator and nothing under it reads as a page that
   * failed to load rather than as a page they may not have.
   */
  it('drops a group whose every page this session is refused', () => {
    const groups = groupedNav(operator())
    expect(groups.map(g => g.id)).not.toContain('admin')
    for (const group of groups) {
      expect(group.tabs.length).toBeGreaterThan(0)
    }
  })

  it('returns nothing at all rather than a row of empty headings', () => {
    expect(groupedNav([])).toEqual([])
  })
})

/**
 * The three lists that must agree about what a page is.
 *
 * `TABS` decides what the rail draws, `VALID_TABS` decides what the router will accept, and
 * `PAGE_KEYWORDS` decides what the search can find. Each is a separate literal, and each failure of
 * agreement is silent in a different way: a page in TABS and not VALID_TABS is a nav item whose
 * click does nothing, a page in VALID_TABS and not TABS is a URL that renders a blank screen, and a
 * keyword entry for a page that no longer exists is dead weight nothing will ever match.
 */
describe('the page id lists agree', () => {

  it('routes every page the rail offers', () => {
    for (const tab of TABS) {
      expect(VALID_TABS, `${tab.id} is in the rail but not routable`).toContain(tab.id)
    }
  })

  it('offers every page it will route to', () => {
    const ids = new Set(TABS.map(t => t.id))
    for (const id of VALID_TABS) {
      expect(ids, `/${id} is routable but is in no group`).toContain(id)
    }
  })

  it('has search keywords only for pages that exist', () => {
    const ids = new Set(TABS.map(t => t.id))
    for (const id of Object.keys(PAGE_KEYWORDS)) {
      expect(ids, `PAGE_KEYWORDS names "${id}", which is not a page`).toContain(id)
    }
  })

  it('indexes every card against a page that exists', () => {
    const ids = new Set(TABS.map(t => t.id))
    for (const card of CARDS) {
      expect(ids, `the "${card.label}" card claims to be on "${card.tab}"`).toContain(card.tab)
    }
  })

  it('gives every card a unique id', () => {
    const ids = CARDS.map(c => c.id)
    expect(new Set(ids).size, 'two cards share an id, so one is unreachable by key').toBe(ids.length)
  })
})
