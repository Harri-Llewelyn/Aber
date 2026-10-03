import React from 'react'

/**
 * The header of a page's only card: the page's icon, title and one-sentence description, with the
 * card's actions beside them. It carries no count: a count belongs where it states what is loaded,
 * what a filter holds or how much work waits, not on a heading.
 *
 * Every page is one card, so this header is where the page says what it is, once. It renders the same `.card-header` the other cards use, so it stays a
 * non-shrinking child of `.card-fill` and the list beneath it scrolls on its own.
 *
 * @param {React.ReactNode} [icon] The page's glyph at size 15 -- the rail's own, so the two agree.
 *
 * @param {string} title The page's name, in the words the rail uses for it.
 *
 * @param {React.ReactNode} [description] One sentence, about 20 words. The detail goes in the
 * page's help file.
 *
 * @param {React.ReactNode} [note] A muted line under the description stating a fact about the
 * stack's current state, such as a setting's effect ("Raw telemetry is kept for 14 days."). Falsy
 * renders nothing.
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
 *     description="The parts of the site your cells are filed into, each with its own plan."
 * *     actions={<button className="btn btn-primary btn-sm">New Area</button>}
 *   />
 */
export function CardHeading({ icon, title, description, note, actions, id, level = 'h3' }) {
  const Title = level
  return (
    <div className="card-header card-heading">
      <Title className="section-title" id={id}>
        {icon}
        {title}
      </Title>
      {actions}
      {description && <p className="card-heading-description">{description}</p>}
      {note && <p className="card-heading-note">{note}</p>}
    </div>
  )
}
