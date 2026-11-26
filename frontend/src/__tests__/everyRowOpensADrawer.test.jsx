import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { VocabularyTab } from '../components/tabs/VocabularyTab'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'
import { siteVocabularyUrl } from '../routes'
import { tabLink } from '../test/tabBar'

/**
 * Metrics › Uncatalogued and Vocabulary › Imported open a drawer from each row, as every list does, so a
 * column a narrow card hides is still in view. The drawer has every field the row has, and the acts: the
 * Uncatalogued drawer Catalogue, the Imported drawer Show Concepts, Share Definitions or Stop Sharing, and
 * Remove. The row keeps what a table row shows.
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(), displayNamesFor: vi.fn(), removeSiteVocabulary: vi.fn(),
      setSiteVocabularySharing: vi.fn(), siteVocabularyHolders: vi.fn(), importSiteVocabulary: vi.fn()
    }
  }
})

const UNCATALOGUED = [
  {
    metric_name: 'Hydraulic/PRESSURE', device_count: 5,
    devices: [
      { id: 'press-1', name: 'Press_01', quarantined: false }, { id: 'press-2', name: 'Press_02', quarantined: true },
      { id: 'press-3', name: 'Press_03', quarantined: false }, { id: 'press-4', name: 'Press_04', quarantined: false },
      { id: 'press-5', name: 'Press_05', quarantined: false }
    ],
    last_declared_at: '2026-10-02T10:00:00Z', datatypes: [3, 10]
  },
  {
    metric_name: 'Motor Speed', device_count: 1, devices: [{ id: 'fan-1', name: 'Fan_01', quarantined: false }],
    last_declared_at: '2026-10-01T09:00:00Z', datatypes: []
  }
]

const ISO_FILE = {
  id: 'a1b2c3d4-0000-4000-8000-000000001689', name: 'ISO 22400 KPIs', source_format: 'aasx', kind: 'published_standard',
  standard_name: 'ISO 22400-2', standard_edition: '2014', standard_publisher: 'ISO', sha256: 'a'.repeat(64),
  version: '2.1', licence_note: 'Single-site licence.', definitions_shareable: false,
  imported_by: 'u-admin', imported_at: '2026-11-10T09:30:00Z', concept_count: 2
}
const CONCEPTS = [
  { vocabulary_id: ISO_FILE.id, semantic_id: 'https://example.test/kpi/OEE', semantic_id_type: 'IRI', preferred_name: 'Overall equipment effectiveness', definition: null, unit: '%', unit_id: null, data_type: 'REAL_MEASURE' },
  { vocabulary_id: ISO_FILE.id, semantic_id: 'https://example.test/kpi/Scrap', semantic_id_type: 'IRI', preferred_name: 'Scrap ratio', definition: null, unit: null, unit_id: null, data_type: null }
]
const CATALOG = [
  { metric_uuid: 'm1', name: 'OEE', datatype: 10, standard: null, site_vocabulary_id: ISO_FILE.id, semantic_id: 'https://example.test/kpi/OEE', further_semantic_ids: [] },
  { metric_uuid: 'm2', name: 'Scrap', datatype: 10, standard: null, deprecated: true, semantic_id: 'https://example.test/kpi/Scrap', further_semantic_ids: [] }
]

let uncatalogued
beforeEach(() => {
  vi.clearAllMocks()
  uncatalogued = UNCATALOGUED
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/uncatalogued-metrics')) return Promise.resolve(uncatalogued)
    if (path.startsWith('/api/v1/site-vocabularies')) return Promise.resolve([ISO_FILE])
    if (path.startsWith('/api/v1/site-vocabulary-concepts')) return Promise.resolve(CONCEPTS)
    if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(CATALOG)
    return Promise.resolve([])
  })
  api.displayNamesFor.mockResolvedValue(new Map([['u-admin', 'Ada Admin']]))
})

const openPanel = () => document.querySelector('.context-panel-open')
const drawer = () => within(openPanel())
/** The drawer's fields, label to the text of its value. */
const fieldsOf = () => Object.fromEntries([...openPanel().querySelectorAll('.context-field')]
  .map(f => [f.querySelector('dt').textContent.trim(), f.querySelector('dd').textContent.trim()]))
const query = (key) => new URLSearchParams(window.location.search).get(key)

