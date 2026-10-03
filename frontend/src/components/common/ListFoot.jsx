import React from 'react'
import { ActionButton } from './ActionButton'

/**
 * The foot of a list that loads in steps: "Show 30 more" while rows remain, "All 57 shown." once
 * they are all loaded, nothing when the list is empty. Place it after the list's scroller so it
 * stays on screen. `shown` and `total` are row counts; the button names the smaller of `step` and
 * the rows left. `pending` marks the fetch in flight and disables the button. `counted` puts
 * "30 of 57" before the button while rows remain; pass it only when `total` is exact.
 *
 * @example
 * <ListFoot shown={rows.length} total={count} step={30} pending={loadingMore}
 *   onMore={() => setLimit(limit + 30)} />
 */
export function ListFoot({ shown, total, onMore, pending = false, step = 30, counted = false }) {
  if (!total) return null
  const more = shown < total
  return (
    <div className="list-foot">
      {more && counted && <span className="list-foot-end">{shown} of {total}</span>}
      {more ? (
        <ActionButton
          className="btn btn-ghost btn-sm"
          pending={pending}
          pendingLabel="Loading…"
          onClick={onMore}
        >
          Show {Math.min(step, total - shown)} more
        </ActionButton>
      ) : (
        <span className="list-foot-end">All {total} shown.</span>
      )}
    </div>
  )
}
