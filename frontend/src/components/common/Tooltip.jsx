import React, { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useHoverIntent } from '../../hooks/useHoverIntent'
import { useEscapeKey } from '../../hooks/useEscapeKey'

export const TOOLTIP_WIDTH = 320
const GAP = 6

/** How long the pointer rests on a control before its tooltip shows. Crossing a tab bar takes less. */
export const TOOLTIP_DELAY_MS = 300

/**
 * The element a trigger's bubble is portalled into: the open dialog the trigger sits in, else
 * <body>. A dialog opened with showModal() is in the top layer, which draws everything outside it
 * beneath its backdrop. Only the topmost dialog can be reached, so for any trigger a person can
 * point at this is the element Modal's `overlayHost()` names; it is read from the trigger rather
 * than from the first `dialog[open]`, which under a confirmation is the dialog beneath.
 */
export const tooltipHost = (trigger) => trigger?.closest?.('dialog[open]') ?? document.body

/**
 * Where a tooltip's bubble goes while `visible`: below the trigger, or above it when the trigger is
 * low in the window, and never past the window's sides, inside `tooltipHost(trigger)`. Null while
 * hidden. A scroll or a resize calls `onDismiss` rather than tracking the trigger.
 *
 * @returns {{ pos: object|null, container: Element|null }}
 */
export function useTooltipPosition(triggerRef, visible, onDismiss) {
  const [placed, setPlaced] = useState({ pos: null, container: null })
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    if (!visible || !trigger) { setPlaced({ pos: null, container: null }); return }
    const r = trigger.getBoundingClientRect()
    const flip = r.bottom + GAP + 160 > window.innerHeight && r.top > window.innerHeight / 2
    const left = Math.max(8, Math.min(r.left, window.innerWidth - TOOLTIP_WIDTH - 8))
    setPlaced({
      pos: flip ? { left, bottom: window.innerHeight - r.top + GAP } : { left, top: r.bottom + GAP },
      container: tooltipHost(trigger),
    })
    const close = () => dismiss.current?.()
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [visible, triggerRef])

  return placed
}

/**
 * The one tooltip bubble, which HelpTip and the tab bar's tabs both draw, so the two always look
 * alike. Portalled with a fixed position into `container` (`tooltipHost`), because most triggers
 * sit inside a `.card`, whose overflow is hidden, and an open dialog covers <body>. `role="tooltip"`;
 * the trigger names it by `id` in `aria-describedby`.
 *
 * Drawn only while `pos` is set, unless `keepMounted`: then it is in the document, hidden, while
 * closed, so a trigger whose `aria-describedby` is always set names an element that exists.
 */
export function TooltipBubble({ id, text, pos, container = null, keepMounted = false }) {
  if (!pos && !keepMounted) return null
  return createPortal(
    <span
      role="tooltip"
      id={id}
      className="tooltip-bubble"
      hidden={!pos}
      style={pos ? { ...pos, maxWidth: TOOLTIP_WIDTH } : undefined}
    >
      {text}
    </span>,
    container || document.body
  )
}

/**
 * A tooltip on a control that does something else when pressed, such as a tab (WAI-ARIA tooltip
 * pattern). It shows once the pointer rests on the control (`delay`), and at once on keyboard
 * focus. Escape, blur, the pointer leaving, a press, a scroll and a resize close it. Escape is taken
 * from the shared stack, so it closes the tooltip before a drawer behind it.
 *
 * A press's focus is not keyboard focus, and neither is the focus the browser hands back to the
 * control as its window is activated again: that one leaves the tooltip as it was when the window
 * lost focus.
 *
 * Spread `trigger` onto the control, and pass `bubble` to TooltipBubble.
 */
export function useTooltip({ delay = TOOLTIP_DELAY_MS } = {}) {
  const id = useId()
  const ref = useRef(null)
  const hover = useHoverIntent(delay)
  const [focused, setFocused] = useState(false)
  const pressed = useRef(false)
  // What `focused` was when the window lost focus from this control; null otherwise.
  const focusedAsWindowLeft = useRef(null)
  const visible = hover.open || focused

  const { hide: hideHover } = hover
  const hide = useCallback(() => { hideHover(); setFocused(false) }, [hideHover])
  const { pos, container } = useTooltipPosition(ref, visible, hide)
  useEscapeKey(hide, visible)

  const trigger = {
    ref,
    'aria-describedby': id,
    onMouseEnter: hover.onMouseEnter,
    onMouseLeave: hide,
    onMouseDown: () => { pressed.current = true; hide() },
    onClick: () => { pressed.current = false },
    onFocus: (e) => {
      const returning = focusedAsWindowLeft.current
      focusedAsWindowLeft.current = null
      if (pressed.current) { pressed.current = false; return }
      if (returning !== null && e.relatedTarget === null) setFocused(returning)
      else setFocused(true)
    },
    onBlur: () => {
      pressed.current = false
      // `document.hasFocus()` is already false while the window's own loss of focus blurs this.
      focusedAsWindowLeft.current = document.hasFocus() ? null : focused
      hide()
    },
  }

  return { trigger, bubble: { id, pos, container }, visible, hide }
}
