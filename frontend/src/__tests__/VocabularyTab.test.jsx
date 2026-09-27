import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { VocabularyTab } from '../components/tabs/VocabularyTab'
import { api } from '../api'

/**
 * The Standard Vocabulary Reference as a page of its own. Use hands the selection to the Schemas
 * page rather than filling a form here, so the contract to protect is the shape of that handover;
 * SchemasTab.test.jsx asserts the other half.
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

// One class and one relation, so the tab can show that only the class carries a Use action.
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

/* One card on the page: the entries of whichever standard is selected. The page's own heading sits
   above it, outside every card, so it is no longer the way in. */
const card = () => within(document.querySelector('.card'))

/** The standard pills are the page's tablist, above the card. */
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
    fireEvent.click(card().getByRole('button', { name: /OEE/ }))
    const chip = card().getByTitle(/^AVAILABILITY \(A\)/)
    expect(chip.getAttribute('role')).toBeNull()
    fireEvent.click(chip)
    expect(onUseEntry).not.toHaveBeenCalled()
  })

  it('identifies a 223P class by name, and offers no Use on a relation', async () => {
    // The Metrics page's Concept picker leaves relations out; if Use still handed one over, the
    // form would compose `BMS/hasProperty`, a metric named after a predicate. Same rule, both
    // doors: isMetricConcept().
    const onUseEntry = vi.fn()
    renderTab({ onUseEntry })
    await ready()

    fireEvent.click(standardTab(/ASHRAE 223P/))
    fireEvent.click(card().getByRole('button', { name: /Sensor/ }))
    fireEvent.click(card().getByTitle(/^Temperature sensor —/))
    expect(onUseEntry).toHaveBeenCalledWith({ standard: 'ASHRAE 223P', name: 'TemperatureSensor' })

    onUseEntry.mockClear()
    fireEvent.click(card().getByRole('button', { name: /Root/ }))
    const relation = card().getByTitle(/^has property —/)
    expect(relation.getAttribute('role')).toBeNull()
    fireEvent.click(relation)
    expect(onUseEntry).not.toHaveBeenCalled()
  })
})

describe('Vocabulary page — heading, tabs, then the card', () => {
  it('states the page once, above a switch that changes only which card is shown', async () => {
    /* The shape Access Control and Settings use. The heading names the page and does not move when
       a tab does; the tablist is a page control, so it is not inside the card it swaps. */
    renderTab()
    await ready()

    const heading = screen.getByRole('heading', { name: /Standard Vocabulary Reference/ })
    expect(heading.closest('.card')).toBeNull()
    expect(screen.getByRole('tablist').closest('.card')).toBeNull()

    // The card names the standard on show, and holds the search for it.
    const header = document.querySelector('.card-header')
    expect(within(header).getByRole('heading', { name: /MTConnect/ })).toBeTruthy()
    expect(document.querySelector('.card-body .filter-bar')).toBeTruthy()
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

/**
 * The explanatory text runs the full width of the column: a measure cap would stack two sentences
 * into six short lines on a page whose purpose is to get a long list on screen. jsdom does no
 * layout, so this is asserted against App.css directly.
 *
 * This page's standing text is now the shared `.page-heading` description, so the rule lives there
 * and guards every page carrying one. A cap was reintroduced once already: 88ch wrapped the
 * sentence across half a wide monitor and spent a row on nothing.
 */
describe('A page description is not measure-capped', () => {
  const rule = (selector) =>
    APP_CSS.match(new RegExp(`\\n${selector.replace(/[.:()\\-]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`))?.[1]

  it('lets the description run the width of the column', () => {
    const description = rule('.page-heading p')
    expect(description).toBeTruthy()
    expect(description).not.toMatch(/max-width/)
  })

  it('is the element this page states itself in', async () => {
    // Asserted against the DOM as well as the stylesheet: a rule guarding a class nothing renders
    // is a test that cannot fail.
    renderTab()
    await ready()
    const heading = screen.getByRole('heading', { name: /Standard Vocabulary Reference/ })
    expect(heading.closest('.page-heading')?.querySelector('p')).toBeTruthy()
  })
})
