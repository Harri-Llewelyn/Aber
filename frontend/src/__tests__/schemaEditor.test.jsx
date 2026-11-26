import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SchemaBuilderModal } from '../components/modals/SchemaBuilderModal'
import { SchemaDetailModal } from '../components/modals/SchemaDetailModal'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'
import { requiresRolesTitle } from '../hooks/usePermissions'
import { rangeText } from '../utils/schemaProperty'
import { pressHeld, wrongIn } from '../test/dialogs'
import { tooltipOf } from '../test/tooltips'

/**
 * The one body of the dialogs that build a schema, edit a draft of one and show a version
 * (common/SchemaEditor): the same fields in the same order at one width, with the metric list taking
 * the height that is left. What each dialog writes is held by SchemasTab, schemaVersioningUi,
 * schemaDraftPicker and schemaBuilderContract.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const metric = (name, extra = {}) => ({
  metric_uuid: `uuid-${name}`, name, datatype: 10, standard: 'MTConnect', description: '', deprecated: false, ...extra
})

const CATALOG = [metric('Axes/X/POSITION'), metric('Axes/Y/POSITION'), metric('Controller/EXECUTION', { datatype: 12 })]

const V1 = {
  schema_uuid: 'v1-uuid', schema_name: 'Mill', lineage_name: 'Mill', version: 1, status: 'active', parent_schema_id: null,
  description: 'A three axis mill', change_description: 'Initial release',
  semantic_id: 'https://example.org/mill', semantic_id_type: 'IRI',
  schema_definition: {
    type: 'object',
    properties: {
      'Axes/X/POSITION': { type: 'number', minimum: -40, maximum: 120 },
      'Axes/Y/POSITION': { type: 'number', minimum: 0 }
    }
  }
}
const DRAFT = { ...V1, schema_uuid: 'v2-uuid', schema_name: 'Mill_v2', version: 2, status: 'draft', parent_schema_id: 'v1-uuid', change_description: 'Added the coolant loop' }
const ACTIVE_V2 = { ...DRAFT, status: 'active' }

const builder = (props = {}) => {
  render(<SchemaBuilderModal catalog={CATALOG} onSubmit={vi.fn()} onCancel={vi.fn()} {...props} />)
  return screen.getByRole('dialog')
}
const detail = (schema, props = {}) => {
  render(
    <SchemaDetailModal schema={schema} schemas={[V1, schema]} catalog={CATALOG} canManage
      onSaveDraft={vi.fn()} onPublish={vi.fn()} onDiscard={vi.fn()} onClose={vi.fn()} {...props} />
  )
  return screen.getByRole('dialog')
}
const draft = (props) => detail(DRAFT, props)
const published = (props) => detail(ACTIVE_V2, { schemas: [{ ...V1, status: 'archived' }, ACTIVE_V2], ...props })

const labels = (dialog) => [...dialog.querySelectorAll('.form-label')].map(el => el.textContent.trim().replace(/\s+/g, ' '))
const body = (dialog) => dialog.querySelector('.modal-body')
const box = (dialog, name) => [...dialog.querySelectorAll('input[type="checkbox"]')]
  .find(el => el.closest('label').querySelector('.mono').textContent === name)
const press = (dialog, name) => fireEvent.click(within(dialog).getByRole('button', { name }))
const pressed = (dialog) => dialog.querySelector('.modal-problem')
const actions = (dialog) => [...dialog.querySelectorAll('.modal-actions button')].map(b => b.textContent.trim())

describe('one body', () => {
  it('holds the same fields in the same order, and what a version adds beside them', () => {
    const asked = labels(builder())
    expect(asked).toEqual(['Schema Name', 'Description', 'Semantic ID (optional)', 'Reference Type', 'Metrics 0 selected'])
    cleanup()

    const edited = labels(draft())
    expect(edited).toEqual(['Schema Name', 'Schema UUID', 'Description', 'Change Description', 'Semantic ID (optional)',
      'Reference Type', 'Metrics 2 selected', 'Version History 2'])
    cleanup()

    expect(labels(published())).toEqual(edited.map(l => l.replace(' (optional)', '').replace(' selected', '')))
  })

  it.each([['the builder', builder], ['a draft', draft], ['a published version', published]])('is wide in %s, and the metric list takes what is left', (_, open) => {
    const dialog = open()
    expect(dialog.firstElementChild).toHaveClass('modal', 'modal-wide')
    expect(body(dialog)).toHaveClass('modal-body-fill')
    const fills = [...body(dialog).children].filter(el => el.classList.contains('modal-fill'))
    expect(fills).toHaveLength(1)
    expect(fills[0]).toBe(within(dialog).getByRole('group', { name: /^Metrics/ }))
    expect(fills[0].querySelector('.list-picker-list, .schema-editor-list')).not.toBeNull()
    // Nothing but the list shares its height: what is said about it stands around it.
    expect(fills[0].querySelector('[role="alert"], .form-hint')).toBeNull()
  })

  it('names each control by its label', () => {
    const dialog = draft()
    for (const [name, value] of [['Description', 'A three axis mill'], ['Change Description', 'Added the coolant loop']]) {
      expect(within(dialog).getByRole('textbox', { name })).toHaveValue(value)
    }
    cleanup()
    expect(within(builder()).getByRole('textbox', { name: 'Description' })).toHaveValue('')
  })

  it('shows a version’s name as text, with why', () => {
    const dialog = draft()
    expect(within(dialog).queryByRole('textbox', { name: /Schema Name/ })).toBeNull()
    expect(within(dialog).getByText('Follows the first version’s name, so it cannot be changed.')).toBeTruthy()
  })

  it('shows a published version as text: no control, each value where its field was, its ranges in words', () => {
    const dialog = published()
    expect(dialog.querySelectorAll('input, select, textarea')).toHaveLength(0)
    const values = [...dialog.querySelectorAll('.form-static')].map(el => el.textContent.trim())
    expect(values).toEqual(['Mill_v2', 'v2-uuid', 'A three axis mill', 'Added the coolant loop', 'https://example.org/mill', 'IRI'])
    expect([...dialog.querySelectorAll('.schema-editor-list > li')].map(li => li.textContent)).toEqual([
      'Axes/X/POSITIONminimum · maximum-40 to 120', 'Axes/Y/POSITIONminimum0 or more'
    ])
  })

  it('says what a published version does not hold', () => {
    const bare = { ...ACTIVE_V2, description: null, change_description: null, semantic_id: null, semantic_id_type: null, schema_definition: {} }
    const dialog = detail(bare, { schemas: [bare] })
    expect([...dialog.querySelectorAll('.form-static')].map(el => el.textContent.trim())).toEqual([
      'Mill_v2', 'v2-uuid', 'Not set', 'Not set', 'Not set', 'Not set', 'This schema models no metrics.'
    ])
  })

  it('keeps the version history below the list, closed until it is asked for', () => {
    for (const open of [draft, published]) {
      const dialog = open()
      const history = dialog.querySelector('details.schema-history')
      expect(history.open).toBe(false)
      const order = [...body(dialog).children]
      expect(order.findIndex(el => el.contains(history))).toBeGreaterThan(order.findIndex(el => el.classList.contains('modal-fill')))
      const rows = [...history.querySelectorAll('li')].map(li => li.textContent)
      expect(rows[0]).toMatch(/Mill.*Initial release/)
      // The open version is marked in words as well as by its ground.
      expect(rows.map(r => r.includes('This version'))).toEqual([false, true])
      cleanup()
    }
  })
})

describe('the primary says what is missing', () => {
  it('in the builder: every field at once, and the focus on the first', () => {
    const onSubmit = vi.fn()
    const dialog = builder({ onSubmit })
    pressHeld(dialog, 'Save Schema', 'Give the schema a name')
    expect(wrongIn(dialog)).toEqual(['Give the schema a name', 'Tick at least one metric. A schema with none constrains nothing.', 'Give the schema a name'])
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: /Schema Name/ }))

    fireEvent.change(document.activeElement, { target: { value: 'Mill' } })
    pressHeld(dialog, 'Save Schema', /Tick at least one metric/)
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Search catalog metrics'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('in a draft: an empty list, and a save that changes nothing', () => {
    const onSaveDraft = vi.fn()
    const onPublish = vi.fn()
    const dialog = draft({ onSaveDraft, onPublish })
    pressHeld(dialog, 'Save Draft', 'Nothing has changed.')

    for (const name of ['Axes/X/POSITION', 'Axes/Y/POSITION']) fireEvent.click(box(dialog, name))
    pressHeld(dialog, 'Save Draft', /Tick at least one metric/)
    pressHeld(dialog, 'Publish Version v2', /Tick at least one metric/)
    expect(onSaveDraft).not.toHaveBeenCalled()
    expect(onPublish).not.toHaveBeenCalled()
  })

  it('never asks a publish for a change: the draft is published as it is', async () => {
    const onSaveDraft = vi.fn()
    const onPublish = vi.fn().mockResolvedValue()
    const dialog = draft({ onSaveDraft, onPublish })
    pressHeld(dialog, 'Save Draft', 'Nothing has changed.')
    await act(async () => press(dialog, 'Publish Version v2'))
    expect(onPublish).toHaveBeenCalledTimes(1)
    expect(onSaveDraft).not.toHaveBeenCalled()
    expect(pressed(dialog)).toHaveTextContent(/^$/)
  })

  it('goes to the first range that cannot be saved, said as it is typed', () => {
    const onSubmit = vi.fn()
    const dialog = builder({ onSubmit })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Schema Name/ }), { target: { value: 'Mill' } })
    for (const name of ['Axes/X/POSITION', 'Axes/Y/POSITION']) fireEvent.click(box(dialog, name))
    const bound = (which) => within(dialog).getByRole('spinbutton', { name: `${which} of Axes/Y/POSITION` })
    fireEvent.change(bound('Minimum'), { target: { value: '9' } })
    fireEvent.change(bound('Maximum'), { target: { value: '1' } })
    const said = 'Fix the range of Axes/Y/POSITION: The minimum is above the maximum.'
    expect(wrongIn(dialog)).toEqual([said])
    pressHeld(dialog, 'Save Schema', said)
    expect(document.activeElement).toBe(bound('Minimum'))

    // Unticked, its range is neither written nor in the way, and comes back with the tick.
    fireEvent.click(box(dialog, 'Axes/Y/POSITION'))
    expect(wrongIn(dialog)).toEqual([])
    fireEvent.click(box(dialog, 'Axes/Y/POSITION'))
    expect(bound('Minimum')).toHaveValue(9)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('in a version with a draft open already, Create Version', () => {
    const onFork = vi.fn()
    const dialog = detail(V1, { schemas: [V1, DRAFT], onFork })
    expect(wrongIn(dialog)).toEqual([])
    pressHeld(dialog, 'Create Version v2', 'A draft (Mill_v2) already exists for this schema. Publish or discard it first.')
    expect(onFork).not.toHaveBeenCalled()
    cleanup()

    press(detail(V1, { schemas: [V1], onFork }), 'Create Version v2')
    expect(onFork).toHaveBeenCalledTimes(1)
  })
})

describe('closing', () => {
  it('is Cancel while an edit can be lost, and Close when nothing can', () => {
    const dialog = draft()
    expect(actions(dialog)).toEqual(['Close', 'Save Draft', 'Publish Version v2', 'Discard Draft'])
    const description = within(dialog).getByRole('textbox', { name: 'Description' })
    fireEvent.change(description, { target: { value: 'Another' } })
    expect(actions(dialog)[0]).toBe('Cancel')
    fireEvent.change(description, { target: { value: 'A three axis mill' } })
    expect(actions(dialog)[0]).toBe('Close')
    cleanup()

    expect(actions(builder())).toEqual(['Cancel', 'Save Schema'])
    cleanup()
    expect(actions(published())).toEqual(['Close', 'Create Version v3'])
    cleanup()
    expect(actions(detail({ ...V1, status: 'archived' }))).toEqual(['Close'])
  })

  it('does nothing while a write runs, and the act pressed is the one that says so', async () => {
    let finish
    const onSaveDraft = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const onClose = vi.fn()
    const onDiscard = vi.fn()
    const dialog = draft({ onSaveDraft, onClose, onDiscard })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Change Description' }), { target: { value: 'Another' } })
    await act(async () => press(dialog, 'Save Draft'))

    expect(actions(dialog)).toEqual(['Cancel', 'Saving…', 'Publish Version v2', 'Discard Draft'])
    for (const button of dialog.querySelectorAll('.modal-actions button')) expect(button).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    press(dialog, 'Discard Draft')
    press(dialog, 'Publish Version v2')
    expect(onClose).not.toHaveBeenCalled()
    expect(onDiscard).not.toHaveBeenCalled()

    await act(async () => finish())
    expect(actions(dialog)[1]).toBe('Save Draft')
    expect(onSaveDraft).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a refusal is shown as it was worded, and the builder keeps what was chosen', async () => {
    const dialog = builder({ onSubmit: vi.fn().mockRejectedValue(new Error('duplicate key value violates unique constraint')) })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Schema Name/ }), { target: { value: 'Mill' } })
    fireEvent.click(box(dialog, 'Axes/X/POSITION'))
    press(dialog, 'Save Schema')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('duplicate key value violates unique constraint')
    expect(box(dialog, 'Axes/X/POSITION').checked).toBe(true)
  })
})

describe('a role that may not manage schemas', () => {
  const DENIED = requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)

  it('reads a draft as text, is told why, and may take no act', () => {
    const onPublish = vi.fn()
    const dialog = draft({ canManage: false, onPublish })
    expect(dialog.querySelectorAll('input, select, textarea')).toHaveLength(0)
    expect(within(dialog).getByRole('status')).toHaveTextContent(`You are reading this draft. ${DENIED} to change it`)
    expect(actions(dialog)).toEqual(['Close', 'Publish Version v2', 'Discard Draft'])
    for (const name of ['Publish Version v2', 'Discard Draft']) {
      const button = within(dialog).getByRole('button', { name })
      expect(button).toBeDisabled()
      expect(tooltipOf(button)).toBe(DENIED)
    }
    // What is stored, not what an editor's save would write.
    expect([...dialog.querySelectorAll('.schema-editor-list .mono:first-of-type')].map(el => el.textContent)).toEqual(['Axes/X/POSITION', 'Axes/Y/POSITION'])
  })

  it('cannot create a version, and the button says who can', () => {
    const button = within(published({ canManage: false })).getByRole('button', { name: 'Create Version v3' })
    expect(button).toBeDisabled()
    expect(tooltipOf(button)).toBe(DENIED)
  })

  describe('on the page', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/schemas') ? [V1, DRAFT] : path.startsWith('/api/v1/metric-catalog') ? CATALOG : []))
    })

    it.each([[true, 'Edit Draft'], [false, 'View Schema Detail']])('the drawer names what a draft opens as (may manage: %s)', async (may, label) => {
      render(<SchemasTab showToast={vi.fn()} hasPermission={() => may} onSelectSchema={vi.fn()} />)
      fireEvent.click(await screen.findByText('Mill_v2'))
      fireEvent.click(within(document.querySelector('.context-panel')).getByRole('button', { name: label }))
      const dialog = await screen.findByRole('dialog')
      expect(dialog.querySelectorAll('textarea')).toHaveLength(may ? 1 : 0)
    })
  })
})

/**
 * A file applied from YAML makes a draft whose definition is the one the builders write
 * (test_a_device_schema_is_applied_from_a_document.py holds it to the same fixture).
 */
