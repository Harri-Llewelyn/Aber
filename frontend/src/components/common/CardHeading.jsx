import React from 'react'

/**
 * The header of a page's only card: the page's icon, title and one-sentence description, with the
 * count and the card's actions beside them.
 *
 * A page with one card has no PageHeading above it, so this header is where the page says what it
 * is, once. A page with several cards opens with a PageHeading instead and its cards keep their
 * title HelpTips. It renders the same `.card-header` the other cards use, so it stays a
 * non-shrinking child of `.card-fill` and the list beneath it scrolls on its own.
 *
 * @param {React.ReactNode} [icon] The page's glyph at size 15 -- the rail's own, so the two agree.
 *
 * @param {string} title The page's name, in the words the rail uses for it.
 *
 * @param {React.ReactNode} [description] One sentence, about 20 words. The detail goes in the
 * page's help file.
 *
 * @param {React.ReactNode} [count] A `SectionCount`, drawn after the title.
 *
 * @param {React.ReactNode} [actions] The primary button, Export, or a legend, on the right.
 *
 * @param {string} [id] An id for the title, for a region to name itself by.
 *
 * @param {'h2'|'h3'} [level] The title's heading level. Defaults to h3, as the cards' titles are.
 *
 *   <CardHeading
 *     icon={<IconFactory size={15} />}
 *     title="Areas"
 *     description="The parts of the campus your cells are filed into, each with its floor plan."
 *     count={<SectionCount total={areas.length} />}
 *     actions={<button className="btn btn-primary btn-sm">New Area</button>}
 *   />
 */
export function CardHeading({ icon, title, description, count, actions, id, level = 'h3' }) {
  const Title = level
  return (
    <div className="card-header card-heading">
      <Title className="section-title" id={id}>
        {icon}
        {title}
        {count}
      </Title>
      {actions}
      {description && <p className="card-heading-description">{description}</p>}
    </div>
  )
}
