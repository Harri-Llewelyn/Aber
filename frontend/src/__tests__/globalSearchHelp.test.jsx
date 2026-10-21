/**
 * The top bar's Help group: headings from help/, found through the help panel's own index and
 * matcher (help/searchIndex.js), capped, and opened in the help panel. The expectations are read
 * from `searchHelp` itself, so an edit to a help page cannot break these cases; what they pin is
 * the box's use of it.
 */
import React, { useState } from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { TABS, tabIsVisible } from '../navigation'
import { helpTitle, pageHelpFile } from '../help'
import { searchHelp } from '../help/searchIndex'

vi.mock('../api', () => ({
  api: { resolveId: vi.fn(), searchAssets: vi.fn(), get: vi.fn() }
}))

// The real function, watched: the panel in the last case listens for it as it does in the app.
vi.mock('../help/openHelp', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, openHelpAt: vi.fn(actual.openHelpAt) }
})

import { api } from '../api'
import { openHelpAt } from '../help/openHelp'
import { GlobalSearch, HELP_GROUP_LIMIT } from '../components/common/GlobalSearch'
import { HelpPanel } from '../components/common/HelpPanel'

const CURRENT = 'devices'
const props = () => ({
  tabs: TABS.filter(t => tabIsVisible(t, () => true, 'Administrator')),
  currentTab: CURRENT,
  onNavigate: vi.fn(),
  onSelectDevice: vi.fn(),
  onSelectSection: vi.fn(),
  onSelectSetting: vi.fn(),
  onSelectTrail: vi.fn()
})

/** What the box should list for `query`: the panel's matcher, ranked for the open page, capped. */
const expected = (query) => searchHelp(query, { limit: HELP_GROUP_LIMIT, currentFile: pageHelpFile(CURRENT) })

const type = (value) => {
  const input = screen.getByRole('combobox')
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  return input
}

const helpGroup = () => screen.queryByRole('group', { name: 'Help' })
const helpOptions = () => within(helpGroup()).getAllByRole('option')
const labelOf = (option) => option.querySelector('.global-search-result-label').textContent
const detailOf = (option) => option.querySelector('.global-search-result-detail')?.textContent ?? null
const selected = () => screen.getAllByRole('option').findIndex(o => o.getAttribute('aria-selected') === 'true')

beforeEach(() => {
  vi.clearAllMocks()
  api.resolveId.mockResolvedValue([])
  api.searchAssets.mockResolvedValue([])
  api.get.mockResolvedValue([])
  // jsdom has no scrollIntoView; the panel scrolls to the heading with it.
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { delete Element.prototype.scrollIntoView })

describe('the Help group', () => {
  it('lists the headings the help matches, each with the page or guide it is in', () => {
    const hits = expected('quarantine')
    // The case needs a heading under a title of its own, which is what the second line names.
    expect(hits.some(h => h.heading !== h.page)).toBe(true)

    render(<GlobalSearch {...props()} />)
    type('quarantine')

    const options = helpOptions()
    expect(options.map(labelOf)).toEqual(hits.map(h => h.heading))
    hits.forEach((h, i) => {
      expect(detailOf(options[i]), h.heading).toBe(h.heading === h.page ? null : helpTitle(h.file))
    })
  })

  it('stops at five, so a common word leaves room for pages and records', () => {
    expect(HELP_GROUP_LIMIT).toBe(5)
    expect(searchHelp('gateway', { limit: Infinity }).length).toBeGreaterThan(HELP_GROUP_LIMIT)

    render(<GlobalSearch {...props()} />)
    type('gateway')

    expect(helpOptions()).toHaveLength(HELP_GROUP_LIMIT)
  })

  it('sits after the pages and cards and before the records', async () => {
    api.searchAssets.mockResolvedValue([{ kind: 'device', id: '55555555-5555-4555-8555-555555555555', name: 'Devices Rig' }])
    expect(expected('devices').length).toBeGreaterThan(0)

    render(<GlobalSearch {...props()} />)
    type('devices')
    await screen.findByText('Devices Rig')

    const all = screen.getAllByRole('option')
    const help = helpOptions()
    const first = all.indexOf(help[0])
    expect(first).toBeGreaterThan(0)
    expect(labelOf(all[0])).toBe('Devices')
    expect(all.slice(first, first + help.length)).toEqual(help)
    expect(labelOf(all.at(-1))).toBe('Devices Rig')
  })

  it('opens the help panel at the heading chosen, and closes the search', () => {
    const hits = expected('quarantine')
    const at = hits.findIndex(h => h.id)
    const hit = hits[at]
    render(<GlobalSearch {...props()} />)
    const input = type('quarantine')

    fireEvent.click(helpOptions()[at])

    expect(openHelpAt).toHaveBeenCalledWith(hit.file, hit.id)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input).toHaveValue('')
  })

  it('is reached with the arrow keys and opened with Enter, like any other row', () => {
    const hits = expected('gateway')
    render(<GlobalSearch {...props()} />)
    const input = type('gateway')

    const firstHelp = screen.getAllByRole('option').indexOf(helpOptions()[0])
    expect(firstHelp).toBeGreaterThan(0)
    for (let i = 0; i < firstHelp; i++) fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(selected()).toBe(firstHelp)
    expect(input.getAttribute('aria-activedescendant')).toBe(helpOptions()[0].id)

    // One more down is the group's second row, and Enter opens that one.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(openHelpAt).toHaveBeenCalledWith(hits[1].file, hits[1].id || null)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('wraps from the first row to the last help row when there are no records', () => {
    render(<GlobalSearch {...props()} />)
    const input = type('gateway')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[selected()]).toBe(helpOptions().at(-1))
  })

  it('shows nothing for an empty box, one character or an id', () => {
    render(<GlobalSearch {...props()} />)
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    expect(screen.queryByRole('listbox')).toBeNull()

    type('   ')
    expect(helpGroup()).toBeNull()

    // One letter starts a word in most of the help; the static index still answers it.
    type('g')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(helpGroup()).toBeNull()

    type('3f2504e0-4f89-41d3-9a0c-0305e82c3301')
    expect(helpGroup()).toBeNull()
  })

  it('opens the panel itself at that heading, with nothing else wired', async () => {
    const hits = expected('quarantine')
    const at = hits.findIndex(h => h.id)
    const hit = hits[at]
    /* The App's part, as in helpLinks.test.jsx: the drawer's open state, which the panel asks for. */
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <GlobalSearch {...props()} />
          <HelpPanel open={open} tabId={CURRENT} onClose={() => setOpen(false)} onOpen={() => setOpen(true)} />
        </>
      )
    }
    render(<Harness />)
    type('quarantine')
    fireEvent.click(helpOptions()[at])

    const title = () => document.querySelector('.context-panel-app .context-panel-title')?.textContent
    await waitFor(() => expect(title()).toBe(helpTitle(hit.file)))
    expect(Element.prototype.scrollIntoView.mock.contexts.at(-1).dataset.heading).toBe(hit.id)
  })
})
