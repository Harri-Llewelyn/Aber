/**
 * The shared list filter (common/FilterChecklist.jsx): a checklist in groups, a search box once a
 * list is long, a count beside each value, the keyboard, and the words a toolbar dropdown's button
 * shows. Every list filter on every page draws one.
 */
import React, { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import {
  FilterChecklist, FilterDropdown, FilterList, FilterCheck, filterWords, SEARCH_AT
} from '../components/common/FilterChecklist'

const STATUSES = [
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'stale', label: 'Stale' },
]

const KINDS = [
  { value: 'AREA', label: 'Areas', group: 'The plant' },
  { value: 'CELL', label: 'Cells', group: 'The plant' },
  { value: 'DEVICE', label: 'Devices', group: 'The plant' },
  { value: 'SCHEMA', label: 'Schemas', group: 'The model' },
  { value: 'METRIC', label: 'Metric catalog', group: 'The model' },
]

/** A controlled checklist, as a page holds one, with the latest value readable. */
function Held({ initial = [], Component = FilterChecklist, ...props }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <Component {...props} value={value} onChange={setValue} />
      <output data-testid="value">{value.join(',')}</output>
    </>
  )
}
const valueNow = () => screen.getByTestId('value').textContent

describe('FilterChecklist', () => {
  it('draws a list with no groups flat: one checkbox per value and no headings', () => {
    render(<Held label="Status" options={STATUSES} plural="statuses" />)
    const list = screen.getByRole('group', { name: 'Status' })
    expect(within(list).getAllByRole('checkbox').map(c => c.parentElement.textContent)).toEqual(['Online', 'Offline', 'Stale'])
    expect(within(list).queryAllByRole('group')).toHaveLength(0)
  })

  it('ORs the values it holds and hands back the next list in the options\' order', () => {
    render(<Held label="Status" options={STATUSES} plural="statuses" />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Stale' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Online' }))
    expect(valueNow()).toBe('online,stale')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Stale' }))
    expect(valueNow()).toBe('online')
  })

  it('draws each group under a heading whose checkbox chooses or clears the group', () => {
    render(<Held label="Entity" options={KINDS} plural="kinds" />)
    const plant = screen.getByRole('group', { name: 'The plant' })
    expect(within(plant).getAllByRole('checkbox')).toHaveLength(4)
    fireEvent.click(screen.getByRole('checkbox', { name: 'The plant' }))
    expect(valueNow()).toBe('AREA,CELL,DEVICE')
    fireEvent.click(screen.getByRole('checkbox', { name: 'The plant' }))
    expect(valueNow()).toBe('')
  })

  it('shows a heading mixed while some of its group is chosen, and chooses the rest from there', () => {
    render(<Held label="Entity" options={KINDS} plural="kinds" initial={['CELL']} />)
    const heading = screen.getByRole('checkbox', { name: 'The plant' })
    expect(heading.indeterminate).toBe(true)
    expect(heading.checked).toBe(false)
    expect(screen.getByRole('checkbox', { name: 'The model' }).indeterminate).toBe(false)
    fireEvent.click(heading)
    expect(valueNow()).toBe('AREA,CELL,DEVICE')
    expect(screen.getByRole('checkbox', { name: 'The plant' }).indeterminate).toBe(false)
    expect(screen.getByRole('checkbox', { name: 'The plant' }).checked).toBe(true)
  })

  it('has no search box at the threshold, and one above it that narrows the values', () => {
    const many = Array.from({ length: SEARCH_AT + 1 }, (_, i) => ({ value: `v${i}`, label: `Value ${i}` }))
    const { unmount } = render(<Held label="Gateway" options={many.slice(0, SEARCH_AT)} plural="gateways" />)
    expect(screen.queryByRole('searchbox')).toBeNull()
    unmount()
    render(<Held label="Gateway" options={many} plural="gateways" />)
    const box = screen.getByRole('searchbox', { name: 'Search gateway' })
    expect(box.getAttribute('placeholder')).toBe('Search gateways…')
    fireEvent.change(box, { target: { value: 'value 8' } })
    expect(screen.getAllByRole('checkbox').map(c => c.parentElement.textContent)).toEqual(['Value 8'])
    fireEvent.change(box, { target: { value: 'nothing' } })
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.getByText('No gateways match “nothing”.')).toBeTruthy()
  })

  it('under a search, a heading chooses only the values it shows', () => {
    const options = [...KINDS, ...Array.from({ length: 5 }, (_, i) => ({ value: `X${i}`, label: `Extra ${i}`, group: 'Capture' }))]
    render(<Held label="Entity" options={options} plural="kinds" />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ce' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'The plant' }))
    // "Cells" and "Devices" contain "ce"; "Areas" does not, and stays unchosen.
    expect(valueNow()).toBe('CELL,DEVICE')
  })

  it('shows each value\'s count, zero included, and none when the page gives no counts', () => {
    const { unmount } = render(<Held label="Status" options={STATUSES} plural="statuses" counts={new Map([['online', 4], ['stale', 1]])} />)
    expect(screen.getByRole('checkbox', { name: 'Online 4' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Offline 0' })).toBeTruthy()
    unmount()
    render(<Held label="Status" options={STATUSES} plural="statuses" />)
    expect(screen.getByRole('checkbox', { name: 'Online' })).toBeTruthy()
  })

  it('moves between the checkboxes with ↑ and ↓, from the search box into them, and ticks with Space', () => {
    const options = Array.from({ length: SEARCH_AT + 2 }, (_, i) => ({ value: `v${i}`, label: `Value ${i}` }))
    render(<Held label="Gateway" options={options} plural="gateways" />)
    const box = screen.getByRole('searchbox')
    box.focus()
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    const boxes = screen.getAllByRole('checkbox')
    expect(document.activeElement).toBe(boxes[0])
    fireEvent.keyDown(boxes[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(boxes[1])
    fireEvent.keyDown(boxes[1], { key: 'End' })
    expect(document.activeElement).toBe(boxes[boxes.length - 1])
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(boxes[boxes.length - 2])
    fireEvent.keyDown(document.activeElement, { key: 'Home' })
    expect(document.activeElement).toBe(boxes[0])
    // A native checkbox: Space ticks it as a click does.
    fireEvent.click(document.activeElement)
    expect(valueNow()).toBe('v0')
  })
})

describe('filterWords', () => {
  const base = { options: STATUSES, noun: 'status', plural: 'statuses' }
  it('says Any with nothing chosen, the value with one, and the count with several', () => {
    expect(filterWords({ ...base, value: [] })).toBe('Any status')
    expect(filterWords({ ...base, value: ['offline'] })).toBe('Offline')
    expect(filterWords({ ...base, value: ['online', 'stale'] })).toBe('2 statuses')
  })
  it('reads every value as Any where every row has one of them, and lets a page name a choice', () => {
    expect(filterWords({ ...base, value: ['online', 'offline', 'stale'] })).toBe('3 statuses')
    expect(filterWords({ ...base, value: ['online', 'offline', 'stale'], everyIsAny: true })).toBe('Any status')
    expect(filterWords({ ...base, value: ['online', 'offline'], words: v => (v.length === 2 ? 'Current' : null) })).toBe('Current')
  })
  it('prefers a value\'s short words, and shows an unlisted value as itself', () => {
    expect(filterWords({ ...base, options: [{ value: 'x', label: 'Long words', short: 'Short' }], value: ['x'] })).toBe('Short')
    expect(filterWords({ ...base, value: ['gone'] })).toBe('gone')
  })
})

describe('FilterDropdown', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: /^Status:/ }))

  it('is a toolbar button named for its filter and its words, opening the checklist in a dialog', () => {
    render(<Held Component={FilterDropdown} label="Status" noun="status" plural="statuses" options={STATUSES} />)
    const button = screen.getByRole('button', { name: 'Status: Any status' })
    expect(button.textContent).toBe('Any status')
    expect(button.className).toContain('control-md')
    open()
    const dialog = screen.getByRole('dialog', { name: 'Status' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Offline' }))
    expect(screen.getByRole('button', { name: 'Status: Offline' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Online' }))
    expect(screen.getByRole('button', { name: 'Status: 2 statuses' })).toBeTruthy()
  })

  it('takes the focus to its first checkbox as it opens, and gives it back to the button on Escape', () => {
    render(<Held Component={FilterDropdown} label="Status" noun="status" plural="statuses" options={STATUSES} />)
    const button = screen.getByRole('button', { name: /^Status:/ })
    open()
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Online' }))
    fireEvent.keyDown(document.activeElement, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('clears its search on the first Escape and closes on the second', () => {
    const options = Array.from({ length: SEARCH_AT + 1 }, (_, i) => ({ value: `v${i}`, label: `Value ${i}` }))
    render(<Held Component={FilterDropdown} label="Status" noun="status" plural="statuses" options={options} />)
    open()
    const box = screen.getByRole('searchbox')
    expect(document.activeElement).toBe(box)
    fireEvent.change(box, { target: { value: '3' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(box.value).toBe('')
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has a Clear that returns it to its default, disabled while it is there', () => {
    const lifecycle = [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }]
    render(<Held Component={FilterDropdown} label="Lifecycle" noun="lifecycle" plural="lifecycles" everyIsAny
      options={lifecycle} initial={['active']} defaultValue={['active']} />)
    expect(screen.getByRole('button', { name: 'Lifecycle: Active' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Lifecycle:/ }))
    const clear = screen.getByRole('button', { name: 'Clear' })
    expect(clear.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Archived' }))
    expect(screen.getByRole('button', { name: 'Lifecycle: Any lifecycle' })).toBeTruthy()
    expect(clear.disabled).toBe(false)
    fireEvent.click(clear)
    expect(valueNow()).toBe('active')
  })
})

describe('FilterList and FilterCheck', () => {
  it('labels a list inside a Filters panel and offers its tip on a HelpTip', () => {
    render(<Held Component={FilterList} label="Gateway" plural="gateways" options={STATUSES} tip="Where it publishes." />)
    expect(screen.getByText('Gateway')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Gateway' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'About gateway' })).toBeTruthy()
  })

  it('is a checkbox for a yes-or-no choice, with the count it would add', () => {
    const onChange = vi.fn()
    render(<FilterCheck label="Show deleted entities" checked={false} onChange={onChange} count={3} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show deleted entities 3' }))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
