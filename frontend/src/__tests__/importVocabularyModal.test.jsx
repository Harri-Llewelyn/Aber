import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ImportVocabularyModal } from '../components/modals/ImportVocabularyModal'
import { api } from '../api'
import { jsonConcept, jsonEnvironment, xmlConcept, xmlEnvironment, fileOf } from './aasFixtures'

/**
 * Import vocabulary: the file is read in the browser, what it holds is shown before anything is
 * written, the dialog says why it cannot go ahead, and the rows go to import_site_vocabulary().
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { siteVocabularyHolders: vi.fn(), importSiteVocabulary: vi.fn() } }
})

const OEE = 'https://example.test/kpi/OEE'
const SCRAP = 'https://example.test/kpi/Scrap'
const MTBF = 'https://example.test/kpi/Mtbf'

const jsonFile = (cds, name = 'kpis.json') => fileOf(JSON.stringify(jsonEnvironment(cds)), name)
const THREE = [
  jsonConcept(OEE, 'Overall equipment effectiveness', 'Definition one.', { version: '2' }),
  jsonConcept(SCRAP, 'Scrap ratio', 'Definition two.'),
  jsonConcept(MTBF, 'Mean time between failures', 'Definition three.')
]

const renderModal = (props = {}) => {
  const onImported = vi.fn()
  const onClose = vi.fn()
  render(<ImportVocabularyModal onImported={onImported} onClose={onClose} {...props} />)
  return { onImported, onClose }
}

const dialog = () => screen.getByRole('dialog', { name: 'Import vocabulary' })
const fileInput = () => within(dialog()).getByLabelText(/^File/)
const confirmButton = () => within(dialog()).getByRole('button', { name: 'Import vocabulary' })
const choose = async (file) => {
  fireEvent.change(fileInput(), { target: { files: [file] } })
  await screen.findByRole('group', { name: 'What the file holds' }).catch(() => null)
}
const facts = () => Object.fromEntries([...document.querySelectorAll('.site-import-facts dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]))
const problem = () => (document.querySelector('.modal-problem')?.textContent ?? '').trim()

beforeEach(() => {
  vi.clearAllMocks()
  api.siteVocabularyHolders.mockResolvedValue(new Map())
})

describe('Import vocabulary, before a file is chosen', () => {
  it('asks for a file and holds the confirm without scolding on open', () => {
    renderModal()

    expect(within(dialog()).getByText(/Nothing is written until you import/)).toBeTruthy()
    expect(confirmButton()).toBeDisabled()
    expect(confirmButton()).toHaveClass('btn-primary', 'btn-disabled')
    expect(problem()).toBe('')
  })

  it('says the licence is the site\'s responsibility and that the definitions start unshared', () => {
    renderModal()

    expect(within(dialog()).getByText(/The licence is the site's responsibility/)).toBeTruthy()
    expect(within(dialog()).getByText(/definitions start unshared/)).toBeTruthy()
  })

  it('offers the two kinds of file, the site\'s own first, and no standard fields until a standard is chosen', () => {
    renderModal()

    const kinds = within(dialog()).getAllByRole('radio')
    expect(kinds.map(r => r.parentElement.textContent)).toEqual(['A published standard', "The site's own vocabulary"])
    expect(kinds[1]).toBeChecked()
    expect(within(dialog()).queryByLabelText(/^Edition/)).toBeNull()
  })
})

describe('the preview', () => {
  it('shows the format, the version the file states and how many concepts will be imported', async () => {
    renderModal()
    await choose(jsonFile(THREE))

    await waitFor(() => expect(facts()['Will be imported']).toBe('3 concepts'))
    expect(facts().Format).toBe('AAS JSON environment')
    expect(facts().Version).toBe('2')
    expect(facts()['Already defined']).toBe('None.')
    expect(facts()['No IEC 61360 content']).toBe('None.')
  })

  it('says when the file states no version, and fills the name from the file name', async () => {
    renderModal()
    await choose(jsonFile([jsonConcept(OEE, 'OEE', 'Definition.')], 'Group KPIs.json'))

    await waitFor(() => expect(facts().Version).toBe('The file states none.'))
    expect(within(dialog()).getByLabelText(/^Name/).value).toBe('Group KPIs')
  })

  it('lists the ids a vocabulary already defines, and by which, and does not count them as imported', async () => {
    api.siteVocabularyHolders.mockResolvedValue(new Map([[OEE, 'ISO 22400'], [SCRAP, 'Group naming standard']]))
    renderModal()
    await choose(jsonFile(THREE))

    await waitFor(() => expect(facts()['Will be imported']).toBe('1 concept'))
    expect(facts()['Already defined']).toContain('2 concepts, skipped')
    expect(facts()['Already defined']).toContain(`${OEE}, by ISO 22400`)
    expect(facts()['Already defined']).toContain(`${SCRAP}, by Group naming standard`)
    expect(api.siteVocabularyHolders).toHaveBeenCalledWith([OEE, SCRAP, MTBF])
  })

  it('counts the ConceptDescriptions with no IEC 61360 content, an id stated twice and one it cannot use', async () => {
    renderModal()
    await choose(jsonFile([
      jsonConcept(OEE, 'OEE', 'Definition.'),
      jsonConcept(SCRAP, 'Scrap', 'Definition.', { withoutContent: true }),
      jsonConcept(OEE, 'OEE again', 'Definition.'),
      jsonConcept('just a word', 'Bad id', 'Definition.')
    ]))

    await waitFor(() => expect(facts()['Will be imported']).toBe('1 concept'))
    expect(facts()['No IEC 61360 content']).toBe('1 ConceptDescription, skipped.')
    expect(facts()['Stated twice']).toBe('1 concept, the first of each kept.')
    expect(facts().Unusable).toContain('its id is not an IRI, an IRDI or an ExpandedNodeId')
  })

  it('reads an XML environment too', async () => {
    renderModal()
    await choose(fileOf(xmlEnvironment([xmlConcept(OEE, 'OEE', 'Definition.')]), 'kpis.xml'))

    await waitFor(() => expect(facts().Format).toBe('AAS XML environment'))
  })

  it('shows a refused file\'s reason under the file, and holds the import', async () => {
    renderModal()
    await choose(fileOf(xmlEnvironment([], { prolog: '<!DOCTYPE environment [<!ENTITY x "y">]>' }), 'bomb.xml'))

    const hint = await screen.findByRole('alert')
    expect(hint.textContent).toMatch(/document type/)
    expect(confirmButton()).toBeDisabled()
    expect(problem()).toBe('Choose a file the reader can open.')
    expect(within(dialog()).queryByRole('group', { name: 'What the file holds' })).toBeNull()
  })
})

describe('why it cannot go ahead', () => {
  it('says, above the buttons, that every concept is already defined when none is left to import', async () => {
    api.siteVocabularyHolders.mockResolvedValue(new Map([[OEE, 'ISO 22400']]))
    renderModal()
    await choose(jsonFile([jsonConcept(OEE, 'OEE', 'Definition.')]))

    await waitFor(() => expect(problem()).toMatch(/Every concept in the file is already defined/))
    expect(confirmButton()).toBeDisabled()
  })

  it('asks for the standard, its edition and its publisher when the file is a published one, and for a name', async () => {
    renderModal()
    await choose(jsonFile(THREE))
    await waitFor(() => expect(confirmButton()).not.toBeDisabled())

    fireEvent.click(within(dialog()).getByRole('radio', { name: /A published standard/ }))
    await waitFor(() => expect(problem()).toBe('Name the standard, its edition and its publisher.'))
    expect(confirmButton()).toBeDisabled()
    fireEvent.change(within(dialog()).getByLabelText(/^Standard/), { target: { value: 'ISO 22400-2' } })
    fireEvent.change(within(dialog()).getByLabelText(/^Edition/), { target: { value: '2014' } })
    expect(confirmButton()).toBeDisabled()
    fireEvent.change(within(dialog()).getByLabelText(/^Publisher/), { target: { value: 'ISO' } })
    expect(problem()).toBe('')
    expect(within(dialog()).getByText('ISO 22400-2:2014')).toBeTruthy()
    expect(confirmButton()).not.toBeDisabled()

    fireEvent.change(within(dialog()).getByLabelText(/^Name/), { target: { value: '  ' } })
    expect(problem()).toBe('Give the vocabulary a name.')
    expect(confirmButton()).toBeDisabled()
  })
})

describe('importing', () => {
  it('hands the file and every row the reader took to the function, and says what came back', async () => {
    api.importSiteVocabulary.mockResolvedValue({ id: 'new-id', concepts: 3, skipped: [] })
    const { onImported } = renderModal()
    await choose(jsonFile(THREE, 'iso.json'))
    await waitFor(() => expect(confirmButton()).not.toBeDisabled())

    fireEvent.click(within(dialog()).getByRole('radio', { name: /A published standard/ }))
    fireEvent.change(within(dialog()).getByLabelText(/^Standard/), { target: { value: 'ISO 22400-2' } })
    fireEvent.change(within(dialog()).getByLabelText(/^Edition/), { target: { value: '2014' } })
    fireEvent.change(within(dialog()).getByLabelText(/^Publisher/), { target: { value: 'ISO' } })
    fireEvent.change(within(dialog()).getByLabelText(/^Licence note/), { target: { value: 'Single-site licence.' } })
    fireEvent.click(confirmButton())

    await waitFor(() => expect(onImported).toHaveBeenCalledWith({ id: 'new-id', concepts: 3, skipped: [], name: 'iso' }))
    const [file, rows] = api.importSiteVocabulary.mock.calls[0]
    expect(file).toMatchObject({
      name: 'iso', source_format: 'aas-json', kind: 'published_standard', standard_name: 'ISO 22400-2',
      standard_edition: '2014', standard_publisher: 'ISO', version: '2', licence_note: 'Single-site licence.'
    })
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(rows.map(r => r.semantic_id)).toEqual([OEE, SCRAP, MTBF])
  })

  it('sends a site\'s own vocabulary with no standard fields and no empty ones', async () => {
    api.importSiteVocabulary.mockResolvedValue({ id: 'x', concepts: 1, skipped: [] })
    renderModal()
    await choose(jsonFile([jsonConcept(OEE, 'OEE', 'Definition.')]))
    await waitFor(() => expect(confirmButton()).not.toBeDisabled())
    fireEvent.click(confirmButton())

    await waitFor(() => expect(api.importSiteVocabulary).toHaveBeenCalled())
    const [file] = api.importSiteVocabulary.mock.calls[0]
    expect(Object.keys(file).sort()).toEqual(['kind', 'name', 'sha256', 'source_format'])
    expect(file.kind).toBe('site_own')
  })

  it('keeps the dialog open with the refusal as the database worded it', async () => {
    api.importSiteVocabulary.mockRejectedValue(new Error('This file is already imported as "ISO KPIs" (on 2026-11-01).'))
    const { onImported, onClose } = renderModal()
    await choose(jsonFile(THREE))
    await waitFor(() => expect(confirmButton()).not.toBeDisabled())
    fireEvent.click(confirmButton())

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('already imported as "ISO KPIs"')
    expect(onImported).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(within(dialog()).getByLabelText(/^Name/).value).toBe('kpis')
  })

  it('closes on Cancel without writing anything', async () => {
    const { onClose } = renderModal()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalled()
    expect(api.importSiteVocabulary).not.toHaveBeenCalled()
  })
})
