import React, { useState } from 'react'
import { IconChevronDown, IconChevronUp } from './Icons'
import { OverflowText } from './OverflowText'
import { Tooltip } from './Tooltip'

/**
 * The heading of a group of rows that opens and closes: a disclosure button with a chevron, an
 * optional icon, the group's name and how many rows it holds ("Devices · 12"). It names the element
 * it opens in `controls`, which the page hides while `open` is false. The page lays out the row
 * the button sits in and keeps which groups are open (`hooks/useOpenGroups.js` for a list whose
 * groups start closed); the button only reports a press.
 *
 * @param {boolean} open Whether the group's rows are shown.
 * @param {Function} onToggle Called on a press, to open a closed group or close an open one.
 * @param {string} label The group's name. Cut, it slides on hover or focus, and while it is cut the
 *   tooltip carries it whole, with `detail`.
 * @param {number} [count] How many rows the group holds, drawn after the name.
 * @param {string} [countLabel] The count as a screen reader hears it ("12 lanes"); the number alone
 *   without it.
 * @param {string} [detail] Words drawn after the name, and after the count where there is one: what a
 *   filter list has chosen ("Entity · 2 chosen"), a group's one fact ("Gateways · 81 · last deleted 25
 *   Nov"). Cut before the name is, and slides on hover or focus. While it is cut, the button's tooltip
 *   carries it whole, since reduced motion stops the slide.
 * @param {string} [title] The button's tooltip, for what the name does not say. A cut `detail` comes
 *   before it.
 * @param {boolean} [muted] Draws the name in the secondary colour: a group that is a remainder, such as
 *   Ungrouped.
 * @param {node} [icon] Drawn before the name. Decorative: hidden from assistive technology.
 * @param {string} [controls] The id of the element holding the rows.
 * @param {string} [className] Extra classes on the button.
 *
 *   <GroupHeading open={open} onToggle={toggle} label="Devices" count={12} countLabel="12 lanes"
 *     icon={<IconCpu size={12} />} controls="devices-rows" />
 */
export function GroupHeading({ open, onToggle, label, count, countLabel, detail, title = null, muted = false, icon = null, controls, className = '' }) {
  const Chevron = open ? IconChevronUp : IconChevronDown
  // Whether `detail` and the name were cut when OverflowText last measured them, as the pointer or
  // focus arrived.
  const [cut, setCut] = useState(false)
  const [nameCut, setNameCut] = useState(false)
  const whole = nameCut ? [label, detail].filter(Boolean).join(' · ') : detail && cut ? detail : null
  return (
    // The cut words are no description: the sr-only words below already give a screen reader the whole value.
    <Tooltip text={whole || title} describe={!whole}>
      <button
        type="button"
        className={`table-group-button group-heading${className ? ` ${className}` : ''}`}
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
      >
        <Chevron size={12} className="group-heading-chevron" aria-hidden="true" />
        {icon && <span className="group-heading-icon" aria-hidden="true">{icon}</span>}
        <OverflowText className={`table-group-label group-heading-label${muted ? ' table-group-label-muted' : ''}`} onMeasure={setNameCut}>{label}</OverflowText>
        {count !== undefined && count !== null && (
          <span className="group-heading-count">
            <span aria-hidden="true">· {count}</span>
            <span className="sr-only">, {countLabel || count}</span>
          </span>
        )}
        {detail && (
          <span className="group-heading-count group-heading-detail">
            <span className="group-heading-detail-shown" aria-hidden="true">
              <OverflowText onMeasure={setCut}>· {detail}</OverflowText>
            </span>
            <span className="sr-only">, {detail}</span>
          </span>
        )}
      </button>
    </Tooltip>
  )
}
