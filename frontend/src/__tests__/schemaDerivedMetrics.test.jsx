import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SchemaBuilderModal } from '../components/modals/SchemaBuilderModal'
import { SchemaDetailModal } from '../components/modals/SchemaDetailModal'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { api } from '../api'
import { metricUrl } from '../routes'

/**
 * The editor's Derived Metrics section (common/SchemaDerivedMetrics): the derived metrics a schema names,
 * in the builder, in a draft and in a read-only version. It offers the ones the ticked metrics cover, says
 * at once what a ticked one lacks, refuses the save of one, and writes the list with the metrics in one
 * request, so the database judges them together.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const metric = (name, extra = {}) => ({
  metric_uuid: `uuid-${name}`, name, datatype: 10, standard: null, description: '', deprecated: false, derivation: null, ...extra
})
const COUNT = 'Controller/PART_COUNT'
const MODE = 'Controller/MODE'
const PHASE_A = 'Power/PHASE_A'
const PHASE_B = 'Power/PHASE_B'
const RATE = 'Controller/PARTS_PER_HOUR'
const AUTO = 'Derived/AUTOMATIC'
const NET = 'Power/NET'
const OLD = 'Derived/OLD_RATE'
const MEASURED = [metric(COUNT), metric(MODE, { datatype: 12, permitted_values: ['AUTO', 'SETUP'] }), metric(PHASE_A), metric(PHASE_B)]
const CATALOG = [
  ...MEASURED,
  metric(RATE, { derivation: { kind: 'counter_rate', input: COUNT } }),
  metric(AUTO, { derivation: { kind: 'time_in_state', input: MODE, states: ['AUTO'] } }),
  metric(NET, { derivation: { kind: 'sum', inputs: [{ metric: PHASE_A, sign: 1 }, { metric: PHASE_B, sign: -1 }] } }),
  metric(OLD, { deprecated: true, derivation: { kind: 'counter_rate', input: COUNT } }),
]
const entry = (name) => (name === MODE ? { type: 'string', enum: ['AUTO', 'SETUP'] } : { type: 'number' })
const definition = (...names) => ({ type: 'object', properties: Object.fromEntries(names.map(n => [n, entry(n)])) })
const V1 = {
  schema_uuid: 'v1-uuid', schema_name: 'Press', lineage_name: 'Press', version: 1, status: 'active', parent_schema_id: null, description: '', change_description: '',
  schema_definition: definition(COUNT, PHASE_A, PHASE_B), derived_metrics: [NET, RATE],
}
const DRAFT = { ...V1, schema_uuid: 'v2-uuid', schema_name: 'Press_v2', version: 2, status: 'draft', parent_schema_id: 'v1-uuid' }

const builder = (props = {}) => {
  const onSubmit = vi.fn().mockResolvedValue()
  render(<SchemaBuilderModal catalog={CATALOG} onSubmit={onSubmit} onCancel={vi.fn()} {...props} />)
  return { dialog: screen.getByRole('dialog'), onSubmit }
}
const version = (schema = DRAFT, props = {}) => {
  const onSaveDraft = vi.fn().mockResolvedValue()
  const onPublish = vi.fn().mockResolvedValue()
  render(<SchemaDetailModal schema={schema} schemas={[V1, schema]} catalog={CATALOG} canManage onSaveDraft={onSaveDraft} onPublish={onPublish} onDiscard={vi.fn()} onClose={vi.fn()} {...props} />)
  return { dialog: screen.getByRole('dialog'), onSaveDraft, onPublish }
}
const section = (dialog) => dialog.querySelector('details.schema-derived')
const summary = (dialog) => section(dialog).querySelector('summary')
const count = (dialog) => summary(dialog).querySelector('.section-count').textContent
const listed = (dialog) => [...section(dialog).querySelectorAll('.list-picker-label .metric-picker-name')].map(el => el.textContent)
const box = (root, name) => [...root.querySelectorAll('input[type="checkbox"]')].find(el => el.closest('label').querySelector('.metric-picker-name').textContent === name)
const tickMetric = (dialog, name) => fireEvent.click(box(dialog.querySelector('.schema-editor-metrics'), name))
const tickDerived = (dialog, name) => fireEvent.click(box(section(dialog), name))
const press = (dialog, name) => act(async () => { fireEvent.click(within(dialog).getByRole('button', { name })) })
const errorOf = (dialog) => dialog.querySelector('.schema-asides > .field-error-above')?.textContent.trim() ?? null

describe('what the section is', () => {
  it('stands under the metrics, closed, beside the version history, and is not one of the metrics', () => {
    for (const open of [() => builder().dialog, () => version().dialog, () => version({ ...DRAFT, status: 'active' }).dialog]) {
      const dialog = open()
      const own = section(dialog)
      expect(own.open).toBe(false)
      const children = [...dialog.querySelector('.modal-body').children]
      const asides = own.parentElement
      expect(asides).toHaveClass('schema-asides')
      expect(children.indexOf(asides)).toBeGreaterThan(children.findIndex(el => el.classList.contains('modal-fill')))
      const history = dialog.querySelector('details.schema-history')
      if (history) expect(history.parentElement).toBe(asides)
      expect(dialog.querySelector('.schema-editor-metrics').textContent).not.toContain(RATE)
      cleanup()
    }
  })

  it('is not drawn where the catalog holds no derived metric and the version names none', () => {
    expect(section(builder({ catalog: MEASURED }).dialog)).toBeNull()
    cleanup()
    expect(section(version({ ...DRAFT, derived_metrics: [] }, { catalog: MEASURED }).dialog)).toBeNull()
  })

  it('shows a read-only version as text: the names with their definitions, and no control', () => {
    const { dialog } = version({ ...DRAFT, status: 'active' })
    expect(count(dialog)).toBe('2')
    expect([...section(dialog).querySelectorAll('li')].map(li => li.textContent)).toEqual([
      `${RATE}rate of ${COUNT}, per hour`, `${NET}${PHASE_A} − ${PHASE_B}`
    ])
    expect(section(dialog).querySelectorAll('input, button, select')).toHaveLength(0)
    cleanup()
    const none = version({ ...DRAFT, status: 'active', derived_metrics: [] }).dialog
    expect(section(none).textContent).toContain('This schema names no derived metrics.')
  })

  it('reads a version as an older database answers it, with no list, as naming none', () => {
    const { dialog } = version({ ...DRAFT, derived_metrics: undefined })
    expect(count(dialog)).toBe('0 of 2 selected')
  })
})

describe('what it offers', () => {
  it('is the derived metrics whose inputs are ticked, from the same picker, as they are ticked', () => {
    const { dialog } = builder()
    expect(count(dialog)).toBe('0 of 0 selected')
    expect(section(dialog).textContent).toContain('No derived metric is computed from the ticked metrics alone.')
    tickMetric(dialog, COUNT)
    expect(listed(dialog)).toEqual([RATE])
    tickMetric(dialog, PHASE_A)
    expect(listed(dialog)).toEqual([RATE])
    tickMetric(dialog, PHASE_B)
    expect(listed(dialog)).toEqual([RATE, NET])
    expect(count(dialog)).toBe('0 of 2 selected')
    // Each says how it is computed.
    expect(section(dialog).textContent).toContain(`rate of ${COUNT}, per hour`)
  })

  it('leaves out a deprecated one, unless the version or the one it was made from names it', () => {
    const { dialog } = builder()
    tickMetric(dialog, COUNT)
    expect(listed(dialog)).not.toContain(OLD)
    cleanup()
    expect(listed(version({ ...DRAFT, derived_metrics: [OLD] }).dialog)).toContain(OLD)
    cleanup()
    expect(listed(version({ ...DRAFT, derived_metrics: [] }, { schemas: [{ ...V1, derived_metrics: [OLD] }, DRAFT] }).dialog)).toContain(OLD)
  })

  it('leaves out a time in state whose state the metric may no longer report', () => {
    const catalog = CATALOG.map(m => (m.name === MODE ? { ...m, permitted_values: ['SETUP'] } : m))
    const { dialog } = builder({ catalog })
    tickMetric(dialog, MODE)
    expect(listed(dialog)).toEqual([])
    cleanup()
    const has = builder().dialog
    tickMetric(has, MODE)
    expect(listed(has)).toEqual([AUTO])
  })

  it('has a search when the list is long, and no standard filter, which a derived metric has no use for', () => {
    const { dialog } = version()
    expect(within(section(dialog)).queryByLabelText('Search derived metrics')).toBeNull()
    cleanup()
    const many = [...CATALOG, ...Array.from({ length: 6 }, (_, i) => metric(`Derived/RATE_${i}`, { derivation: { kind: 'counter_rate', input: COUNT } }))]
    const long = version(DRAFT, { catalog: many }).dialog
    expect(within(section(long)).getByLabelText('Search derived metrics')).toBeTruthy()
    expect(within(section(long)).queryByLabelText('Standard')).toBeNull()
  })
})

describe('what is saved', () => {
  it('is the ticked ones in name order with the schema that is built, and no key where none is', async () => {
    const { dialog, onSubmit } = builder()
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Schema Name/ }), { target: { value: 'Press' } })
    for (const name of [COUNT, PHASE_A, PHASE_B]) tickMetric(dialog, name)
    tickDerived(dialog, NET)
    tickDerived(dialog, RATE)
    await press(dialog, 'Save Schema')
    expect(onSubmit.mock.calls[0][0].derived_metrics).toEqual([RATE, NET])
    expect(Object.keys(onSubmit.mock.calls[0][0].schema_definition.properties)).toEqual([COUNT, PHASE_A, PHASE_B])
    cleanup()

    const bare = builder()
    fireEvent.change(within(bare.dialog).getByRole('textbox', { name: /Schema Name/ }), { target: { value: 'Press' } })
    tickMetric(bare.dialog, COUNT)
    await press(bare.dialog, 'Save Schema')
    expect(bare.onSubmit.mock.calls[0][0]).not.toHaveProperty('derived_metrics')
  })

  it("is a draft's list alone when only that changed, counted against the last saved draft", async () => {
    const { dialog, onSaveDraft } = version()
    expect(count(dialog)).toBe('2 of 2 selected')
    tickDerived(dialog, NET)
    expect(summary(dialog).textContent).toContain('−1 vs. the last saved draft')
    await press(dialog, 'Save Draft')
    expect(onSaveDraft.mock.calls[0][0].derived_metrics).toEqual([RATE])
    expect(onSaveDraft.mock.calls[0][0]).not.toHaveProperty('schema_definition')
  })

  it('is nothing when it was put back, and the press says so', async () => {
    const { dialog, onSaveDraft } = version()
    tickDerived(dialog, NET)
    tickDerived(dialog, NET)
    await press(dialog, 'Save Draft')
    expect(onSaveDraft).not.toHaveBeenCalled()
    expect(dialog.querySelector('.modal-problem').textContent).toContain('Nothing has changed')
  })

  it('is the metrics and the list in one write where both changed', async () => {
    const { dialog, onSaveDraft } = version()
    tickMetric(dialog, PHASE_B)
    tickDerived(dialog, NET)
    await press(dialog, 'Save Draft')
    expect(onSaveDraft).toHaveBeenCalledTimes(1)
    const patch = onSaveDraft.mock.calls[0][0]
    expect(Object.keys(patch.schema_definition.properties)).toEqual([COUNT, PHASE_A])
    expect(patch.derived_metrics).toEqual([RATE])
  })

  it('does not send the list where nothing of it changed', async () => {
    const { dialog, onSaveDraft } = version()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Description' }), { target: { value: 'Edited' } })
    await press(dialog, 'Save Draft')
    expect(onSaveDraft.mock.calls[0][0]).not.toHaveProperty('derived_metrics')
  })
})

describe('an input that goes', () => {
  it('is said as it is unticked, with the metric that is missing, and the derived metric stays ticked', () => {
    const { dialog } = version()
    expect(errorOf(dialog)).toBeNull()
    tickMetric(dialog, PHASE_B)
    expect(errorOf(dialog)).toBe(`${NET} is computed from ${PHASE_B}, which this schema does not model. Add ${PHASE_B} to its metrics, or leave ${NET} out.`)
    // Still in the list, ticked, so that it can be unticked; and the section is not opened under the pointer.
    expect(listed(dialog)).toEqual([RATE, NET])
    expect(box(section(dialog), NET).checked).toBe(true)
    expect(section(dialog).open).toBe(false)
    // Ticking the input again puts it right: nothing was lost.
    tickMetric(dialog, PHASE_B)
    expect(errorOf(dialog)).toBeNull()
    expect(box(section(dialog), NET).checked).toBe(true)
  })

  it.each([['Save Draft', 'onSaveDraft'], ['Publish Version v2', 'onPublish']])('refuses %s, which says why and goes to the section', async (name, handler) => {
    const opened = version()
    tickMetric(opened.dialog, COUNT)
    await press(opened.dialog, name)
    expect(opened.onSaveDraft).not.toHaveBeenCalled()
    expect(opened[handler]).not.toHaveBeenCalled()
    expect(opened.dialog.querySelector('.modal-problem').textContent).toContain(`${RATE} is computed from ${COUNT}`)
    expect(document.activeElement).toBe(summary(opened.dialog))
    tickDerived(opened.dialog, RATE)
    expect(errorOf(opened.dialog)).toBeNull()
    expect(listed(opened.dialog)).not.toContain(RATE)
    await press(opened.dialog, name)
    expect(opened.onSaveDraft).toHaveBeenCalledTimes(1)
  })

  it('refuses a state the draft would not permit, also where only the catalog changed since', async () => {
    const catalog = CATALOG.map(m => (m.name === MODE ? { ...m, permitted_values: ['SETUP'] } : m))
    const draft = { ...DRAFT, schema_definition: definition(MODE), derived_metrics: [AUTO] }
    const { dialog, onPublish } = version(draft, { catalog })
    expect(errorOf(dialog)).toContain(`${AUTO} counts the state "AUTO", which this schema does not permit ${MODE} to report (SETUP).`)
    await press(dialog, 'Publish Version v2')
    expect(onPublish).not.toHaveBeenCalled()
  })

  it("shows the database's own refusal in the dialog, which stays open", async () => {
    const onSaveDraft = vi.fn().mockRejectedValue(new Error(`${NET} is not in the metric catalogue. Add it on the Metrics page first.`))
    const { dialog } = version(DRAFT, { onSaveDraft })
    tickDerived(dialog, RATE)
    await press(dialog, 'Save Draft')
    await waitFor(() => expect(dialog.querySelector('.modal-error, [role="alert"]')).not.toBeNull())
    expect(dialog.textContent).toContain(`${NET} is not in the metric catalogue.`)
  })
})

describe('the Schemas page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockImplementation((path) => Promise.resolve(
      path.startsWith('/api/v1/schemas') ? [V1, { ...V1, schema_uuid: 'bare-uuid', schema_name: 'Bare', lineage_name: 'Bare', derived_metrics: [] }]
        : path.startsWith('/api/v1/metric-catalog') ? CATALOG : []))
  })

  it('lists the derived metrics a version names in its drawer, each opening on the Metrics page', async () => {
    render(<SchemasTab showToast={vi.fn()} hasPermission={() => false} onSelectSchema={vi.fn()} />)
    fireEvent.click(await screen.findByText('Press'))
    const panel = document.querySelector('.context-panel')
    const field = await waitFor(() => within(panel).getByText('Derived Metrics').closest('.context-field'))
    expect([...field.querySelectorAll('a.chip')].map(a => [a.textContent, a.getAttribute('href')])).toEqual([
      [NET, metricUrl(`uuid-${NET}`, false, true)], [RATE, metricUrl(`uuid-${RATE}`, false, true)]
    ])
    // Cut text slides on hover or focus: a name too long for the drawer stays in one line.
    expect(field.querySelector('.chip-name.overflow-text')).not.toBeNull()
  })

  it('shows the field as not set for a version that names none', async () => {
    render(<SchemasTab showToast={vi.fn()} hasPermission={() => false} onSelectSchema={vi.fn()} />)
    fireEvent.click(await screen.findByText('Bare'))
    const panel = document.querySelector('.context-panel')
    const field = await waitFor(() => within(panel).getByText('Derived Metrics').closest('.context-field'))
    expect(field.querySelectorAll('a')).toHaveLength(0)
  })
})
