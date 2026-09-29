import { useState, useCallback, useRef } from 'react'

/** The toast types. Anything else a caller passes is shown as `info`. */
export const TOAST_TYPES = ['success', 'info', 'warning', 'error']

/** Toasts on screen at once. A fourth pushes the oldest off. */
export const MAX_VISIBLE_TOASTS = 3

/**
 * The toasts on screen. `showToast(msg, type)` is the only way in. Every callback is stable, so
 * passing them down re-renders nothing.
 */
export function useToast() {
  const [toasts, setToasts] = useState([])
  const nextId = useRef(1)

  const showToast = useCallback((msg, type = 'success') => {
    const entry = {
      id: nextId.current++,
      msg: msg == null ? '' : String(msg),
      type: TOAST_TYPES.includes(type) ? type : 'info',
      at: Date.now()
    }
    const same = (e) => e.msg === entry.msg && e.type === entry.type
    // A message already on screen is replaced rather than stacked, so it restarts its timer and a
    // failure repeated by a poll shows once.
    setToasts(prev => [...prev.filter(t => !same(t)), entry].slice(-MAX_VISIBLE_TOASTS))
  }, [])

  /** The toast's timer ran out. */
  const expireToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  /** The user closed the toast. */
  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  return { toasts, showToast, expireToast, dismissToast }
}
