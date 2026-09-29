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

  it('leads with the Site Map alone', () => {
    // The landing page, and the one page that answers "how is everything right now" rather than
    // belonging to a subject.
    expect(TABS.filter(t => t.group === NAV_GROUPS[0].id).map(t => t.id)).toEqual(['site-map'])
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
   * The placements pinned so they are not re-litigated by accident. Audit Trail traces cells,
   * gateways and devices equally, so it is filed by tense with Capture rather than beside Devices.
   */
  it('files Audit Trail by tense rather than by subject', () => {
    expect(TABS.find(t => t.id === 'audit-trail').group).toBe('history')
  })

  /**
   * The retention group is a subject, not a permission level: each page runs a retention timer
   * over something and offers a way back from it. Asserted as the whole membership, because the
   * group only means that while all three are in it -- drop one and what is left reads as
   * "the Administrator pages", which is the grouping this replaced.
   */
  it('groups the three pages that keep something against a timer', () => {
    const retention = TABS.filter(t => t.group === 'retention').map(t => t.id)
    expect(retention).toEqual(['cold-storage', 'backups', 'archives'])
  })

  /**
   * Archived Entities and Cold Storage are neighbours, and before that they were three groups
   * apart with a comment explaining that the distance was what told them apart. The label is now
   * carrying that job, so a rename back to the bare "Archives" would silently undo it.
   */
  it('keeps Archived Entities named for what it holds, beside Cold Storage', () => {
    expect(TABS.find(t => t.id === 'archives').label).toBe('Archived Entities')
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
   * The case the function exists for: an Operator holds none of the three retention pages -- Cold
   * Storage admits three roles and not theirs, Backups is Administrator, Archived Entities needs
   * `archive:manage` -- so the whole group goes, and a separator with nothing under it never
   * renders. `admin` is no longer the example: Directory is ungated and keeps it alive.
   */
  it('drops a group whose every page this session is refused', () => {
    const groups = groupedNav(operator())
    expect(groups.map(g => g.id)).not.toContain('retention')
    for (const group of groups) {
      expect(group.tabs.length).toBeGreaterThan(0)
    }
  })

  /**
   * The other half of the same move: a group with one visible page still renders. Directory tells
   * anyone where Grafana and Node-RED are, so filing it with the two Administrator pages must not
   * gate it by association.
   */
  it('keeps a group alive for its one ungated page', () => {
    const admin = groupedNav(operator()).find(g => g.id === 'admin')
    expect(admin?.tabs.map(t => t.id)).toEqual(['directory'])
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

    it('hides the Audit Trail from a role without audit_trail:read', () => {
      // The Operator dead end: `audit_trail` has its own RLS and returns no rows without the
      // permission, so the page rendered an empty table.
      expect(tabIsVisible(tab('audit-trail'), holding(PERMISSION_UUIDS.PROPOSAL_CREATE), 'Operator')).toBe(false)
    })

    it('shows it to the three roles the policy admits', () => {
      const canRead = holding(PERMISSION_UUIDS.AUDIT_TRAIL_READ)
      for (const role of ['Administrator', 'Shopfloor_Manager', 'Auditor']) {
        expect(tabIsVisible(tab('audit-trail'), canRead, role), role).toBe(true)
      }
    })

    it('gates it on the permission rather than on a list of role names', () => {
      // One predicate deciding visibility and access: a role list here would be a second opinion
      // beside the RLS policy.
      expect(tab('audit-trail').permission).toBe(PERMISSION_UUIDS.AUDIT_TRAIL_READ)
      expect(tab('audit-trail').role).toBeUndefined()
    })
  })
})
