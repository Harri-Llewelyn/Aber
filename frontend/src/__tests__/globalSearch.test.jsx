import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { buildTargets, matchTargets, scoreTarget, CARDS } from '../searchIndex'
import { TABS, tabIsVisible } from '../navigation'

/**
 * The global search.
 *
 * IT ANSWERS THREE QUESTIONS AND THEY FAIL IN THREE DIFFERENT WAYS, which is why this suite is
 * split the way it is:
 *
 *   The RANKING is pure and is tested as arithmetic. Its failure is silent -- a result list that is
 *   merely in a worse order still looks like it works, and only stops being useful.
 *
 *   The ID LOOKUP is asynchronous and races itself. Its failure is a palette showing the asset for
 *   an id that is no longer in the box, which is worse than showing nothing.
 *
 *   The VISIBILITY of what can be found has to match the rail exactly. Its failure is offering an
 *   Operator a page the rail does not, which is a signpost to a blank screen.
 */

vi.mock('../api', () => ({
  api: { resolveId: vi.fn(), searchAssets: vi.fn() }
}))

import { api } from '../api'
import { GlobalSearch } from '../components/common/GlobalSearch'

const adminTabs = () => TABS.filter(t => tabIsVisible(t, () => true, 'Administrator'))
const targets = () => buildTargets(adminTabs())

const labels = (query, limit) => matchTargets(query, targets(), limit).map(t => t.label)

// =================================================================================================
describe('what the index holds', () => {

  it('takes the pages it is given rather than filtering them again', () => {
    // ONE PREDICATE DECIDES VISIBILITY, and it is `tabIsVisible` in navigation.jsx. A second copy
    // here would be a second answer to the same question, and the day the two disagree the palette
    // offers a page the rail does not.
    const operator = TABS.filter(t => tabIsVisible(t, () => false, 'Operator'))
    const found = buildTargets(operator).map(t => t.tabId)

    expect(found).not.toContain('settings')
    expect(found).not.toContain('access-control')
    expect(found).toContain('overview')
  })

  it('drops a card whose page this session cannot open', () => {
    // A card inherits its page's visibility and cannot narrow it further. Runtime configuration is
    // on Settings, which an Operator does not have.
    const operator = buildTargets(TABS.filter(t => tabIsVisible(t, () => false, 'Operator')))
    expect(operator.map(t => t.label)).not.toContain('Runtime configuration')

    expect(targets().map(t => t.label)).toContain('Runtime configuration')
  })

  it('tells a card which page it is on, because that is the answer being looked for', () => {
    const catalog = targets().find(t => t.label === 'Metric Catalog')
    expect(catalog.kind).toBe('card')
    expect(catalog.page).toBe('Schemas')
  })
})

