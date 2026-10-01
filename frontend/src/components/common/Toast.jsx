import React, { useEffect, useRef } from 'react'
import { IconCheck, IconInfo, IconAlertTriangle, IconAlertCircle, IconX } from './Icons'

/** The shortest time each type stays up. An error has none: it stays until it is dismissed. */
export const TOAST_MIN_MS = { success: 4000, info: 4000, warning: 8000 }
/** Reading time: a second to notice the toast, then 60 ms a character (about 200 words a minute). */
export const TOAST_NOTICE_MS = 1000
export const TOAST_MS_PER_CHAR = 60
/** The longest any toast waits. Past it the message is still in the notification history. */
export const TOAST_MAX_MS = 20000
/** A toast the pointer or focus leaves resumes with at least this long left. */
export const TOAST_RESUME_MIN_MS = 2000

/** How long a toast stays up in ms, or null for one that stays until dismissed. */
export function toastDuration(msg, type) {
  if (type === 'error') return null
  const reading = TOAST_NOTICE_MS + String(msg ?? '').length * TOAST_MS_PER_CHAR
  return Math.min(TOAST_MAX_MS, Math.max(TOAST_MIN_MS[type] ?? TOAST_MIN_MS.info, reading))
}

/** One glyph per type, shared with the notification history so the two read alike. */
export const TOAST_ICONS = {
  success: IconCheck,
  info: IconInfo,
  warning: IconAlertTriangle,
  error: IconAlertCircle
}

/** Read out before the message: the icon and colour tell only a sighted user it is a warning. */
export const TOAST_SPOKEN_PREFIX = { warning: 'Warning: ', error: 'Error: ' }

/**
 * One toast. Its timer pauses while the pointer is over it or focus is inside it, and the close
 * button is there for every type, since an error has no timer at all. Escape is not bound: it
 * already closes the modal or drawer the toast is floating over.
 *
 * With `onOpen` the message is a button that calls it with the toast's id; the close button never
 * does.
 */
export function Toast({ id, msg, type, onDismiss, onExpire, onOpen }) {
  const duration = toastDuration(msg, type)
  const remaining = useRef(duration)
  const startedAt = useRef(0)
  const timer = useRef(null)
  const held = useRef({ hover: false, focus: false })
  const expire = useRef(onExpire)
  expire.current = onExpire

  const run = () => {
    if (duration === null || timer.current !== null) return
    startedAt.current = Date.now()
    timer.current = setTimeout(() => {
      timer.current = null
      expire.current?.(id)
    }, remaining.current)
  }

  const hold = (reason) => {
    held.current[reason] = true
    if (timer.current === null) return
    clearTimeout(timer.current)
    timer.current = null
    remaining.current = Math.max(TOAST_RESUME_MIN_MS, remaining.current - (Date.now() - startedAt.current))
  }

  const release = (reason) => {
    held.current[reason] = false
    if (!held.current.hover && !held.current.focus) run()
  }

  // Keyed by id in ToastStack, so each toast mounts once and owns its own timer.
  useEffect(() => {
    run()
    return () => {
      clearTimeout(timer.current)
      timer.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const Icon = TOAST_ICONS[type] ?? IconInfo
  const text = (
    <>
      {TOAST_SPOKEN_PREFIX[type] && <span className="sr-only">{TOAST_SPOKEN_PREFIX[type]}</span>}
      {msg}
    </>
  )

  return (
    <div
      className={`toast toast-${type}`}
      onMouseEnter={() => hold('hover')}
      onMouseLeave={() => release('hover')}
      onFocus={() => hold('focus')}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) release('focus') }}
    >
      <span className="toast-icon" aria-hidden="true"><Icon size={16} /></span>
      {onOpen ? (
        <button type="button" className="toast-msg toast-open" onClick={() => onOpen(id)} title="Show the firing alerts">
          {text}
        </button>
      ) : (
        <span className="toast-msg">{text}</span>
      )}
      <button type="button" className="toast-dismiss" onClick={() => onDismiss?.(id)} aria-label="Dismiss" title="Dismiss">
        <IconX size={14} />
      </button>
    </div>
  )
}

/**
 * The corner the toasts stack in, newest nearest the corner. Both live regions are always in the
 * DOM, empty when nothing is showing, because a region inserted together with its first message is
 * not announced. Errors go in the assertive `alert` region; everything else is a polite `status`.
 */
export function ToastStack({ toasts = [], onDismiss, onExpire }) {
  const renderToast = (t) => (
    <Toast key={t.id} id={t.id} msg={t.msg} type={t.type} onDismiss={onDismiss} onExpire={onExpire} onOpen={t.onOpen} />
  )
  return (
    <div className="toast-stack">
      <div className="toast-region" role="alert" aria-live="assertive" aria-atomic="false">
        {toasts.filter(t => t.type === 'error').map(renderToast)}
      </div>
      <div className="toast-region" role="status" aria-live="polite" aria-atomic="false">
        {toasts.filter(t => t.type !== 'error').map(renderToast)}
      </div>
    </div>
  )
}
