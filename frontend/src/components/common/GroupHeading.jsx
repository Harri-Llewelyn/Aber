import React from 'react'
import { IconChevronDown, IconChevronUp } from './Icons'

/**
 * The heading of a group of rows that opens and closes: a disclosure button with a chevron, an
 * optional icon, the group's name and how many rows it holds ("Devices · 12"). It names the element
 * it opens in `controls`, which the page hides while `open` is false. The page lays out the row
 * the button sits in and keeps which groups are open; the button only reports a press.
 *
 * @param {boolean} open Whether the group's rows are shown.
 * @param {Function} onToggle Called on a press, to open a closed group or close an open one.
 * @param {string} label The group's name.
 * @param {number} [count] How many rows the group holds, drawn after the name.
 * @param {string} [countLabel] The count as a screen reader hears it ("12 lanes"); the number alone
 *   without it.
 * @param {node} [icon] Drawn before the name. Decorative: hidden from assistive technology.
 * @param {string} [controls] The id of the element holding the rows.
 * @param {string} [className] Extra classes on the button.
 *
 *   <GroupHeading open={open} onToggle={toggle} label="Devices" count={12} countLabel="12 lanes"
 *     icon={<IconCpu size={12} />} controls="devices-rows" />
 */
export function GroupHeading({ open, onToggle, label, count, countLabel, icon = null, controls, className = '' }) {
  const Chevron = open ? IconChevronUp : IconChevronDown
  return (
    <button
      type="button"
      className={`table-group-button group-heading${className ? ` ${className}` : ''}`}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <Chevron size={12} className="group-heading-chevron" aria-hidden="true" />
      {icon && <span className="group-heading-icon" aria-hidden="true">{icon}</span>}
      <span className="table-group-label group-heading-label">{label}</span>
      {count !== undefined && count !== null && (
        <span className="group-heading-count">
          <span aria-hidden="true">· {count}</span>
          <span className="sr-only">, {countLabel || count}</span>
        </span>
      )}
    </button>
  )
}
