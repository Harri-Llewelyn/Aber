import React from 'react'
import { ActionButton } from './ActionButton'

/** A count with its noun, as the foot says it: "1 run", "18,431 events". */
export function countWords(n, noun, plural = `${noun}s`) {
  return `${Number(n).toLocaleString('en-GB')} ${n === 1 ? noun : plural}`
}

/** A noun in Title Case, for the button: "machine identities" reads "Machine Identities". */
const titleCase = (words) => words.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

/**
 * The foot of a list that loads in steps, naming what it counts: **Show 30 More Runs** while rows
 * remain, "All 57 runs shown." once they are all loaded, nothing when the list is empty. Place it
 * after the list's scroller so it stays on screen. `shown` and `total` are row counts; the button
 * names the smaller of `step` and the rows left. `noun` is one row's word and `plural` the rows'
 * ("runs" unless given). `pending` marks the fetch in flight and disables the button. `counted` puts
 * "30 runs of 57 runs" before the button while rows remain; pass it only when `total` is exact.
 * `about` follows the total in both lines ("for 12 entities"). The words are the text, so a screen
 * reader hears what is shown.
 *
 * @example
 * <ListFoot shown={rows.length} total={count} step={30} noun="run" pending={loadingMore}
 *   onMore={() => setLimit(limit + 30)} />
 */
export function ListFoot({ shown, total, onMore, noun, plural = `${noun}s`, about, pending = false, step = 30, counted = false }) {
  if (!total) return null
  const more = shown < total
  const next = Math.min(step, total - shown)
  const after = about ? ` ${about}` : ''
  return (
    <div className="list-foot">
      {more && counted && (
        <span className="list-foot-end">{countWords(shown, noun, plural)} of {countWords(total, noun, plural)}{after}</span>
      )}
      {more ? (
        <ActionButton
          className="btn btn-ghost btn-sm"
          pending={pending}
          pendingLabel="Loading…"
          onClick={onMore}
        >
          Show {next.toLocaleString('en-GB')} More {titleCase(next === 1 ? noun : plural)}
        </ActionButton>
      ) : (
        <span className="list-foot-end">
          {total === 1 ? `${countWords(1, noun, plural)}${after} shown.` : `All ${countWords(total, noun, plural)}${after} shown.`}
        </span>
      )}
    </div>
  )
}
