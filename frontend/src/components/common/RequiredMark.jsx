import React from 'react'
import { Tooltip } from './Tooltip'

/**
 * The asterisk after the label of a field that must be filled in, with the convention on hover.
 * Hidden from a screen reader, which hears `aria-required` on the control instead: put both on.
 */
export function RequiredMark({ title = 'Required' }) {
  return (
    <Tooltip text={title}>
      <span className="required-mark" aria-hidden="true">*</span>
    </Tooltip>
  )
}
