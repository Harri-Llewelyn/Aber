import React from 'react'
import { IconChevronDown, IconChevronUp, IconChevronsUpDown } from './Icons'

/**
 * A sortable column's header: the label is a button, and a click sorts the table by the column,
 * a second reverses it, and a third returns the table to its default order. The sorted column's
 * header carries `aria-sort` and an arrow, as the WAI-ARIA "Sortable Table" pattern has it; the
 * other columns show a faint double arrow while the pointer or focus is on them.
 *
 * `sort` is the table's useTableSort (or useLocalTableSort) result. `title` is the column's hover
 * text, on the cell as an unsorted header has it. A header that cannot be sorted (actions, an
 * icon column) stays a plain `<th>`.
 *
 *   <SortHeader sort={sort} column="name" title="Human-readable device name">Name</SortHeader>
 */
export function SortHeader({ sort, column, title, className, style, children }) {
  const active = sort.column === column
  const direction = active ? (sort.descending ? 'descending' : 'ascending') : undefined
  const Arrow = !active ? IconChevronsUpDown : sort.descending ? IconChevronDown : IconChevronUp
  return (
    <th aria-sort={direction} title={title} className={className} style={style}>
      <button type="button" className="sort-header" onClick={() => sort.toggle(column)}>
        {children}
        <Arrow size={12} aria-hidden="true" className={active ? 'sort-arrow' : 'sort-arrow sort-arrow-idle'} />
      </button>
    </th>
  )
}
