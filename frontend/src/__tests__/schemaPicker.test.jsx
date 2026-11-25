import React, { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SchemaPicker } from '../components/common/SchemaPicker'
import { schemaHit } from '../utils/schemaSearch'

/**
 * A device's schemas, chosen from a ListPicker: what a row says, what the search finds a schema by,
 * and the order. The list itself is held by listPicker.test.jsx, and the device form's use of it by
 * deviceSchemaSearch.test.jsx.
 */

const schema = (name, { metrics = [], ...extra } = {}) => ({
  schema_uuid: `id-${name}`, schema_name: name, version: 1, status: 'active', description: '',
  schema_definition: { properties: Object.fromEntries(metrics.map(m => [m, { type: 'number' }])) }, ...extra
})

const SPINDLE = schema('Spindle_Schema', { metrics: ['Spindle/LOAD', 'Spindle/SPEED'], description: 'The main spindle of a machining centre' })
const MILL = schema('Mill_Schema_v2', { version: 2, metrics: ['Spindle/LOAD_PEAK', 'Spindle/LOAD', 'Axes/X/POSITION'] })
const DRAFT = schema('Press_Schema_v3', { version: 3, status: 'draft', metrics: ['Press/FORCE'] })
const OLD = schema('Oven_Schema', { status: 'archived', metrics: ['Oven/TEMPERATURE'] })
const BARE = schema('Bare_Schema', { schema_definition: null })
const ALL = [SPINDLE, MILL, DRAFT, OLD, BARE]

function Harness({ schemas = ALL, initial = [], ...props }) {
  const [value, setValue] = useState(initial)
  return (
    <SchemaPicker
      legend="Schemas"
      schemas={schemas}
      value={value}
      onToggle={id => setValue(v => (v.includes(id) ? v.filter(x => x !== id) : [...v, id]))}
      {...props}
    />
  )
}

const box = (name) => screen.queryByRole('checkbox', { name })
const names = () => screen.queryAllByRole('checkbox').map(cb => cb.getAttribute('aria-label'))
const row = (name) => box(name).closest('.list-picker-row')
const detail = (name) => row(name).querySelector('.schema-picker-detail').textContent
const type = (value) => fireEvent.change(screen.getByLabelText('Search name, description or metric'), { target: { value } })
const described = (name) => box(name).getAttribute('aria-describedby').split(' ').map(id => document.getElementById(id).textContent)

describe('a row', () => {
  it('says the name, the version, how many metrics it models and the description', () => {
    render(<Harness />)
    expect(row('Spindle_Schema').querySelector('.schema-picker-name').textContent).toBe('Spindle_Schema')
    expect(row('Spindle_Schema').querySelector('.schema-picker-version').textContent).toBe('v1')
    expect(detail('Spindle_Schema')).toBe('2 metrics · The main spindle of a machining centre')
  })

  it('counts one metric as one, and says so when a schema models none or cannot be read', () => {
    render(<Harness />)
    expect(detail('Press_Schema_v3 · Draft')).toBe('1 metric')
    expect(detail('Bare_Schema')).toBe('No metrics')
  })

  it('says the status in words while a version is not in force, and only then', () => {
    render(<Harness />)
    expect(row('Press_Schema_v3 · Draft').querySelector('.badge').textContent).toBe('v3 · Draft')
    expect(row('Oven_Schema · Archived').querySelector('.badge').textContent).toBe('v1 · Archived')
    expect(row('Mill_Schema_v2').querySelector('.badge')).toBeNull()
    expect(row('Mill_Schema_v2').textContent).not.toContain('Active')
  })

  it('is heard by its name, and described by its version, its count and its description', () => {
    render(<Harness />)
    expect(described('Spindle_Schema')).toEqual(['v1', '2 metrics · The main spindle of a machining centre'])
    expect(described('Press_Schema_v3 · Draft')).toEqual(['v3 · Draft', '1 metric'])
  })

  it('cuts a long name and a long description to a line that slides, with the whole text in the row', () => {
    const long = schema('A_Name_That_Goes_On', { description: 'A description that goes on and on' })
    render(<Harness schemas={[long]} />)
    const cut = [...row('A_Name_That_Goes_On').querySelectorAll('.overflow-text')].map(el => el.textContent)
    expect(cut).toEqual(['A_Name_That_Goes_On', '· A description that goes on and on'])
  })
})

