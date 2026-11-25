import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VocabularyTab } from '../components/tabs/VocabularyTab'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { EditMetricSemanticIdModal } from '../components/modals/EditMetricSemanticIdModal'
import { semanticIdCandidates } from '../utils/semanticIdSources'
import { api } from '../api'
import { tabBar, tabLink } from '../test/tabBar'
import { getByTooltip, queryByTooltip, tooltipOf } from '../test/tooltips'
import { HELP_SOURCES as HELP_CORPUS } from './helpSources'

/**
 * QUDT on the Vocabulary page and in the semantic id pickers: the tab, its credit to QUDT.org, the
 * handover of a click, and the rule for where a quantity kind may be a metric's own id. The helpers
 * are in qudt.test.js.
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const NS = 'http://qudt.org/vocab/quantitykind/'
const TEMPERATURE = NS + 'Temperature'
const FLOW = NS + 'VolumeFlowRate'
const KINDS = [
  { semantic_id: TEMPERATURE, name: 'Temperature', description: 'Temperature is a physical property of matter that quantitatively expresses hot and cold.' },
  { semantic_id: NS + 'Time', name: 'Time', description: 'Time is a quantity of duration.' },
  { semantic_id: FLOW, name: 'Volume Flow Rate', description: 'Volume flow rate is the volume of fluid that passes per unit time.' }
]

const CATALOG = [
  // A kind as a metric's own id, and one as a further id, which both count as in use.
  { metric_uuid: 'm1', name: 'BMS/ZONE_TEMPERATURE', metric_group: 'BMS', datatype: 10, units: 'CELSIUS', standard: 'ASHRAE 223P', semantic_id: TEMPERATURE, deprecated: false, further_semantic_ids: [] },
  { metric_uuid: 'm2', name: 'Axes/DISPLACEMENT', metric_group: 'Axes', datatype: 10, category: 'SAMPLE', units: 'MILLIMETER', standard: 'MTConnect', semantic_id: 'https://aber.local/semantics/mtconnect/v2.0/DataItemType/DISPLACEMENT', deprecated: false,
    further_semantic_ids: [{ semantic_id: NS + 'Time', semantic_id_type: 'IRI', source: null }] }
]

const routes = {
  '/api/v1/schemas': [],
  '/api/v1/metric-catalog': CATALOG,
  '/api/v1/metric-groups': [
    { group_uuid: 'g1', name: 'Axes', standard: 'MTConnect' },
    { group_uuid: 'g5', name: 'BMS', standard: 'ASHRAE 223P' },
    { group_uuid: 'g4', name: 'Hydraulic', standard: null }
  ],
  '/api/v1/mtconnect-vocabulary': [{ kind: 'DATA_ITEM_TYPE', name: 'ANGLE', category: 'SAMPLE' }, { kind: 'UNIT', name: 'MILLIMETER', category: null }],
  '/api/v1/qudt-quantity-kinds': KINDS,
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

describe('the QUDT tab of the Vocabulary page', () => {
  const renderTab = (props = {}) =>
    render(<VocabularyTab hasPermission={() => true} onUseEntry={vi.fn()} {...props} />)
  const ready = () => waitFor(() => expect(tabBar()).toBeTruthy())
  const open = async (props) => {
    renderTab(props)
    await ready()
    fireEvent.click(tabLink(/QUDT/))
    return within(cardEl())
  }

  it('is the fifth tab, after ASHRAE 223P and before VDA 5050, and carries no count', async () => {
    renderTab()
    await ready()
    const text = tabBar().textContent
    expect(text.indexOf('QUDT')).toBeGreaterThan(text.indexOf('ASHRAE 223P'))
    expect(text.indexOf('QUDT')).toBeLessThan(text.indexOf('VDA 5050'))
    expect(tabLink(/QUDT/).querySelector('.section-count')).toBeNull()
  })

  it('says on its tooltip what a quantity kind is', async () => {
    renderTab()
    await ready()
    expect(getByTooltip(/^Quantity kinds, what a reading measures/)).toBe(tabLink(/QUDT/))
  })

  it('credits QUDT.org under CC BY 4.0, with the licence a link', async () => {
    await open()
    const notice = cardEl().querySelector('.vocab-notice')
    expect(notice.textContent).toBe('Quantity kinds from QUDT 3.5.2, by QUDT.org, under CC BY 4.0.')
    const link = within(notice).getByRole('link', { name: 'CC BY 4.0' })
    expect(link.getAttribute('href')).toBe('https://creativecommons.org/licenses/by/4.0/')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('shows the credit on no other tab', async () => {
    await open()
    fireEvent.click(tabLink(/ASHRAE 223P/))
    expect(cardEl().querySelector('.vocab-notice')).toBeNull()
  })

  it('draws the kinds under their first letter, collapsed until opened', async () => {
    const card = await open()
    for (const title of [/^T/, /^V/]) expect(card.getByRole('button', { name: title })).toBeTruthy()
    expect(queryByTooltip(/^Temperature —/, cardEl())).toBeNull()
    fireEvent.click(card.getByRole('button', { name: /^T\b/ }))
    expect(getByTooltip(/^Temperature — Temperature is a physical property/, cardEl())).toBeTruthy()
  })

  it('shows QUDT\'s id on a line of its own when a kind is pointed at', async () => {
    const card = await open()
    fireEvent.click(card.getByRole('button', { name: /^V/ }))
    expect(tooltipOf(getByTooltip(/^Volume Flow Rate —/, cardEl()))).toContain(`Semantic ID ${FLOW}`)
  })

  it('finds a kind by what its description says', async () => {
    await open()
    fireEvent.change(screen.getByPlaceholderText(/Search quantity kinds/), { target: { value: 'duration' } })
    expect(getByTooltip(/^Time —/, cardEl())).toBeTruthy()
    expect(queryByTooltip(/^Temperature —/, cardEl())).toBeNull()
  })

  it('counts a kind a catalog metric carries as its own id or as a further one', async () => {
    const card = await open()
    const head = (name) => card.getByRole('button', { name }).closest('.vocab-section-head')
    expect(head(/^T\b/).textContent).toMatch(/2 in use/)
    expect(head(/^V\b/).textContent).not.toMatch(/in use/)
  })

  it('hands a click to the Metrics page as a Custom metric with the kind\'s IRI', async () => {
    const onUseEntry = vi.fn()
    const card = await open({ onUseEntry })
    fireEvent.click(card.getByRole('button', { name: /^V/ }))
    fireEvent.click(getByTooltip(/^Volume Flow Rate —/, cardEl()))
    expect(onUseEntry).toHaveBeenCalledWith({ standard: '', semanticId: FLOW, semanticIdType: 'IRI' })
  })

  it('offers no action without the permission to add a metric', async () => {
    const onUseEntry = vi.fn()
    const card = await open({ hasPermission: () => false, onUseEntry })
    fireEvent.click(card.getByRole('button', { name: /^V/ }))
    fireEvent.click(getByTooltip(/^Volume Flow Rate —/, cardEl()))
    expect(onUseEntry).not.toHaveBeenCalled()
  })

  it('has its own section of the help, which says QUDT is credited and a kind is not a standard', () => {
    expect(HELP_CORPUS.vocabulary).toContain('### QUDT\n')
    const qudt = HELP_CORPUS.vocabulary.split('### QUDT')[1].split('###')[0]
    expect(qudt).toMatch(/CC BY 4\.0/)
    expect(qudt).toMatch(/QUDT\.org/)
    expect(qudt).toMatch(/further/)
  })
})

describe('Add Metric and the QUDT quantity kinds', () => {
  const standardSelect = () => screen.getByLabelText('Standard')
  const semanticIdInput = () => screen.getByRole('textbox', { name: /Semantic ID/ })
  const referenceType = () => screen.getByLabelText('Reference Type')
  const openSearch = () => fireEvent.click(screen.getByRole('button', { name: 'Search Vocabularies' }))
  const search = (text) => fireEvent.change(
    screen.getByRole('textbox', { name: 'Search the vocabularies and templates' }), { target: { value: text } })
  const listed = () => {
    const list = screen.queryByRole('list', { name: 'Matching concepts' })
    return list ? within(list).getAllByRole('button').map(o => o.textContent) : []
  }
  const quantityKindReads = () => api.get.mock.calls.filter(([path]) => path.startsWith('/api/v1/qudt-quantity-kinds')).length

  const renderWith = (entry) => render(
    <MetricsTab
      showToast={vi.fn()}
      hasPermission={() => true}
      pendingVocabularyEntry={entry}
      onConsumeVocabularyEntry={vi.fn()}
    />
  )

  it('arrives from the Vocabulary page as a Custom metric whose own id is the kind, typed IRI', async () => {
    renderWith({ standard: '', semanticId: FLOW, semanticIdType: 'IRI' })
    await waitFor(() => expect(semanticIdInput().value).toBe(FLOW))

    expect(standardSelect().value).toBe('')
    expect(referenceType().value).toBe('IRI')
    expect(screen.getByText(/Provenance|Custom/)).toBeTruthy()
  })

  it('reads the kinds when a dialog with a picker opens, and not for the page alone', async () => {
    renderWith(null)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/api/v1/metric-catalog')))
    expect(quantityKindReads()).toBe(0)
  })

  it('reads them once, however often the dialog is opened and closed', async () => {
    renderWith({ standard: 'MTConnect', type: 'ANGLE' })
    await waitFor(() => expect(standardSelect().value).toBe('MTConnect'))
    await waitFor(() => expect(quantityKindReads()).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(quantityKindReads()).toBe(1)
  })

  it('offers no kind as the id of an MTConnect metric, and says only that standards\' ids are listed', async () => {
    renderWith({ standard: 'MTConnect', type: 'ANGLE' })
    await waitFor(() => expect(standardSelect().value).toBe('MTConnect'))
    await waitFor(() => expect(quantityKindReads()).toBe(1))
    openSearch()
    search('temperature')
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search the vocabularies and templates' })).toBeTruthy())
    expect(listed().some(t => t.includes('QUDT'))).toBe(false)
  })

  it('offers the kinds as the id of a Custom metric, and asks no replacement note of it', async () => {
    renderWith({ standard: 'MTConnect', type: 'ANGLE' })
    await waitFor(() => expect(standardSelect().value).toBe('MTConnect'))
    await waitFor(() => expect(quantityKindReads()).toBe(1))
    fireEvent.change(standardSelect(), { target: { value: '' } })
    openSearch()
    search('flow rate')

    await waitFor(() => expect(listed().some(t => t.includes('Volume Flow Rate') && t.includes('QUDT') && t.includes(FLOW))).toBe(true))
    fireEvent.click(screen.getAllByRole('button').find(b => b.textContent.includes('Volume Flow Rate') && b.textContent.includes(FLOW)))
    expect(semanticIdInput().value).toBe(FLOW)
    expect(referenceType().value).toBe('IRI')
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('offers the kinds as the id of an ASHRAE 223P metric, with no note that it replaces one', async () => {
    renderWith({ standard: 'MTConnect', type: 'ANGLE' })
    await waitFor(() => expect(standardSelect().value).toBe('MTConnect'))
    await waitFor(() => expect(quantityKindReads()).toBe(1))
    fireEvent.change(standardSelect(), { target: { value: 'ASHRAE 223P' } })
    openSearch()
    search('temperature')

    await waitFor(() => expect(listed().some(t => t.includes('Temperature') && t.includes('QUDT'))).toBe(true))
    fireEvent.click(screen.getAllByRole('button').find(b => b.textContent.includes('Temperature') && b.textContent.includes(TEMPERATURE)))
    expect(semanticIdInput().value).toBe(TEMPERATURE)
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('says a kind typed in by hand is another standard\'s id on an MTConnect metric, as it does for any', async () => {
    renderWith({ standard: 'MTConnect', type: 'ANGLE' })
    await waitFor(() => expect(standardSelect().value).toBe('MTConnect'))
    await waitFor(() => expect(quantityKindReads()).toBe(1))
    fireEvent.change(semanticIdInput(), { target: { value: TEMPERATURE } })

    expect(screen.getByRole('note').textContent).toMatch(/Temperature comes from QUDT\. A metric carries\s+one semantic id, so it replaces any MTConnect id/)
  })
})

describe('Edit Metric and the QUDT quantity kinds', () => {
  const candidates = semanticIdCandidates({ quantityKinds: KINDS })
  const mtconnect = {
    metric_uuid: 'm1', name: 'Systems/TEMPERATURE', datatype: 10, standard: 'MTConnect',
    semantic_id: 'https://aber.local/semantics/mtconnect/v2.0/DataItemType/TEMPERATURE', semantic_id_type: 'IRI',
    permitted_values: null, further_semantic_ids: []
  }
  const open = (metric) => {
    render(<EditMetricSemanticIdModal metric={metric} usageCount={0} candidates={candidates} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    return within(document.querySelector('.modal'))
  }
  const furtherSection = (modal) => within(modal.getByRole('group', { name: /Further Semantic IDs/ }))

  it('offers the kinds as a further id of a metric another standard names', () => {
    const modal = open(mtconnect)
    fireEvent.click(modal.getByRole('button', { name: 'Add Further ID' }))
    const field = furtherSection(modal)
    fireEvent.click(field.getByRole('button', { name: 'Search Vocabularies' }))
    fireEvent.change(field.getByRole('textbox', { name: 'Search the vocabularies and templates' }), { target: { value: 'temperature' } })
    fireEvent.click(field.getByRole('button', { name: /Temperature/ }))

    expect(field.getByRole('textbox', { name: 'Further Semantic ID' }).value).toBe(TEMPERATURE)
    expect(field.getByRole('combobox', { name: 'Further Reference Type' }).value).toBe('IRI')
  })

  it('offers none as the primary id of that metric, so its own field has no search at all', () => {
    // The only candidates are quantity kinds, and an MTConnect metric may not have one as its own id.
    const modal = open(mtconnect)
    expect(modal.queryAllByRole('button', { name: 'Search Vocabularies' })).toHaveLength(0)
  })

  it('offers the kinds as the primary id of a Custom metric', () => {
    const modal = open({ ...mtconnect, standard: null, semantic_id: null, semantic_id_type: null, name: 'Hydraulic/OIL_TEMPERATURE' })
    fireEvent.click(modal.getAllByRole('button', { name: 'Search Vocabularies' })[0])
    fireEvent.change(modal.getByRole('textbox', { name: 'Search the vocabularies and templates' }), { target: { value: 'flow' } })
    expect(modal.getByRole('list', { name: 'Matching concepts' }).textContent).toContain('Volume Flow Rate')
  })
})
