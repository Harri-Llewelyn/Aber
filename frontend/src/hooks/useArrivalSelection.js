import { useEffect, useRef } from 'react'

/**
 * Open the context drawer on the entity a cross-page navigation named.
 *
 * WHY THIS EXISTS. Every drill-down between pages -- a cell's gateway chip, a gateway's device chip,
 * a device's schema chip -- hands the target page an IDENTIFIER and switches tab. Until now the
 * target page put that identifier in its search box and stopped there, which left the operator on a
 * list of exactly one row that they then had to click. The click is the part that carries no
 * information: the navigation already said which entity was meant.
 *
 * SELECTION IS TRIGGERED BY IDENTIFIER EQUALITY, NEVER BY A SEARCH MATCH, and that distinction is
 * the whole safety of it. `match` compares the arriving term against a row's IDs with `===`;
 * the pages' own search predicates use `includes` across names and ids alike. So typing "Mill" into
 * the search box narrows the table to two rows and opens nothing, while arriving with
 * `dev220000000000400080000` opens that device -- because only one of those two is somebody having
 * already chosen.
 *
 * REMEMBERS WHAT IT LAST ACTED ON, so closing the drawer is permanent. Without that, the effect
 * re-runs on every poll -- `rows` is a fresh array each refresh -- and re-opens the panel the
 * operator just dismissed, roughly every three seconds. The memory is keyed on the TERM rather than
 * being a plain boolean, so a second navigation to a different entity still opens.
 *
 * @param {string}   term     The arriving identifier: a search filter, a URL parameter, or a prop.
 * @param {Array}    rows     The page's loaded entities. Usually empty on first render -- the effect
 *                            re-runs when they arrive, which is why this is a hook and not a
 *                            one-shot read in the tab's initial state.
 * @param {Function} match    (row, term) => boolean. Identifier equality only.
 * @param {Function} onArrive Called once with the matched row.
 */
export function useArrivalSelection(term, rows, match, onArrive) {
  // Refs rather than deps: `match` and `onArrive` are almost always inline arrows, so listing them
  // would re-run this on every render and defeat the `handled` guard below.
  const matchRef = useRef(match)
  const arriveRef = useRef(onArrive)
  matchRef.current = match
  arriveRef.current = onArrive

  const handled = useRef(null)

  useEffect(() => {
    const value = typeof term === 'string' ? term.trim() : ''
    if (!value) {
      // Cleared filter, cleared memory: navigating away and back to the same entity should open it
      // again. This is the only thing that resets it.
      handled.current = null
      return
    }
    if (handled.current === value) return

    const hit = (rows || []).find((row) => {
      try {
        return Boolean(matchRef.current(row, value))
      } catch {
        // A malformed row must not take the page down over a convenience.
        return false
      }
    })
    if (!hit) return

    handled.current = value
    arriveRef.current?.(hit)
  }, [term, rows])
}