// =================================================================================================
describe('ranking', () => {

  /**
   * THE CASE THE FEATURE WAS ASKED FOR. "Metric Catalog" is a card on the Schemas page, and nothing
   * about the word "Schemas" says so -- which is exactly why a reader who wants it cannot find it
   * from the navigation alone.
   */
  it('finds a card by its own name, from a prefix', () => {
    expect(labels('metric')[0]).toBe('Metric Catalog')
    expect(labels('metric cat')[0]).toBe('Metric Catalog')
  })

  it('finds it by initials, which is what a second visit types', () => {
    expect(labels('mc')).toContain('Metric Catalog')
  })

  it('puts an exact name first, above anything that merely contains it', () => {
    expect(labels('devices')[0]).toBe('Devices')
  })

  /**
   * A word-start beats a mid-word substring, and the ordering is the whole design of the bands:
   * "cat" must offer Metric Catalog above Access Control even though the letters appear in both.
   */
  it('prefers a word boundary to a match buried inside a word', () => {
    const catalog = targets().find(t => t.label === 'Metric Catalog')
    const access = targets().find(t => t.label === 'Access Control')
    expect(scoreTarget(catalog, 'cat')).toBeGreaterThan(scoreTarget(access, 'cat'))
  })

  it('prefers a name to a keyword, because a keyword is somebody else guessing what you meant', () => {
    const settings = targets().find(t => t.label === 'Settings')
    const schemas = targets().find(t => t.label === 'Schemas')
    // 'config' is a Settings keyword and appears in no label at all.
    expect(scoreTarget(settings, 'config')).toBeGreaterThan(0)
    expect(scoreTarget(schemas, 'config')).toBe(0)
  })

  /**
   * The keywords earn their place on the pages nobody guesses the name of. "Digital Thread" is a
   * phrase a first-time reader does not have; "audit" is the word they arrive with.
   */
  it('finds a page by the word the job uses rather than the word the UI uses', () => {
    expect(labels('audit')).toContain('Digital Thread')
    expect(labels('mqtt')).toContain('Gateways')
    expect(labels('parquet')).toContain('Cold Storage')
  })

  it('breaks a tie towards the page, since a card navigates to its page anyway', () => {
    // 'Devices' is both a page and the name of the list on it. Two rows, same destination, and the
    // page is the one whose name was typed.
    const ranked = matchTargets('devices', targets())
    expect(ranked[0].kind).toBe('page')
  })

  it('returns nothing rather than everything for a query that matches nothing', () => {
    expect(labels('zzzz')).toEqual([])
  })

  /**
   * The initials band cannot misfire on a single letter, and the reason is worth stating because it
   * looks like it needs a guard and does not: a label's first initial IS its first character, so
   * any one-letter query that matches the initials matches the higher-scoring prefix band first.
   * The band only ever decides anything from two letters on.
   */
  it('scores a single letter as a prefix, never as initials', () => {
    const thread = targets().find(t => t.label === 'Digital Thread')
    expect(scoreTarget(thread, 'd')).toBe(80)
    expect(scoreTarget(thread, 'dt')).toBe(70)
  })

  it('caps the list, so the panel is a shortlist and not a directory', () => {
    expect(matchTargets('a', targets(), 5).length).toBeLessThanOrEqual(5)
  })
})

