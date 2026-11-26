import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VocabularyTab } from '../components/tabs/VocabularyTab'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'
import { requiresRolesTitle } from '../hooks/usePermissions'
import { siteVocabularyUrl } from '../routes'
import { tabLink, tabLinks } from '../test/tabBar'
import { tooltipOf } from '../test/tooltips'
import { jsonConcept, jsonEnvironment } from './aasFixtures'

/**
 * The Imported tab of the Vocabulary page: the files a site imported, their concepts with the same Use
 * action and "N in use" count as the standards' tabs, and Import, Remove and Share, which only an
 * Administrator may press.
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), displayNamesFor: vi.fn(), removeSiteVocabulary: vi.fn(), setSiteVocabularySharing: vi.fn(),
      siteVocabularyHolders: vi.fn(), importSiteVocabulary: vi.fn()
    }
  }
})

const ISO_FILE = {
  id: 'v-iso', name: 'ISO 22400 KPIs', source_format: 'aasx', kind: 'published_standard',
  standard_name: 'ISO 22400-2', standard_edition: '2014', standard_publisher: 'ISO', sha256: 'a'.repeat(64),
  version: '2.1', licence_note: 'Single-site licence.', definitions_shareable: false,
  imported_by: 'u-admin', imported_at: '2026-11-10T09:30:00Z', concept_count: 2
}
const OWN_FILE = {
  id: 'v-own', name: 'Group naming standard', source_format: 'aas-json', kind: 'site_own',
  standard_name: null, standard_edition: null, standard_publisher: null, sha256: 'b'.repeat(64),
  version: null, licence_note: null, definitions_shareable: true,
  imported_by: 'u-admin', imported_at: '2026-11-09T09:30:00Z', concept_count: 1
}
const CONCEPTS = [
  { vocabulary_id: 'v-iso', semantic_id: 'https://example.test/kpi/OEE', semantic_id_type: 'IRI', preferred_name: 'Overall equipment effectiveness', definition: 'How much of the planned time made good parts.', unit: '%', unit_id: null, data_type: 'REAL_MEASURE' },
  { vocabulary_id: 'v-iso', semantic_id: 'https://example.test/kpi/Scrap', semantic_id_type: 'IRI', preferred_name: 'Scrap ratio', definition: null, unit: null, unit_id: null, data_type: null },
  { vocabulary_id: 'v-own', semantic_id: 'https://example.test/group/G1', semantic_id_type: 'IRI', preferred_name: 'Group metric', definition: 'A group metric.', unit: null, unit_id: null, data_type: 'STRING' }
]
const CATALOG = [
  { metric_uuid: 'm1', name: 'OEE', datatype: 10, standard: null, site_vocabulary_id: 'v-iso', semantic_id: 'https://example.test/kpi/OEE', further_semantic_ids: [] },
  { metric_uuid: 'm2', name: 'Other', datatype: 10, standard: null, site_vocabulary_id: null, semantic_id: 'https://example.test/other', further_semantic_ids: [{ semantic_id: 'https://example.test/group/G1' }] },
  { metric_uuid: 'm3', name: 'Axes/DISPLACEMENT', datatype: 10, standard: 'MTConnect', semantic_id: null, further_semantic_ids: [] }
]

let files

const ADMIN_ONLY = (permission) => permission === PERMISSION_UUIDS.SCHEMA_MANAGE

const renderTab = ({ canManage = true, onUseEntry = vi.fn(), showToast = vi.fn() } = {}) => {
  window.history.replaceState({}, '', '/vocabulary/imported')
  render(<VocabularyTab hasPermission={canManage ? ADMIN_ONLY : () => false} onUseEntry={onUseEntry} showToast={showToast} />)
  return { onUseEntry, showToast }
}
const filesTable = async () => {
  const table = await screen.findByRole('table')
  await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1))
  return table
}
const rowOf = (table, name) => within(table).getByText(name).closest('tr')
const cells = (row) => [...row.querySelectorAll('td')].map(td => td.textContent)

beforeEach(() => {
  vi.clearAllMocks()
  files = [ISO_FILE, OWN_FILE]
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/site-vocabularies')) return Promise.resolve(files)
    if (path.startsWith('/api/v1/site-vocabulary-concepts')) return Promise.resolve(CONCEPTS)
    if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(CATALOG)
    return Promise.resolve([])
  })
  api.displayNamesFor.mockResolvedValue(new Map([['u-admin', 'Ada Admin']]))
})

describe('the Imported tab', () => {
  it('is the last tab of the page, named Imported, with a tooltip that says what it holds', async () => {
    renderTab()
    await filesTable()

    expect(tabLinks().at(-1).textContent).toBe('Imported')
    expect(tabLink('Imported').getAttribute('aria-current')).toBe('page')
    expect(tabLink('Imported')).toHaveAccessibleDescription(/imported from AAS files/)
  })

  it('lists each file with what it is, its version, who imported it, its concepts, its use and whether it is shared', async () => {
    renderTab()
    const table = await filesTable()

    expect(within(table).getAllByRole('columnheader').map(th => th.textContent)).toEqual([
      'Vocabulary', 'What it is', 'Version', 'Imported by', 'Imported', 'Concepts', 'In use', 'Definitions', 'Actions'
    ])
    const iso = cells(rowOf(table, 'ISO 22400 KPIs'))
    expect(iso.slice(1, 4)).toEqual(['ISO 22400-2:2014, ISO', '2.1', 'Ada Admin'])
    // Two concepts, one of which a metric carries and one metric was started from: two metrics use it.
    expect(iso.slice(5, 8)).toEqual(['2', '1', 'Not shared'])
    const own = cells(rowOf(table, 'Group naming standard'))
    expect(own.slice(1, 4)).toEqual(["Site's own", '—', 'Ada Admin'])
    expect(own.slice(5, 8)).toEqual(['1', '1', 'Shared'])
  })

  it('sorts the files by a column, and again to reverse it', async () => {
    renderTab()
    const table = await filesTable()
    const order = () => [...table.querySelectorAll('tbody tr')].map(tr => tr.querySelector('td').textContent)
    expect(order()).toEqual(['ISO 22400 KPIs', 'Group naming standard'])

    fireEvent.click(within(table).getByRole('button', { name: 'Vocabulary' }))
    expect(order()).toEqual(['Group naming standard', 'ISO 22400 KPIs'])
    fireEvent.click(within(table).getByRole('button', { name: 'Vocabulary' }))
    expect(order()).toEqual(['ISO 22400 KPIs', 'Group naming standard'])
    fireEvent.click(within(table).getByRole('button', { name: 'Concepts' }))
    expect(order()).toEqual(['Group naming standard', 'ISO 22400 KPIs'])
  })

  it('shows the concepts under it, with how many are in use, and hands one over as a Custom entry', async () => {
    const { onUseEntry } = renderTab()
    await filesTable()

    const heading = screen.getByRole('button', { name: 'ISO 22400 KPIs, 2 entries' })
    expect(heading.closest('.vocab-section-head')).toHaveTextContent('1 in use')
    fireEvent.click(heading)
    const chip = screen.getByRole('button', { name: 'Start a catalog metric from Overall equipment effectiveness, already used by one' })
    fireEvent.click(chip)

    expect(onUseEntry).toHaveBeenCalledWith({ standard: '', siteConcept: CONCEPTS[0], siteVocabulary: ISO_FILE })
  })

  it('searches the concepts by name, id and definition, and opens the files that match', async () => {
    renderTab()
    await filesTable()

    fireEvent.change(screen.getByLabelText('Search the imported vocabularies'), { target: { value: 'planned time' } })
    expect(await screen.findByText('Overall equipment effectiveness')).toBeTruthy()
    expect(screen.queryByText('Scrap ratio')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Group naming standard' })).toBeNull()
  })

  it('opens the file a link names', async () => {
    window.history.replaceState({}, '', `${siteVocabularyUrl('v-own')}`)
    render(<VocabularyTab hasPermission={ADMIN_ONLY} onUseEntry={vi.fn()} showToast={vi.fn()} />)
    await filesTable()

    expect(screen.getByText('Group metric')).toBeTruthy()
    expect(screen.queryByText('Scrap ratio')).toBeNull()
  })

  it('says nothing has been imported, and still offers Import to an Administrator', async () => {
    files = []
    renderTab()

    expect(await screen.findByText(/No vocabulary has been imported/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Import Vocabulary/ })).not.toBeDisabled()
  })
})

describe('who may import, remove and share', () => {
  it('greys every action for a role that may not, with who may in each tooltip and a line saying so', async () => {
    renderTab({ canManage: false })
    const table = await filesTable()
    const requires = requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)

    const buttons = [
      screen.getByRole('button', { name: /Import Vocabulary/ }),
      within(table).getByRole('button', { name: 'Share the definitions of ISO 22400 KPIs' }),
      within(table).getByRole('button', { name: 'Stop sharing the definitions of Group naming standard' }),
      within(table).getByRole('button', { name: 'Remove ISO 22400 KPIs' })
    ]
    for (const button of buttons) {
      expect(button).toBeDisabled()
      expect(button).toHaveClass('btn-disabled')
      expect(tooltipOf(button)).toBe(requires)
    }
    expect(screen.getByText(new RegExp(`${requires} to import, remove or share a vocabulary`))).toBeTruthy()
    expect(api.removeSiteVocabulary).not.toHaveBeenCalled()
  })

  it('lets an Administrator press them, the main one filled in the toolbar', async () => {
    renderTab()
    const table = await filesTable()

    const importButton = screen.getByRole('button', { name: /Import Vocabulary/ })
    expect(importButton).toHaveClass('btn-primary')
    expect(importButton.closest('.filter-bar-actions')).toBeTruthy()
    expect(within(table).getByRole('button', { name: 'Remove ISO 22400 KPIs' })).not.toBeDisabled()
  })

  it('opens the Import dialog from the toolbar', async () => {
    renderTab()
    await filesTable()
    fireEvent.click(screen.getByRole('button', { name: /Import Vocabulary/ }))

    expect(screen.getByRole('dialog', { name: 'Import Vocabulary' })).toBeTruthy()
  })
})

describe('removing a vocabulary', () => {
  it('says how many metrics use it before anything goes, keeps their ids, and ends in a toast that links to the tab', async () => {
    api.removeSiteVocabulary.mockResolvedValue({ id: 'v-iso', name: 'ISO 22400 KPIs', concepts: 2, metrics_linked: 1 })
    const { showToast } = renderTab()
    const table = await filesTable()

    fireEvent.click(within(table).getByRole('button', { name: 'Remove ISO 22400 KPIs' }))
    const dialog = screen.getByRole('dialog', { name: /Remove Vocabulary/ })
    expect(dialog).toHaveTextContent('1 catalog metric use it')
    expect(dialog).toHaveTextContent('They keep their ids')
    expect(api.removeSiteVocabulary).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Vocabulary' }))
    await waitFor(() => expect(api.removeSiteVocabulary).toHaveBeenCalledWith('v-iso'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Vocabulary 'ISO 22400 KPIs' removed", 'success', { to: siteVocabularyUrl() }))
    expect(screen.queryByRole('dialog', { name: /Remove Vocabulary/ })).toBeNull()
  })

  it('says no metric uses one that none does', async () => {
    api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/site-vocabularies') ? files
      : path.startsWith('/api/v1/site-vocabulary-concepts') ? CONCEPTS : []))
    renderTab()
    const table = await filesTable()
    fireEvent.click(within(table).getByRole('button', { name: 'Remove Group naming standard' }))

    expect(screen.getByRole('dialog', { name: /Remove Vocabulary/ })).toHaveTextContent('No catalog metric uses it')
  })

  it('keeps the dialog open with the refusal as the database worded it', async () => {
    api.removeSiteVocabulary.mockRejectedValue(new Error('No imported vocabulary has that id. It may have been removed already.'))
    renderTab()
    const table = await filesTable()
    fireEvent.click(within(table).getByRole('button', { name: 'Remove ISO 22400 KPIs' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: /Remove Vocabulary/ })).getByRole('button', { name: 'Remove Vocabulary' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('may have been removed already')
  })
})

describe('sharing the definitions', () => {
  it('asks first, in one line that the licence is the site\'s responsibility, then shares and says so in a toast that links to the file', async () => {
    api.setSiteVocabularySharing.mockResolvedValue({ id: 'v-iso', name: 'ISO 22400 KPIs', definitions_shareable: true })
    const { showToast } = renderTab()
    const table = await filesTable()

    fireEvent.click(within(table).getByRole('button', { name: 'Share the definitions of ISO 22400 KPIs' }))
    const dialog = screen.getByRole('dialog', { name: /Share the Definitions/ })
    expect(dialog).toHaveTextContent("The licence is the site's responsibility")
    expect(api.setSiteVocabularySharing).not.toHaveBeenCalled()
    const confirm = within(dialog).getByRole('button', { name: 'Share Definitions' })
    expect(confirm).toHaveClass('btn-primary')

    fireEvent.click(confirm)
    await waitFor(() => expect(api.setSiteVocabularySharing).toHaveBeenCalledWith('v-iso', true))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("The definitions of 'ISO 22400 KPIs' are shared", 'success', { to: siteVocabularyUrl('v-iso') }))
  })

  it('stops sharing at once, with no question, and says so in a toast that links to the file', async () => {
    api.setSiteVocabularySharing.mockResolvedValue({ id: 'v-own', name: 'Group naming standard', definitions_shareable: false })
    const { showToast } = renderTab()
    const table = await filesTable()

    fireEvent.click(within(table).getByRole('button', { name: 'Stop sharing the definitions of Group naming standard' }))

    await waitFor(() => expect(api.setSiteVocabularySharing).toHaveBeenCalledWith('v-own', false))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      "The definitions of 'Group naming standard' are no longer shared", 'success', { to: siteVocabularyUrl('v-own') }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reads the files again after an act, so the table says what is now true', async () => {
    api.setSiteVocabularySharing.mockImplementation(async () => {
      files = [{ ...ISO_FILE, definitions_shareable: true }, OWN_FILE]
      return { id: 'v-iso', name: 'ISO 22400 KPIs', definitions_shareable: true }
    })
    renderTab()
    const table = await filesTable()
    fireEvent.click(within(table).getByRole('button', { name: 'Share the definitions of ISO 22400 KPIs' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: /Share the Definitions/ })).getByRole('button', { name: 'Share Definitions' }))

    await waitFor(() => expect(cells(rowOf(screen.getByRole('table'), 'ISO 22400 KPIs'))[7]).toBe('Shared'))
  })
})

describe('an import', () => {
  it('ends in a toast that says how many were taken and skipped and links to the file', async () => {
    const { showToast } = renderTab()
    await filesTable()
    // The dialog's own checks and hand-over are held by importVocabularyModal.test.jsx; here the page's
    // reading of what the function answered is what matters.
    api.importSiteVocabulary.mockResolvedValue({ id: 'v-new', concepts: 3, skipped: [{ semantic_id: 'x', reason: 'already_defined', held_by: 'MTConnect' }] })
    api.siteVocabularyHolders.mockResolvedValue(new Map())
    fireEvent.click(screen.getByRole('button', { name: /Import Vocabulary/ }))
    const dialog = screen.getByRole('dialog', { name: 'Import Vocabulary' })
    const body = JSON.stringify(jsonEnvironment([jsonConcept('https://example.test/new', 'New concept', 'Text.')]))
    fireEvent.change(within(dialog).getByTestId('vocabulary-file'), { target: { files: [new File([body], 'new.json')] } })
    await within(dialog).findByRole('group', { name: 'What the File Holds' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import Vocabulary' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      "Vocabulary 'new' imported: 3 concepts, 1 skipped", 'success', { to: siteVocabularyUrl('v-new') }))
  })
})

describe('the sidebar and the tab bar agree on the tab', () => {
  it('lists Imported last, after the standards and the templates, by the slug the tab is drawn under', async () => {
    const { TABS, SITE_VOCABULARY_TAB, TEMPLATES_TAB, VOCABULARY_TABS } = await import('../navigation')
    const { siteVocabularyTab } = await import('../components/common/SiteVocabularyPanel')
    const { pathSlug } = await import('../hooks/useUrlState')
    const pageTabs = TABS.find(t => t.id === 'vocabulary').pageTabs
    expect(pageTabs).toEqual([...VOCABULARY_TABS, TEMPLATES_TAB, SITE_VOCABULARY_TAB])
    const drawn = siteVocabularyTab({ canManage: true })
    expect(SITE_VOCABULARY_TAB).toEqual({ id: pathSlug(drawn.id), label: drawn.label })
    expect(drawn.panel).toBeTruthy()
    expect(drawn.sections).toBeUndefined()
  })
})
