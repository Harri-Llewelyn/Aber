import { describe, it, expect } from 'vitest'
import { NAV_GROUPS, TABS, tabIsVisible, groupedNav } from '../navigation'
import { VALID_TABS, PERMISSION_UUIDS } from '../constants'
import { CARDS, PAGE_KEYWORDS } from '../searchIndex'

/**
 * The navigation model. What is guarded is the grouping: a page in the wrong group, or in a group
 * that does not exist, is reachable and filed where nobody looks for it, which no screenshot shows.
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
   * The groups carry no caption: a heading would have to hold its box in the collapsed rail,
   * leaving blank strips in the resting state. Asserted as an absence because a `label`
   * reintroduced here would render nothing.
   */
  it('carries no caption to render', () => {
    for (const group of NAV_GROUPS) {
      expect(group.label, `the "${group.id}" group declares a caption nothing renders`).toBeUndefined()
    }
  })

  /**
   * The two placements pinned so they are not re-litigated by accident. Archives is filed with the
   * assets it archives, not the admin pages, because grouping by who may see a page would make the
   * group mean "restricted". Digital Thread traces cells, gateways and devices equally, so it is
   * filed by tense with Capture and Cold Storage.
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
   * The case the function exists for: an Operator sees neither administration page, and a separator
   * with nothing under it reads as a page that failed to load.
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
 * The three lists that must agree about what a page is: `TABS` decides what the rail draws,
 * `VALID_TABS` what the router accepts, and `PAGE_KEYWORDS` what the search can find. Each
 * disagreement is silent in a different way.
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

  describe('a page nobody may read is not offered', () => {
    const tab = (id) => TABS.find(t => t.id === id)
    const holding = (...ids) => (uuid) => ids.includes(uuid)

    it('hides the Digital Thread from a role without digital_thread:read', () => {
      // The Operator dead end: `digital_thread` has its own RLS and returns no rows without the
      // permission, so the page rendered an empty table.
      expect(tabIsVisible(tab('digital-thread'), holding(PERMISSION_UUIDS.PROPOSAL_CREATE), 'Operator')).toBe(false)
    })

    it('shows it to the three roles the policy admits', () => {
      const canRead = holding(PERMISSION_UUIDS.DIGITAL_THREAD_READ)
      for (const role of ['Administrator', 'Shopfloor_Manager', 'Auditor']) {
        expect(tabIsVisible(tab('digital-thread'), canRead, role), role).toBe(true)
      }
    })

    it('gates it on the permission rather than on a list of role names', () => {
      // One predicate deciding visibility and access: a role list here would be a second opinion
      // beside the RLS policy.
      expect(tab('digital-thread').permission).toBe(PERMISSION_UUIDS.DIGITAL_THREAD_READ)
      expect(tab('digital-thread').role).toBeUndefined()
    })
  })
})
