import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { api } from '../api'
import { dropdownButton, openDropdown, valueName } from '../test/listFilters'
import { sitePrefill, withSiteStandards, importedStandardOptions, metricStandardLabel, datatypeForIec61360 } from '../utils/siteVocabulary'

/**
 * Metrics started from an imported vocabulary: the Standard column labels one from its file, the
 * Standard filter offers each published standard a site imported, and Add Metric is filled from a
 * concept without copying a licensed definition into the catalog.
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const ISO_FILE = {
  id: 'v-iso', name: 'ISO 22400 KPIs', kind: 'published_standard', source_format: 'aasx',
  standard_name: 'ISO 22400-2', standard_edition: '2014', standard_publisher: 'ISO',
  definitions_shareable: false, concept_count: 2
}
const OWN_FILE = {
  id: 'v-own', name: 'Group naming standard', kind: 'site_own', source_format: 'aas-json',
  standard_name: null, standard_edition: null, standard_publisher: null,
  definitions_shareable: true, concept_count: 1
}

const CATALOG = [
  { metric_uuid: 'm1', name: 'Axes/DISPLACEMENT', metric_group: 'Axes', datatype: 10, category: 'SAMPLE', standard: 'MTConnect', semantic_id: null, deprecated: false },
  { metric_uuid: 'm2', name: 'OEE', metric_group: null, datatype: 10, standard: null, site_vocabulary_id: 'v-iso', semantic_id: 'https://example.test/kpi/OEE', deprecated: false },
  { metric_uuid: 'm3', name: 'GroupMetric', metric_group: null, datatype: 10, standard: null, site_vocabulary_id: 'v-own', semantic_id: 'https://example.test/group/G1', deprecated: false },
  { metric_uuid: 'm4', name: 'safety_interlock', metric_group: null, datatype: 11, standard: null, semantic_id: null, deprecated: false }
]

const CONCEPT = {
  vocabulary_id: 'v-iso', semantic_id: 'https://example.test/kpi/OverallEquipmentEffectiveness', semantic_id_type: 'IRI',
  preferred_name: 'Overall equipment effectiveness', definition: 'How much of the planned time made good parts.',
  unit: '%', unit_id: null, data_type: 'REAL_MEASURE'
}

const routes = {
  '/api/v1/schemas': [],
  '/api/v1/metric-catalog': CATALOG,
  '/api/v1/site-vocabularies': [ISO_FILE, OWN_FILE],
  '/api/v1/metric-groups': [{ group_uuid: 'g1', name: 'Axes', standard: 'MTConnect' }],
  '/api/v1/mtconnect-vocabulary': [{ kind: 'UNIT', name: 'PERCENT', category: null }],
  '/api/v1/iso22400-vocabulary': [],
  '/api/v1/opcua-vocabulary': [],
  '/api/v1/ashrae223-vocabulary': [],
  '/api/v1/vda5050-vocabulary': [],
  '/api/v1/idta-submodel-templates': [],
  '/api/v1/gateways': [],
  '/api/v1/devices': []
}

const mockRoutes = (overrides = {}) => api.get.mockImplementation((path) => {
  const table = { ...routes, ...overrides }
  const key = Object.keys(table).find(r => path.startsWith(r))
  return Promise.resolve(key ? table[key] : [])
})

const renderTab = (props = {}) => render(
  <MetricsTab showToast={vi.fn()} hasPermission={() => true} {...props} />
)

const catalogTable = () => document.querySelector('.card table')
const waitForCatalog = async () => {
  await waitFor(() => expect(catalogTable()).toBeTruthy())
  await waitFor(() => expect(within(catalogTable()).getAllByRole('button', { expanded: false }).length).toBeGreaterThan(0))
  for (const header of within(catalogTable()).queryAllByRole('button', { expanded: false })) fireEvent.click(header)
}
/** The text of the Standard column, by metric name. */
const standardOf = (name) => within(catalogTable()).getByText(name).closest('tr').querySelectorAll('td')[1].textContent
const standardFilter = () => dropdownButton('Standard')
const optionTexts = () => {
  const texts = [...openDropdown('Standard').querySelectorAll('.filter-checklist-option')].map(o => o.textContent)
  fireEvent.click(standardFilter())
  return texts
}
const listed = () => [...catalogTable().querySelectorAll('tbody tr:not(.table-group-row) td:first-child .mono')].map(el => el.textContent)
const chooseStandard = (label) => {
  const panel = openDropdown('Standard')
  for (const box of within(panel).getAllByRole('checkbox')) {
    if (box.checked !== valueName(label)(box.closest('label').textContent)) fireEvent.click(box)
  }
  fireEvent.click(standardFilter())
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/metrics')
  mockRoutes()
})

