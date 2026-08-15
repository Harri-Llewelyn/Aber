import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { VocabularyTab } from '../components/tabs/VocabularyTab'
import { api } from '../api'

/**
 * The Standard Vocabulary Reference, now a page of its own rather than a third card on Schemas.
 *
 * These assertions moved here wholesale from SchemasTab.test.jsx -- the panel's behaviour did not
 * change, only where it lives. What is new is the last group: Use no longer fills in a form on the
 * same page, it hands the selection to the Schemas page, so the contract to protect is the SHAPE
 * OF THAT HANDOVER. Its other half is covered in SchemasTab.test.jsx, which asserts the same
 * payload arrives and opens the form.
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn() } }
})

const CATALOG = [
  { metric_uuid: 'm1', name: 'Axes/DISPLACEMENT', metric_group: 'Axes', datatype: 10, category: 'SAMPLE', units: 'MILLIMETER', standard: 'MTConnect', deprecated: false }
]

const VOCABULARY = [
  { kind: 'DATA_ITEM_TYPE', name: 'ANGLE', category: 'SAMPLE' },
  { kind: 'COMPONENT', name: 'Axes', category: null },
  { kind: 'UNIT', name: 'MILLIMETER', category: null },
  { kind: 'UNIT', name: 'PERCENT', category: null }
]

const ISO_VOCABULARY = [
  {
    name: 'AVAILABILITY', kpi_id: 'A', category: 'OEE', unit: 'PERCENT',
    formula: 'A = APT / PBT', description: 'Availability ratio',
    semantic_id: 'https://acs-cymru.local/semantics/iso22400/AVAILABILITY'
  },
  {
    name: 'MTBF', kpi_id: 'MTBF', category: 'Maintenance', unit: 'HOUR',
    formula: 'MTBF = APT / number of failures', description: 'Mean operating time between failures',
    semantic_id: 'https://acs-cymru.local/semantics/iso22400/MTBF'
  }
]

const OPCUA_VOCABULARY = [
  {
    name: 'ActualPosition', companion_spec: 'OPC 40010 Robotics',
    node_id: 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/ActualPosition',
    datatype: 'Double', unit: 'MILLIMETER', description: 'Current position of an axis.',
    semantic_id: 'http://opcfoundation.org/UA/Robotics/ActualPosition'
  },
  {
    name: 'Manufacturer', companion_spec: 'OPC 40001 Machinery',
    node_id: 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/Manufacturer',
    datatype: 'LocalizedText', unit: null, description: 'Name of the machine manufacturer.',
    semantic_id: 'http://opcfoundation.org/UA/Machinery/Manufacturer'
  }
]

const routes = {
  '/api/v1/metric-catalog': CATALOG,
  '/api/v1/mtconnect-vocabulary': VOCABULARY,
  '/api/v1/iso22400-vocabulary': ISO_VOCABULARY,
  '/api/v1/opcua-vocabulary': OPCUA_VOCABULARY
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    const key = Object.keys(routes).find(r => path.startsWith(r))
    return Promise.resolve(key ? routes[key] : [])
  })
})

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

const renderTab = (props = {}) =>
  render(<VocabularyTab hasPermission={() => true} onUseEntry={vi.fn()} {...props} />)

const card = () =>
  within(screen.getAllByRole('heading', { name: /Standard Vocabulary Reference/ })[0].closest('.card'))

/**
 * The standard pills live in the page's `.filter-bar`, not in the card.
 *
 * They used to sit inside it, under the header, with the search box floating in that header beside
 * the title -- so the two halves of one decision ("which vocabulary" and "which word in it") were
 * separated by a heading, and the title had to wrap around a 220px input unrelated to it. Both are
 * now one control row above the card, the shape every other page uses.
 */
const standardTab = (name) => screen.getByRole('tab', { name })
const ready = async () => {
  await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy())
}

