import React from 'react'

/**
 * The "Clear filters (N)" button that ends a filter bar. Renders nothing when `count` is 0, so
 * put it last in the bar: it carries `margin-left: auto`, which keeps it at the right-hand end
 * whether or not the bar has wrapped. `count` is the number of controls that are off their
 * default, the lifecycle select included; `onClear` resets all of them.
 *
 * @example
 * <ClearFilters count={[query, state !== 'all', lifecycle !== 'active'].filter(Boolean).length}
 *   onClear={reset} />
 */
export function ClearFilters({ count, onClear }) {
  if (!count) return null
  return (
    <button type="button" className="btn btn-ghost btn-sm filter-bar-clear" onClick={onClear}>
      ✕ Clear filters ({count})
    </button>
  )
}