describe('Metrics › Uncatalogued', () => {
  const show = async (address = '/metrics/uncatalogued', hasPermission = () => true) => {
    window.history.replaceState(null, '', address)
    render(<MetricsTab showToast={vi.fn()} hasPermission={hasPermission} />)
    await waitFor(() => expect(document.querySelectorAll('.card tbody tr')).toHaveLength(2))
  }
  const rowOf = (name) => within(document.querySelector('.card table')).getByText(name).closest('tr')

  it('opens a drawer from a row, with every field the row has and each device, by its name in the address', async () => {
    await show()
    const row = rowOf('Hydraulic/PRESSURE')
    expect(row).toHaveClass('row-selectable')
    fireEvent.click(row)

    await waitFor(() => expect(openPanel()).not.toBeNull())
    expect(query('declared')).toBe('Hydraulic/PRESSURE')
    expect(row).toHaveClass('row-selected')
    expect(fieldsOf()).toMatchObject({ Name: 'Hydraulic/PRESSURE', Devices: '5', Datatype: 'Int32, Double' })
    expect(fieldsOf()['Last Declared']).toMatch(/2 Oct 2026/)
    // Every device, where the row shows three and a button for the rest.
    const chips = drawer().getAllByRole('link', { name: /Press_0/ })
    expect(chips).toHaveLength(5)
    expect(chips[0]).toHaveAttribute('href', '/devices?search=press-1')
    expect(chips[1]).toHaveTextContent('quarantined')
    expect(within(row).getAllByRole('link', { name: /Press_0/ })).toHaveLength(3)
    // Catalogue is the drawer's, not the row's.
    expect(within(row).queryByRole('button', { name: /Catalogue/ })).toBeNull()
    expect(drawer().getByRole('button', { name: /Catalogue/ })).toHaveClass('btn-primary')

    fireEvent.click(row)
    await waitFor(() => expect(openPanel()).toBeNull())
    expect(query('declared')).toBeNull()
  })

  it('opens from the keyboard, and from a link that names it', async () => {
    await show(`/metrics/uncatalogued?declared=${encodeURIComponent('Motor Speed')}`)
    await waitFor(() => expect(openPanel()).not.toBeNull())
    expect(drawer().getByText('Not set')).toBeTruthy()
    fireEvent.keyDown(rowOf('Motor Speed'), { key: 'Enter' })
    await waitFor(() => expect(openPanel()).toBeNull())
    fireEvent.keyDown(rowOf('Hydraulic/PRESSURE'), { key: ' ' })
    await waitFor(() => expect(query('declared')).toBe('Hydraulic/PRESSURE'))
  })

  it('says at its top why a name the catalog cannot hold is not catalogued, and greys Catalogue', async () => {
    await show(`/metrics/uncatalogued?declared=${encodeURIComponent('Motor Speed')}`)
    await waitFor(() => expect(openPanel()).not.toBeNull())
    expect(drawer().getByRole('list', { name: 'Warnings' })).toHaveTextContent(/The catalog cannot hold this name.*Rename it on the devices/)
    expect(drawer().getByRole('button', { name: /Catalogue/ })).toBeDisabled()
  })

  it('greys Catalogue for a reader who may not add a metric, and still opens the drawer', async () => {
    await show('/metrics/uncatalogued', (p) => p !== PERMISSION_UUIDS.SCHEMA_MANAGE)
    fireEvent.click(rowOf('Hydraulic/PRESSURE'))
    await waitFor(() => expect(openPanel()).not.toBeNull())
    expect(drawer().getByRole('button', { name: /Catalogue/ })).toBeDisabled()
  })

  it('closes once the name is catalogued and leaves the list, and on a change of tab', async () => {
    api.post.mockResolvedValue({ metric_uuid: 'm9' })
    await show(`/metrics/uncatalogued?declared=${encodeURIComponent('Hydraulic/PRESSURE')}`)
    await waitFor(() => expect(openPanel()).not.toBeNull())
    fireEvent.click(drawer().getByRole('button', { name: /Catalogue/ }))
    // The births disagree on its datatype, so the form leaves it to be chosen.
    fireEvent.change(screen.getByLabelText('Sparkplug Datatype'), { target: { value: '10' } })
    uncatalogued = [UNCATALOGUED[1]]
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add Metric' })).getByRole('button', { name: 'Add Metric' }))
    await waitFor(() => expect(document.querySelectorAll('.card tbody tr')).toHaveLength(1))
    await waitFor(() => expect(query('declared')).toBeNull())
    expect(openPanel()).toBeNull()

    fireEvent.click(rowOf('Motor Speed'))
    await waitFor(() => expect(openPanel()).not.toBeNull())
    fireEvent.click(tabLink('Metric Catalog'))
    await waitFor(() => expect(document.querySelector('.context-panel-open[aria-label*="Motor Speed"]')).toBeNull())
  })
})

