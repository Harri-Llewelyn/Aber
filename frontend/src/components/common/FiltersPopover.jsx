import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from './Tooltip'

/** The gap under the button, the same as the top bar's panels: room for the arrow. */
const GAP = 8
/** The panel's width and its margin from the window's edge (App.css). */
const WIDTH = 320
const MARGIN = 8
/** How near the panel's corner the arrow may sit: its 8px radius and the arrow's half-width. */
const ARROW_INSET = 16
/** What can take focus inside the panel, the first of which does as it opens. */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A toolbar button that opens a panel under it: the frame of the Filters popover and of the time
 * window's (TimeWindowControl). The panel is `role="dialog"` named `label`, and focus moves to its
 * first control as it opens. Escape and a click outside close it and return focus to the button.
 * It is portalled to <body> and fixed under the button, because the card that holds the row clips
 * its overflow; scrolling or resizing closes it. Its arrow points at the button's centre through
 * `--arrow-x` (App.css, Popover arrows).
 *
 *   <ToolbarPopover label="Choose a time window" button={words} tip="…">
 *     {({ close }) => <Choices onChoose={(w) => { onChange(w); close() }} />}
 *   </ToolbarPopover>
 *
 * `children` and `foot` may be functions of `{ close }`. `buttonClass` styles the button, and `tip`
 * is its tooltip.
 */
export function ToolbarPopover({ label, button, buttonClass = 'btn btn-sm btn-ghost', tip, foot, children }) {
  const id = useId()
  const buttonRef = useRef(null)
  const panelRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)

  const close = () => {
    setOpen(false)
    buttonRef.current?.focus()
  }

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) { setPos(null); return }
    const r = buttonRef.current.getBoundingClientRect()
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - WIDTH - MARGIN))
    // The arrow stays over the button's centre when the panel is shifted to fit the window.
    const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN)
    const arrowX = Math.max(ARROW_INSET, Math.min(r.left + r.width / 2 - left, width - ARROW_INSET))
    setPos({ top: r.bottom + GAP, left, arrowX })
  }, [open])

  // Once placed, as a hidden panel cannot take focus. Not scrolled to, which would close it.
  const placed = pos !== null
  useEffect(() => {
    if (placed) panelRef.current?.querySelector(FOCUSABLE)?.focus({ preventScroll: true })
  }, [placed])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') close() }
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || buttonRef.current?.contains(e.target)) return
      close()
    }
    const dismiss = (e) => { if (!(e.target instanceof Node && panelRef.current?.contains(e.target))) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [open])

  const content = (part) => (typeof part === 'function' ? part({ close }) : part)

  return (
    <>
      <Tooltip text={open ? null : tip}>
        <button
          ref={buttonRef}
          type="button"
          className={buttonClass}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={id}
          onClick={() => setOpen(o => !o)}
        >
          {button}
        </button>
      </Tooltip>
      {open && createPortal(
        <div
          ref={panelRef}
          id={id}
          role="dialog"
          aria-label={label}
          className="filters-popover"
          style={pos ? { top: pos.top, left: pos.left, '--arrow-x': `${pos.arrowX}px` } : { visibility: 'hidden' }}
        >
          <div className="filters-popover-controls">{content(children)}</div>
          {foot && <div className="filters-popover-foot">{content(foot)}</div>}
        </div>,
        document.body,
      )}
    </>
  )
}

/**
 * A "Filters" button in a toolbar row that opens a panel holding the filters the row has no room
 * for. Search, status and the page's key toggle stay in the row; the rest go in here.
 *
 *   <FiltersPopover activeCount={n} onClear={clearAll}>{controls}</FiltersPopover>
 *
 * The button reads "Filters", or "Filters (n)" while n are set. The panel is a ToolbarPopover named
 * "Filters", with its own Clear button, which calls `onClear` and is disabled at 0.
 */
export function FiltersPopover({ activeCount = 0, onClear, children }) {
  return (
    <ToolbarPopover
      label="Filters"
      button={activeCount > 0 ? `Filters (${activeCount})` : 'Filters'}
      foot={(
        <button type="button" className="btn btn-sm btn-ghost" disabled={activeCount === 0} onClick={onClear}>
          Clear
        </button>
      )}
    >
      {children}
    </ToolbarPopover>
  )
}