describe('Vocabulary page', () => {
  it('renders one card for all three standards, not three cards', async () => {
    renderTab()
    await ready()

    expect(screen.queryByRole('heading', { name: /MTConnect Vocabulary/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /ISO 22400 Vocabulary/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /OPC UA Vocabulary/ })).toBeNull()
  })

  it('offers every standard as a tab, with its entry count visible', async () => {
    // All three counts visible at once is the point of a segmented control over a dropdown: it is
    // what shows the vocabularies are different sizes and different kinds of thing.
    renderTab()
    await ready()

    expect(within(standardTab(/MTConnect/)).getByText('4')).toBeTruthy()
    expect(within(standardTab(/ISO 22400/)).getByText('2')).toBeTruthy()
    expect(within(standardTab(/OPC UA/)).getByText('2')).toBeTruthy()
  })

  it('opens on MTConnect and marks only that tab selected', async () => {
    renderTab()
    await ready()

    expect(standardTab(/MTConnect/).getAttribute('aria-selected')).toBe('true')
    expect(standardTab(/ISO 22400/).getAttribute('aria-selected')).toBe('false')
  })

  it('swaps the rendered dataset when a tab is selected', async () => {
    renderTab()
    await ready()

    expect(card().queryByRole('button', { name: /OEE/ })).toBeNull()
    fireEvent.click(standardTab(/ISO 22400/))
    expect(card().getByRole('button', { name: /OEE/ })).toBeTruthy()
    expect(card().queryByRole('button', { name: /Data Item Types/ })).toBeNull()
  })

  it('starts every section collapsed - the vocabularies are reference, not the working set', async () => {
    renderTab()
    await ready()

    fireEvent.click(standardTab(/ISO 22400/))
    expect(card().getByRole('button', { name: /OEE/ })).toBeTruthy()
    expect(card().queryByTitle(/^AVAILABILITY \(A\)/)).toBeNull()
  })

  it('keeps the search text across a tab switch', async () => {
    // "Which standard has a word for this?" should be one query, not three.
    renderTab()
    await ready()

    // The search box is in the filter bar beside the pills now, not floating in the card header.
    fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: 'availability' } })
    fireEvent.click(standardTab(/ISO 22400/))

    expect(screen.getByPlaceholderText(/Search/).value).toBe('availability')
    expect(card().getByTitle(/^AVAILABILITY \(A\)/)).toBeTruthy()
  })
})

describe('Vocabulary page — Use hands off to the Schemas page', () => {
  it('identifies a KPI by name', async () => {
    const onUseEntry = vi.fn()
    renderTab({ onUseEntry })
    await ready()

    fireEvent.click(standardTab(/ISO 22400/))
    fireEvent.click(card().getByRole('button', { name: /OEE/ }))
    fireEvent.click(card().getByTitle(/^AVAILABILITY \(A\)/))

    expect(onUseEntry).toHaveBeenCalledWith({ standard: 'ISO 22400', name: 'AVAILABILITY' })
  })

  it('identifies an OPC UA point by companion spec AND name', async () => {
    const onUseEntry = vi.fn()
    renderTab({ onUseEntry })
    await ready()

    fireEvent.click(standardTab(/OPC UA/))
    fireEvent.click(card().getByRole('button', { name: /OPC 40010 Robotics/ }))
    fireEvent.click(card().getByTitle(/^ActualPosition —/))

    // Both parts are required: opcua_vocabulary is keyed on (companion_spec, name) because two
    // specifications legitimately define the same browse name, so a name-only handover would be
    // ambiguous the moment a second spec defines ActualPosition.
    expect(onUseEntry).toHaveBeenCalledWith({
      standard: 'OPC UA',
      companionSpec: 'OPC 40010 Robotics',
      name: 'ActualPosition'
    })
  })

  it('does not offer the chips as actions without the manage permission', async () => {
    const onUseEntry = vi.fn()
    renderTab({ hasPermission: () => false, onUseEntry })
    await ready()

    fireEvent.click(standardTab(/ISO 22400/))
    fireEvent.click(card().getByRole('button', { name: /OEE/ }))
    const chip = card().getByTitle(/^AVAILABILITY \(A\)/)
    expect(chip.getAttribute('role')).toBeNull()
    fireEvent.click(chip)
    expect(onUseEntry).not.toHaveBeenCalled()
  })
})

