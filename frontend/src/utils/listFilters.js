/**
 * The meaning every list filter shares: OR within one filter, AND across filters, and nothing chosen
 * is no constraint. A page describes each of its list filters as a facet, the values it has chosen
 * and the values a row has, and gets back the rows and each value's count in one pass.
 */

/** Whether a row with `rowValues` passes a filter that has chosen `chosen`: nothing chosen passes all. */
export function matchesAny(chosen, rowValues) {
  if (!chosen || chosen.length === 0) return true
  return (rowValues || []).some(v => chosen.includes(v))
}

/**
 * The rows every facet and `pass` let through, and for each facet the count of each value among the
 * rows the OTHER filters let through, so a count says what choosing that value would add.
 *
 * @param {Array} rows
 * @param {Array<{key: string, chosen: Array<string>, values: function(*): Array<string>}>} facets
 * `values(row)` lists the values a row has for that filter; a row may have several, or none.
 * @param {function(*): boolean} [pass] The page's other filters: search, toggles.
 * @returns {{rows: Array, counts: Object<string, Map<string, number>>}}
 */
export function applyFacets(rows, facets, pass = () => true) {
  const counts = Object.fromEntries(facets.map(f => [f.key, new Map()]))
  const shown = []
  for (const row of rows || []) {
    if (!pass(row)) continue
    const values = facets.map(f => [...new Set(f.values(row) || [])])
    const ok = facets.map((f, i) => matchesAny(f.chosen, values[i]))
    const failing = ok.filter(o => !o).length
    if (failing === 0) shown.push(row)
    facets.forEach((f, i) => {
      // Counted when every other facet passes: this one's own choice does not hide its values.
      if (failing === 0 || (failing === 1 && !ok[i])) {
        const tally = counts[f.key]
        for (const v of values[i]) tally.set(v, (tally.get(v) || 0) + 1)
      }
    })
  }
  return { rows: shown, counts }
}

/**
 * Lifecycle, the same on every page that hides archived rows: Active and Archived, opening on Active.
 * A link from before reads `lifecycle=all` as both. Nothing chosen and both chosen each show
 * everything.
 */
export const LIFECYCLE_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
]
export const LIFECYCLE_DEFAULT = Object.freeze(['active'])
export const LIFECYCLE_ALIASES = Object.freeze({ all: ['active', 'archived'] })
export const LIFECYCLE_VALUES = LIFECYCLE_OPTIONS.map(o => o.value)

/** A row's lifecycle value, from its `is_archived`. */
export const lifecycleOf = (row) => [row?.is_archived ? 'archived' : 'active']

/** Whether a lifecycle choice differs from the page's default, which Clear filters counts. */
export const lifecycleChanged = (chosen) =>
  !(chosen.length === LIFECYCLE_DEFAULT.length && chosen.every(v => LIFECYCLE_DEFAULT.includes(v)))
