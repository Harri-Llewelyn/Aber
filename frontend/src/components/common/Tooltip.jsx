import React, { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useHoverIntent } from '../../hooks/useHoverIntent'
import { useEscapeKey } from '../../hooks/useEscapeKey'

export const TOOLTIP_WIDTH = 320
/** From the trigger: room for the arrow's point. */
const GAP = 8
/** From the window's sides. */
const MARGIN = 8
/**
 * The nearest the arrow's centre comes to the bubble's side: the 8px corner radius plus half the
 * turned 8px square. App.css keeps the arrow inside a narrower bubble by the same distance.
 */
export const ARROW_INSET = 14

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
 * Where the bubble and its arrow go for a trigger at `r` in a `vw` by `vh` window. Below the
 * trigger, or `above` it when the trigger is low in the window. The bubble starts at the trigger's
 * left edge (a narrow trigger's centre less ARROW_INSET), or, where the widest bubble would pass the
 * window's right side, ends at its right edge (`end`, placed by `right`), so a short bubble still
 * reaches its trigger. `arrowX` is the trigger's centre from that edge of the bubble, kept
 * ARROW_INSET inside it.
 */
export function placeTooltip(r, vw, vh) {
  const width = Math.min(TOOLTIP_WIDTH, vw - 2 * MARGIN)
  const centre = r.left + r.width / 2
  const above = r.bottom + GAP + 160 > vh && r.top > vh / 2
  const y = above ? { bottom: vh - r.top + GAP } : { top: r.bottom + GAP }
  const arrow = (offset) => Math.max(ARROW_INSET, Math.min(offset, width - ARROW_INSET))
  const start = Math.min(r.left, centre - ARROW_INSET)
  const end = Math.max(r.left + r.width, centre + ARROW_INSET)
  if (start + width + MARGIN > vw && end - width >= MARGIN) {
    const right = Math.max(MARGIN, vw - end)
    return { ...y, right, width, above, end: true, arrowX: arrow(vw - right - centre) }
  }
  const left = Math.max(MARGIN, Math.min(start, vw - width - MARGIN))
  return { ...y, left, width, above, end: false, arrowX: arrow(centre - left) }
}

/**
 * Where a tooltip's bubble goes while `visible` (placeTooltip), inside `tooltipHost(trigger)`. Null
 * while hidden. A scroll or a resize calls `onDismiss` rather than tracking the trigger.
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
    setPlaced({
      pos: placeTooltip(trigger.getBoundingClientRect(), window.innerWidth, window.innerHeight),
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
 * the trigger names it by `id` in `aria-describedby`. Its arrow points at the trigger: `--arrow-x`
 * from `pos`, and the classes say which border and edge it is measured on (App.css).
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
      className={`tooltip-bubble${pos?.above ? ' tooltip-bubble-above' : ''}${pos?.end ? ' tooltip-bubble-end' : ''}`}
      hidden={!pos}
      style={pos ? {
        ...(pos.above ? { bottom: pos.bottom } : { top: pos.top }),
        ...(pos.end ? { right: pos.right } : { left: pos.left }),
        maxWidth: pos.width,
        '--arrow-x': `${pos.arrowX}px`,
      } : undefined}
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

/** A ref that sets each of `refs`: an object ref's `current`, or a callback ref. */
const setRefs = (...refs) => (el) => {
  for (const r of refs) {
    if (typeof r === 'function') r(el)
    else if (r) r.current = el
  }
}

/**
 * The shared tooltip on one control: wrap the control, and `text` shows in the bubble, as useTooltip
 * shows it. The control's own ref and handlers still run. With no `text` the control is drawn as it
 * is, in the same place, so a tooltip that comes and goes never remounts it. The bubble describes
 * the control (`aria-describedby`) unless its text is the control's `aria-label`: an icon-only
 * button carries its name there, so the name never depends on the tooltip, and is not read twice.
 *
 *   <Tooltip text="Send the bundle to the gateway again">
 *     <button type="button" className="btn btn-ghost btn-sm" onClick={resend}>Resend</button>
 *   </Tooltip>
 *
 * The child is one element, or a component that passes the ref and the handlers to one. On
 * something that takes no focus the tooltip shows to a pointer only, so keep it to controls.
 */
export function Tooltip({ text, delay, children }) {
  const tip = useTooltip({ delay })
  const child = React.Children.only(children)
  if (!text) return <>{child}{null}</>

  const own = child.props
  const { trigger } = tip
  const both = (ours, theirs) => (e) => { ours(e); theirs?.(e) }
  const describes = own['aria-label'] !== text
  const describedBy = [own['aria-describedby'], describes && trigger['aria-describedby']].filter(Boolean).join(' ')
  return (
    <>
      {React.cloneElement(child, {
        ref: setRefs(trigger.ref, child.ref),
        'aria-describedby': describedBy || undefined,
        onMouseEnter: both(trigger.onMouseEnter, own.onMouseEnter),
        onMouseLeave: both(trigger.onMouseLeave, own.onMouseLeave),
        onMouseDown: both(trigger.onMouseDown, own.onMouseDown),
        onClick: both(trigger.onClick, own.onClick),
        onFocus: both(trigger.onFocus, own.onFocus),
        onBlur: both(trigger.onBlur, own.onBlur),
      })}
      <TooltipBubble {...tip.bubble} text={text} keepMounted={describes} />
    </>
  )
}
