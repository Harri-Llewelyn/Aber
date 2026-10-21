import React from 'react'
import { IconEye, IconEyeOff } from './Icons'
import { Tooltip } from './Tooltip'

/**
 * The button beside a password input that shows the text only while it is held down.
 *
 * Held rather than toggled so the password is never left visible: releasing, leaving the button,
 * losing focus or a cancelled touch all hide it again. Space and Enter hold it from the keyboard.
 */
export function HoldToReveal({ revealed, onChange }) {
  const show = () => onChange(true)
  const hide = () => onChange(false)
  return (
    <Tooltip text="Hold to show password">
      <button
        type="button"
        className="password-reveal"
        aria-label="Hold to show password"
        aria-pressed={revealed}
        onPointerDown={e => { e.preventDefault(); show() }}
        onPointerUp={hide}
        onPointerLeave={hide}
        onPointerCancel={hide}
        onBlur={hide}
        onContextMenu={e => e.preventDefault()}
        onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); show() } }}
        onKeyUp={e => { if (e.key === ' ' || e.key === 'Enter') hide() }}
      >
        {revealed ? <IconEyeOff size={15} /> : <IconEye size={15} />}
      </button>
    </Tooltip>
  )
}