describe('the search', () => {
  it('finds a schema by its name, without regard to case', () => {
    render(<Harness />)
    type('PRESS_schema')
    expect(names()).toEqual(['Press_Schema_v3 · Draft'])
  })

  it('finds a schema by its description, and goes on showing it', () => {
    render(<Harness />)
    type('machining centre')
    expect(names()).toEqual(['Spindle_Schema'])
    expect(detail('Spindle_Schema')).toContain('The main spindle')
  })

  it('finds the schemas that carry a metric, and says which metric in place of the description', () => {
    render(<Harness />)
    type('spindle/load')
    expect(names()).toEqual(['Spindle_Schema', 'Mill_Schema_v2'])
    expect(detail('Spindle_Schema')).toBe('2 metrics · models Spindle/LOAD')
    // The metric typed in full first, whatever the schema's own order.
    expect(detail('Mill_Schema_v2')).toBe('3 metrics · models Spindle/LOAD and 1 more match')
    expect(described('Mill_Schema_v2')[1]).toBe('3 metrics · models Spindle/LOAD and 1 more match')
    type('')
    expect(detail('Spindle_Schema')).toContain('The main spindle')
  })

  it('finds a schema by a metric it only requires', () => {
    const required = schema('Required_Schema', { schema_definition: { required: ['Coolant/FLOW'] } })
    render(<Harness schemas={[SPINDLE, required]} />)
    type('coolant')
    expect(names()).toEqual(['Required_Schema'])
    expect(detail('Required_Schema')).toBe('1 metric · models Coolant/FLOW')
  })

  it('says when it finds nothing, and keeps what is chosen', () => {
    render(<Harness initial={[MILL.schema_uuid]} />)
    type('no such thing')
    expect(screen.getByText('No matching schemas.')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Schemas 1 selected' })).toBeTruthy()
    type('')
    expect(box('Mill_Schema_v2').checked).toBe(true)
  })
})

describe('the order', () => {
  const sixty = Array.from({ length: 60 }, (_, i) => schema(`Schema_${String(i + 1).padStart(2, '0')}`))

  it('lists what is chosen as it opens first, and the rest in the order given', () => {
    render(<Harness schemas={sixty} initial={['id-Schema_42', 'id-Schema_07']} />)
    expect(names()).toHaveLength(60)
    expect(names().slice(0, 4)).toEqual(['Schema_07', 'Schema_42', 'Schema_01', 'Schema_02'])
    expect(screen.getByRole('group', { name: 'Schemas 2 selected' })).toBeTruthy()
  })

  it('moves no row when one is ticked or unticked', () => {
    render(<Harness schemas={sixty} initial={['id-Schema_42']} />)
    const before = names()
    fireEvent.click(box('Schema_60'))
    fireEvent.click(box('Schema_42'))
    expect(names()).toEqual(before)
    expect(screen.getByRole('group', { name: 'Schemas 1 selected' })).toBeTruthy()
  })

  it('keeps its order and its search when the page reads the schemas again', () => {
    const { rerender } = render(<Harness schemas={sixty} initial={['id-Schema_42']} />)
    type('schema_4')
    rerender(<Harness schemas={sixty.map(s => ({ ...s }))} initial={['id-Schema_42']} />)
    expect(names()).toEqual(['Schema_42', 'Schema_40', 'Schema_41', 'Schema_43', 'Schema_44', 'Schema_45', 'Schema_46', 'Schema_47', 'Schema_48', 'Schema_49'])
  })

  it('is as tall as the schemas it offers, whatever a search leaves, and short with none', () => {
    const { rerender } = render(<Harness schemas={sixty} />)
    const list = () => document.querySelector('.list-picker-list')
    const rows = () => list().style.getPropertyValue('--schema-rows')
    expect(list()).toHaveClass('schema-picker-list')
    expect(rows()).toBe('60')
    type('schema_42')
    expect(names()).toEqual(['Schema_42'])
    expect(rows()).toBe('60')
    type('')
    rerender(<Harness schemas={sixty.slice(0, 1)} />)
    expect(names()).toEqual(['Schema_01'])
    expect(list()).toHaveClass('schema-picker-list')
    expect(rows()).toBe('1')
    rerender(<Harness schemas={[]} />)
    expect(list()).not.toHaveClass('schema-picker-list')
    expect(list().textContent).toBe('No schemas yet. Create one on the Schemas page.')
    expect(screen.queryByLabelText('Search name, description or metric')).toBeNull()
  })
})

describe('schemaHit()', () => {
  const metrics = ['Spindle/LOAD_PEAK', 'Spindle/LOAD', 'Axes/X/POSITION']

  it('finds everything with nothing typed', () => {
    expect(schemaHit(SPINDLE, [], '')).toEqual({ metrics: [] })
  })

  it('names no metric when the schema says it itself', () => {
    expect(schemaHit({ schema_name: 'Spindle' }, metrics, 'spindle')).toEqual({ metrics: [] })
    expect(schemaHit({ schema_name: 'Mill', description: 'A spindle' }, metrics, 'spindle')).toEqual({ metrics: [] })
  })

  it('puts the metric typed in full before one it is only part of', () => {
    expect(schemaHit({ schema_name: 'Mill' }, metrics, 'spindle/load')).toEqual({ metrics: ['Spindle/LOAD', 'Spindle/LOAD_PEAK'] })
  })

  it('finds nothing where nothing says it', () => {
    expect(schemaHit({ schema_name: 'Mill', description: null }, metrics, 'coolant')).toBeNull()
  })
})
