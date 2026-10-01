import React from 'react'

/**
 * A spinner and "Loading {label}…" in the card, below the filter bar. Show it on the FIRST load
 * only; on a reload keep the rows on screen and mark the refresh quietly. It is padded like
 * EmptyState, so the card does not change height when loading resolves to empty.
 *
 * @example
 * {loading && !loaded ? <LoadingState label="cells" /> : <CellTable rows={rows} />}
 */
export function LoadingState({ label }) {
  return (
    <div className="loading-wrap" role="status">
      <span className="spinner" />
      Loading {label}…
    </div>
  )
}
