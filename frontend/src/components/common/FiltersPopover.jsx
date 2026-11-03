import React, {
  Children, Fragment, cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from './Tooltip'
import { IconChevronDown } from './Icons'

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
 * `children` and `foot` may be functions of `{ close }`. `buttonClass` styles the button, `tip`
 * is its tooltip, and `buttonLabel` its accessible name where the words alone do not say what it
 * filters (a list filter's "Any status"). An Escape a control inside has already used, such as a
 * search box clearing its text, does not close the panel.
 */
export function ToolbarPopover({ label, button, buttonLabel, buttonClass = 'btn btn-sm btn-ghost', tip, foot, children }) {
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

  // Once placed. Not scrolled to, which would close it.
  const placed = pos !== null
  useEffect(() => {
    if (placed) panelRef.current?.querySelector(FOCUSABLE)?.focus({ preventScroll: true })
  }, [placed])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) close() }
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
          aria-label={buttonLabel}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={id}
          onClick={() => setOpen(o => !o)}
        >
          {button}
          {/* Says the button opens a panel, as a select's arrow does; turned while it is open. */}
          <IconChevronDown size={12} className="popover-chevron" aria-hidden="true" />
        </button>
      </Tooltip>
      {open && createPortal(
        <div
          ref={panelRef}
          id={id}
          role="dialog"
          aria-label={label}
          className="filters-popover"
          // Unplaced, transparent rather than hidden: `.btn` transitions every property, so a button
          // would inherit visibility through a transition that starts hidden, and refuse the focus above.
          style={pos ? { top: pos.top, left: pos.left, '--arrow-x': `${pos.arrowX}px` } : { opacity: 0, pointerEvents: 'none' }}
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
 * Marks a component the Filters panel lays out as a section beside others like it: FilterList.
 * The panel finds its lists by this, among its children and inside fragments, not deeper.
 */
export const PANEL_LIST = Symbol.for('aber.filtersPanelList')

const isPanelList = (child) => isValidElement(child) && child.type?.[PANEL_LIST] === true
const sectionKey = (list) => (list ? String(list.props.label) : null)
const sameSet = (a = [], b = []) => a.length === b.length && a.every(v => b.includes(v))
const flatten = (children) => Children.toArray(children).flatMap(child =>
  (isValidElement(child) && child.type === Fragment ? flatten(child.props.children) : [child]))

/**
 * A Filters panel's controls. Two or more lists become sections that open and close, one at a
 * time, above the panel's other controls (its FilterCheck boxes). As the panel opens, the first
 * list whose choice differs from its `defaultValue` opens, or else the first list. Which is open
 * belongs to the open panel: it starts again each time and is not in the address. A lone list
 * keeps its label and is drawn as it is.
 */
function FilterSections({ children }) {
  const items = flatten(children)
  const lists = items.filter(isPanelList)
  const [openKey, setOpenKey] = useState(() =>
    sectionKey(lists.find(l => !sameSet(l.props.value, l.props.defaultValue)) ?? lists[0]))
  if (lists.length < 2) return <>{children}</>
  return (
    <>
      <div className="filter-sections">
        {lists.map(list => {
          const key = sectionKey(list)
          return cloneElement(list, {
            key,
            section: { open: openKey === key, onToggle: () => setOpenKey(k => (k === key ? null : key)) },
          })
        })}
      </div>
      {items.filter(item => !isPanelList(item))}
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
 * "Filters", with its own Clear button, which calls `onClear` and is disabled at 0. Its lists
 * (FilterList) open and close as sections, one at a time (FilterSections), so only the panel
 * scrolls.
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
      {({ close }) => <FilterSections>{typeof children === 'function' ? children({ close }) : children}</FilterSections>}
    </ToolbarPopover>
  )
}
