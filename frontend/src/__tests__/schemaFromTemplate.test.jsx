import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SchemaBuilderModal } from '../components/modals/SchemaBuilderModal'
import { SchemaDetailModal } from '../components/modals/SchemaDetailModal'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { VocabularyTab } from '../components/tabs/VocabularyTab'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'
import { navigate } from '../hooks/useUrlState'
import { requiresRolesTitle } from '../hooks/usePermissions'
import { tooltipOf } from '../test/tooltips'

/**
 * Build Schema from Template (0342): the schema editor with a template chosen first, which ticks the metrics
 * that fill its elements, makes its id the semantic id, says which element each metric fills and which
 * elements nothing fills, and refuses the save while one the template requires is unfilled, in the
 * database's words. A version built so shows its template; the Templates tab's Build Schema opens the
 * builder with the template chosen. The rule itself is idtaTemplateFill.test.js's.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const FIXTURE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-harness', 'fixtures', 'schema-template-elements.json'), 'utf8'))
const TEMPLATE = FIXTURE.template.template_id
const TITLE = 'Fixture Template 1.0.0'
const OTHER = 'https://example.com/aber/fixture/other'
const ELEMENTS = [
  ...FIXTURE.elements.map(e => ({ ...FIXTURE.template, ...e, semantic_id_type: e.semantic_id ? 'IRI' : null })),
  { template_id: OTHER, template_name: 'Other Template', template_number: 'FIXTURE 0343', template_version: '2.0.0',
    path: 'Serial', parent_path: null, ordinal: 1, id_short: 'Serial', model_type: 'Property', semantic_id: 'urn:aber:fixture:0342:serial', semantic_id_type: 'IRI', cardinality: 'One' }
]
const CATALOG = FIXTURE.catalog.map(m => ({
  metric_uuid: `uuid-${m.name}`, name: m.name, datatype: 12, standard: null, description: '', deprecated: false,
  semantic_id: m.semantic_id, further_semantic_ids: m.further.map(id => ({ semantic_id: id, semantic_id_type: 'IRI' }))
}))
const NAME = 'Fixture_0342/NAME'
const LABEL = 'Fixture_0342/LABEL'
const STREET = 'Fixture_0342/STREET'
const SERIAL = 'Fixture_0342/SERIAL'

const builder = (props = {}) => {
  const onSubmit = vi.fn().mockResolvedValue({})
  render(<SchemaBuilderModal fromTemplate catalog={CATALOG} templates={ELEMENTS} onSubmit={onSubmit} onCancel={vi.fn()} {...props} />)
  return { dialog: screen.getByRole('dialog'), onSubmit }
}
const ticked = (dialog) => [...dialog.querySelectorAll('input[type="checkbox"]:checked')]
  .map(el => el.closest('label').querySelector('.mono').textContent).sort()
const box = (dialog, name) => [...dialog.querySelectorAll('input[type="checkbox"]')]
  .find(el => el.closest('label').querySelector('.mono').textContent === name)
const choose = (dialog, id) => fireEvent.change(within(dialog).getByLabelText(/^Template/), { target: { value: id } })
const save = (dialog) => fireEvent.click(within(dialog).getByRole('button', { name: 'Save Schema' }))
const summary = (dialog) => dialog.querySelector('.schema-template summary').textContent.replace(/\s+/g, ' ').trim()
const unfilled = (dialog) => [...dialog.querySelectorAll('.schema-template-list li')]
  .map(li => [li.querySelector('.mono').textContent, li.querySelector('.badge')?.textContent ?? ''])

describe('Build Schema from Template', () => {
  it('asks for the template after the name and the description, and opens with none chosen', () => {
    const { dialog } = builder()
    expect(within(dialog).getByRole('heading', { name: 'Build Schema from Template' })).toBeTruthy()
    const labels = [...dialog.querySelectorAll('.schema-editor-fields .form-label')].map(el => el.textContent.trim())
    expect(labels).toEqual(['Schema Name', 'Description', 'Template'])
    expect(within(dialog).getByLabelText(/^Template/).value).toBe('')
    expect([...within(dialog).getByLabelText(/^Template/).options].map(o => o.textContent))
      .toEqual(['Choose a template…', `${TITLE} (FIXTURE 0342)`, 'Other Template 2.0.0 (FIXTURE 0343)'])
    expect(ticked(dialog)).toEqual([])
    // The semantic id is the template's: text, never an input.
    expect(within(dialog).queryByLabelText(/^Semantic ID/)).toBeNull()
  })

  it('makes the template id the semantic id and ticks the metrics that fill its elements', () => {
    const { dialog } = builder()
    choose(dialog, TEMPLATE)
    expect(dialog.querySelector('.semantic-id-own .form-static').textContent).toContain(TEMPLATE)
    expect(ticked(dialog)).toEqual(Object.keys(FIXTURE.cases[4].filled).concat([
      'Fixture_0342/COUNT', 'Fixture_0342/MARKING', 'Fixture_0342/SERIAL']).sort())
    // Each row says the element its metric fills, ticked or not.
    const row = box(dialog, LABEL).closest('label')
    expect(row.querySelector('.schema-template-fills').textContent).toBe('fills Label')
    expect(box(dialog, 'Fixture_0342/ELSEWHERE').closest('label').querySelector('.schema-template-fills')).toBeNull()
  })

  it('lists the elements nothing fills, marking the ones the template requires', () => {
    const { dialog } = builder({ initialTemplate: TEMPLATE })
    fireEvent.click(box(dialog, LABEL))
    fireEvent.click(box(dialog, SERIAL))
    expect(summary(dialog)).toBe('Template Elements 4 of 7 filled')
    expect(unfilled(dialog)).toEqual([['Label', 'Required'], ['Serial', ''], ['SerialAgain', '']])
  })

  it('refuses the save while a required element is unfilled, in the database\'s words', () => {
    const { dialog, onSubmit } = builder({ initialTemplate: TEMPLATE })
    fireEvent.change(within(dialog).getByLabelText(/^Schema Name/), { target: { value: 'Plate' } })
    fireEvent.click(box(dialog, LABEL))
    fireEvent.click(box(dialog, STREET))
    save(dialog)
    const said = `No metric here fills Label, Address.Street, which ${TITLE} requires. A metric fills an element when the element's semantic id is the metric's own or one of its further ids.`
    expect(dialog.querySelector('.modal-problem').textContent).toContain(said)
    expect(dialog.querySelector('#schema-builder-template-error').textContent.trim()).toBe(said)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('asks for a template first', () => {
    const { dialog, onSubmit } = builder()
    fireEvent.change(within(dialog).getByLabelText(/^Schema Name/), { target: { value: 'Plate' } })
    fireEvent.click(box(dialog, NAME))
    save(dialog)
    expect(dialog.querySelector('#schema-builder-template-error').textContent.trim()).toBe('Choose the template the schema is built from')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('saves the template with the schema, its id as the semantic id', async () => {
    const { dialog, onSubmit } = builder({ initialTemplate: TEMPLATE })
    fireEvent.change(within(dialog).getByLabelText(/^Schema Name/), { target: { value: 'Plate' } })
    save(dialog)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const [payload] = onSubmit.mock.calls[0]
    expect(payload).toMatchObject({ template_id: TEMPLATE, semantic_id: TEMPLATE, semantic_id_type: 'IRI' })
    expect(Object.keys(payload.schema_definition.properties)).toContain(NAME)
  })

  it('takes back what one template ticked when another is chosen, and keeps what was ticked by hand', () => {
    const { dialog } = builder({ initialTemplate: TEMPLATE })
    fireEvent.click(box(dialog, 'Fixture_0342/ELSEWHERE'))
    choose(dialog, OTHER)
    expect(ticked(dialog)).toEqual(['Fixture_0342/ELSEWHERE', SERIAL])
    expect(dialog.querySelector('.semantic-id-own .form-static').textContent).toContain(OTHER)
  })

  it('opens with none chosen for a template the rows do not hold', () => {
    const { dialog } = builder({ initialTemplate: 'https://example.com/aber/none' })
    expect(within(dialog).getByLabelText(/^Template/).value).toBe('')
  })

  it('is Build Schema from Catalog as it was without a template', () => {
    render(<SchemaBuilderModal catalog={CATALOG} templates={ELEMENTS} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Build Schema from Catalog' })).toBeTruthy()
    expect(within(dialog).queryByLabelText(/^Template/)).toBeNull()
    expect(dialog.querySelector('.schema-template')).toBeNull()
    expect(dialog.querySelector('.schema-template-fills')).toBeNull()
  })
})

const BUILT = {
  schema_uuid: 'plate-v1', schema_name: 'Plate', lineage_name: 'Plate', version: 1, status: 'active', parent_schema_id: null,
  description: '', change_description: 'Initial release', semantic_id: TEMPLATE, semantic_id_type: 'IRI', derived_metrics: [],
  schema_definition: { type: 'object', properties: { [NAME]: { type: 'string' }, [LABEL]: { type: 'string' }, [STREET]: { type: 'string' } } },
  template_id: TEMPLATE,
  // As the version holds it: the Label is filled, whatever the catalogue says now.
  template_elements: {
    [NAME]: { path: 'Name', semantic_id: 'urn:aber:fixture:0342:name' },
    [LABEL]: { path: 'Label', semantic_id: 'urn:aber:fixture:0342:label' },
    [STREET]: { path: 'Address.Street', semantic_id: 'urn:aber:fixture:0342:street' }
  }
}

describe('a version built from a template', () => {
  const detail = (schema, props = {}) => {
    render(<SchemaDetailModal schema={schema} schemas={[schema]} catalog={CATALOG} templates={ELEMENTS} canManage
      onSaveDraft={vi.fn()} onPublish={vi.fn()} onDiscard={vi.fn()} onClose={vi.fn()} onFork={vi.fn()} {...props} />)
    return screen.getByRole('dialog')
  }

  it('names its template as a link to the templates, and each metric the element it fills, as the version holds them', () => {
    const catalog = CATALOG.map(m => (m.name === LABEL ? { ...m, further_semantic_ids: [] } : m))
    const dialog = detail(BUILT, { catalog })
    const link = within(dialog).getByRole('link', { name: `${TITLE} (FIXTURE 0342)` })
    expect(link.getAttribute('href')).toBe('/vocabulary/templates')
    const rows = [...dialog.querySelectorAll('.schema-editor-list li')]
    expect(rows.map(li => li.querySelector('.schema-template-fills')?.textContent).filter(Boolean))
      .toEqual(['fills Name', 'fills Label', 'fills Address.Street'])
    expect(summary(dialog)).toBe('Template Elements 3 of 7 filled')
  })

  it('keeps the template on a draft, works the elements out again as its metrics change, and refuses what the database would', () => {
    const draft = { ...BUILT, schema_uuid: 'plate-v2', schema_name: 'Plate_v2', version: 2, status: 'draft', parent_schema_id: 'plate-v1' }
    const onSaveDraft = vi.fn().mockResolvedValue()
    const dialog = detail(draft, { onSaveDraft, schemas: [BUILT, draft] })
    expect(within(dialog).queryByLabelText(/^Template/)).toBeNull()
    expect(within(dialog).queryByLabelText(/^Semantic ID/)).toBeNull()
    fireEvent.click(box(dialog, STREET))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Draft' }))
    expect(dialog.querySelector('#schema-detail-template-error').textContent)
      .toContain(`No metric here fills Address.Street, which ${TITLE} requires.`)
    expect(onSaveDraft).not.toHaveBeenCalled()
  })

  it('reads as any other version without the templates\' rows', () => {
    const dialog = detail(BUILT, { templates: [] })
    expect(within(dialog).getByRole('link', { name: TEMPLATE })).toBeTruthy()
    expect(dialog.querySelector('.schema-template')).toBeNull()
  })
})

describe('the Schemas page', () => {
  const ALL = Object.values(PERMISSION_UUIDS)
  const routes = (rows) => ({
    '/api/v1/schemas': rows, '/api/v1/metric-catalog': CATALOG, '/api/v1/devices': [], '/api/v1/idta-template-elements': ELEMENTS
  })
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockImplementation((path) => {
      const table = routes([BUILT])
      const key = Object.keys(table).find(r => path.startsWith(r))
      return Promise.resolve(key ? table[key] : [])
    })
  })
  const page = (permissions = ALL) => render(
    <SchemasTab showToast={vi.fn()} hasPermission={p => permissions.includes(p)} onSelectSchema={vi.fn()} onSelectDevice={vi.fn()} />)

  it('opens Build Schema from Template with none chosen from its toolbar', async () => {
    page()
    fireEvent.click(await screen.findByRole('button', { name: /Build Schema from Template/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText(/^Template/).value).toBe('')
  })

  it('opens it with the template chosen when the Templates tab sends one, and forgets it', async () => {
    act(() => navigate(`/schemas?template=${encodeURIComponent(TEMPLATE)}`))
    page()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText(/^Template/).value).toBe(TEMPLATE)
    await waitFor(() => expect(window.location.search).not.toContain('template='))
  })

  it('leaves a role that may not build one on the list', async () => {
    act(() => navigate(`/schemas?template=${encodeURIComponent(TEMPLATE)}`))
    page([])
    await screen.findByText('Plate')
    await waitFor(() => expect(window.location.search).not.toContain('template='))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names the template in a version\'s drawer', async () => {
    act(() => navigate('/schemas?schema=plate-v1'))
    page()
    const link = await screen.findByRole('link', { name: TITLE })
    expect(link.getAttribute('href')).toBe('/vocabulary/templates')
  })
})

describe('the Templates tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockImplementation((path) => Promise.resolve(path === '/api/v1/idta-template-elements' ? ELEMENTS : []))
    act(() => navigate('/vocabulary/templates'))
  })

  it('offers each template\'s Build Schema, a link to the builder with it chosen', async () => {
    render(<VocabularyTab hasPermission={() => true} showToast={vi.fn()} onUseEntry={vi.fn()} />)
    const links = await screen.findAllByRole('link', { name: /Build Schema/ })
    expect(links.map(a => a.getAttribute('href'))).toEqual([
      `/schemas?template=${encodeURIComponent(TEMPLATE)}`, `/schemas?template=${encodeURIComponent(OTHER)}`
    ])
    expect(tooltipOf(links[0])).toContain(`with ${TITLE} chosen`)
  })

  it('greys it for a role that may not build a schema, and says why', async () => {
    render(<VocabularyTab hasPermission={() => false} showToast={vi.fn()} onUseEntry={vi.fn()} />)
    const [button] = await screen.findAllByRole('button', { name: /Build Schema/ })
    expect(button.disabled).toBe(true)
    expect(tooltipOf(button)).toBe(requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE))
    expect(screen.queryByRole('link', { name: /Build Schema/ })).toBeNull()
  })
})
