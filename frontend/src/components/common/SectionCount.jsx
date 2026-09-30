import React from 'react'

/**
 * The text a count pill shows: `shown / total` while only part of the rows are drawn, and a bare
 * total otherwise. `shown` absent, or `total` not a number, means "all of them".
 */
export const countLabel = (shown, total) => {
  if (typeof total !== 'number') return String(shown ?? total ?? 0)
  return shown != null && shown !== total ? `${shown} / ${total}` : String(total)
}

/**
 * The count pill on a card's title row. Place it directly after the title's HelpTip. It always
 * renders, 0 included, so a card's header does not change shape when its list empties.
 *
 * `total` is every row that exists (if unknown, `shown` is drawn alone). Pass `shown` while a filter is on, or while fewer rows are
 * loaded than exist, and the pill reads `shown / total`.
 *
 *   <SectionCount total={devices.length} shown={visible.length} />
 */
export function SectionCount({ total, shown }) {
  return <span className="section-count">{countLabel(shown, total)}</span>
}
