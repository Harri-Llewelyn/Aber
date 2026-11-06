import React from 'react'
import { Tooltip } from './Tooltip'

/**
 * The asterisk after the label of a field that must be filled in, with the convention on hover.
 * App.css draws the asterisk, so the label's text, which names the control, stays the field's
 * name. Hidden from a screen reader, which hears `aria-required` on the control instead: put both.
 */
export function RequiredMark({ title = 'Required' }) {
  return (
    <Tooltip text={title}>
      <span className="required-mark" aria-hidden="true" />
    </Tooltip>
  )
}