describe('Vocabulary page — control row and description structure', () => {
  it('puts the standard pills and the search in one filter bar, outside the card', async () => {
    // "Which vocabulary" and "which word in it" are two halves of one decision. They used to be
    // separated by a heading: the pills sat inside the card under its header, and the search box
    // floated in that header beside the title -- which the title then had to wrap around.
    renderTab()
    await ready()

    const bar = document.querySelector('.filter-bar')
    expect(bar).toBeTruthy()
    expect(within(bar).getByRole('tablist')).toBeTruthy()
    expect(within(bar).getByPlaceholderText(/Search/)).toBeTruthy()

    // The card header is now the title and its explanation, and nothing else.
    const header = document.querySelector('.card-header')
    expect(within(header).queryByRole('tablist')).toBeNull()
    expect(within(header).queryByPlaceholderText(/Search/)).toBeNull()
    expect(within(header).getByRole('heading', { name: /Standard Vocabulary Reference/ })).toBeTruthy()
  })

  it('pushes the search to the right-hand end of the bar', async () => {
    renderTab()
    await ready()
    expect(screen.getByPlaceholderText(/Search/).className).toMatch(/filter-bar-spacer/)
  })

  it('breaks the explanation into a lead and labelled notes', async () => {
    // It was one paragraph of six sentences running the width of the card, with the two facts in
    // it that stop someone making a mistake buried mid-run.
    renderTab()
    await ready()

    const description = document.querySelector('.vocab-description')
    expect(description).toBeTruthy()
    expect(description.querySelectorAll('p').length).toBeGreaterThan(1)

    // The two load-bearing MTConnect caveats are now their own labelled lines.
    expect(within(description).getByText('Reference only.')).toBeTruthy()
    expect(within(description).getByText('Names are composed.')).toBeTruthy()
  })

  it('gives every standard its own notes, not just the default tab', async () => {
    renderTab()
    await ready()

    fireEvent.click(standardTab(/ISO 22400/))
    const description = document.querySelector('.vocab-description')
    // The AVAILABILITY name clash is the one thing on this tab that causes a real mistake.
    expect(within(description).getByText('Beware the name clash.')).toBeTruthy()
  })
})

/**
 * The explanatory text runs the full width of the card.
 *
 * It was capped at a measure (90ch on the subtitle, 96ch on the description) on the usual
 * reasoning that a very long line is one the eye loses its place returning to. That reasoning is
 * right for a column of body copy and wrong here: this is two or three sentences at the top of a
 * full-width card, and capping them stacked each into six short lines with the rest of the row
 * left empty -- more vertical space spent than readability gained, on a page whose whole purpose
 * is to get a long list of vocabulary terms on screen.
 *
 * jsdom does no layout, so this is asserted against App.css directly: a rendering test cannot
 * tell a wrapped line from an unwrapped one, and the cap is exactly the kind of thing that gets
 * reintroduced by someone applying the general rule without seeing this page.
 */
describe('Vocabulary page — text is not measure-capped', () => {
  const rule = (selector) =>
    APP_CSS.match(new RegExp(`\\n${selector.replace(/[.:()\\-]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`))?.[1]

  it('leaves the subtitle uncapped', () => {
    const subtitle = rule('.vocab-subtitle')
    expect(subtitle).toBeTruthy()
    expect(subtitle).toMatch(/max-width:\s*none/)
    expect(subtitle).not.toMatch(/max-width:\s*\d+ch/)
  })

  it('leaves the description and its notes uncapped', () => {
    const description = rule('.vocab-description')
    expect(description).toBeTruthy()
    expect(description).toMatch(/max-width:\s*none/)
    expect(description).not.toMatch(/max-width:\s*\d+ch/)
  })

  // The notes are <p> children of .vocab-description, so a cap reintroduced one level down would
  // undo this just as completely.
  it('does not cap the paragraphs inside the description either', () => {
    expect(APP_CSS).toMatch(/\.vocab-description p \{[^}]*max-width:\s*none/)
  })
})
