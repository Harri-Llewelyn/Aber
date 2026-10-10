import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { VocabularyTab } from '../components/tabs/VocabularyTab'
import { api } from '../api'

/**
 * The Vocabulary page. Clicking an entry hands the selection to the Metrics page rather than
 * filling a form here, so the contract to protect is the shape of that handover; MetricsTab.test.jsx
 * asserts the other half.
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
    semantic_id: 'https://aber.local/semantics/iso22400/AVAILABILITY'
  },
  {
    name: 'MTBF', kpi_id: 'MTBF', category: 'Maintenance', unit: 'HOUR',
    formula: 'MTBF = APT / number of failures', description: 'Mean operating time between failures',
    semantic_id: 'https://aber.local/semantics/iso22400/MTBF'
  }
]

const OPCUA_VOCABULARY = [
  {
    name: 'ActualPosition', companion_spec: 'OPC 40010 Robotics',
    node_id: 'nsu=http://opcfoundation.org/UA/Robotics/;i=16662',
    datatype: 'Double', unit: 'MILLIMETER', description: 'Current position of an axis.',
    semantic_id: 'nsu=http://opcfoundation.org/UA/Robotics/;i=16662'
  },
  {
    name: 'Manufacturer', companion_spec: 'OPC 40001 Machinery',
    node_id: 'nsu=http://opcfoundation.org/UA/Machinery/;i=6002',
    datatype: 'LocalizedText', unit: null, description: 'Name of the machine manufacturer.',
    semantic_id: 'nsu=http://opcfoundation.org/UA/Machinery/;i=6002'
  }
]

// One class and one relation, so the tab can show that only the class can be clicked.
const ASHRAE223_VOCABULARY = [
  {
    name: 'TemperatureSensor', concept_kind: 'Class', label: 'Temperature sensor', subclass_of: 'Sensor',
    description: 'A `Sensor` that measures temperature.',
    semantic_id: 'http://data.ashrae.org/standard223#TemperatureSensor'
  },
  {
    name: 'hasProperty', concept_kind: 'Relation', label: 'has property', subclass_of: null,
    description: 'A `Relation` that associates a `Concept` with a `Property`.',
    semantic_id: 'http://data.ashrae.org/standard223#hasProperty'
  }
]

const routes = {
  '/api/v1/metric-catalog': CATALOG,
  '/api/v1/mtconnect-vocabulary': VOCABULARY,
  '/api/v1/iso22400-vocabulary': ISO_VOCABULARY,
  '/api/v1/opcua-vocabulary': OPCUA_VOCABULARY,
  '/api/v1/ashrae223-vocabulary': ASHRAE223_VOCABULARY
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

/* The page's one card: its heading, the tab per standard, and the selected standard's entries. */
const card = () => within(document.querySelector('.card'))

/** The standard tabs, inside the card under its heading. */
const standardTab = (name) => screen.getByRole('tab', { name })
const ready = async () => {
  await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy())
}

describe('Vocabulary page', () => {
  it('renders one card for all four standards, not four cards', async () => {
    renderTab()
    await ready()

    expect(screen.queryByRole('heading', { name: /MTConnect Vocabulary/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /ISO 22400 Vocabulary/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /OPC UA Vocabulary/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /ASHRAE 223P Vocabulary/ })).toBeNull()
  })

  it('offers every standard as a tab, carrying no count', async () => {
    renderTab()
    await ready()

    for (const name of [/MTConnect/, /ISO 22400/, /OPC UA/, /ASHRAE 223P/]) {
      expect(standardTab(name).querySelector('.section-count')).toBeNull()
    }
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

    expect(card().queryByRole('button', { name: /^OEE/ })).toBeNull()
    fireEvent.click(standardTab(/ISO 22400/))
    expect(card().getByRole('button', { name: /^OEE/ })).toBeTruthy()
    expect(card().queryByRole('button', { name: /^Data Item Types/ })).toBeNull()
  })

  it('starts every section collapsed - the vocabularies are reference, not the working set', async () => {
    renderTab()
    await ready()

    fireEvent.click(standardTab(/ISO 22400/))
    expect(card().getByRole('button', { name: /^OEE/ })).toBeTruthy()
    expect(card().queryByTitle(/^AVAILABILITY \(A\)/)).toBeNull()
  })

  it('keeps the search text across a tab switch', async () => {
    // "Which standard has a word for this?" should be one query, not three.
    renderTab()
    await ready()

    fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: 'availability' } })
    fireEvent.click(standardTab(/ISO 22400/))

    expect(screen.getByPlaceholderText(/Search/).value).toBe('availability')
    expect(card().getByTitle(/^AVAILABILITY \(A\)/)).toBeTruthy()
  })
})

