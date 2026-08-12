import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
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
    semantic_id: 'https://factoryplus.local/semantics/iso22400/AVAILABILITY'
  },
  {
    name: 'MTBF', kpi_id: 'MTBF', category: 'Maintenance', unit: 'HOUR',
    formula: 'MTBF = APT / number of failures', description: 'Mean operating time between failures',
    semantic_id: 'https://factoryplus.local/semantics/iso22400/MTBF'
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

const renderTab = (props = {}) =>
  render(<VocabularyTab hasPermission={() => true} onUseEntry={vi.fn()} {...props} />)

const card = () =>
  within(screen.getAllByRole('heading', { name: /Standard Vocabulary Reference/ })[0].closest('.card')
    || screen.getByRole('tablist').closest('.card'))
const standardTab = (name) => card().getByRole('tab', { name })
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

    fireEvent.change(card().getByPlaceholderText(/Search/), { target: { value: 'availability' } })
    fireEvent.click(standardTab(/ISO 22400/))

    expect(card().getByPlaceholderText(/Search/).value).toBe('availability')
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