describe('a draft a YAML file made', () => {
  const fixture = JSON.parse(readFileSync(join(
    dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-harness', 'fixtures', 'schema-builder-output.json'
  ), 'utf8'))
  const imported = { ...DRAFT, schema_definition: fixture.schema_definition, semantic_id: null, semantic_id_type: null }

  it('opens with every metric and range, and nothing to save', () => {
    const onSaveDraft = vi.fn()
    const dialog = detail(imported, { catalog: fixture.catalog, onSaveDraft })
    for (const m of fixture.catalog) expect(box(dialog, m.name).checked, m.name).toBe(true)
    expect(within(dialog).getByRole('spinbutton', { name: 'Maximum of Axes/S/LOAD' })).toHaveValue(150)
    expect(within(dialog).getByRole('spinbutton', { name: 'Minimum of Systems/TEMPERATURE' })).toHaveValue(-40)
    pressHeld(dialog, 'Save Draft', 'Nothing has changed.')
    expect(onSaveDraft).not.toHaveBeenCalled()
  })

  it('is saved with the range somebody changes and the rest as it was', async () => {
    const onSaveDraft = vi.fn().mockResolvedValue()
    const dialog = detail(imported, { catalog: fixture.catalog, onSaveDraft })
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Maximum of Axes/S/LOAD' }), { target: { value: '140' } })
    press(dialog, 'Save Draft')
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled())
    const { properties } = fixture.schema_definition
    expect(onSaveDraft.mock.calls[0][0].schema_definition).toEqual({
      type: 'object', properties: { ...properties, 'Axes/S/LOAD': { ...properties['Axes/S/LOAD'], maximum: 140 } }
    })
  })
})

describe('a range in words', () => {
  it.each([
    [{ minimum: -40, maximum: 120.5 }, '-40 to 120.5'], [{ minimum: 0 }, '0 or more'], [{ maximum: 0 }, '0 or less'],
    [{ type: 'number' }, null], [{ minimum: 'low' }, null], [undefined, null], ['not an entry', null]
  ])('%j is %s', (entry, words) => {
    expect(rangeText(entry)).toBe(words)
  })
})
