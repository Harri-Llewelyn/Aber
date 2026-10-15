/**
 * Sortable tables (#801): the comparison each column type makes (utils/tableSort.js), the sort held
 * in the address or in a modal's state (hooks/useTableSort.js), and the header that shows and
 * toggles it (common/SortHeader.jsx).
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import { act, render, renderHook, screen, fireEvent } from '@testing-library/react'
import { nextSort, parseSort, rankIn, severityRank, sortRows } from '../utils/tableSort'
import { useLocalSortableRows, useSortableRows, useTableSort } from '../hooks/useTableSort'
import { SortHeader } from '../components/common/SortHeader'

const at = (url) => window.history.replaceState(null, '', url)
const address = () => window.location.pathname + window.location.search

const by = (rows, columns, sort) => sortRows(rows, columns, parseSort(sort, columns)).map(r => r.id)

describe('sortRows', () => {
  it('sorts names in natural order, blind to case', () => {
    const rows = [{ id: 'a', n: 'Line 10' }, { id: 'b', n: 'line 9' }, { id: 'c', n: 'Line 1' }, { id: 'd', n: 'Boiler' }]
    const columns = { name: { type: 'text', value: r => r.n } }
    expect(by(rows, columns, 'name')).toEqual(['d', 'c', 'b', 'a'])
    expect(by(rows, columns, '-name')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('sorts times by instant, not by their text, from ISO strings, Dates and milliseconds', () => {
    const rows = [
      { id: 'later', t: '2026-10-15T09:00:00+01:00' },
      { id: 'earliest', t: new Date('2026-10-15T07:00:00Z') },
      { id: 'middle', t: Date.parse('2026-10-15T07:30:00Z') }
    ]
    const columns = { at: { type: 'time', value: r => r.t } }
    // 09:00+01:00 is 08:00Z: by its text it would sort first.
    expect(by(rows, columns, 'at')).toEqual(['earliest', 'middle', 'later'])
  })

  it('sorts numbers by size, not as text', () => {
    const rows = [{ id: 'nine', n: 9 }, { id: 'ten', n: 10 }, { id: 'two', n: '2' }]
    const columns = { count: { type: 'number', value: r => r.n } }
    expect(by(rows, columns, 'count')).toEqual(['two', 'nine', 'ten'])
    expect(by(rows, columns, '-count')).toEqual(['ten', 'nine', 'two'])
  })

  it('puts empty values last in either direction', () => {
    const rows = [
      { id: 'null', t: null }, { id: 'new', t: '2026-10-15' }, { id: 'blank', t: '' },
      { id: 'bad', t: 'not a time' }, { id: 'old', t: '2026-01-01' }, { id: 'missing' }
    ]
    const columns = { at: { type: 'time', value: r => r.t } }
    expect(by(rows, columns, 'at')).toEqual(['old', 'new', 'null', 'blank', 'bad', 'missing'])
    expect(by(rows, columns, '-at')).toEqual(['new', 'old', 'null', 'blank', 'bad', 'missing'])
    const names = { name: { type: 'text', value: r => r.n } }
    expect(by([{ id: 'x', n: '  ' }, { id: 'y', n: 'a' }], names, '-name')).toEqual(['y', 'x'])
  })

  it('keeps equal rows in the order they came in, in either direction', () => {
    const rows = [{ id: 1, s: 'b' }, { id: 2, s: 'a' }, { id: 3, s: 'b' }, { id: 4, s: 'a' }]
    const columns = { s: { type: 'text', value: r => r.s } }
    expect(by(rows, columns, 's')).toEqual([2, 4, 1, 3])
    expect(by(rows, columns, '-s')).toEqual([1, 3, 2, 4])
  })

  it('ranks a status by severity, not alphabetically', () => {
    const rows = [
      { id: 'online', tone: 'success' }, { id: 'quarantined', tone: 'warning' },
      { id: 'offline', tone: 'neutral' }, { id: 'failed', tone: 'danger' }
    ]
    const columns = { status: { type: 'rank', value: r => severityRank(r.tone) } }
    expect(by(rows, columns, 'status')).toEqual(['failed', 'quarantined', 'offline', 'online'])
    expect(by(rows, columns, '-status')).toEqual(['online', 'offline', 'quarantined', 'failed'])
  })

  it('ranks a tone alias with the colour it draws as, and an unknown tone as neutral', () => {
    expect(severityRank('critical')).toBe(severityRank('danger'))
    expect(severityRank('offline')).toBe(severityRank('danger'))
    expect(severityRank('ok')).toBe(severityRank('success'))
    expect(severityRank('nonsense')).toBe(severityRank('neutral'))
  })

  it('ranks a value by a fixed order, and a value outside it as empty', () => {
    expect(rankIn(['failed', 'claimed'], 'claimed')).toBe(1)
    expect(rankIn(['failed', 'claimed'], 'other')).toBeNull()
  })

  it('returns the rows unchanged, and unsorted in place, for the default order', () => {
    const rows = [{ id: 2 }, { id: 1 }]
    const columns = { id: { type: 'number', value: r => r.id } }
    expect(sortRows(rows, columns, null)).toBe(rows)
    sortRows(rows, columns, { column: 'id', descending: false })
    expect(rows.map(r => r.id)).toEqual([2, 1])
  })
})

describe('parseSort and nextSort', () => {
  const columns = { name: { type: 'text', value: r => r.name }, seen: { type: 'time', value: r => r.seen } }

  it('reads a column for ascending and a leading - for descending, and nothing else', () => {
    expect(parseSort('name', columns)).toEqual({ column: 'name', descending: false })
    expect(parseSort('-seen', columns)).toEqual({ column: 'seen', descending: true })
    expect(parseSort('', columns)).toBeNull()
    expect(parseSort('-', columns)).toBeNull()
    expect(parseSort('colour', columns)).toBeNull()
    expect(parseSort('toString', columns)).toBeNull()
  })

  it('cycles a column from ascending to descending to the default order', () => {
    expect(nextSort(null, 'name')).toBe('name')
    expect(nextSort(parseSort('name', columns), 'name')).toBe('-name')
    expect(nextSort(parseSort('-name', columns), 'name')).toBe('')
    expect(nextSort(parseSort('-name', columns), 'seen')).toBe('seen')
  })
})

describe('useTableSort', () => {
  const columns = { name: { type: 'text', value: r => r.name }, seen: { type: 'time', value: r => r.seen } }
  const rows = [{ name: 'Line 10' }, { name: 'Line 9' }]

  it('holds the sort in the address, and leaves the default order out of it', () => {
    at('/devices?search=line')
    const { result } = renderHook(() => useSortableRows(rows, columns))
    expect(result.current[0]).toBe(rows)
    act(() => result.current[1].toggle('name'))
    expect(address()).toBe('/devices?search=line&sort=name')
    expect(result.current[0].map(r => r.name)).toEqual(['Line 9', 'Line 10'])
    act(() => result.current[1].toggle('name'))
    expect(address()).toBe('/devices?search=line&sort=-name')
    expect(result.current[0].map(r => r.name)).toEqual(['Line 10', 'Line 9'])
    act(() => result.current[1].toggle('name'))
    expect(address()).toBe('/devices?search=line')
    expect(result.current[0]).toBe(rows)
  })

  it('reads a sort from the address on arrival, and tidies away one the table does not offer', () => {
    at('/devices?sort=-seen')
    const { result: arrived } = renderHook(() => useTableSort(columns))
    expect(arrived.current).toMatchObject({ column: 'seen', descending: true })

    at('/devices?sort=colour&search=x')
    const { result } = renderHook(() => useTableSort(columns))
    expect(result.current.column).toBeNull()
    expect(address()).toBe('/devices?search=x')
  })

  it('holds a modal table\'s sort in its own state, leaving the page\'s sort alone', () => {
    at('/devices?sort=-seen')
    const { result } = renderHook(() => useLocalSortableRows(rows, columns))
    expect(result.current[1].column).toBeNull()
    act(() => result.current[1].toggle('name'))
    expect(result.current[1]).toMatchObject({ column: 'name', descending: false })
    expect(address()).toBe('/devices?sort=-seen')
  })
})

describe('SortHeader', () => {
  function Table({ rows }) {
    const columns = React.useMemo(() => ({
      name: { type: 'text', value: r => r.name },
      count: { type: 'number', value: r => r.count }
    }), [])
    const [sorted, sort] = useSortableRows(rows, columns)
    return (
      <table>
        <thead>
          <tr>
            <SortHeader sort={sort} column="name" title="The thing's name">Name</SortHeader>
            <SortHeader sort={sort} column="count">Count</SortHeader>
            <th className="row-actions">Actions</th>
          </tr>
        </thead>
        <tbody>{sorted.map(r => <tr key={r.name}><td>{r.name}</td><td>{r.count}</td><td /></tr>)}</tbody>
      </table>
    )
  }
  const rows = [{ name: 'Pump 2', count: 5 }, { name: 'Pump 10', count: 1 }, { name: 'Boiler', count: 12 }]
  const names = () => screen.getAllByRole('row').slice(1).map(r => r.cells[0].textContent)

  it('is a button in the header cell, with the hover text on the cell', () => {
    at('/devices')
    render(<Table rows={rows} />)
    const button = screen.getByRole('button', { name: 'Name' })
    expect(button.closest('th')).toHaveAttribute('title', 'The thing\'s name')
    expect(button).toHaveAttribute('type', 'button')
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('sorts on a click, reverses on a second, and returns to the default order on a third', () => {
    at('/devices')
    render(<Table rows={rows} />)
    const header = screen.getByRole('columnheader', { name: 'Name' })
    expect(names()).toEqual(['Pump 2', 'Pump 10', 'Boiler'])
    expect(header).not.toHaveAttribute('aria-sort')

    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(names()).toEqual(['Boiler', 'Pump 2', 'Pump 10'])
    expect(header).toHaveAttribute('aria-sort', 'ascending')

    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(names()).toEqual(['Pump 10', 'Pump 2', 'Boiler'])
    expect(header).toHaveAttribute('aria-sort', 'descending')

    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(names()).toEqual(['Pump 2', 'Pump 10', 'Boiler'])
    expect(header).not.toHaveAttribute('aria-sort')
    expect(address()).toBe('/devices')
  })

  it('marks only the sorted column, and moves the mark when another column is clicked', () => {
    at('/devices?sort=-count')
    render(<Table rows={rows} />)
    expect(names()).toEqual(['Boiler', 'Pump 2', 'Pump 10'])
    expect(screen.getByRole('columnheader', { name: 'Count' })).toHaveAttribute('aria-sort', 'descending')
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveAttribute('aria-sort')

    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending')
    expect(screen.getByRole('columnheader', { name: 'Count' })).not.toHaveAttribute('aria-sort')
    expect(document.querySelectorAll('th[aria-sort]')).toHaveLength(1)
  })

  it('leaves a column it is not given as a plain header', () => {
    at('/devices')
    render(<Table rows={rows} />)
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull()
  })
})
