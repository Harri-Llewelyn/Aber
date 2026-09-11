import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronDown } from './Icons'

/**
 * An overflow ("...") menu for table row actions. Rendered through a portal with `position: fixed`
 * because `.table-wrap` is `overflow-x: auto` and would clip a menu positioned inside the row; the
 * cost is that it closes on scroll and resize rather than following. Uncontrolled: it owns `open`
 * and closes after any item fires.
 */
export function ActionMenu({ items, label = 'More actions', disabled = false, testId }) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)

  // Callers build the item list with conditionals, so a separator can end up leading, trailing or
  // doubled; collapse those.
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
    // Closed rather than repositioned on scroll. `true` captures scroll on the .table-wrap
    // container, which does not bubble.
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
