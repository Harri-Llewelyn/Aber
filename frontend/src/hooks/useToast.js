import { useState, useCallback, useEffect, useRef } from 'react'

/** The toast types. Anything else a caller passes is shown as `info`. */
export const TOAST_TYPES = ['success', 'info', 'warning', 'error']

/** Toasts on screen at once. A fourth pushes the oldest off; it stays in the history. */
export const MAX_VISIBLE_TOASTS = 3

/** Entries the notification history keeps, newest first. */
export const HISTORY_LIMIT = 50

/**
 * Where the history is kept: sessionStorage, so it survives a reload and stays in this browser tab.
 * It holds message text only. App.jsx clears it when the session ends.
 */
export const HISTORY_STORAGE_KEY = 'aber_notification_history'

const isStoredEntry = (e) => Boolean(e) && typeof e === 'object'
  && Number.isFinite(e.id) && typeof e.msg === 'string'
  && TOAST_TYPES.includes(e.type) && Number.isFinite(e.at)

/** The stored history, or an empty one when storage is blocked, missing or holds something else. */
export function readStoredHistory() {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(HISTORY_STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isStoredEntry).slice(0, HISTORY_LIMIT).map(({ id, msg, type, at, read, count }) => ({
      id, msg, type, at,
      read: read === true,
      count: Number.isInteger(count) && count > 1 ? count : 1
    }))
  } catch {
    return []
  }
}

function writeStoredHistory(history) {
  try {
    if (history.length) window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history))
    else window.sessionStorage.removeItem(HISTORY_STORAGE_KEY)
  } catch { /* blocked or full: the history carries on in memory */ }
}

/** Forget the stored history, so the next person to sign in on this tab starts with an empty list. */
export function clearStoredHistory() {
  try { window.sessionStorage.removeItem(HISTORY_STORAGE_KEY) } catch { /* storage unavailable */ }
}

/**
 * The toasts on screen and the notification history behind the top bar's bell. `showToast(msg,
 * type)` is the only way in: each call shows a toast and records the same message in the history.
 * Every callback is stable, so passing them down re-renders nothing.
 */
export function useToast() {
  const [toasts, setToasts] = useState([])
  const [history, setHistory] = useState(readStoredHistory)
  // Continues from the stored history, so a React key never repeats across a reload.
  const nextId = useRef(null)
  if (nextId.current === null) nextId.current = history.reduce((max, e) => Math.max(max, e.id), 0) + 1

  useEffect(() => { writeStoredHistory(history) }, [history])

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
    // A repeat of the newest entry is counted on it rather than filling the list.
    setHistory(prev => {
      const repeat = prev.length > 0 && same(prev[0])
      const recorded = { ...entry, read: false, count: repeat ? prev[0].count + 1 : 1 }
      return [recorded, ...(repeat ? prev.slice(1) : prev)].slice(0, HISTORY_LIMIT)
    })
  }, [])

  /** The toast's timer ran out. Its history entry stays unread. */
  const expireToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  /** The user closed the toast, which counts as having read it. */
  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
    setHistory(prev => prev.some(e => e.id === id && !e.read)
      ? prev.map(e => (e.id === id ? { ...e, read: true } : e))
      : prev)
  }, [])

  const markAllRead = useCallback(() => {
    setHistory(prev => prev.some(e => !e.read) ? prev.map(e => (e.read ? e : { ...e, read: true })) : prev)
  }, [])

  const clearHistory = useCallback(() => setHistory([]), [])

  return { toasts, showToast, expireToast, dismissToast, history, markAllRead, clearHistory }
}
