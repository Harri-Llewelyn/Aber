import { useState, useCallback, useEffect, useRef } from 'react'
import { GRAFANA_URL } from '../constants'

/**
 * The toast types, which are severity: how long a toast stays and which live region reads it out
 * (Toast.jsx). Anything else a caller passes is shown as `info`.
 */
const TOAST_TYPES = ['success', 'info', 'warning', 'error']

/**
 * The groups a message sorts into, which decide its icon and the notification list's filter. Info
 * is routine news, successes included; Warning is the dashboard's own failures and warnings; Alert
 * is a Grafana alert, firing or resolved.
 */
export const TOAST_GROUPS = ['info', 'warning', 'alert']
const DEFAULT_GROUP = { success: 'info', info: 'info', warning: 'warning', error: 'warning' }

/** A message's group: the one it was given, or its type's when it has none or an unknown one. */
export const groupOf = ({ type, group } = {}) =>
  (TOAST_GROUPS.includes(group) ? group : DEFAULT_GROUP[type] ?? 'info')

/** Whether `to` holds what a browser strips from a URL or reads as a slash: a space, a control character or `\`. */
const hasUnsafeChar = (to) => [...to].some(c => c <= ' ' || c === '\u007f' || c === '\\')

/**
 * Whether `to` may be a message's link: a path in this app (one leading slash, so never a
 * protocol-relative `//host`) or an address under the configured Grafana. Checked as a message
 * comes in and again as the history is read back, so nothing stored can become a `javascript:` or
 * off-site link.
 */
export function isSafeDestination(to) {
  if (typeof to !== 'string' || to.length > 2048 || hasUnsafeChar(to)) return false
  if (/^\/(?!\/)/.test(to)) return true
  if (!/^https?:\/\/[^/?#]+/.test(GRAFANA_URL)) return false
  return to === GRAFANA_URL || ['/', '?', '#'].some(c => to.startsWith(GRAFANA_URL + c))
}

/** Toasts on screen at once. A fourth pushes the oldest off; it stays in the history. */
export const MAX_VISIBLE_TOASTS = 3

/** Entries the notification history keeps, newest first. */
export const HISTORY_LIMIT = 50

/**
 * Where the history is kept: sessionStorage, so it survives a reload and stays in this browser tab.
 * It holds text only: the message, its group and its destination. App.jsx clears it when the
 * session ends.
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
    // An entry stored before groups existed takes its type's; a destination that fails the check
    // is dropped and the entry kept as plain text.
    return parsed.filter(isStoredEntry).slice(0, HISTORY_LIMIT).map(({ id, msg, type, group, to, at, read, count }) => ({
      id, msg, type, group: groupOf({ type, group }), at,
      ...(isSafeDestination(to) ? { to } : {}),
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
 * type, options)` is the only way in: each call shows a toast and records a message in the history,
 * the same one unless `options.detail` gives the history a longer text than the toast carries.
 * `options.group` is needed only where the type's group is wrong: a Grafana alert passes 'alert'.
 * `options.to` is where the message is about, as text: a path from routes.js or a Grafana URL,
 * which makes the toast's message and its row in the history a link (see Toast). One that fails
 * isSafeDestination is ignored. Every callback is stable, so passing them down re-renders nothing.
 */
export function useToast() {
  const [toasts, setToasts] = useState([])
  const [history, setHistory] = useState(readStoredHistory)
  // Continues from the stored history, so a React key never repeats across a reload.
  const nextId = useRef(null)
  if (nextId.current === null) nextId.current = history.reduce((max, e) => Math.max(max, e.id), 0) + 1

  useEffect(() => { writeStoredHistory(history) }, [history])

  const showToast = useCallback((msg, type = 'success', { detail, group, to } = {}) => {
    const known = TOAST_TYPES.includes(type) ? type : 'info'
    const entry = {
      id: nextId.current++,
      msg: msg == null ? '' : String(msg),
      type: known,
      group: groupOf({ type: known, group }),
      ...(isSafeDestination(to) ? { to } : {}),
      at: Date.now()
    }
    const recordedMsg = detail == null ? entry.msg : String(detail)
    const same = (e) => e.type === entry.type && e.group === entry.group && e.to === entry.to
    const sameToast = (e) => e.msg === entry.msg && same(e)
    const sameEntry = (e) => e.msg === recordedMsg && same(e)
    // A message already on screen is replaced rather than stacked, so it restarts its timer and a
    // failure repeated by a poll shows once.
    setToasts(prev => [...prev.filter(t => !sameToast(t)), entry].slice(-MAX_VISIBLE_TOASTS))
    // A repeat of the newest entry is counted on it rather than filling the list.
    setHistory(prev => {
      const repeat = prev.length > 0 && sameEntry(prev[0])
      const recorded = { ...entry, msg: recordedMsg, read: false, count: repeat ? prev[0].count + 1 : 1 }
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

  /** Marks the entries with these ids read, or every entry when no list is given. */
  const markRead = useCallback((ids) => {
    const marks = Array.isArray(ids) ? (e) => ids.includes(e.id) : () => true
    setHistory(prev => prev.some(e => !e.read && marks(e))
      ? prev.map(e => (e.read || !marks(e) ? e : { ...e, read: true }))
      : prev)
  }, [])

  const clearHistory = useCallback(() => setHistory([]), [])

  return { toasts, showToast, expireToast, dismissToast, history, markRead, clearHistory }
}