describe('what a metric started from an imported file is labelled', () => {
  it('labels a published standard by its citation and "(site licence)", and a site\'s own file by its name', async () => {
    renderTab()
    await waitForCatalog()

    expect(standardOf('OEE')).toBe('ISO 22400-2:2014 (site licence)')
    expect(standardOf('GroupMetric')).toBe('Group naming standard')
    expect(standardOf('safety_interlock')).toBe('Local extension')
    expect(standardOf('Axes/DISPLACEMENT')).toBe('MTConnect')
  })

  it('says so in the drawer too', async () => {
    renderTab()
    await waitForCatalog()
    fireEvent.click(within(catalogTable()).getByText('OEE').closest('tr'))

    expect(within(document.querySelector('.context-panel')).getByText('ISO 22400-2:2014 (site licence)')).toBeTruthy()
  })

  it('falls back to Local extension where the files cannot be read, and the page stands', async () => {
    api.get.mockImplementation((path) => (path.startsWith('/api/v1/site-vocabularies')
      ? Promise.reject(new Error('relation does not exist'))
      : Promise.resolve(routes[Object.keys(routes).find(r => path.startsWith(r))] || [])))
    renderTab()
    await waitForCatalog()

    expect(standardOf('OEE')).toBe('Local extension')
    expect(optionTexts().some(t => t.includes('site licence'))).toBe(false)
  })
})

describe('the Standard filter and an imported standard', () => {
  it('offers one option for each published standard, after the standards and before Local extension', async () => {
    renderTab()
    await waitForCatalog()

    const texts = optionTexts()
    expect(texts).toEqual([
      'MTConnect 1', 'ISO 22400 0', 'OPC UA 0', 'ASHRAE 223P 0', 'VDA 5050 0',
      'ISO 22400-2:2014 (site licence) 1', 'Local extension 2'
    ])
  })

  it('narrows to the metrics started from that standard, and Local extension keeps a site\'s own and the rest', async () => {
    renderTab()
    await waitForCatalog()

    chooseStandard('ISO 22400-2:2014 (site licence)')
    expect(listed()).toEqual(['OEE'])

    chooseStandard('Local extension')
    expect(listed()).toEqual(['GroupMetric', 'safety_interlock'])
  })

  it('keeps a link that names an imported standard, and drops one the files do not hold', async () => {
    window.history.replaceState({}, '', `/metrics?standard=${encodeURIComponent('site:ISO 22400-2:2014')}`)
    const first = renderTab()
    await waitFor(() => expect(catalogTable()).toBeTruthy())
    await waitFor(() => expect(listed()).toEqual(['OEE']))
    first.unmount()

    window.history.replaceState({}, '', `/metrics?standard=${encodeURIComponent('site:Nothing 1:2000')}`)
    renderTab()
    await waitForCatalog()
    expect(window.location.search).not.toContain('standard')
    expect(standardFilter()).toHaveTextContent('Any standard')
  })

  it('offers no option for a site\'s own vocabulary, which is a local extension', () => {
    expect(importedStandardOptions([OWN_FILE])).toEqual([])
    expect(importedStandardOptions([ISO_FILE, { ...ISO_FILE, id: 'v-iso-2' }])).toHaveLength(1)
  })
})

