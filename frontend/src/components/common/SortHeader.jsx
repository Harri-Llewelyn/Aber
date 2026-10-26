import React from 'react'
import { HelpTip } from './HelpTip'
import { IconChevronDown, IconChevronUp, IconChevronsUpDown } from './Icons'
import { Tooltip } from './Tooltip'

/**
 * A sortable column's header: the label is a button, and a click sorts the table by the column,
 * a second reverses it, and a third returns the table to its default order. The sorted column's
 * header carries `aria-sort` and an arrow, as the WAI-ARIA "Sortable Table" pattern has it; the
 * other columns show a faint double arrow while the pointer or focus is on them.
 *
 * `sort` is the table's useTableSort (or useLocalTableSort) result. `title` is what the column
 * holds, said once for every row: the shared tooltip on the label's button, never the browser's.
 * A header that cannot be sorted (actions, an icon column) is a plain `<th>`, or a ColumnHeader
 * when it has something to say.
 *
 * `help` puts a HelpTip ("?") after the label, named by `helpLabel`, for a column whose meaning
 * needs more than the tooltip and must reach a touch screen, where a tap on the label sorts.
 *
 *   <SortHeader sort={sort} column="name" title="The name people see; the Sparkplug id is under it">Name</SortHeader>
 */
export function SortHeader({ sort, column, title, help, helpLabel, className, style, children }) {
  const active = sort.column === column
  const direction = active ? (sort.descending ? 'descending' : 'ascending') : undefined
  const Arrow = !active ? IconChevronsUpDown : sort.descending ? IconChevronDown : IconChevronUp
  return (
    <th aria-sort={direction} className={className} style={style}>
      <Tooltip text={title}>
        <button type="button" className="sort-header" onClick={() => sort.toggle(column)}>
          {children}
          <Arrow size={12} aria-hidden="true" className={active ? 'sort-arrow' : 'sort-arrow sort-arrow-idle'} />
        </button>
      </Tooltip>
      {help && <HelpTip text={help} label={helpLabel || 'What this column means'} size={12} />}
    </th>
  )
}

/**
 * A header that cannot be sorted but says what its column holds: `title` in the shared tooltip, on
 * the label, which takes keyboard focus so the sentence is not for the pointer alone.
 *
 *   <ColumnHeader title="What the device last reported for this metric">Value</ColumnHeader>
 */
export function ColumnHeader({ title, className, style, children }) {
  return (
    <th className={className} style={style}>
      <Tooltip text={title}>
        <span className="column-hint" tabIndex={0}>{children}</span>
      </Tooltip>
    </th>
  )
}
