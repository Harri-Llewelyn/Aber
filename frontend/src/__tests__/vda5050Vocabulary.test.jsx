import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VocabularyTab } from '../components/tabs/VocabularyTab'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { api } from '../api'
import { tabBar, tabLink } from '../test/tabBar'
import { getByTooltip, queryByTooltip } from '../test/tooltips'
import { HELP_SOURCES as HELP_CORPUS } from './helpSources'
import { pressHeld } from '../test/dialogs'

/**
 * VDA 5050 on the Vocabulary page and in Add Metric: the tab, its entries, the handover of a click
 * and what a field fills into the form. The vocabulary's own helpers are in vda5050.test.js.
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const ID = (path) => `https://aber.local/semantics/vda5050/v3.0/State/${path}`
const VDA = [
  { name: 'driving', datatype: 'Boolean', unit: null, description: 'True: the mobile robot is driving and/or rotating.', permitted_values: null, semantic_id: ID('driving') },
  { name: 'operatingMode', datatype: 'String', unit: null, description: 'Current operating mode of the mobile robot.', permitted_values: ['STARTUP', 'AUTOMATIC', 'MANUAL'], semantic_id: ID('operatingMode') },
  { name: 'powerSupply.stateOfCharge', datatype: 'Double', unit: null, description: 'State of Charge in %.', permitted_values: null, semantic_id: ID('powerSupply.stateOfCharge') },
  { name: 'velocity.vx', datatype: 'Double', unit: 'm/s', description: 'The velocity in its x direction', permitted_values: null, semantic_id: ID('velocity.vx') }
]

const CATALOG = [
  { metric_uuid: 'm1', name: 'AGV/driving', metric_group: 'AGV', datatype: 11, category: 'EVENT', standard: 'VDA 5050', semantic_id: ID('driving'), deprecated: false },
  { metric_uuid: 'm2', name: 'Axes/DISPLACEMENT', metric_group: 'Axes', datatype: 10, category: 'SAMPLE', units: 'MILLIMETER', standard: 'MTConnect', deprecated: false }
]

const routes = {
  '/api/v1/schemas': [],
  '/api/v1/metric-catalog': CATALOG,
  '/api/v1/metric-groups': [
    { group_uuid: 'g1', name: 'Axes', standard: 'MTConnect' },
    { group_uuid: 'g2', name: 'AGV', standard: 'VDA 5050', description: 'VDA 5050 3.0 calls the vehicle a mobile robot.' }
  ],
  '/api/v1/mtconnect-vocabulary': [{ kind: 'DATA_ITEM_TYPE', name: 'ANGLE', category: 'SAMPLE' }, { kind: 'UNIT', name: 'MILLIMETER', category: null }],
  '/api/v1/vda5050-vocabulary': VDA,
  '/api/v1/gateways': [],
  '/api/v1/devices': []
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    const key = Object.keys(routes).find(r => path.startsWith(r))
    return Promise.resolve(key ? routes[key] : [])
  })
})

const cardEl = () => document.querySelector('.card')

describe('the VDA 5050 tab of the Vocabulary page', () => {
  const renderTab = (props = {}) =>
    render(<VocabularyTab hasPermission={() => true} onUseEntry={vi.fn()} {...props} />)
  const ready = () => waitFor(() => expect(tabBar()).toBeTruthy())
  const open = async (props) => {
    renderTab(props)
    await ready()
    fireEvent.click(tabLink(/VDA 5050/))
    return within(cardEl())
  }

  it('is the fifth tab, after ASHRAE 223P, and carries no count', async () => {
    renderTab()
    await ready()
    expect(tabBar().textContent.indexOf('VDA 5050')).toBeGreaterThan(tabBar().textContent.indexOf('ASHRAE 223P'))
    expect(tabLink(/VDA 5050/).querySelector('.section-count')).toBeNull()
  })

  it('says on its tooltip what the VDA calls the vehicle', async () => {
    renderTab()
    await ready()
    expect(getByTooltip(/calls the vehicle a mobile robot/)).toBe(tabLink(/VDA 5050/))
  })

  it('draws the fields in the parts of the vehicle state, collapsed until opened', async () => {
    const card = await open()
    for (const title of [/^Vehicle state/, /^Power supply/, /^Velocity/]) {
      expect(card.getByRole('button', { name: title })).toBeTruthy()
    }
    expect(queryByTooltip(/^driving —/, cardEl())).toBeNull()
    fireEvent.click(card.getByRole('button', { name: /^Vehicle state/ }))
    expect(getByTooltip(/^driving — True: the mobile robot is driving and\/or rotating\./, cardEl())).toBeTruthy()
  })

  it('shows a field its path, the schema\'s description and its unit when pointed at', async () => {
    const card = await open()
    fireEvent.click(card.getByRole('button', { name: /^Velocity/ }))
    expect(getByTooltip(/^velocity\.vx — The velocity in its x direction \(m\/s\)/, cardEl())).toBeTruthy()
  })

  it('finds a field by what its description says', async () => {
    await open()
    fireEvent.change(screen.getByPlaceholderText(/Search fields/), { target: { value: 'state of charge' } })
    expect(getByTooltip(/^powerSupply\.stateOfCharge —/, cardEl())).toBeTruthy()
    expect(queryByTooltip(/^driving —/, cardEl())).toBeNull()
  })

  it('hands a click to the Metrics page as the standard and the field\'s path', async () => {
    const onUseEntry = vi.fn()
    const card = await open({ onUseEntry })
    fireEvent.click(card.getByRole('button', { name: /^Power supply/ }))
    fireEvent.click(getByTooltip(/^powerSupply\.stateOfCharge —/, cardEl()))
    expect(onUseEntry).toHaveBeenCalledWith({ standard: 'VDA 5050', name: 'powerSupply.stateOfCharge' })
  })

  it('offers no action without the permission to add a metric', async () => {
    const onUseEntry = vi.fn()
    const card = await open({ hasPermission: () => false, onUseEntry })
    fireEvent.click(card.getByRole('button', { name: /^Vehicle state/ }))
    fireEvent.click(getByTooltip(/^driving —/, cardEl()))
    expect(onUseEntry).not.toHaveBeenCalled()
  })

  it('ticks a field a catalog metric carries the id of, and no other', async () => {
    const card = await open()
    const head = (name) => card.getByRole('button', { name }).closest('.vocab-section-head')
    expect(head(/^Vehicle state/).textContent).toMatch(/1 in use/)
    expect(head(/^Power supply/).textContent).not.toMatch(/in use/)
  })

  it('has its own section of the help, which says the unit is the operator\'s to choose', () => {
    expect(HELP_CORPUS.vocabulary).toContain('### VDA 5050\n')
    const vda = HELP_CORPUS.vocabulary.split('### VDA 5050')[1].split('##')[0]
    expect(vda).toMatch(/calls the vehicle a mobile robot/)
    expect(vda).toMatch(/The unit is not filled in\./)
    expect(vda).toMatch(/It is never the cell the device is in\./)
  })
})

describe('Add Metric from a VDA 5050 field', () => {
  const standardSelect = () => screen.getByLabelText('Standard')
  const fieldSelect = () => screen.getByLabelText('Field')
  const datatypeSelect = () => screen.getByLabelText('Sparkplug Datatype')
  const semanticIdInput = () => screen.getByRole('textbox', { name: /Semantic ID/ })
  const valuesInput = () => screen.getByRole('textbox', { name: 'Permitted Values' })
  const namePreview = () => screen.getByText(/Devices will publish this metric as/)
  const unitsSelect = () => screen.getByLabelText('Units')
  const addDialog = () => screen.getByRole('dialog', { name: 'Add Metric' })

  const renderWith = (entry) => render(
    <MetricsTab
      showToast={vi.fn()}
      hasPermission={() => true}
      pendingVocabularyEntry={entry}
      onConsumeVocabularyEntry={vi.fn()}
    />
  )

  it('arrives from the Vocabulary page filled: the group, the name, the datatype, the id and the values', async () => {
    renderWith({ standard: 'VDA 5050', name: 'operatingMode' })
    await waitFor(() => expect(standardSelect().value).toBe('VDA 5050'))

    expect(fieldSelect().value).toBe('operatingMode')
    expect(within(namePreview()).getByText('AGV/operatingMode')).toBeTruthy()
    expect(datatypeSelect().value).toBe('12')
    expect(semanticIdInput().value).toBe(ID('operatingMode'))
    expect(valuesInput().value).toBe('STARTUP, AUTOMATIC, MANUAL')
    api.post.mockResolvedValue({})
    fireEvent.click(within(addDialog()).getByRole('button', { name: 'Add Metric' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/metric-catalog', expect.objectContaining({ name: 'AGV/operatingMode' })))
  })

  it('names a nested field by its path and leaves the unit, which the schema writes as m/s, to the operator', async () => {
    renderWith({ standard: 'VDA 5050', name: 'velocity.vx' })
    await waitFor(() => expect(standardSelect().value).toBe('VDA 5050'))

    expect(within(namePreview()).getByText('AGV/velocity/vx')).toBeTruthy()
    expect(datatypeSelect().value).toBe('10')
    expect(unitsSelect().value).toBe('')
    expect(valuesInput().value).toBe('')
  })

  it('offers the group AGV once VDA 5050 is the standard, and a field picker grouped by part of the state', async () => {
    renderWith({ standard: 'VDA 5050', name: 'driving' })
    await waitFor(() => expect(standardSelect().value).toBe('VDA 5050'))

    const groups = [...fieldSelect().querySelectorAll('optgroup')].map(g => g.label)
    expect(groups).toEqual(['Vehicle state (2)', 'Power supply (1)', 'Velocity (1)'])
    expect([...screen.getByLabelText('Group').querySelectorAll('option')].map(o => o.textContent)).toContain('AGV')
  })

  it('fills the form from the Field picker, and clears the values when the next field has none', async () => {
    renderWith({ standard: 'VDA 5050', name: 'operatingMode' })
    await waitFor(() => expect(standardSelect().value).toBe('VDA 5050'))

    fireEvent.change(fieldSelect(), { target: { value: 'powerSupply/stateOfCharge' } })
    expect(within(namePreview()).getByText('AGV/powerSupply/stateOfCharge')).toBeTruthy()
    expect(datatypeSelect().value).toBe('10')
    expect(semanticIdInput().value).toBe(ID('powerSupply.stateOfCharge'))
    expect(screen.queryByRole('textbox', { name: 'Permitted Values' })?.value ?? '').toBe('')
  })

  it('takes an enum\'s values back when the standard changes, and keeps the operator\'s own for the others', async () => {
    renderWith({ standard: 'VDA 5050', name: 'operatingMode' })
    await waitFor(() => expect(standardSelect().value).toBe('VDA 5050'))
    expect(valuesInput().value).toBe('STARTUP, AUTOMATIC, MANUAL')

    fireEvent.change(standardSelect(), { target: { value: 'MTConnect' } })
    expect(valuesInput().value).toBe('')

    fireEvent.change(valuesInput(), { target: { value: 'READY, ACTIVE' } })
    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })
    expect(valuesInput().value).toBe('READY, ACTIVE')
  })

  it('asks for a field until one is chosen', async () => {
    renderWith({ standard: 'MTConnect', type: 'ANGLE' })
    await waitFor(() => expect(standardSelect().value).toBe('MTConnect'))

    fireEvent.change(standardSelect(), { target: { value: 'VDA 5050' } })
    expect(fieldSelect().value).toBe('')
    pressHeld(addDialog(), 'Add Metric', 'Choose a field')
    expect(fieldSelect()).toHaveFocus()
  })
})