// =================================================================================================
describe('the palette', () => {
  const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

  const props = () => ({
    tabs: adminTabs(),
    currentTab: 'overview',
    onNavigate: vi.fn(),
    onSelectDevice: vi.fn(),
    onSelectGateway: vi.fn(),
    onSelectCell: vi.fn(),
    onSelectSchema: vi.fn()
  })

  const type = (value) => {
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value } })
    return input
  }

  beforeEach(() => {
    vi.clearAllMocks()
    api.resolveId.mockResolvedValue([])
    api.searchAssets.mockResolvedValue([])
  })

  it('shows nothing until something is typed, so the bar is not a permanent dropdown', () => {
    render(<GlobalSearch {...props()} />)
    fireEvent.focus(screen.getByRole('combobox'))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('navigates to a card by opening the page that holds it', async () => {
    const p = props()
    render(<GlobalSearch {...p} />)
    type('metric catalog')

    fireEvent.click(await screen.findByText('Metric Catalog'))
    expect(p.onNavigate).toHaveBeenCalledWith('schemas')
  })

  it('opens the highlighted row on Enter', async () => {
    const p = props()
    render(<GlobalSearch {...p} />)
    const input = type('cold storage')

    await screen.findByRole('listbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(p.onNavigate).toHaveBeenCalledWith('cold-storage')
  })

  it('moves the highlight with the arrow keys and wraps', async () => {
    render(<GlobalSearch {...props()} />)
    const input = type('c')
    await screen.findByRole('listbox')

    const options = () => screen.getAllByRole('option')
    const selected = () => options().findIndex(o => o.getAttribute('aria-selected') === 'true')

    expect(selected()).toBe(0)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(selected()).toBe(1)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(selected()).toBe(0)
    // Wraps to the end rather than sticking, so the last item is one keystroke from the first.
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(selected()).toBe(options().length - 1)
  })

  it('clears itself on Escape, so it is not a trap', async () => {
    render(<GlobalSearch {...props()} />)
    const input = type('devices')
    await screen.findByRole('listbox')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input.value).toBe('')
  })

  // ---------------------------------------------------------------------------------------------
  describe('an id pasted into the box', () => {

    it('is resolved against the database rather than the static index', async () => {
      api.resolveId.mockResolvedValue([{ kind: 'device', id: UUID, name: 'Haas VF-2' }])
      const p = props()
      render(<GlobalSearch {...p} />)
      type(UUID)

      expect(await screen.findByText('Haas VF-2')).toBeTruthy()
      // The KIND is the answer the search was opened to get -- the id was already known.
      expect(screen.getByText('Device')).toBeTruthy()

      fireEvent.click(screen.getByText('Haas VF-2'))
      expect(p.onSelectDevice).toHaveBeenCalledWith(UUID)
    })

    it('sends each kind to the page that owns it', async () => {
      for (const [kind, prop] of [
        ['gateway', 'onSelectGateway'],
        ['cell', 'onSelectCell'],
        ['schema', 'onSelectSchema']
      ]) {
        api.resolveId.mockResolvedValue([{ kind, id: UUID, name: `a ${kind}` }])
        const p = props()
        const { unmount } = render(<GlobalSearch {...p} />)
        type(UUID)

        fireEvent.click(await screen.findByText(`a ${kind}`))
        expect(p[prop], `a ${kind} must open the ${kind} page`).toHaveBeenCalledWith(UUID)
        unmount()
      }
    })

    /**
     * A MISS AND A REFUSAL READ THE SAME, DELIBERATELY. RLS returns no rows rather than an error, so
     * "no such device" and "not a device you may see" are indistinguishable from the browser --
     * and asserting the first would tell an Operator that an id they are not cleared for does not
     * exist.
     */
    it('says what was searched and does not claim the id is unknown', async () => {
      api.resolveId.mockResolvedValue([])
      render(<GlobalSearch {...props()} />)
      type(UUID)

      const message = await screen.findByText(/visible to you/i)
      expect(message.textContent).toMatch(/cell, gateway, device or schema/i)
      expect(message.textContent).not.toMatch(/does not exist/i)
    })

    it('does not run the static matcher against it', async () => {
      render(<GlobalSearch {...props()} />)
      type(UUID)
      await waitFor(() => expect(api.resolveId).toHaveBeenCalled())

      // No page or card contains a hex string, so a matcher run here can only produce the "nothing
      // matches" message flashing up before the lookup returns.
      expect(screen.queryByText(/Nothing matches/i)).toBeNull()
    })

    it('does not run the ID lookup on a partial id', async () => {
      render(<GlobalSearch {...props()} />)
      type(UUID.slice(0, 20))

      await waitFor(() => expect(screen.queryByRole('listbox')).toBeTruthy())
      // `isUuid` passes only a COMPLETE id, so the primary-key probe does not run. What does run
      // is the name search -- a partial id is a perfectly well-formed thing to type, and it simply
      // matches nothing. Asserted rather than left implied, because "no lookup at all" was true
      // before the estate could be searched by name and quietly stopped being so.
      expect(api.resolveId).not.toHaveBeenCalled()
      await waitFor(() => expect(api.searchAssets).toHaveBeenCalled())
    })

    /**
     * THE RACE. Four table reads run per lookup and two lookups can be in flight when somebody
     * corrects a digit. Without the staleness guard the slower FIRST reply lands after the second
     * and leaves the palette showing an asset for an id that is no longer in the box.
     */
    it('ignores a reply for an id that is no longer being asked about', async () => {
      const OTHER = '11111111-2222-4333-8444-555555555555'
      let releaseFirst
      api.resolveId
        .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = () => resolve([{ kind: 'device', id: UUID, name: 'STALE' }]) }))
        .mockResolvedValueOnce([{ kind: 'cell', id: OTHER, name: 'FRESH' }])

      render(<GlobalSearch {...props()} />)
      type(UUID)
      await waitFor(() => expect(api.resolveId).toHaveBeenCalledTimes(1))

      type(OTHER)
      expect(await screen.findByText('FRESH')).toBeTruthy()

      // The first lookup answers late. It must not repaint the panel.
      releaseFirst()
      await waitFor(() => expect(screen.queryByText('STALE')).toBeNull())
      expect(screen.getByText('FRESH')).toBeTruthy()
    })

    it('reports a failed lookup as "not found" rather than as an error', async () => {
      api.resolveId.mockRejectedValue(new Error('PostgREST unreachable'))
      render(<GlobalSearch {...props()} />)
      type(UUID)

      expect(await screen.findByText(/visible to you/i)).toBeTruthy()
    })
  })

  describe('an asset name typed into the box', () => {
    const hit = (kind, name, id) => ({ kind, id, name })

    beforeEach(() => {
      api.resolveId.mockResolvedValue([])
      api.searchAssets.mockResolvedValue([])
    })

    it('finds all four kinds by name', async () => {
      api.searchAssets.mockResolvedValue([
        hit('device', 'Haas VF-2', '11111111-1111-4111-8111-111111111111'),
        hit('gateway', 'Haas Cell Gateway', '22222222-2222-4222-8222-222222222222'),
        hit('cell', 'Haas Bay', '33333333-3333-4333-8333-333333333333'),
        hit('schema', 'Haas Mill Schema', '44444444-4444-4444-8444-444444444444')
      ])
      render(<GlobalSearch {...props()} />)
      type('Haas')

      await waitFor(() => expect(screen.getByText('Haas VF-2')).toBeInTheDocument())
      expect(screen.getByText('Haas Cell Gateway')).toBeInTheDocument()
      expect(screen.getByText('Haas Bay')).toBeInTheDocument()
      expect(screen.getByText('Haas Mill Schema')).toBeInTheDocument()
    })

    it('waits for a second character', async () => {
      // One letter matches most of an estate, and a palette that fills on the first keystroke is one
      // people stop typing into.
      render(<GlobalSearch {...props()} />)
      type('H')
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeTruthy())
      expect(api.searchAssets).not.toHaveBeenCalled()
    })

    it('puts pages and cards above assets', async () => {
      // The static index answers instantly and the estate lookup arrives after a debounce, so
      // assets on top would push a result the user was already reaching for out from under the
      // cursor. Navigation is also the commoner intent.
      api.searchAssets.mockResolvedValue([hit('device', 'Devices Rig', '55555555-5555-4555-8555-555555555555')])
      render(<GlobalSearch {...props()} />)
      type('device')

      await waitFor(() => expect(screen.getByText('Devices Rig')).toBeInTheDocument())
      const labels = screen.getAllByRole('option').map(o => o.textContent)
      expect(labels[0]).toMatch(/Devices/)
      expect(labels[labels.length - 1]).toMatch(/Devices Rig/)
    })

    it('reports a name that matches nothing without an error', async () => {
      api.searchAssets.mockRejectedValue(new Error('PostgREST unreachable'))
      render(<GlobalSearch {...props()} />)
      type('nothing-called-this')
      await waitFor(() => expect(api.searchAssets).toHaveBeenCalled())
      // Same reasoning as the id lookup: the box somebody is typing in is not where they should
      // learn the backend is down.
      await waitFor(() => expect(screen.queryByText(/Nothing matches/i)).toBeTruthy())
    })
  })
})

// =================================================================================================

describe('the card index', () => {

  /**
   * A CARD IS A HEADING IN A 90KB COMPONENT WITH NO REGISTRY BEHIND IT, so nothing can assert that
   * the heading still exists. What CAN be asserted is that the index still points at real pages and
   * has no duplicate entries -- and that this file is read by somebody renaming a card, which is
   * most of what the guard is for.
   *
   * The page-agreement half lives in navigation.test.js, beside the other three id lists.
   */
  it('carries the card the feature was requested for', () => {
    const catalog = CARDS.find(c => c.label === 'Metric Catalog')
    expect(catalog, 'the Metric Catalog entry is the motivating case').toBeTruthy()
    expect(catalog.tab).toBe('schemas')
  })

  it('gives every card a label somebody could plausibly type', () => {
    for (const card of CARDS) {
      expect(card.label.trim()).toBe(card.label)
      expect(card.label.length).toBeGreaterThan(2)
    }
  })
})
