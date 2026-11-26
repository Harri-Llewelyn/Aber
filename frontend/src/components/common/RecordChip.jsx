import React from 'react'
import { ENTITY_PAGES, KIND_ICONS } from '../../utils/entityPages'
import { OverflowText } from './OverflowText'
import { RouteLink } from './RouteLink'
import { Tooltip } from './Tooltip'

/**
 * A record chip's tooltip: where the record opens, then `note`, a sentence of its own with its stop
 * (a device's state or alert, why a cell may be dragged), when there is one.
 */
export const recordChipTitle = (name, page, note) => `Open ${name} on the ${page} page${note ? `. ${note}` : ''}`

/** The flags a chip carries after its name, as `{ text, tone }`: one, several, or a bare word. */
const flagsOf = (flag) => [].concat(flag ?? []).filter(Boolean).map(f => (typeof f === 'string' ? { text: f } : f))

/**
 * A record that another one names, as a chip that opens it: in a drawer's field, a Site Map panel, a
 * table's cell. A status `dot` (its style, as `deviceDotStyle()` gives it), the kind's icon, the name
 * as an OverflowText, and each `flag` after it: a word, or `{ text, tone }` with `tone` one of
 * warning, danger, muted or accent, never the colour alone. `children` follow the flags.
 *
 * With `to` it is a link (RouteLink: a plain click navigates in place, `onNavigate` instead where the
 * page passes one), and its tooltip is recordChipTitle(): "Open {name} on the {page} page", then
 * `note`. `kind` is the record's kind as KIND_ICONS and ENTITY_PAGES name it, which give the icon and
 * the page; `icon` replaces the kind's (a cell's or an area's own), and null draws none. A gateway's
 * chip keeps its tinted border.
 *
 * Without `to` it is a button that acts on this page, its tooltip `title`: the Site Map's cell chip,
 * which opens the cell's panel, the Audit Trail's Changed by, which clears its filter, and the "N more"
 * that shows the rest of a list of chips.
 *
 *   <RecordChip kind="devices" to={deviceUrl(d.asset_id)} name={d.asset_name} dot={deviceDotStyle(d, alert)} />
 */
export function RecordChip({
  kind, to, name, page, note, title, icon, dot, flag, selected = false, className = '', children, ...rest
}) {
  const Icon = KIND_ICONS[kind]
  const glyph = icon === undefined ? (Icon ? <Icon size={11} /> : null) : icon
  const classes = `chip chip-link${kind === 'gateways' ? ' chip-gw' : ''}${selected ? ' is-selected' : ''}${className ? ` ${className}` : ''}`
  const body = (
    <>
      {dot && <span className="badge-dot" style={dot} aria-hidden="true" />}
      {glyph}
      <OverflowText className="chip-name">{name}</OverflowText>
      {flagsOf(flag).map(f => (
        <span key={f.text} className={`chip-flag${f.tone ? ` chip-flag-${f.tone}` : ''}`}>{f.text}</span>
      ))}
      {children}
    </>
  )
  if (to) {
    return (
      <RouteLink className={classes} to={to} title={title ?? recordChipTitle(name, page ?? ENTITY_PAGES[kind]?.page, note)} {...rest}>
        {body}
      </RouteLink>
    )
  }
  return (
    <Tooltip text={title}>
      <button type="button" className={classes} {...rest}>{body}</button>
    </Tooltip>
  )
}
