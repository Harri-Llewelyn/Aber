import React, { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconHelp } from './Icons'

const BUBBLE_WIDTH = 320
const GAP = 6

/**
 * A "?" beside a label whose explanation is read on demand rather than on every visit.
 *
 * The bubble shows on hover and on keyboard focus; a click pins it, which is the only route on a
 * touch screen. It is portalled to <body> with a fixed position because most labels sit inside a
 * `.card`, whose overflow is hidden, and scrolling or resizing closes it rather than tracking the
 * trigger. `role="tooltip"` and `aria-describedby` tie the text to the button for screen readers.
 */
export function HelpTip({ text, label = 'More information', size = 13, className = '' }) {
  const id = useId()
  const ref = useRef(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState(null)
  const visible = hovered || focused || pinned

  useLayoutEffect(() => {
    if (!visible || !ref.current) { setPos(null); return }
    const r = ref.current.getBoundingClientRect()
    const flip = r.bottom + GAP + 160 > window.innerHeight && r.top > window.innerHeight / 2
    const left = Math.max(8, Math.min(r.left, window.innerWidth - BUBBLE_WIDTH - 8))
    setPos(flip
      ? { left, bottom: window.innerHeight - r.top + GAP }
      : { left, top: r.bottom + GAP })
    const close = () => { setHovered(false); setFocused(false); setPinned(false) }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [visible])

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`help-tip${pinned ? ' help-tip-pinned' : ''} ${className}`.trim()}
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
      {visible && pos && createPortal(
        <span role="tooltip" id={id} className="help-tip-bubble" style={{ ...pos, maxWidth: BUBBLE_WIDTH }}>
          {text}
        </span>,
        document.body
      )}
    </>
  )
}
