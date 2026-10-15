import { useCallback, useMemo, useState } from 'react'
import { useUrlState } from './useUrlState'
import { nextSort, parseSort, sortRows } from '../utils/tableSort'

/*
 * A sortable table's sort, for `common/SortHeader.jsx` to draw and toggle. `columns` maps each
 * sortable column's id to its type and value (`utils/tableSort.js`). Build it once at module level,
 * or in a useMemo when it reads the page's state, so the rows are not re-sorted on every render.
 *
 * The result is `{ column, descending, toggle(column), apply(rows) }`: `column` is null in the
 * table's default order, and `apply` sorts any rows by the current sort, for a table drawn as
 * groups that each sort on their own.
 */
function useSortOver(columns, value, setValue) {
  const sort = useMemo(() => parseSort(value, columns), [value, columns])
  const toggle = useCallback(
    (column) => setValue(current => nextSort(parseSort(current, columns), column)),
    [setValue, columns]
  )
  const apply = useCallback((rows) => sortRows(rows, columns, sort), [columns, sort])
  return useMemo(() => ({
    column: sort?.column ?? null,
    descending: Boolean(sort?.descending),
    toggle,
    apply
  }), [sort, toggle, apply])
}

/**
 * A page table's sort, held in the address (`?sort=name`, `?sort=-last_heartbeat`), so a sorted
 * view can be linked to and survives a reload. A page shows one table per tab, so every page uses
 * the key `sort`, and a tab change drops it as it does the other filters.
 *
 * `active` is false while the table's tab is not the one shown, for a page that keeps every tab's
 * table in one component: the hidden table then neither reads the sort nor tidies away one meant
 * for the table that is shown.
 */
export function useTableSort(columns, { key = 'sort', active = true } = {}) {
  const valid = useCallback((value) => parseSort(value, columns) !== null, [columns])
  const [value, setValue] = useUrlState(key, '', { allowed: active ? valid : null })
  return useSortOver(columns, active ? value : '', setValue)
}

/** A sort held by the component, for a table in a modal, which has no address of its own. */
export function useLocalTableSort(columns) {
  const [value, setValue] = useState('')
  return useSortOver(columns, value, setValue)
}

/** `[sortedRows, sort]` for a page table: useTableSort, with its rows sorted. */
export function useSortableRows(rows, columns, options) {
  const sort = useTableSort(columns, options)
  const sorted = useMemo(() => sort.apply(rows), [sort, rows])
  return [sorted, sort]
}

/** `[sortedRows, sort]` for a table in a modal: useLocalTableSort, with its rows sorted. */
export function useLocalSortableRows(rows, columns) {
  const sort = useLocalTableSort(columns)
  const sorted = useMemo(() => sort.apply(rows), [sort, rows])
  return [sorted, sort]
}
