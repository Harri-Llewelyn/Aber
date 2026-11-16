import React from 'react'

/**
 * Under a number chart: its lowest and highest, with the bucket each was in, and its mean and median
 * over time (numberKey(), utils/history.js), in the text key's place and style. `entries` are
 * numberKey()'s. Pointing at an entry calls `onMark` with its `mark` (what the chart marks: a
 * point, or a level), and on leaving with null. The words say all of it, so nothing is reachable by
 * hover alone.
 *
 *   <NumberKey entries={numberKey(numberFigures(series, starts, { now }), starts, 5, 'KILOWATT')} onMark={setMark} />
 */
export function NumberKey({ entries, onMark = null }) {
  return (
    <ul className="chart-state-key chart-number-key">
      {entries.map(e => (
        <li
          key={e.id}
          className="chart-number-key-entry"
          onMouseEnter={() => onMark?.(e.mark)}
          onMouseLeave={() => onMark?.(null)}
        >
          <span className="chart-number-key-label">{e.label}</span>
          <span className="chart-number-key-value">{e.value}</span>
          <span className="chart-number-key-when">{e.when}</span>
        </li>
      ))}
    </ul>
  )
}
