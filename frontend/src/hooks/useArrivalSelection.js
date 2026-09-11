import { useEffect, useRef } from 'react'

/**
 * Open the context drawer on the entity a cross-page navigation named. Selection is triggered by
 * identifier equality, never by a search match: `match` compares with `===`, while the pages'
 * search predicates use `includes`. Remembers the term it last acted on, so closing the drawer is
 * permanent across polls and a navigation to a different entity still opens.
 *
 * @param {string} term The arriving identifier: a search filter, a URL parameter, or a prop.
 *
 * @param {Array} rows The page's loaded entities; usually empty on first render, so the effect
 * re-runs when they arrive.
 *
 * @param {Function} match (row, term) => boolean. Identifier equality only.
 *
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
