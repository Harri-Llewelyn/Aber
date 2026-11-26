import React, { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ListPicker } from '../components/common/ListPicker'

/**
 * The list MetricPicker and SchemaPicker build on: the search, the ticked rows that scroll inside
 * themselves, the count and the fieldset. What each picker adds is held by its own tests.
 */

const ITEMS = ['Apple', 'Banana', 'Cherry'].map(name => ({ id: name.toLowerCase(), name }))
const matches = (item, needle) => item.name.toLowerCase().includes(needle)

/** The picker with the choice held the way a dialog holds it. */
function Harness({ initial = [], items = ITEMS, ...props }) {
  const [chosen, setChosen] = useState(initial)
  return (
    <ListPicker
      items={items}
      keyOf={i => i.id}
      isPicked={i => chosen.includes(i.id)}
      onPick={i => setChosen(c => (c.includes(i.id) ? c.filter(id => id !== i.id) : [...c, i.id]))}
      searchLabel="Search fruit"
      matches={matches}
      renderItem={i => <span>{i.name}</span>}
      emptyText="There is no fruit."
      noMatchText="No matching fruit."
      {...props}
    />
  )
}

const box = (name) => screen.queryByRole('checkbox', { name })
const search = () => screen.getByLabelText('Search fruit')
const type = (value) => fireEvent.change(search(), { target: { value } })
const list = () => document.querySelector('.list-picker-list')

describe('ListPicker', () => {
  it('searches what is listed, never what is chosen, and trims the needle', () => {
    render(<Harness initial={['cherry']} legend="Fruit" />)
    type('  BAN ')
    expect(box('Banana')).toBeTruthy()
    expect(box('Cherry')).toBeNull()
    fireEvent.click(box('Banana'))
    expect(screen.getByRole('group', { name: 'Fruit 2 selected' })).toBeTruthy()
    type('')
    expect(box('Cherry').checked).toBe(true)
    expect(box('Banana').checked).toBe(true)
    expect(box('Apple').checked).toBe(false)
  })

  it('is a fieldset named by its legend and the count, holding the note and what comes after', () => {
    render(<Harness legend="Fruit" note={<p>Pick freely.</p>}><p>All of it is ripe.</p></Harness>)
    const group = screen.getByRole('group', { name: 'Fruit 0 selected' })
    expect(group.tagName).toBe('FIELDSET')
    expect(group).toHaveClass('form-group')
    const order = [...group.children]
    const at = (el) => order.indexOf(el)
    expect(at(screen.getByText('Pick freely.'))).toBeLessThan(at(document.querySelector('.list-picker-search')))
    expect(at(document.querySelector('.list-picker-search'))).toBeLessThan(at(list()))
    expect(at(list())).toBeLessThan(at(screen.getByText('All of it is ripe.')))
  })

  it('without a legend draws the search row and the list as siblings, so a flex column decides their height', () => {
    render(<div data-testid="column"><Harness /></div>)
    expect([...screen.getByTestId('column').children].map(el => el.className)).toEqual(['list-picker-search', 'list-picker-list'])
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('takes a height or a class for the list, which scrolls inside itself with either', () => {
    const { rerender } = render(<Harness listStyle={{ flex: 'none', height: '120px' }} />)
    expect(list().style.height).toBe('120px')
    expect(list().style.overflowY).toBe('auto')
    rerender(<Harness listClass="fruit-list" />)
    expect(list()).toHaveClass('list-picker-list', 'fruit-list')
    expect(list().style.overflowY).toBe('auto')
  })

  it('draws what else narrows the list beside the search, and both apply', () => {
    const passes = (i) => i.id !== 'banana'
    render(<Harness filters={<button type="button">Not yellow</button>} passes={passes} />)
    expect(within(document.querySelector('.list-picker-search')).getByRole('button', { name: 'Not yellow' })).toBeTruthy()
    expect(box('Banana')).toBeNull()
    type('an')
    expect(screen.getByText('No matching fruit.')).toBeTruthy()
  })

  it('says one thing when the search finds nothing and another when there is nothing to choose from', () => {
    const { unmount } = render(<Harness />)
    type('durian')
    expect(list().textContent).toBe('No matching fruit.')
    unmount()
    render(<Harness items={[]} searchLabel={undefined} />)
    expect(list().textContent).toBe('There is no fruit.')
    // Nothing to search, so no search row at all.
    expect(document.querySelector('.list-picker-search')).toBeNull()
  })

  it('holds the rows the caller names, unless they are chosen, so they can be taken out', () => {
    render(<Harness initial={['cherry']} isDisabled={i => i.id !== 'apple'} />)
    expect(box('Apple').disabled).toBe(false)
    expect(box('Banana').disabled).toBe(true)
    expect(box('Cherry').disabled).toBe(false)
  })

  it('is native controls in the order listed, so Tab and Space need no handler', () => {
    render(<Harness legend="Fruit" />)
    const controls = [...document.querySelectorAll('input, button, select, [tabindex]')]
    expect(controls[0]).toBe(search())
    expect(controls.slice(1).map(c => [c.type, c.hasAttribute('tabindex')])).toEqual([
      ['checkbox', false], ['checkbox', false], ['checkbox', false]
    ])
  })

  it('gives a row’s control a name of its own when the caller has one', () => {
    render(<Harness inputProps={i => ({ 'aria-label': `The ${i.name}` })} />)
    expect(box('The Apple')).toBeTruthy()
  })

  it('counts the chosen of each group it is given', () => {
    render(<Harness initial={['apple']} groupsOf={items => [
      { key: 'a', items: items.filter(i => i.id === 'apple'), heading: n => <h3>A, {n} chosen</h3> },
      { key: 'rest', items: items.filter(i => i.id !== 'apple'), heading: n => <h3>The rest, {n} chosen</h3> }
    ]} />)
    expect(screen.getAllByRole('heading').map(h => h.textContent)).toEqual(['A, 1 chosen', 'The rest, 0 chosen'])
    fireEvent.click(box('Banana'))
    expect(screen.getAllByRole('heading').map(h => h.textContent)).toEqual(['A, 1 chosen', 'The rest, 1 chosen'])
  })
})
