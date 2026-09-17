import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { buildTargets, matchTargets, scoreTarget, CARDS } from '../searchIndex'
import { TABS, tabIsVisible } from '../navigation'

/**
 * The global search answers three questions that fail in three different ways: the ranking is pure
 * and tested as arithmetic (its failure is a worse order that still looks like it works); the id
 * lookup is asynchronous and races itself (its failure is showing an asset for an id no longer in
 * the box); and the visibility of what can be found has to match the rail exactly.
 */

vi.mock('../api', () => ({
  // `get` is the settings read the box makes once it is opened; most cases here do not care what
  // comes back, so it answers with nothing and the suite that does care overrides it.
  api: { resolveId: vi.fn(), searchAssets: vi.fn(), get: vi.fn().mockResolvedValue([]) }
}))

import { api } from '../api'
import { GlobalSearch } from '../components/common/GlobalSearch'

const adminTabs = () => TABS.filter(t => tabIsVisible(t, () => true, 'Administrator'))
const targets = () => buildTargets(adminTabs())

const labels = (query, limit) => matchTargets(query, targets(), limit).map(t => t.label)

// =================================================================================================
describe('what the index holds', () => {

  it('takes the pages it is given rather than filtering them again', () => {
    // One predicate decides visibility, `tabIsVisible` in navigation.jsx; a second copy here would
    // be a second answer to the same question.
    const operator = TABS.filter(t => tabIsVisible(t, () => false, 'Operator'))
    const found = buildTargets(operator).map(t => t.tabId)

    expect(found).not.toContain('settings')
    expect(found).not.toContain('access-control')
    expect(found).toContain('site-map')
  })

  it('drops a card whose page this session cannot open', () => {
    // A card inherits its page's visibility and cannot narrow it further. Runtime configuration is
    // on Settings, which an Operator does not have.
    const operator = buildTargets(TABS.filter(t => tabIsVisible(t, () => false, 'Operator')))
    expect(operator.map(t => t.label)).not.toContain('Runtime configuration')

    expect(targets().map(t => t.label)).toContain('Runtime configuration')
  })

  /* THE GATE IS THE TAB, NOT RLS. `system_settings` is SELECT-able by every authenticated session
     -- the policy that names Administrator is the UPDATE one -- so a setting must be withheld here
     or the box would send an Operator to a page that will not render for them. */
  it('offers a setting only to a session that can open the Settings page', () => {
    const rows = [{ key: 'site.name', label: 'Site name', category: 'Site' }]
    const operator = buildTargets(TABS.filter(t => tabIsVisible(t, () => false, 'Operator')), rows)
    expect(operator.map(t => t.label)).not.toContain('Site name')
    expect(buildTargets(adminTabs(), rows).map(t => t.label)).toContain('Site name')
  })

  it('tells a card which page it is on, because that is the answer being looked for', () => {
    const credentials = targets().find(t => t.label === 'Broker credentials')
    expect(credentials.kind).toBe('card')
    expect(credentials.page).toBe('Access Control')
  })
})

