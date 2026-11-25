import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VocabularyTab } from '../components/tabs/VocabularyTab'
import { idtaTemplateTab } from '../components/common/IDTATemplatePanel'
import { TABS, TEMPLATES_TAB, currentTabOf, pageTitleOf, tabHref } from '../navigation'
import { pathSlug } from '../hooks/useUrlState'
import { api } from '../api'
import { tabBar, tabLink } from '../test/tabBar'
import { getByTooltip } from '../test/tooltips'
import { HELP_SOURCES as HELP_CORPUS } from './helpSources'

/**
 * The Templates tab of the Vocabulary page: the IDTA submodel templates, each element under the one it is
 * inside, for looking up. The helpers are in idtaTemplates.test.js.
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const NAMEPLATE_ID = 'https://admin-shell.io/idta/nameplate/3/0/Nameplate'
const AID_ID = 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/Submodel'
const SERIAL = '0112/2///61987#ABA951#009'
const nameplate = (more) => ({
  template_id: NAMEPLATE_ID, template_name: 'Digital Nameplate', template_number: 'IDTA 02006', template_version: '3.0.3',
  parent_path: null, value_type: null, semantic_id_type: 'IRDI', supplemental_semantic_ids: [], cardinality: null,
  definition: null, example_value: null, ...more
})
const aid = (more) => ({
  ...nameplate(more), template_id: AID_ID, template_name: 'Asset Interfaces Description', template_number: 'IDTA 02017',
  template_version: '1.0.1', semantic_id_type: more.semantic_id ? 'IRI' : null
})

const ELEMENTS = [
  nameplate({ path: 'SerialNumber', id_short: 'SerialNumber', ordinal: 1, model_type: 'Property', value_type: 'xs:string', semantic_id: SERIAL,
    supplemental_semantic_ids: ['0173-1#02-AAM556#004'], cardinality: 'ZeroToOne', example_value: '12345678' }),
  nameplate({ path: 'Markings', id_short: 'Markings', ordinal: 2, model_type: 'SubmodelElementList', value_type: 'SubmodelElementCollection',
    semantic_id: '0112/2///61360_7#AAS006#001', cardinality: 'ZeroToOne' }),
  nameplate({ path: 'Markings[0]', parent_path: 'Markings', id_short: null, ordinal: 3, model_type: 'SubmodelElementCollection',
    semantic_id: '0112/2///61360_7#AAS009#001', cardinality: 'OneToMany', definition: 'Note: CE marking is declared as mandatory' }),
  nameplate({ path: 'Markings[0].MarkingName', parent_path: 'Markings[0]', id_short: 'MarkingName', ordinal: 4, model_type: 'Property',
    value_type: 'xs:string', semantic_id: '0112/2///61987#ABA231#009', cardinality: 'One' }),
  aid({ path: 'InterfaceTemplateForMQTT', id_short: 'InterfaceTemplateForMQTT', ordinal: 1, model_type: 'SubmodelElementCollection',
    semantic_id: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/Interface', cardinality: 'ZeroToMany' }),
  aid({ path: 'InterfaceTemplateForMQTT.security', parent_path: 'InterfaceTemplateForMQTT', id_short: 'security', ordinal: 2,
    model_type: 'SubmodelElementList', value_type: 'ReferenceElement', semantic_id: 'https://www.w3.org/2019/wot/td#hasSecurityConfiguration', cardinality: 'One' }),
  aid({ path: 'InterfaceTemplateForMQTT.security[0]', parent_path: 'InterfaceTemplateForMQTT.security', id_short: null, ordinal: 3,
    model_type: 'ReferenceElement', semantic_id: null })
]

const routes = { '/api/v1/idta-template-elements': ELEMENTS }
const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((route) => {
    const key = Object.keys(routes).find(r => route.startsWith(r))
    return Promise.resolve(key ? routes[key] : [])
  })
})

const cardEl = () => document.querySelector('.card')
const card = () => within(cardEl())
const open = async (props) => {
  render(<VocabularyTab hasPermission={() => true} onUseEntry={vi.fn()} showToast={vi.fn()} {...props} />)
  await waitFor(() => expect(tabBar()).toBeTruthy())
  fireEvent.click(tabLink(/Templates/))
}
const section = (name) => card().getByRole('button', { name })
const rows = () => [...cardEl().querySelectorAll('.template-element')]
const nameOf = (row) => row.querySelector('.template-element-name > .mono').textContent

describe('the Templates tab of the Vocabulary page', () => {
  it('comes after the standards and before Imported, carries no count, and says what it holds', async () => {
    await open()
    const labels = [...tabBar().querySelectorAll('a')].map(a => a.textContent)
    expect(labels.slice(-2)).toEqual(['Templates', 'Imported'])
    expect(tabLink(/Templates/).querySelector('.section-count')).toBeNull()
    expect(getByTooltip(/^IDTA submodel templates/)).toBe(tabLink(/Templates/))
  })

  it('is at the address the sidebar gives it, which names the browser tab', () => {
    const drawn = idtaTemplateTab({ elements: [] })
    expect(TEMPLATES_TAB).toEqual({ id: pathSlug(drawn.id), label: drawn.label })
    expect(TABS.find(t => t.id === 'vocabulary').pageTabs).toContain(TEMPLATES_TAB)
    expect(tabHref('vocabulary', 'templates')).toBe('/vocabulary/templates')
    expect(currentTabOf('vocabulary', '/vocabulary/templates').label).toBe('Templates')
    expect(pageTitleOf('vocabulary', '/vocabulary/templates')).toMatch(/Templates/)
  })

  it('has one section for each template, by its IDTA number, collapsed until opened', async () => {
    await open()
    expect([...cardEl().querySelectorAll('.table-group-label')].map(l => l.textContent))
      .toEqual(['Digital Nameplate 3.0.3', 'Asset Interfaces Description 1.0.1'])
    expect(rows()).toHaveLength(0)
    fireEvent.click(section(/^Digital Nameplate/))
    expect(rows()).toHaveLength(4)
  })

  it('draws a row for each element in the template\'s order, stepped in under the one it is inside', async () => {
    await open()
    fireEvent.click(section(/^Digital Nameplate/))
    expect(rows().map(r => [nameOf(r), r.style.getPropertyValue('--template-depth')])).toEqual([
      ['SerialNumber', '0'], ['Markings', '0'], ['Markings[0]', '1'], ['MarkingName', '2']
    ])
    // What the step shows, for a reader that does not see it.
    expect(rows()[3].querySelector('.sr-only').textContent).toBe(', inside Markings[0]')
    expect(rows()[0].querySelector('.sr-only')).toBeNull()
  })

  it('says each element\'s type, how many its parent holds, what the template says of it and its example', async () => {
    await open()
    fireEvent.click(section(/^Digital Nameplate/))
    const [serial, , item] = rows()
    expect(serial.textContent).toContain('Property · xs:string')
    expect(serial.textContent).toContain('Zero or one')
    expect(serial.textContent).toContain('Example: 12345678')
    expect(item.textContent).toContain('One or more')
    expect(item.textContent).toContain('Note: CE marking is declared as mandatory')
    expect(item.textContent).not.toContain('Example')
  })

  it('copies the semantic id, the further ones and the template\'s own id, each with a toast', async () => {
    const showToast = vi.fn()
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue() } })
    await open({ showToast })
    fireEvent.click(section(/^Digital Nameplate/))

    fireEvent.click(card().getByRole('button', { name: `Copy semantic id (IRDI) ${SERIAL}` }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Copied semantic id (IRDI) to clipboard', 'success'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SERIAL)
    expect(card().getByRole('button', { name: 'Copy further semantic id 0173-1#02-AAM556#004' })).toBeTruthy()
    expect(card().getByRole('button', { name: `Copy template id ${NAMEPLATE_ID}` })).toBeTruthy()
  })

  it('says so where a template gives an element no id, and no cardinality', async () => {
    await open()
    fireEvent.click(section(/^Asset Interfaces/))
    const last = rows().at(-1)
    expect(nameOf(last)).toBe('security[0]')
    expect(within(last).queryByRole('button')).toBeNull()
    expect(last.textContent).toContain('Not stated')
    expect(last.querySelector('.template-element-id').textContent).toBe('—')
  })

  it('finds an element by its name, its id, a further id or its path, and keeps what it is inside', async () => {
    await open()
    const search = screen.getByPlaceholderText('Search template elements…')
    const found = (text) => {
      fireEvent.change(search, { target: { value: text } })
      return rows().map(nameOf)
    }
    expect(found('markingname')).toEqual(['Markings', 'Markings[0]', 'MarkingName'])
    expect(found('ABA951')).toEqual(['SerialNumber'])
    expect(found('AAM556')).toEqual(['SerialNumber'])
    expect(found('hasSecurityConfiguration')).toEqual(['InterfaceTemplateForMQTT', 'security'])
    expect(found('declared as mandatory')).toEqual(['Markings', 'Markings[0]'])
    expect(found('no such element')).toEqual([])
    expect(screen.getByText(/Nothing in the Templates vocabulary matches/)).toBeTruthy()
  })

  it('starts no metric and edits nothing, whoever is looking', async () => {
    const onUseEntry = vi.fn()
    await open({ onUseEntry })
    fireEvent.click(section(/^Digital Nameplate/))
    expect(cardEl().querySelector('.vocab-chip-action, .vocab-chip-plus, .vocab-in-use')).toBeNull()
    expect(cardEl().querySelector('.vocab-sections input, .vocab-sections select, .vocab-sections textarea')).toBeNull()
    // Every button in the list copies an id, and none is greyed for want of a permission.
    const buttons = within(cardEl().querySelector('.template-elements')).getAllByRole('button')
    expect(buttons.every(b => /^Copy /.test(b.getAttribute('aria-label')) && !b.disabled)).toBe(true)
    fireEvent.click(rows()[0])
    expect(onUseEntry).not.toHaveBeenCalled()
    expect(cardEl().querySelector('.card-heading-description').textContent).toBe(
      'What each IDTA template asks a submodel to hold, not what a device publishes.')
  })

  it('is the same for a viewer who may not add a metric', async () => {
    await open({ hasPermission: () => false })
    fireEvent.click(section(/^Digital Nameplate/))
    expect(rows()).toHaveLength(4)
    expect(cardEl().querySelector('.card-heading-description').textContent).not.toMatch(/Requires/)
  })

  it('leaves the other tabs\' heading and chips as they were', async () => {
    await open()
    fireEvent.click(tabLink(/QUDT/))
    expect(cardEl().querySelector('.card-heading-description').textContent).toMatch(/click an entry to start a catalog metric/)
    expect(cardEl().querySelector('.template-elements')).toBeNull()
  })

  it('credits IDTA under CC BY 4.0 and says the elements are abridged, with the licence a link, on this tab alone', async () => {
    await open()
    const notice = cardEl().querySelector('.vocab-notice')
    expect(notice.textContent).toBe('Elements of submodel templates by IDTA, abridged, under CC BY 4.0.')
    const link = within(notice).getByRole('link', { name: 'CC BY 4.0' })
    expect(link.getAttribute('href')).toBe('https://creativecommons.org/licenses/by/4.0/')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    fireEvent.click(tabLink(/ASHRAE 223P/))
    expect(cardEl().querySelector('.vocab-notice')).toBeNull()
  })

  it('wraps a long name and a long text rather than scrolling sideways', () => {
    const rule = (selector) => APP_CSS.slice(APP_CSS.indexOf(`\n${selector} {`)).split('}')[0]
    expect(rule('.template-element-name')).toMatch(/overflow-wrap:\s*anywhere/)
    expect(rule('.template-element-name')).toMatch(/min-width:\s*0/)
    const columns = rule('.template-element').match(/grid-template-columns: ([^;]+);/)[1]
    expect(columns).toBe('minmax(0, 1fr) minmax(0, 190px) 92px minmax(0, 340px)')
  })

  it('has its own section of the help, which says a template is only looked up', () => {
    const help = HELP_CORPUS.vocabulary.split('## The Templates tab')[1]?.split('\n## ')[0]
    expect(help).toMatch(/Digital Nameplate/)
    expect(help).toMatch(/Asset Interfaces Description/)
    expect(help).toMatch(/CC BY 4\.0/)
  })
})
