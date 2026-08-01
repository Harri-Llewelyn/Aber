import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronDown } from './Icons'

/**
 * An overflow ("...") menu for table row actions.
 *
 * RENDERED THROUGH A PORTAL, and that is the whole reason this is a component rather than a few
 * lines of inline JSX. `.table-wrap` is `overflow-x: auto`, so a menu positioned inside the row is
 * CLIPPED by that scroll container -- it opens and you see a sliver of it. Portalling to
 * document.body with `position: fixed` puts it outside the clipping context. The cost is that the
 * menu no longer moves with the row, which is why it closes on scroll and on resize rather than
 * trying to follow.
 *
 * This is the same family of bug the Devices row has hit twice before, both times because a cell's
 * contents were assumed to be free to overflow when the wrapper says otherwise.
 *
 * The menu is uncontrolled: it owns `open` and closes itself after any item fires, since every
 * action here either navigates, opens a modal, or mutates a row.
 */
export function ActionMenu({ items, label = 'More actions', disabled = false, testId }) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)

  // Callers build the item list with conditionals (`!archived && {...}`), so a separator can end
  // up leading, trailing, or doubled once its neighbours drop out. Collapse those rather than
  // rendering a stray rule, which reads as a missing item.
  const visible = items
    .filter(Boolean)
    .reduce((acc, item) => {
      if (item.separator && (acc.length === 0 || acc[acc.length - 1].separator)) return acc
      acc.push(item)
      return acc
    }, [])
    .filter((item, index, all) => !(item.separator && index === all.length - 1))

  const place = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    // Right-aligned to the trigger: the actions column is the last one and sits against the right
    // edge, so a left-aligned menu would open off-screen on a narrow viewport.
    setCoords({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) })
  }, [])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event) => {
      if (triggerRef.current?.contains(event.target)) return
      if (menuRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    // Closed rather than repositioned on scroll: a fixed-position menu detached from its row would
    // otherwise drift away from the button that opened it. `true` captures scroll on the
    // .table-wrap container too, which does not bubble.
    const onScrollOrResize = () => setOpen(false)

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onScrollOrResize)
    window.addEventListener('scroll', onScrollOrResize, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onScrollOrResize)
      window.removeEventListener('scroll', onScrollOrResize, true)
    }
  }, [open])

  // Focus the first enabled item on open, so the menu is operable from the keyboard.
  useEffect(() => {
    if (!open) return
    const first = menuRef.current?.querySelector('button:not([disabled])')
    first?.focus()
  }, [open, coords])

  const run = (item) => {
    if (item.disabled) return
    setOpen(false)
    item.onClick?.()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={disabled || !visible.some(item => !item.separator)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        data-testid={testId}
        onClick={() => setOpen(o => !o)}
      >
        {label} <IconChevronDown size={12} />
      </button>

      {open && coords && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          className="action-menu"
          style={{ position: 'fixed', top: coords.top, right: coords.right }}
        >
          {visible.map((item, index) => (
            item.separator ? (
              <div key={`sep-${index}`} className="action-menu-separator" role="separator" />
            ) : (
              <button
                key={item.key || item.label}
                type="button"
                role="menuitem"
                className={`action-menu-item${item.danger ? ' action-menu-item-danger' : ''}`}
                disabled={item.disabled}
                // The reason an item is unavailable is the useful part -- "Requires Admin
                // permissions" reads far better here than on a greyed-out button in a crowded row.
                title={item.title || ''}
                onClick={() => run(item)}
              >
                {item.icon && <span className="action-menu-icon">{item.icon}</span>}
                <span>{item.label}</span>
              </button>
            )
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
