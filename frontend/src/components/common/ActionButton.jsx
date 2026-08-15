import React from 'react'

/**
 * A button that states, while its action is running, that it is running.
 *
 * WHY THE LABEL CHANGES RATHER THAN JUST THE SPINNER. A spinner beside an unchanged "Save" reads
 * as decoration next to a button that did nothing. "Saving…" is the part that answers the question
 * the operator is actually asking, and it is the part a screen reader gets -- swapping the text
 * changes the button's accessible name, which a spinner glyph never would.
 *
 * Disabled while pending, always: this is the last line of the double-submit guard that
 * usePendingAction opens (see the note there about the click-to-commit gap).
 *
 * `className` is passed in whole rather than composed from variant props, because these buttons
 * are already a zoo -- btn-primary, btn-ghost, btn-danger btn-danger-reveal, btn-sm, plus the
 * permission-gated `btn-disabled` some call sites add -- and reducing that to an enum here would
 * mean either losing a variant or inventing a name for each combination in use.
 */
export function ActionButton({
  pending = false,
  pendingLabel,
  className = 'btn btn-primary',
  disabled = false,
  children,
  ...rest
}) {
  return (
    <button
      className={`${className}${pending ? ' btn-loading' : ''}`}
      disabled={pending || disabled}
      // Announced to assistive tech as busy, so the state is not carried by the label alone.
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? (
        <>
          <span className="spinner spinner-sm" />
          {pendingLabel}
        </>
      ) : children}
    </button>
  )
}
