import React from 'react'

/**
 * A button that states, while its action is running, that it is running. The label changes as well
 * as the spinner, so the accessible name changes too. Disabled while pending, as the last line of
 * the double-submit guard usePendingAction opens. `className` is passed in whole rather than
 * composed from variant props.
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
