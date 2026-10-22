import React from 'react'
import { Tooltip } from './Tooltip'

/**
 * A button that states, while its action is running, that it is running. The label changes as well
 * as the spinner, so the accessible name changes too. Disabled while pending, as the last line of
 * the double-submit guard usePendingAction opens. `className` is passed in whole rather than
 * composed from variant props.
 *
 * `permitted` is for a button the signed-in role may not use: `permitted={false}` disables it,
 * adds `btn-disabled`, shows `deniedTitle` as its tooltip and never calls `onClick`. It replaces
 * the `btn-disabled` + `disabled` + `can && fn` triple. `title` is its tooltip otherwise: the
 * shared one (Tooltip.jsx), for what the label does not say, such as why it is disabled.
 *
 * @example
 * <ActionButton permitted={canEdit} deniedTitle="Only admins can archive a cell."
 *   pending={busy} pendingLabel="Archiving…" onClick={archive}>Archive</ActionButton>
 */
export function ActionButton({
  pending = false,
  pendingLabel,
  className = 'btn btn-primary',
  disabled = false,
  permitted = true,
  deniedTitle,
  onClick,
  title,
  children,
  ...rest
}) {
  const denied = permitted === false
  return (
    <Tooltip text={denied ? deniedTitle : title}>
      <button
        className={`${className}${denied ? ' btn-disabled' : ''}${pending ? ' btn-loading' : ''}`}
        disabled={pending || disabled || denied}
        onClick={denied ? undefined : onClick}
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
    </Tooltip>
  )
}
