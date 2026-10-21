import React from 'react'
import { Tooltip } from './Tooltip'

/**
 * An icon-only button with its hover text in the shared tooltip (Tooltip.jsx), never a `title`.
 * `label` is its accessible name; `tip` is the bubble's text when it differs, such as a shorter word
 * or the key that does the same (which `aria-keyshortcuts` states for a screen reader). The bubble
 * repeats the name, so it is not also the button's description. `inactive` is `aria-disabled`,
 * not `disabled`, so a button pressed to its limit keeps focus; its click is dropped.
 */
export function TipButton({ label, tip = null, inactive = false, className = 'btn btn-ghost btn-icon', onClick, children, ...rest }) {
  return (
    <Tooltip text={tip || label} describe={false}>
      <button
        type="button"
        className={`${className}${inactive ? ' btn-disabled' : ''}`}
        aria-label={label}
        aria-disabled={inactive || undefined}
        onClick={(e) => { if (!inactive) onClick?.(e) }}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  )
}