describe('Vocabulary page — a click hands off to the Metrics page', () => {
  it('identifies a KPI by name', async () => {
    const onUseEntry = vi.fn()
    renderTab({ onUseEntry })
    await ready()

    fireEvent.click(standardTab(/ISO 22400/))
    fireEvent.click(card().getByRole('button', { name: /^OEE/ }))
    fireEvent.click(card().getByTitle(/^AVAILABILITY \(A\)/))

    expect(onUseEntry).toHaveBeenCalledWith({ standard: 'ISO 22400', name: 'AVAILABILITY' })
  })

  it('identifies an OPC UA point by companion spec AND name', async () => {
    const onUseEntry = vi.fn()
    renderTab({ onUseEntry })
    await ready()

    fireEvent.click(standardTab(/OPC UA/))
    fireEvent.click(card().getByRole('button', { name: /^OPC 40010 Robotics/ }))
    fireEvent.click(card().getByTitle(/^ActualPosition —/))

    // Both parts are required: opcua_vocabulary is keyed on (companion_spec, name) because two
    // specifications can define the same browse name.
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
    fireEvent.click(card().getByRole('button', { name: /^OEE/ }))
    const chip = card().getByTitle(/^AVAILABILITY \(A\)/)
    expect(chip.getAttribute('role')).toBeNull()
    fireEvent.click(chip)
    expect(onUseEntry).not.toHaveBeenCalled()
  })

  it('identifies a 223P class by name, and offers no Use on a relation', async () => {
    // The Metrics page's Concept picker leaves relations out; if a click still handed one over, the
    // dialog would compose `BMS/hasProperty`, a metric named after a predicate. Same rule, both
    // doors: isMetricConcept().
    const onUseEntry = vi.fn()
    renderTab({ onUseEntry })
    await ready()

    fireEvent.click(standardTab(/ASHRAE 223P/))
    fireEvent.click(card().getByRole('button', { name: /^Sensor/ }))
    fireEvent.click(card().getByTitle(/^Temperature sensor —/))
    expect(onUseEntry).toHaveBeenCalledWith({ standard: 'ASHRAE 223P', name: 'TemperatureSensor' })

    onUseEntry.mockClear()
    fireEvent.click(card().getByRole('button', { name: /^Root/ }))
    const relation = card().getByTitle(/^has property —/)
    expect(relation.getAttribute('role')).toBeNull()
    fireEvent.click(relation)
    expect(onUseEntry).not.toHaveBeenCalled()
  })
})