describe('Vocabulary › Imported', () => {
  const show = async (address = '/vocabulary/imported', canManage = true) => {
    window.history.replaceState(null, '', address)
    render(<VocabularyTab hasPermission={canManage ? (p) => p === PERMISSION_UUIDS.SCHEMA_MANAGE : () => false} onUseEntry={vi.fn()} showToast={vi.fn()} />)
    const table = await screen.findByRole('table')
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1))
    return table
  }
  const rowOf = (table) => within(table).getByText('ISO 22400 KPIs').closest('tr')

  it('opens a drawer from a row, beside the card, with every field the row has and what its name\'s tooltip held', async () => {
    const table = await show()
    const row = rowOf(table)
    expect(row).toHaveClass('row-selectable')
    fireEvent.click(row)

    await waitFor(() => expect(openPanel()).not.toBeNull())
    expect(query('file')).toBe(ISO_FILE.id)
    expect(row).toHaveClass('row-selected')
    // A flex item of the page's row, as every page's drawer is, not inside the card.
    expect(openPanel().closest('.card')).toBeNull()
    expect(openPanel().closest('.page-layout')).not.toBeNull()
    expect(fieldsOf()).toMatchObject({
      'Vocabulary UUID': ISO_FILE.id, 'What it is': 'ISO 22400-2:2014, ISO', Version: '2.1', Format: 'AASX package',
      'Imported by': 'Ada Admin', Concepts: '2', Definitions: 'Not shared', Licence: 'Single-site licence.', 'SHA-256': 'a'.repeat(64)
    })
    expect(fieldsOf().Imported).toMatch(/10 Nov 2026/)
    // In use shows the metrics it counts, each opening its own drawer, a deprecated one on its tab.
    expect(drawer().getByRole('link', { name: /OEE/ })).toHaveAttribute('href', '/metrics?metric=m1')
    expect(drawer().getByRole('link', { name: /Scrap/ })).toHaveAttribute('href', '/metrics/deprecated?metric=m2')
    // The acts are the drawer's: Show Concepts first, then Share Definitions and Remove.
    expect(drawer().getAllByRole('button').filter(b => b.classList.contains('context-action')).map(b => b.textContent.trim()))
      .toEqual(['Show Concepts', 'Share Definitions', 'Remove'])
    expect(within(row).queryAllByRole('button')).toHaveLength(0)
  })

  it('opens its concepts below the table from a link that names it, and from Show Concepts', async () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    const scrap = () => screen.queryByRole('button', { name: /Start a catalog metric from Scrap ratio/ })
    await show(siteVocabularyUrl(ISO_FILE.id))
    await waitFor(() => expect(openPanel()).not.toBeNull())
    expect(scrap()).toBeTruthy()

    // Closed by hand, Show Concepts opens it again and brings it into view.
    fireEvent.click(screen.getByRole('button', { name: 'ISO 22400 KPIs, 2 entries' }))
    expect(scrap()).toBeNull()
    fireEvent.click(drawer().getByRole('button', { name: 'Show Concepts' }))
    await waitFor(() => expect(scrap()).toBeTruthy())
    await waitFor(() => expect(scrolled).toHaveBeenCalled())
    expect(scrolled.mock.contexts.at(-1).dataset.section).toBe(`site:${ISO_FILE.id}`)
    delete Element.prototype.scrollIntoView
  })

  it('greys the acts for a role that may not, and leaves Show Concepts to everyone', async () => {
    const table = await show('/vocabulary/imported', false)
    fireEvent.click(rowOf(table))
    await waitFor(() => expect(openPanel()).not.toBeNull())
    expect(drawer().getByRole('button', { name: 'Show Concepts' })).toBeEnabled()
    expect(drawer().getByRole('button', { name: 'Share Definitions' })).toBeDisabled()
    expect(drawer().getByRole('button', { name: 'Remove' })).toBeDisabled()
  })

  it('closes once the file is removed', async () => {
    api.removeSiteVocabulary.mockResolvedValue({ id: ISO_FILE.id, name: ISO_FILE.name })
    const table = await show()
    fireEvent.click(rowOf(table))
    await waitFor(() => expect(openPanel()).not.toBeNull())
    api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/metric-catalog') ? CATALOG : []))
    fireEvent.click(drawer().getByRole('button', { name: 'Remove' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: /Remove Vocabulary/ })).getByRole('button', { name: 'Remove Vocabulary' }))
    await waitFor(() => expect(openPanel()).toBeNull())
    await waitFor(() => expect(query('file')).toBeNull())
  })
})
