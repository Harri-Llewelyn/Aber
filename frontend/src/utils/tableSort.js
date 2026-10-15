import { TONE_CLASS } from '../components/common/Badge'

/*
 * Sorting a table by one of its columns, in the browser. A column says what its cells mean, and the
 * comparison follows the meaning rather than the text a cell shows:
 *
 * - `text`: natural order, blind to case and accents, so "Line 10" comes after "Line 9".
 * - `number`: by size.
 * - `time`: by instant. Takes an ISO string, a Date or epoch milliseconds.
 * - `rank`: by a number the column works out, lowest first. A status column ranks by severity
 *   (`severityRank`), so ascending puts what needs attention at the top.
 *
 * An empty value (null, '', a time that does not parse) goes last in either direction. Rows that
 * compare equal keep the order they arrived in, which is the table's default order, so a reversed
 * sort reverses the column and not the ties.
 *
 * A sort is held as text, as the address carries it: the column's id for ascending, with a leading
 * `-` for descending (`-last_heartbeat`). '' is the table's default order.
 */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const finite = (n) => (Number.isFinite(n) ? n : null)

/** Each type's sort key for a cell's value, or null when the cell is empty. */
const KEYS = {
  text: (v) => {
    const s = v === null || v === undefined ? '' : String(v).trim()
    return s === '' ? null : s
  },
  number: (v) => (v === null || v === undefined || v === '' ? null : finite(Number(v))),
  time: (v) => {
    if (v === null || v === undefined || v === '') return null
    if (v instanceof Date) return finite(v.getTime())
    return finite(typeof v === 'number' ? v : Date.parse(v))
  }
}
KEYS.rank = KEYS.number

const COMPARE = {
  text: collator.compare,
  number: (a, b) => a - b,
  time: (a, b) => a - b,
  rank: (a, b) => a - b
}

/** The column and direction a sort names, or null for the default order or a column not offered. */
export function parseSort(value, columns) {
  const text = String(value || '')
  const descending = text.startsWith('-')
  const column = descending ? text.slice(1) : text
  return column && Object.hasOwn(columns, column) ? { column, descending } : null
}

/**
 * The sort a click on `column`'s header makes: ascending first, then descending, then the table's
 * default order.
 */
export function nextSort(current, column) {
  if (!current || current.column !== column) return column
  return current.descending ? '' : `-${column}`
}

/**
 * `rows` in the order `sort` names (a parseSort result), or `rows` itself for the default order.
 * Never sorts in place.
 *
 * @param {Array} rows
 *
 * @param {Object<string, {type: 'text'|'number'|'time'|'rank', value: Function}>} columns Each
 * sortable column by id: its type, and `value(row)`, the value it sorts on.
 *
 * @param {{column: string, descending: boolean}|null} sort
 */
export function sortRows(rows, columns, sort) {
  const spec = sort && columns[sort.column]
  if (!spec || !Array.isArray(rows)) return rows
  const key = KEYS[spec.type]
  const compare = COMPARE[spec.type]
  if (!key) throw new Error(`Unknown sort type "${spec.type}" for column "${sort.column}"`)
  const sign = sort.descending ? -1 : 1
  return rows
    .map((row, index) => ({ row, index, key: key(spec.value(row)) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) {
        if (a.key === b.key) return a.index - b.index
        return a.key === null ? 1 : -1
      }
      return sign * compare(a.key, b.key) || a.index - b.index
    })
    .map(entry => entry.row)
}

/*
 * Severity by a Badge tone, most severe first: red, amber, waiting on a person, waiting on a
 * machine, unknown, inert, informational, healthy. Ranked by the class a tone draws as, so the
 * aliases the `*Tone` helpers return (`critical`, `offline`, `ok`) rank with the colour they show.
 */
const CLASS_RANK = [
  'badge-danger',
  'badge-warning',
  'badge-pending',
  'badge-provisioned',
  'badge-unknown',
  'badge-neutral',
  'badge-info',
  'badge-brand',
  'badge-success'
]

/** A Badge tone's severity rank for a `rank` column: 0 is the most severe. */
export function severityRank(tone) {
  const rank = CLASS_RANK.indexOf(TONE_CLASS[tone] || 'badge-neutral')
  return rank < 0 ? CLASS_RANK.indexOf('badge-neutral') : rank
}

/** A value's place in `order`, for a `rank` column with a fixed order; a value not listed is empty. */
export function rankIn(order, value) {
  const at = order.indexOf(value)
  return at < 0 ? null : at
}