describe('Vocabulary page — the pointer to Metrics', () => {
  const description = () => document.querySelector('.card-heading-description').textContent

  it('says an entry is clicked to start a catalog metric, not "used"', async () => {
    renderTab()
    await ready()

    const text = description()
    expect(text).toMatch(/click an entry to start a catalog metric from it/)
    expect(text.match(/[.!?](\s|$)/g)).toHaveLength(1)
    expect(text.split(' ').length).toBeLessThanOrEqual(28)
    expect(text).not.toMatch(/\bUse\b/)
  })

  it('says who may click when the viewer cannot', async () => {
    renderTab({ hasPermission: () => false })
    await ready()

    expect(description()).toMatch(/Requires Administrator to start a catalog metric/)
  })

  it('counts nothing on the card or its section headings, and keeps "N in use"', async () => {
    renderTab()
    await ready()

    expect(document.querySelector('.card .section-count')).toBeNull()
    fireEvent.change(screen.getByLabelText('Search the MTConnect vocabulary'), { target: { value: 'a' } })
    expect(document.querySelector('.card .section-count')).toBeNull()
    // The one figure that ties a standard to this stack's catalog: Axes names a catalog metric.
    const components = card().getByRole('button', { name: /^Components/ }).closest('.vocab-section-head')
    expect(within(components).getByText('1 in use')).toBeTruthy()
  })

  it('says nothing matches with an icon, rather than an empty card', async () => {
    renderTab()
    await ready()

    fireEvent.change(screen.getByLabelText('Search the MTConnect vocabulary'), { target: { value: 'zzz' } })
    expect(document.querySelector('.empty-state .empty-icon')).toBeTruthy()
    expect(screen.getByText(/Nothing in the MTConnect vocabulary matches/)).toBeTruthy()
  })

  it('shows a spinner while the vocabularies load', () => {
    api.get.mockImplementation(() => new Promise(() => {}))
    renderTab()
    expect(screen.getByRole('status').textContent).toMatch(/Loading vocabularies/)
  })
})

describe('Vocabulary page — one card: heading, tabs, toolbar, sections', () => {
  it('names the page once, in the card heading, with the tabs directly under it', async () => {
    renderTab()
    await ready()

    const cardEl = document.querySelector('.card')
    expect(document.querySelectorAll('.card')).toHaveLength(1)
    expect(document.querySelector('.page-heading')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Vocabulary' }).closest('.card-heading')).toBeTruthy()
    expect(screen.getByRole('tablist').closest('.tab-strip').parentElement).toBe(cardEl)
    // The tab names the standard on show; no second heading repeats it.
    expect(screen.getAllByRole('heading')).toHaveLength(1)
  })

  it('puts the selected standard’s "?" in the tab bar, after the last tab', async () => {
    renderTab()
    await ready()

    const help = () => document.querySelector('.card > .tab-strip > .tab-strip-help')
    expect(help().previousElementSibling).toBe(screen.getByRole('tablist'))
    expect(within(help()).getByRole('button', { name: 'About the MTConnect vocabulary' })).toBeTruthy()

    fireEvent.click(standardTab(/ISO 22400/))
    expect(within(help()).getByRole('button', { name: 'About the ISO 22400 vocabulary' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'About the MTConnect vocabulary' })).toBeNull()
  })

  it('keeps the toolbar row under the tabs for the search and Expand all, with no "?" in it', async () => {
    renderTab()
    await ready()

    const bar = document.querySelector('.card > .tab-strip + .filter-bar')
    expect(bar).toBeTruthy()
    expect(within(bar).getByLabelText('Search the MTConnect vocabulary')).toBeTruthy()
    expect(within(bar).getByRole('button', { name: /^(Expand|Collapse) all$/ })).toBeTruthy()
    expect(bar.querySelector('.help-tip')).toBeNull()
  })

  it('scrolls inside the card, with the sections as the scroller', async () => {
    renderTab()
    await ready()

    const page = document.querySelector('.page-fill')
    expect(page).toBeTruthy()
    const fill = page.querySelectorAll('.card-fill')
    expect(fill).toHaveLength(1)
    const scroller = fill[0].querySelector(':scope > .card-fill-scroll')
    expect(scroller).toHaveClass('vocab-sections')
    // A section heading pins to the top of this scroller, so nothing above it may pad it down.
    expect(APP_CSS).toMatch(/\n\.vocab-sections \{ padding: 0 0 4px; \}/)
  })

  it('reads a standard’s explanation on demand rather than above every entry', async () => {
    /* It was a lead paragraph and three labelled notes standing above the list on every visit --
       what the vocabulary IS, which is checked once. The tip carries it, per standard. */
    renderTab()
    await ready()
    expect(document.querySelector('.vocab-description')).toBeNull()

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'About the MTConnect vocabulary' }))
    const tip = screen.getByRole('tooltip')
    // The two load-bearing MTConnect caveats survive the move.
    expect(within(tip).getByText('Reference only.')).toBeTruthy()
    expect(within(tip).getByText('Names are composed.')).toBeTruthy()
  })

  it('gives every standard its own tip, not just the default tab', async () => {
    renderTab()
    await ready()

    fireEvent.click(standardTab(/ISO 22400/))
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'About the ISO 22400 vocabulary' }))
    // The AVAILABILITY name clash is the one thing on this tab that causes a real mistake.
    expect(within(screen.getByRole('tooltip')).getByText('Beware the name clash.')).toBeTruthy()
  })
})

