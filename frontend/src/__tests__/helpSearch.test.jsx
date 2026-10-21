/**
 * Search in the help panel: the hand-written matcher over the index of everything in help/ (prefix
 * per term, every term, headings above prose, the current page above others), and the panel's
 * search box, whose results open a file at a heading.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { HelpPanel } from '../components/common/HelpPanel'
import { HELP_RESULT_LIMIT, helpIndex, helpTerms, searchHelp } from '../help/searchIndex'
import { HELP_FILES } from '../help'

const entry = (file, id, heading, kind, text) => ({ file, page: file.toUpperCase(), id, heading, kind, text: text ?? heading })

const INDEX = [
  entry('pages/a', 'quarantine', 'Quarantine', 'heading'),
  entry('pages/a', 'quarantine', 'Quarantine', 'text', 'A device waits in the queue until someone approves it.'),
  entry('pages/a', 'other', 'Other', 'text', 'Approves nothing; the quarantined device stays.'),
  entry('pages/b', 'queue', 'The queue', 'heading'),
  entry('pages/b', 'queue', 'The queue', 'text', 'Quarantine holds a device that is not yet known.'),
  entry('pages/c', 'quarantine-queue', 'Quarantine queue', 'heading'),
]

describe('the help matcher', () => {
  it('splits on anything but letters and digits, in lower case', () => {
    expect(helpTerms('Port 8883, TLS-only: “MQTT”')).toEqual(['port', '8883', 'tls', 'only', 'mqtt'])
  })

  it('matches each term as the start of a word', () => {
    expect(searchHelp('quar', { index: INDEX }).map((r) => r.file + '#' + r.id))
      .toEqual(['pages/a#quarantine', 'pages/c#quarantine-queue', 'pages/a#other', 'pages/b#queue'])
    // "uarantine" is inside a word, not at its start.
    expect(searchHelp('uarantine', { index: INDEX })).toEqual([])
  })

  it('needs every term to match one entry, prose read with its heading', () => {
    // pages/a's prose says queue under the heading Quarantine; pages/b's says quarantine under The queue.
    expect(searchHelp('quarantine queue', { index: INDEX }).map((r) => r.id)).toEqual(['quarantine-queue', 'quarantine', 'queue'])
    expect(searchHelp('quarantine zebra', { index: INDEX })).toEqual([])
  })

  it('ranks headings above prose, and the current page above others', () => {
    const ids = searchHelp('quarantine', { index: INDEX, currentFile: 'pages/b' }).map((r) => r.file + '#' + r.id)
    // pages/b has only a prose match, so it leads the prose and follows every heading.
    expect(ids).toEqual(['pages/a#quarantine', 'pages/c#quarantine-queue', 'pages/b#queue', 'pages/a#other'])
    const current = searchHelp('quarantine', { index: INDEX, currentFile: 'pages/c' }).map((r) => r.file)
    expect(current[0]).toBe('pages/c')
  })

  it('gives one result per heading, the best of its matches', () => {
    const results = searchHelp('quarantine', { index: INDEX })
    const first = results.find((r) => r.id === 'quarantine')
    expect(results.filter((r) => r.id === 'quarantine')).toHaveLength(1)
    expect(first.kind).toBe('heading')
    expect(first.snippet).toBeNull()
    const prose = results.find((r) => r.id === 'queue')
    expect(prose.snippet).toBe('Quarantine holds a device that is not yet known.')
    expect(prose.heading).toBe('The queue')
  })

  it('names the page as the heading before a file’s first heading', () => {
    const results = searchHelp('intro', { index: [entry('pages/x', '', '', 'text', 'An intro line.')] })
    expect(results[0].heading).toBe('PAGES/X')
  })

  it('returns at most 20 by default', () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(`pages/p${i}`, `h${i}`, `Gateway ${i}`, 'heading'))
    expect(searchHelp('gateway', { index: many })).toHaveLength(HELP_RESULT_LIMIT)
    expect(HELP_RESULT_LIMIT).toBe(20)
  })

  it('answers nothing for an empty query', () => {
    expect(searchHelp('  ', { index: INDEX })).toEqual([])
    expect(searchHelp('—', { index: INDEX })).toEqual([])
  })
})

describe('the index of everything in help/', () => {
  it('holds every file, keyed by file and heading id', () => {
    const files = new Set(helpIndex().map((e) => e.file))
    expect([...files].sort()).toEqual(Object.keys(HELP_FILES).sort())
    const glossary = helpIndex().find((e) => e.file === 'guides/glossary' && e.kind === 'heading' && e.id === 'quarantine')
    expect(glossary).toBeTruthy()
  })

  it('holds the prose under each heading, from lists and tables as well as paragraphs', () => {
    const tutorial = helpIndex().filter((e) => e.file === 'guides/tutorial' && e.kind === 'text')
    expect(tutorial.length).toBeGreaterThan(50)
    expect(tutorial.every((e) => typeof e.id === 'string' && e.heading)).toBe(true)
    // Table rows are entries too, their cells joined.
    expect(helpIndex().some((e) => e.file === 'site/install' && e.text.includes(' · '))).toBe(true)
  })
})

describe('the panel’s search box', () => {
  afterEach(() => { delete Element.prototype.scrollIntoView })

  it('lists matches as heading · page, and opens one at its heading', () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    render(<HelpPanel open tabId="devices" onClose={() => {}} />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search help' }), { target: { value: 'quarantine' } })
    expect(screen.getByText('Search help', { selector: '.context-panel-title' })).toBeInTheDocument()
    expect(screen.getByRole('status').textContent).toMatch(/result/)
    const results = screen.getAllByRole('button', { name: /·|Quarantine/ }).filter((b) => b.classList.contains('help-result'))
    expect(results.length).toBeGreaterThan(1)
    expect(results.length).toBeLessThanOrEqual(HELP_RESULT_LIMIT)
    // Devices has no heading that matches, so its prose leads the prose, after every heading.
    const firstProse = results.findIndex((b) => b.querySelector('.help-result-snippet'))
    expect(within(results[firstProse]).getByText(/Devices/)).toBeInTheDocument()
    expect(results.slice(0, firstProse).every((b) => !b.querySelector('.help-result-snippet'))).toBe(true)

    const glossary = results.find((b) => /Glossary/.test(b.textContent) && /^Quarantine\b/.test(b.textContent))
    fireEvent.click(glossary)
    expect(screen.getByText('Glossary', { selector: '.context-panel-title' })).toBeInTheDocument()
    expect(scrolled).toHaveBeenCalled()
    expect(scrolled.mock.contexts.at(-1).dataset.heading).toBe('quarantine')
    // The box empties: the search is a step Back returns to, with its words.
    expect(screen.getByRole('searchbox', { name: 'Search help' }).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.getByRole('searchbox', { name: 'Search help' }).value).toBe('quarantine')
  })

  it('says when nothing matches', () => {
    render(<HelpPanel open tabId="devices" onClose={() => {}} />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search help' }), { target: { value: 'zzzqqq' } })
    expect(screen.getByRole('status').textContent).toBe('Nothing in the help matches “zzzqqq”.')
  })
})
