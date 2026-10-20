import React, { useId, useRef, useState } from 'react'
import { IconHelp } from './Icons'
import { TooltipBubble, useTooltipPosition } from './Tooltip'

/**
 * A "?" beside a label whose explanation is read on demand rather than on every visit.
 *
 * The bubble (the shared TooltipBubble) shows on hover and on keyboard focus; a click pins it, which
 * is the only route on a touch screen. Scrolling or resizing closes it rather than tracking the
 * trigger. `role="tooltip"` and `aria-describedby` tie the text to the button for screen readers.
 */
export function HelpTip({ text, label = 'More information', size = 13 }) {
  const id = useId()
  const ref = useRef(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const visible = hovered || focused || pinned
  const { pos, container } = useTooltipPosition(ref, visible, () => {
    setHovered(false); setFocused(false); setPinned(false)
  })

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`help-tip${pinned ? ' help-tip-pinned' : ''}`}
        aria-label={label}
        aria-describedby={visible ? id : undefined}
        aria-expanded={pinned}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); setPinned(false) }}
        onClick={() => setPinned(v => !v)}
        onKeyDown={e => { if (e.key === 'Escape') { setPinned(false); setFocused(false) } }}
      >
        <IconHelp size={size} />
      </button>
      <TooltipBubble id={id} text={text} pos={visible ? pos : null} container={container} />
    </>
  )
}
