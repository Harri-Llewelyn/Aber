import React, { useEffect, useRef } from 'react'

/** How fast cut text slides towards its end, in pixels a second: about reading pace. */
export const SLIDE_PX_PER_SECOND = 60
/** The shortest slide, so a few hidden pixels do not jump. */
const SLIDE_MIN_MS = 300
/** How long the text takes to slide back once the pointer or focus has gone. */
const RETURN_MS = 250

/**
 * One line of text that may not fit: cut with an ellipsis at rest. While the pointer is on it, or
 * on the control it sits in, or that control has keyboard focus, text that is really cut slides
 * until its end is in view and holds there; it slides back when they leave. It never moves by
 * itself, and under reduced motion it does not move at all, so the control's tooltip must carry
 * the whole text. The whole text is always in the DOM, so a screen reader hears all of it.
 *
 * The control is the nearest button, link or focusable element around it; without one, the text
 * reacts to the pointer alone. Measured as it activates (`scrollWidth` against `clientWidth`), so
 * a drawer opening or the window narrowing needs no listener.
 *
 *   <button type="button" onClick={open}><OverflowText className="trail-lane-name">{name}</OverflowText></button>
 */
export function OverflowText({ children, className = '' }) {
  const outer = useRef(null)

  useEffect(() => {
    const el = outer.current
    if (!el) return undefined
    const host = el.parentElement?.closest('button, a, [tabindex]') || el
    let hovered = false
    let focused = false
    let settle = null

    const still = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches

    const update = () => {
      clearTimeout(settle)
      const shift = el.scrollWidth - el.clientWidth
      if ((hovered || focused) && shift > 0 && !still()) {
        el.style.setProperty('--overflow-ms', `${Math.max(SLIDE_MIN_MS, Math.round((shift / SLIDE_PX_PER_SECOND) * 1000))}ms`)
        el.style.setProperty('--overflow-shift', `${-shift}px`)
        el.classList.add('overflow-text-sliding')
      } else if (el.classList.contains('overflow-text-sliding')) {
        // Back to the start, and the ellipsis only once there, so it never cuts the moving text.
        el.style.setProperty('--overflow-ms', `${RETURN_MS}ms`)
        el.style.setProperty('--overflow-shift', '0px')
        settle = setTimeout(() => el.classList.remove('overflow-text-sliding'), RETURN_MS)
      }
    }

    // Keyboard focus only: a click's focus would hold the text slid after the pointer has gone.
    const keyboardFocus = () => {
      try { return host.matches(':focus-visible') } catch { return true }
    }
    const onEnter = () => { hovered = true; update() }
    const onLeave = () => { hovered = false; update() }
    const onFocus = () => { focused = keyboardFocus(); update() }
    const onBlur = () => { focused = false; update() }

    host.addEventListener('mouseenter', onEnter)
    host.addEventListener('mouseleave', onLeave)
    host.addEventListener('focusin', onFocus)
    host.addEventListener('focusout', onBlur)
    return () => {
      clearTimeout(settle)
      host.removeEventListener('mouseenter', onEnter)
      host.removeEventListener('mouseleave', onLeave)
      host.removeEventListener('focusin', onFocus)
      host.removeEventListener('focusout', onBlur)
    }
  }, [])

  return (
    <span ref={outer} className={`overflow-text${className ? ` ${className}` : ''}`}>
      <span className="overflow-text-inner">{children}</span>
    </span>
  )
}