describe('Vocabulary page — section headings', () => {
  const sectionToggle = (name) => card().getByRole('button', { name })

  it('gives a section’s explanation a "?" beside its toggle, not a line in its body', async () => {
    renderTab()
    await ready()

    const toggle = sectionToggle('Data Item Types — SAMPLE')
    const tipButton = screen.getByRole('button', { name: 'About Data Item Types — SAMPLE' })
    // In the band, beside the toggle; a button cannot hold a button.
    expect(tipButton.closest('.vocab-section-head')).toBe(toggle.closest('.vocab-section-head'))
    expect(toggle.contains(tipButton)).toBe(false)

    fireEvent.click(toggle)
    expect(screen.queryByText(/The only category that carries units/)).toBeNull()
    fireEvent.mouseEnter(tipButton)
    expect(screen.getByRole('tooltip').textContent).toMatch(/The only category that carries units/)
  })

  it('opens the "?" without toggling the section, and toggles on a click elsewhere on the band', async () => {
    renderTab()
    await ready()

    const toggle = sectionToggle('Components')
    fireEvent.click(screen.getByRole('button', { name: 'About Components' }))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle.closest('.vocab-section-head').querySelector('.vocab-in-use'))
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('Vocabulary page — Expand all / Collapse all', () => {
  const toggles = () => [...document.querySelectorAll('.vocab-section-head > .table-group-button')]
  const openCount = () => toggles().filter(b => b.getAttribute('aria-expanded') === 'true').length
  const allButton = () => screen.getByRole('button', { name: /^(Expand|Collapse) all$/ })

  it('sits in the toolbar row and reads "Expand all" while every section is shut', async () => {
    renderTab()
    await ready()

    expect(allButton().closest('.filter-bar')).toBeTruthy()
    expect(allButton().textContent).toBe('Expand all')
    expect(openCount()).toBe(0)
  })

  it('opens every section, then reads "Collapse all" and shuts them again', async () => {
    renderTab()
    await ready()

    fireEvent.click(allButton())
    expect(openCount()).toBe(toggles().length)
    expect(allButton().textContent).toBe('Collapse all')

    fireEvent.click(allButton())
    expect(openCount()).toBe(0)
    expect(allButton().textContent).toBe('Expand all')
  })

  it('reads "Collapse all" while any one section is open', async () => {
    renderTab()
    await ready()

    fireEvent.click(card().getByRole('button', { name: /^Components/ }))
    expect(allButton().textContent).toBe('Collapse all')
  })

  it('closes the sections a search opened, and keeps the search', async () => {
    renderTab()
    await ready()

    fireEvent.change(screen.getByLabelText('Search the MTConnect vocabulary'), { target: { value: 'a' } })
    expect(openCount()).toBe(toggles().length)
    expect(allButton().textContent).toBe('Collapse all')

    fireEvent.click(allButton())
    expect(openCount()).toBe(0)
    expect(card().queryByTitle(/^ANGLE/)).toBeNull()
    expect(screen.getByLabelText('Search the MTConnect vocabulary').value).toBe('a')
    expect(allButton().textContent).toBe('Expand all')

    fireEvent.click(allButton())
    expect(card().getByTitle(/^ANGLE/)).toBeTruthy()
  })

  it('acts on the selected standard only', async () => {
    renderTab()
    await ready()

    fireEvent.click(allButton())
    fireEvent.click(standardTab(/ISO 22400/))
    expect(openCount()).toBe(0)
    expect(allButton().textContent).toBe('Expand all')
  })

  it('has nothing to open when a search matches nothing', async () => {
    renderTab()
    await ready()

    fireEvent.change(screen.getByLabelText('Search the MTConnect vocabulary'), { target: { value: 'zzz' } })
    expect(allButton().disabled).toBe(true)
  })
})

describe('Vocabulary page — a chip that starts a metric', () => {
  it('carries a "+" and an accessible name saying what it does; a chip that cannot has neither', async () => {
    renderTab()
    await ready()
    fireEvent.click(card().getByRole('button', { name: /^Data Item Types — SAMPLE/ }))
    fireEvent.click(card().getByRole('button', { name: /^Components/ }))

    const angle = card().getByTitle(/^ANGLE/)
    expect(angle.getAttribute('aria-label')).toBe('Start a catalog metric from ANGLE')
    expect(angle.querySelector('.vocab-chip-plus')).toBeTruthy()

    // A component is not a metric on its own, so it starts nothing.
    const axes = card().getByTitle(/^Axes/)
    expect(axes.getAttribute('role')).toBeNull()
    expect(axes.getAttribute('aria-label')).toBeNull()
    expect(axes.querySelector('.vocab-chip-plus')).toBeNull()
  })

  it('shows the "+" on hover and on keyboard focus, not at rest', () => {
    expect(APP_CSS).toMatch(/\n\.vocab-chip-plus \{[^}]*visibility: hidden;/)
    expect(APP_CSS).toMatch(
      /\n\.vocab-chip-action:hover \.vocab-chip-plus,\n\.vocab-chip-action:focus-visible \.vocab-chip-plus \{ visibility: visible; \}/
    )
  })

  it('starts the metric from the keyboard as well', async () => {
    const onUseEntry = vi.fn()
    renderTab({ onUseEntry })
    await ready()
    fireEvent.click(card().getByRole('button', { name: /^Data Item Types — SAMPLE/ }))

    fireEvent.keyDown(card().getByRole('button', { name: 'Start a catalog metric from ANGLE' }), { key: 'Enter' })
    expect(onUseEntry).toHaveBeenCalledWith({ standard: 'MTConnect', type: 'ANGLE' })
  })
})

/**
 * The explanatory text runs the full width of the column: a measure cap would stack two sentences
 * into six short lines on a page whose purpose is to get a long list on screen. jsdom does no
 * layout, so this is asserted against App.css directly.
 *
 * This page's standing text is the shared CardHeading description, so the rule lives there and
 * guards every page carrying one.
 */
describe('A page description is not measure-capped', () => {
  const rule = (selector) =>
    APP_CSS.match(new RegExp(`\\n${selector.replace(/[.:()\\-]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`))?.[1]

  it('lets the description run the width of the column', () => {
    // The description shares one rule with the note under it, so the block is read by its last
    // selector after checking the description is in it.
    expect(APP_CSS).toMatch(/\n\.card-heading \.card-heading-description,\n\.card-heading \.card-heading-note \{/)
    const description = rule('.card-heading .card-heading-note')
    expect(description).toBeTruthy()
    expect(description).not.toMatch(/max-width/)
  })

  it('is the element this page states itself in', async () => {
    // Asserted against the DOM as well as the stylesheet: a rule guarding a class nothing renders
    // is a test that cannot fail.
    renderTab()
    await ready()
    const heading = screen.getByRole('heading', { name: 'Vocabulary' })
    expect(heading.closest('.card-heading')?.querySelector('.card-heading-description')).toBeTruthy()
  })
})
