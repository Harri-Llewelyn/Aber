import React from 'react'

/**
 * A page's own title and description, above its cards rather than inside one.
 *
 * A card header speaks for the list beneath it and nothing else, so a page built from more than one
 * card has nowhere to say what the whole page is for. Access Control carried the first of these as
 * two inline blocks; this is that shape, in one place, so the pages that share it cannot drift.
 *
 * Not a card: it states the subject rather than holding content, and a frame around a sentence
 * reads as one more thing to act on.
 *
 * @param {React.ReactNode} icon The page's glyph, already sized -- the nav's own, so the rail and
 * the page agree. Optional.
 *
 * @param {string} title The page's name, in the words the rail uses for it.
 *
 * @param {React.ReactNode} children The description. One or two sentences: what this page is, and
 * whatever about it is surprising enough to say before the first row.
 */
export function PageHeading({ icon, title, children }) {
  return (
    <div className="page-heading">
      <h2 className="section-title">
        {icon}
        {title}
      </h2>
      {children && <p>{children}</p>}
    </div>
  )
}
