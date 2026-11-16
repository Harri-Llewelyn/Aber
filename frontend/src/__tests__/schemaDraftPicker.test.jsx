import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SchemaDetailModal } from '../components/modals/SchemaDetailModal'

/**
 * A draft's editor chooses its metrics from the schema builder's list (common/MetricPicker): the
 * search, the standard filter and the grouped ticks. What it adds is each metric's stored keys, and
 * a range beside a ticked numeric one.
 */

const metric = (name, extra = {}) => ({
  metric_uuid: name, name, datatype: 10, standard: 'MTConnect', description: '', deprecated: false, ...extra
})

const CATALOG = [
  metric('Axes/X/POSITION', { description: 'Where the axis is' }),
  metric('Axes/Y/POSITION'),
  metric('Controller/EXECUTION', { datatype: 12 }),
  metric('Spindle_Load', { standard: null }),
  metric('Old/METER', { deprecated: true }),
  metric('Power/PARTS_PER_HOUR', { derivation: { kind: 'counter_rate', input: 'Controller/PART_COUNT' } })
]

const DRAFT = {
  schema_uuid: 'draft-1', schema_name: 'Mill', version: 2, status: 'draft', parent_schema_id: 'parent-1',
  schema_definition: {
    type: 'object',
    properties: {
      'Axes/X/POSITION': { type: 'number', minimum: 0, description: 'Where the axis is' },
      'Gone/METRIC': { type: 'number' }
    }
  }
}

const open = (props = {}) => {
  const onSaveDraft = vi.fn().mockResolvedValue()
  render(
    <SchemaDetailModal schema={DRAFT} schemas={[DRAFT]} catalog={CATALOG} canManage
      onSaveDraft={onSaveDraft} onClose={() => {}} {...props} />
  )
  return { onSaveDraft, dialog: screen.getByRole('dialog') }
}

const rowOf = (dialog, name) => [...dialog.querySelectorAll('label')].find(l => l.querySelector('.mono')?.textContent === name)
const control = (dialog, name) => rowOf(dialog, name)?.querySelector('input') ?? null
const listed = (dialog) => [...dialog.querySelectorAll('label')]
  .filter(l => l.querySelector('input[type="checkbox"]'))
  .map(l => l.querySelector('.mono').textContent)

describe('a draft schema’s metric list', () => {
  it('is the schema builder’s list: a search, a standard filter and grouped ticks', () => {
    const { dialog } = open()
    expect(within(dialog).getByLabelText('Search catalog metrics')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Standard')).toBeInTheDocument()
    expect([...dialog.querySelectorAll('.metric-picker-group .table-group-label')].map(el => el.textContent))
      .toEqual(['Axes', 'Controller', 'Ungrouped'])
    // Not deprecated, and not derived, since nothing publishes a derived metric.
    expect(listed(dialog)).toEqual(['Axes/X/POSITION', 'Axes/Y/POSITION', 'Controller/EXECUTION', 'Spindle_Load'])
    expect(control(dialog, 'Axes/X/POSITION').type).toBe('checkbox')
  })

  it('shows what the draft stores for a metric after its name, and what a save would write once ticked', () => {
    const { dialog } = open()
    const stored = rowOf(dialog, 'Axes/X/POSITION')
    const name = stored.querySelector('.mono')
    expect(name.nextElementSibling.textContent).toBe('minimum · description')
    // A metric the draft does not hold has no keys to show until it is ticked, then the catalog's.
    const other = rowOf(dialog, 'Axes/Y/POSITION')
    expect(other.querySelectorAll('.mono')).toHaveLength(1)
  })

  it('searches and filters by standard without changing what is ticked', () => {
    const { dialog } = open()
    expect(control(dialog, 'Axes/X/POSITION').checked).toBe(true)
    fireEvent.change(within(dialog).getByLabelText('Search catalog metrics'), { target: { value: 'spindle' } })
    expect(listed(dialog)).toEqual(['Spindle_Load'])
    fireEvent.change(within(dialog).getByLabelText('Search catalog metrics'), { target: { value: '' } })
    fireEvent.change(within(dialog).getByLabelText('Standard'), { target: { value: 'MTConnect' } })
    expect(listed(dialog)).toEqual(['Axes/X/POSITION', 'Axes/Y/POSITION', 'Controller/EXECUTION'])
    expect(control(dialog, 'Axes/X/POSITION').checked).toBe(true)
    expect(dialog.querySelector('.section-count').textContent).toBe('2')
  })

  it('counts the ticked metrics of each group in its heading', () => {
    const { dialog } = open()
    const axes = [...dialog.querySelectorAll('.metric-picker-group')].find(g => g.textContent.startsWith('Axes'))
    expect(axes.textContent).toContain('1 selected')
    fireEvent.click(control(dialog, 'Axes/Y/POSITION'))
    expect(axes.textContent).toContain('2 selected')
  })

  it('keeps the range beside a ticked numeric metric, outside its label, so typing never toggles the tick', () => {
    const { dialog } = open()
    const maximum = within(dialog).getByRole('spinbutton', { name: 'Maximum of Axes/X/POSITION' })
    expect(rowOf(dialog, 'Axes/X/POSITION').contains(maximum)).toBe(false)
    expect(within(dialog).getByRole('spinbutton', { name: 'Minimum of Axes/X/POSITION' })).toHaveValue(0)
    fireEvent.change(maximum, { target: { value: '500' } })
    expect(control(dialog, 'Axes/X/POSITION').checked).toBe(true)
    expect(within(dialog).queryByRole('spinbutton', { name: 'Maximum of Axes/Y/POSITION' })).toBeNull()
    fireEvent.click(control(dialog, 'Axes/Y/POSITION'))
    expect(within(dialog).getByRole('spinbutton', { name: 'Maximum of Axes/Y/POSITION' })).toBeInTheDocument()
  })

  it('saves the metrics ticked, and keeps one the catalog no longer holds', async () => {
    const { dialog, onSaveDraft } = open()
    fireEvent.click(control(dialog, 'Controller/EXECUTION'))
    expect(dialog.textContent).toContain('1 modelled metric no longer in the active')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Draft' }))
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled())
    const properties = onSaveDraft.mock.calls[0][0].schema_definition.properties
    expect(Object.keys(properties).sort()).toEqual(['Axes/X/POSITION', 'Controller/EXECUTION', 'Gone/METRIC'])
  })

  it('shows a published version’s metrics as a plain list, with no picker', () => {
    const active = { ...DRAFT, status: 'active', schema_uuid: 'a-1' }
    const { dialog } = open({ schema: active, schemas: [active] })
    expect(within(dialog).queryByLabelText('Search catalog metrics')).toBeNull()
    expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(dialog.textContent).toContain('Axes/X/POSITION')
  })
})
