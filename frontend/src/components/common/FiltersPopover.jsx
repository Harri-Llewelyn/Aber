import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const GAP = 6

/**
 * A "Filters" button in a toolbar row that opens a panel holding the filters the row has no room
 * for. Search, status and the page's key toggle stay in the row; the rest go in here.
 *
 *   <FiltersPopover activeCount={n} onClear={clearAll}>{controls}</FiltersPopover>
 *
 * The button reads "Filters", or "Filters (n)" while n are set. The panel is `role="dialog"` named
 * "Filters"; Escape and a click outside close it and return focus to the button. Its own Clear
 * button calls `onClear` and is disabled at 0. The panel is portalled to <body> and fixed under
 * the button, because the card that holds the row clips its overflow; scrolling or resizing closes it.
 */
export function FiltersPopover({ activeCount = 0, onClear, children }) {
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
    setPos({ top: r.bottom + GAP, left: Math.max(8, Math.min(r.left, window.innerWidth - 328)) })
  }, [open])

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

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-sm btn-ghost"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={() => setOpen(o => !o)}
      >
        {activeCount > 0 ? `Filters (${activeCount})` : 'Filters'}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          id={id}
          role="dialog"
          aria-label="Filters"
          className="filters-popover"
          style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
        >
          <div className="filters-popover-controls">{children}</div>
          <div className="filters-popover-foot">
            <button type="button" className="btn btn-sm btn-ghost" disabled={activeCount === 0} onClick={onClear}>
              Clear
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