// =================================================================================================
describe('ranking', () => {

  /**
   * The case the feature was asked for: "Playback" is a card on the Capture page, and nothing about
   * the word "Capture" says so. It was "Metric Catalog" on Schemas until the catalogue became the
   * Metrics page, at which point it stopped being a card at all.
   */
  it('finds a card by its own name, from a prefix', () => {
    expect(labels('playb')[0]).toBe('Playback')
    expect(labels('broker cred')[0]).toBe('Broker credentials')
  })

  it('finds it by initials, which is what a second visit types', () => {
    expect(labels('bc')).toContain('Broker credentials')
  })

  it('puts an exact name first, above anything that merely contains it', () => {
    expect(labels('devices')[0]).toBe('Devices')
  })

  /**
   * A word-start beats a mid-word substring: "back" must offer Backups above Playback.
   */
  it('prefers a word boundary to a match buried inside a word', () => {
    const backups = targets().find(t => t.label === 'Backups' && t.kind === 'page')
    const playback = targets().find(t => t.label === 'Playback')
    expect(scoreTarget(backups, 'back')).toBeGreaterThan(scoreTarget(playback, 'back'))
  })

  it('prefers a name to a keyword, because a keyword is somebody else guessing what you meant', () => {
    const settings = targets().find(t => t.label === 'Settings')
    const schemas = targets().find(t => t.label === 'Schemas')
    // 'config' is a Settings keyword and appears in no label at all.
    expect(scoreTarget(settings, 'config')).toBeGreaterThan(0)
    expect(scoreTarget(schemas, 'config')).toBe(0)
  })

  /**
   * The keywords earn their place on the pages nobody guesses the name of: "audit" is the word a
   * first-time reader arrives with.
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
   * The initials band cannot misfire on a single letter: a label's first initial is its first
   * character, so a one-letter query matches the higher-scoring prefix band first.
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
    currentTab: 'site-map',
    onNavigate: vi.fn(),
    onSelectDevice: vi.fn(),
    onSelectGateway: vi.fn(),
    onSelectCell: vi.fn(),
    onSelectArea: vi.fn(),
    onSelectSchema: vi.fn(),
    onSelectSetting: vi.fn(),
    onSelectThread: vi.fn()
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
    api.get.mockResolvedValue([])
  })

  it('shows nothing until something is typed, so the bar is not a permanent dropdown', () => {
    render(<GlobalSearch {...props()} />)
    fireEvent.focus(screen.getByRole('combobox'))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  describe('emptying the box', () => {
    const clearButton = () => screen.queryByRole('button', { name: 'Clear the search' })

    it('offers nothing to clear while the box is empty', () => {
      render(<GlobalSearch {...props()} />)
      fireEvent.focus(screen.getByRole('combobox'))
      expect(clearButton()).toBeNull()
      // The shortcut hint has the slot until there is something to clear.
      expect(document.querySelector('.global-search-kbd')).toBeTruthy()
    })

    it('takes the hint\'s place rather than widening the box', () => {
      render(<GlobalSearch {...props()} />)
      type('cold storage')
      expect(clearButton()).toBeTruthy()
      expect(document.querySelector('.global-search-kbd')).toBeNull()
    })

    it('empties the box and keeps the focus in it', async () => {
      render(<GlobalSearch {...props()} />)
      const input = type('cold storage')
      await screen.findByRole('listbox')

      fireEvent.click(clearButton())

      expect(input).toHaveValue('')
      // Emptied, not dismissed: the next thing typed lands where it was going anyway.
      expect(document.activeElement).toBe(input)
      expect(screen.queryByRole('listbox')).toBeNull()
    })

    it('appears for whitespace, which looks empty and is not', () => {
      render(<GlobalSearch {...props()} />)
      type('   ')
      // No panel -- nothing is searched -- but the box is not empty, so it can be emptied.
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(clearButton()).toBeTruthy()
    })

    it('drops the previous query\'s asset hits with the text', async () => {
      /* The estate lookup is debounced, so without clearing `entities` the last query's rows would
         sit under an empty box until the timer fired. */
      api.searchAssets.mockResolvedValue([{ kind: 'device', id: UUID, name: 'CNC_01' }])
      render(<GlobalSearch {...props()} />)
      const input = type('CNC')
      expect(await screen.findByText('CNC_01')).toBeInTheDocument()

      fireEvent.click(clearButton())

      expect(screen.queryByText('CNC_01')).toBeNull()
      fireEvent.change(input, { target: { value: 'cold storage' } })
      expect(screen.queryByText('CNC_01')).toBeNull()
    })
  })

  it('navigates to a card by opening the page that holds it', async () => {
    const p = props()
    render(<GlobalSearch {...p} />)
    type('playback')

    fireEvent.click(await screen.findByText('Playback'))
    expect(p.onNavigate).toHaveBeenCalledWith('capture')
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
        ['area', 'onSelectArea'],
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
     * A miss and a refusal read the same: RLS returns no rows rather than an error, so asserting
     * "no such device" would tell an Operator that an id they are not cleared for does not exist.
     */
    it('says what was searched and does not claim the id is unknown', async () => {
      api.resolveId.mockResolvedValue([])
      render(<GlobalSearch {...props()} />)
      type(UUID)

      const message = await screen.findByText(/visible to you/i)
      expect(message.textContent).toMatch(/cell, gateway, device or schema/i)
      expect(message.textContent).not.toMatch(/does not exist/i)
    })

    /**
     * THE ID HAD ONE CONSUMER AND IT COVERED FIVE KINDS. `resolveId` probes areas, cells,
     * gateways, devices and schemas; the Digital Thread records twelve, so the copyable Entity ID
     * in its drawer was a dead end for a setting, a backup, a proposal or a person. The thread's
     * own search matches `entity_id` whatever kind carries it, so this row is the answer for all
     * seven -- and it is offered for the other five too, because "what happened to this" is the
     * second question somebody pasting an id is asking.
     */
    it('offers the Digital Thread for an id no asset probe could name', async () => {
      api.resolveId.mockResolvedValue([])
      render(<GlobalSearch {...props()} />)
      type(UUID)

      expect(await screen.findByText(/Find this ID in the Digital Thread/)).toBeTruthy()
    })

    it('offers it for a resolved id as well, beneath the asset itself', async () => {
      api.resolveId.mockResolvedValue([{ kind: 'device', id: UUID, name: 'Haas VF-2' }])
      render(<GlobalSearch {...props()} />)
      type(UUID)

      await screen.findByText('Haas VF-2')
      const rows = [...document.querySelectorAll('.global-search-result-label')]
        .map(el => el.textContent)
      // The asset first: it is the more specific answer, and a row that moves under the cursor
      // once the lookup lands is the reason the static index is ordered this way too.
      expect(rows).toEqual(['Haas VF-2', 'Find this ID in the Digital Thread'])
    })

    it('hands over the id in the box, not the one before it', async () => {
      /* The row carries the term, so correcting a digit has to move it. Two unresolved ids in a
         row leave the asset list empty and `looksLikeId` true throughout, which is the shape that
         would strand the first id on the row.

         It cannot strand one TODAY: `matches` is a fresh `[]` on every render for an id, so the
         memo recomputes regardless of its dependency list. This pins the behaviour rather than
         the mechanism, which is the half that should outlive a change to either. */
      api.resolveId.mockResolvedValue([])
      const p = props()
      render(<GlobalSearch {...p} />)
      type(UUID)
      await screen.findByText(/Find this ID in the Digital Thread/)

      const second = '11111111-2222-4333-8444-555555555555'
      type(second)
      await waitFor(() => expect(api.resolveId).toHaveBeenCalledWith(second))

      fireEvent.click(screen.getByText(/Find this ID in the Digital Thread/))
      expect(p.onSelectThread).toHaveBeenCalledWith(second)
    })

    it('hands the id to the thread rather than to an asset page', async () => {
      api.resolveId.mockResolvedValue([])
      const p = props()
      render(<GlobalSearch {...p} />)
      type(UUID)

      fireEvent.click(await screen.findByText(/Find this ID in the Digital Thread/))
      expect(p.onSelectThread).toHaveBeenCalledWith(UUID)
      // Not an entity hit: those open a page for a kind this id may not have.
      expect(p.onSelectDevice).not.toHaveBeenCalled()
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
      // `isUuid` passes only a complete id, so the primary-key probe does not run; the name search
      // does, and matches nothing.
      expect(api.resolveId).not.toHaveBeenCalled()
      await waitFor(() => expect(api.searchAssets).toHaveBeenCalled())
    })

    /**
     * The race: two lookups can be in flight when somebody corrects a digit, and without the
     * staleness guard the slower first reply lands after the second.
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

    it('finds all five kinds by name', async () => {
      api.searchAssets.mockResolvedValue([
        hit('device', 'Haas VF-2', '11111111-1111-4111-8111-111111111111'),
        hit('gateway', 'Haas Cell Gateway', '22222222-2222-4222-8222-222222222222'),
        hit('cell', 'Haas Bay', '33333333-3333-4333-8333-333333333333'),
        hit('area', 'Haas Hall', '55555555-5555-4555-8555-555555555555'),
        hit('schema', 'Haas Mill Schema', '44444444-4444-4444-8444-444444444444')
      ])
      render(<GlobalSearch {...props()} />)
      type('Haas')

      await waitFor(() => expect(screen.getByText('Haas VF-2')).toBeInTheDocument())
      expect(screen.getByText('Haas Cell Gateway')).toBeInTheDocument()
      expect(screen.getByText('Haas Bay')).toBeInTheDocument()
      // An area was the gap somebody found by looking for one: the map is drawn from areas and
      // nothing in the box could reach one.
      expect(screen.getByText('Haas Hall')).toBeInTheDocument()
      expect(screen.getByText('Haas Mill Schema')).toBeInTheDocument()
    })

    /* A setting is a row, not a page or a card, and the page that holds it is an Administrator's
       and a tablist besides -- so finding one has to land on its category, not on the page. */
    it('finds a setting by its label and opens the page on its category', async () => {
      api.get.mockResolvedValue([
        { key: 'site.name', label: 'Site name', category: 'Site', value: 'AMRC Cymru', value_type: 'string' },
        { key: 'alerts.retention_days', label: 'Alert history kept for (days)', category: 'Retention', value: 7, value_type: 'number' }
      ])
      const p = props()
      render(<GlobalSearch {...p} />)
      type('Site name')

      const row = await screen.findByText('Site name')
      // The category is what the row says underneath, because it is where the page will open.
      expect(row.closest('[role="option"]').textContent).toContain('Site')
      fireEvent.click(row)
      expect(p.onSelectSetting).toHaveBeenCalledWith('site.name')
      expect(p.onNavigate).not.toHaveBeenCalled()
    })

    it('finds a setting by the key the code reads, not only by its label', async () => {
      api.get.mockResolvedValue([
        { key: 'site_map.min_pin_spacing', label: 'Minimum spacing between cells on an area plan', category: 'Site' }
      ])
      const p = props()
      render(<GlobalSearch {...p} />)
      type('min_pin_spacing')

      fireEvent.click(await screen.findByText('Minimum spacing between cells on an area plan'))
      expect(p.onSelectSetting).toHaveBeenCalledWith('site_map.min_pin_spacing')
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
      // assets on top would move under the cursor.
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
   * A card is a heading in a large component with no registry behind it, so nothing can assert the
   * heading still exists. What can be asserted is that the index points at real pages and has no
   * duplicates. The page-agreement half lives in navigation.test.js.
   */
  it('carries a card whose name its page does not say', () => {
    // The motivating case, now that the metric catalogue is a page rather than a card on Schemas:
    // nothing about the word "Capture" tells you Playback is on it.
    const playback = CARDS.find(c => c.label === 'Playback')
    expect(playback, 'the Playback entry is the motivating case').toBeTruthy()
    expect(playback.tab).toBe('capture')
  })

  it('gives every card a label somebody could plausibly type', () => {
    for (const card of CARDS) {
      expect(card.label.trim()).toBe(card.label)
      expect(card.label.length).toBeGreaterThan(2)
    }
  })
})