describe('Add Metric from an imported concept', () => {
  const entry = (file) => ({ standard: '', siteConcept: CONCEPT, siteVocabulary: file })
  const renderFrom = (file) => renderTab({ pendingVocabularyEntry: entry(file), onConsumeVocabularyEntry: vi.fn() })
  const nameInput = () => screen.getByLabelText(/Metric Name/)
  const descriptionInput = () => screen.getByLabelText('Description')

  it('fills a Custom metric: its name from the preferred name, the id, the datatype', async () => {
    mockRoutes()
    renderFrom({ ...ISO_FILE, definitions_shareable: true })
    await waitForCatalog()

    expect(screen.getByLabelText('Standard').value).toBe('')
    expect(nameInput().value).toBe('OverallEquipmentEffectiveness')
    expect(screen.getByRole('textbox', { name: /Semantic ID/ }).value).toBe(CONCEPT.semantic_id)
    expect(screen.getByLabelText('Sparkplug Datatype').value).toBe('10')
    expect(screen.getByText(/linked to ISO 22400-2:2014 \(site licence\)/)).toBeTruthy()
  })

  it('takes the definition as the description only where the file\'s definitions are shared', async () => {
    renderFrom({ ...ISO_FILE, definitions_shareable: true })
    await waitForCatalog()

    expect(descriptionInput().value).toBe(CONCEPT.definition)
    expect(screen.queryByText(/is not copied here/)).toBeNull()
  })

  it('leaves the description empty, and says why in one line, when they are not', async () => {
    renderFrom(ISO_FILE)
    await waitForCatalog()

    expect(descriptionInput().value).toBe('')
    expect(screen.getByText(/The imported definition is not copied here/)).toBeTruthy()
    expect(descriptionInput()).toHaveAccessibleDescription(/is not copied here/)
  })

  it('adds it as a local extension that carries the link, never a typed standard', async () => {
    api.post.mockResolvedValue({ metric_uuid: 'new', name: 'OverallEquipmentEffectiveness' })
    renderFrom(ISO_FILE)
    await waitForCatalog()
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add Metric' })).getByRole('button', { name: 'Add Metric' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/metric-catalog', expect.objectContaining({
      name: 'OverallEquipmentEffectiveness',
      standard: '',
      site_vocabulary_id: 'v-iso',
      semantic_id: CONCEPT.semantic_id,
      semantic_id_type: 'IRI',
      datatype: 10,
      description: ''
    })))
  })

  it('drops the link when the operator changes the standard', async () => {
    api.post.mockResolvedValue({ metric_uuid: 'new', name: 'x' })
    renderFrom(ISO_FILE)
    await waitForCatalog()
    fireEvent.change(screen.getByLabelText('Standard'), { target: { value: 'MTConnect' } })
    expect(screen.queryByText(/linked to/)).toBeNull()
  })
})

describe('what a concept makes of a metric', () => {
  it('maps the IEC 61360 data type as the other prefills map theirs', () => {
    expect(datatypeForIec61360('REAL_MEASURE')).toBe(10)
    expect(datatypeForIec61360('INTEGER_COUNT')).toBe(10)
    expect(datatypeForIec61360('BOOLEAN')).toBe(11)
    expect(datatypeForIec61360('STRING')).toBe(12)
    expect(datatypeForIec61360('DATE')).toBe(12)
    // Not stated: the operator chooses, since the datatype cannot be changed afterwards.
    expect(datatypeForIec61360(null)).toBeUndefined()
  })

  it('never copies a licensed definition into the prefill', () => {
    expect(sitePrefill(CONCEPT, ISO_FILE).description).toBe('')
    expect(sitePrefill(CONCEPT, ISO_FILE).definitionWithheld).toBe(true)
    expect(sitePrefill(CONCEPT, { ...ISO_FILE, definitions_shareable: true }).description).toBe(CONCEPT.definition)
    expect(sitePrefill({ ...CONCEPT, definition: null }, ISO_FILE).definitionWithheld).toBe(false)
  })

  it('labels a file for the Metrics page, and decorates the catalog without touching its other fields', () => {
    expect(metricStandardLabel(ISO_FILE)).toBe('ISO 22400-2:2014 (site licence)')
    expect(metricStandardLabel(OWN_FILE)).toBe('Group naming standard')
    const [seeded, linked] = withSiteStandards(CATALOG, [ISO_FILE, OWN_FILE])
    expect(seeded.standard_label).toBe('MTConnect')
    expect(linked).toMatchObject({ name: 'OEE', standard_label: 'ISO 22400-2:2014 (site licence)', site_standard_filter: 'site:ISO 22400-2:2014' })
  })
})
