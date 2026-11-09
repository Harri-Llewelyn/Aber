import React, { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { MetricPicker } from '../components/common/MetricPicker'

/**
 * The metric list the schema builder and Add Derived Metric share: a search and a standard filter
 * over the metrics grouped by their name's first segment, each with a tick. The schema builder's own
 * behaviour through it is held by SchemasTab.test.jsx and schemaBuilderContract.test.jsx, unchanged;
 * these hold the component itself.
 */

const metric = (name, extra = {}) => ({
  metric_uuid: name, name, datatype: 10, standard: null, semantic_id: null, description: '', units: null, ...extra
})

const METRICS = [
  metric('Axes/X/POSITION', { standard: 'MTConnect', units: 'MILLIMETER', description: 'Where the axis is' }),
  metric('Axes/Y/POSITION', { standard: 'MTConnect', units: 'MILLIMETER' }),
  metric('Controller/EXECUTION', { datatype: 12, standard: 'MTConnect', semantic_id: 'https://example.org/execution' }),
  metric('Spindle_Load', { description: 'How hard the spindle works' })
]

/** The picker with the choice held the way a dialog holds it. */
function Harness({ initial = [], single = false, isDisabled, renderExtra, showUnits, metrics = METRICS, onChosen, listStyle }) {
  const [chosen, setChosen] = useState(initial)
  const pick = (m) => {
    const next = single ? [m.name] : chosen.includes(m.name) ? chosen.filter(n => n !== m.name) : [...chosen, m.name]
    setChosen(next)
    onChosen?.(next)
  }
  return (
    <div>
      <span data-testid="chosen">{chosen.join(',')}</span>
      <MetricPicker
        metrics={metrics}
        isPicked={m => chosen.includes(m.name)}
        onPick={pick}
        single={single}
        isDisabled={isDisabled}
        renderExtra={renderExtra}
        showUnits={showUnits}
        listStyle={listStyle}
      />
    </div>
  )
}

const rowOf = (name) => [...document.querySelectorAll('label')].find(l => l.querySelector('.mono')?.textContent === name)
const control = (name) => rowOf(name)?.querySelector('input') ?? null
const listed = () => [...document.querySelectorAll('label .mono')].map(el => el.textContent)
const chosenNow = () => screen.getByTestId('chosen').textContent

describe('MetricPicker', () => {
  it('groups the metrics by the first segment of their name, ungrouped last, with each metric’s facts', () => {
    render(<Harness />)
    expect([...document.querySelectorAll('.metric-picker-group .table-group-label')].map(el => el.textContent))
      .toEqual(['Axes', 'Controller', 'Ungrouped'])
    const row = rowOf('Axes/X/POSITION')
    expect(row.textContent).toContain('Double')
    expect(row.textContent).toContain('MTConnect')
    expect(row.textContent).toContain('Where the axis is')
    expect(rowOf('Controller/EXECUTION').textContent).toContain('String')
    expect(rowOf('Controller/EXECUTION').textContent).toContain('✓')
    expect(rowOf('Spindle_Load').textContent).toContain('Local extension')
  })

  it('ticks and unticks, and counts the ticked in each group’s heading', () => {
    render(<Harness />)
    expect(document.querySelector('.metric-picker-group-selected')).toBeNull()
    fireEvent.click(control('Axes/X/POSITION'))
    fireEvent.click(control('Axes/Y/POSITION'))
    expect(chosenNow()).toBe('Axes/X/POSITION,Axes/Y/POSITION')
    expect(control('Axes/X/POSITION').type).toBe('checkbox')
    expect(document.querySelector('.metric-picker-group-selected').textContent).toBe('2 selected')
    fireEvent.click(control('Axes/X/POSITION'))
    expect(chosenNow()).toBe('Axes/Y/POSITION')
    expect(document.querySelector('.metric-picker-group-selected').textContent).toBe('1 selected')
  })

  it('searches the name and the description, without regard to case', () => {
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Search catalog metrics'), { target: { value: 'POSITION' } })
    expect(listed()).toEqual(['Axes/X/POSITION', 'Axes/Y/POSITION'])
    fireEvent.change(screen.getByLabelText('Search catalog metrics'), { target: { value: 'works spindle' } })
    expect(listed()).toEqual([])
    fireEvent.change(screen.getByLabelText('Search catalog metrics'), { target: { value: 'HARD' } })
    expect(listed()).toEqual(['Spindle_Load'])
  })

  it('filters by standard, a local extension being the empty one', () => {
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Standard'), { target: { value: 'MTConnect' } })
    expect(listed()).toEqual(['Axes/X/POSITION', 'Axes/Y/POSITION', 'Controller/EXECUTION'])
    fireEvent.change(screen.getByLabelText('Standard'), { target: { value: '' } })
    expect(listed()).toEqual(['Spindle_Load'])
    fireEvent.change(screen.getByLabelText('Standard'), { target: { value: '__any__' } })
    expect(listed()).toHaveLength(4)
  })

  it('narrows what is listed, never what is chosen', () => {
    render(<Harness initial={['Controller/EXECUTION']} />)
    fireEvent.change(screen.getByLabelText('Search catalog metrics'), { target: { value: 'axes' } })
    expect(control('Controller/EXECUTION')).toBeNull()
    expect(chosenNow()).toBe('Controller/EXECUTION')
    fireEvent.click(control('Axes/X/POSITION'))
    expect(chosenNow()).toBe('Controller/EXECUTION,Axes/X/POSITION')
    fireEvent.change(screen.getByLabelText('Search catalog metrics'), { target: { value: '' } })
    expect(control('Controller/EXECUTION').checked).toBe(true)
    expect(control('Axes/X/POSITION').checked).toBe(true)
  })

  it('says when nothing matches, and says another thing when there was nothing to choose from', () => {
    const { unmount } = render(<Harness />)
    fireEvent.change(screen.getByLabelText('Search catalog metrics'), { target: { value: 'no such metric' } })
    expect(screen.getByText('No matching catalog metrics.')).toBeTruthy()
    unmount()

    render(<MetricPicker metrics={[]} isPicked={() => false} onPick={() => {}} emptyText="Nothing can be chosen." />)
    expect(screen.getByText('Nothing can be chosen.')).toBeTruthy()
    expect(screen.queryByText('No matching catalog metrics.')).toBeNull()
  })

  it('says no matching metrics for an empty list when it is given no other words', () => {
    render(<MetricPicker metrics={[]} isPicked={() => false} onPick={() => {}} />)
    expect(screen.getByText('No matching catalog metrics.')).toBeTruthy()
  })

  describe('as a single choice', () => {
    it('is radio buttons of one group, and choosing another replaces the choice', () => {
      render(<Harness single />)
      const radios = [...document.querySelectorAll('input[type="radio"]')]
      expect(radios).toHaveLength(4)
      expect(new Set(radios.map(r => r.name)).size).toBe(1)
      expect(radios[0].name).not.toBe('')
      fireEvent.click(control('Axes/X/POSITION'))
      fireEvent.click(control('Spindle_Load'))
      expect(chosenNow()).toBe('Spindle_Load')
      expect(control('Axes/X/POSITION').checked).toBe(false)
      expect(control('Spindle_Load').checked).toBe(true)
    })

    it('keeps two pickers’ radios apart', () => {
      render(<><Harness single /><Harness single /></>)
      const [first, second] = [...document.querySelectorAll('input[type="radio"]')].filter((_, i) => i % 4 === 0)
      expect(first.name).not.toBe(second.name)
    })
  })

  it('holds the rows the caller names, unless they are chosen, so they can be taken out', () => {
    render(<Harness initial={['Axes/X/POSITION']} isDisabled={m => m.name !== 'Axes/Y/POSITION'} />)
    expect(control('Axes/X/POSITION').disabled).toBe(false)
    expect(control('Axes/Y/POSITION').disabled).toBe(false)
    expect(control('Spindle_Load').disabled).toBe(true)
    expect(control('Controller/EXECUTION').disabled).toBe(true)
  })

  it('draws a row’s extra beside the label, so using it never toggles the tick', () => {
    const onExtra = vi.fn()
    render(<Harness renderExtra={(m, picked) => picked && (
      <button type="button" onClick={onExtra} aria-label={`Extra of ${m.name}`}>extra</button>
    )} />)
    expect(screen.queryByRole('button', { name: /Extra of/ })).toBeNull()
    fireEvent.click(control('Axes/X/POSITION'))
    const extra = screen.getByRole('button', { name: 'Extra of Axes/X/POSITION' })
    expect(rowOf('Axes/X/POSITION').contains(extra)).toBe(false)
    fireEvent.click(extra)
    expect(onExtra).toHaveBeenCalledTimes(1)
    expect(control('Axes/X/POSITION').checked).toBe(true)
    expect(screen.queryByRole('button', { name: 'Extra of Axes/Y/POSITION' })).toBeNull()
  })

  it('shows each metric’s unit only when asked', () => {
    const { unmount } = render(<Harness />)
    expect(rowOf('Axes/X/POSITION').textContent).not.toContain('MILLIMETER')
    unmount()
    render(<Harness showUnits />)
    expect(rowOf('Axes/X/POSITION').textContent).toContain('MILLIMETER')
    expect(within(rowOf('Controller/EXECUTION')).queryByText('MILLIMETER')).toBeNull()
  })

  it('lets the caller set the height of the list, which scrolls inside itself', () => {
    render(<Harness listStyle={{ flex: 'none', height: '220px' }} />)
    const list = rowOf('Axes/X/POSITION').closest('div[style*="overflow"]')
    expect(list.style.height).toBe('220px')
    expect(list.style.overflowY).toBe('auto')
  })
})
