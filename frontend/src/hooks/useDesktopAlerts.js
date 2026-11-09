import { useCallback, useEffect, useRef } from 'react'
import { api } from '../api'
import { FAVICON } from './useAlertFavicon'
import { isAcknowledged } from '../utils/alertAcknowledgement'
import { isSuppressed } from '../utils/alertSuppression'
import { SUBJECT_WAIT_MS, alertNotificationText } from '../utils/desktopNotifications'
import { notificationPermission, notificationSupport } from '../utils/notificationPermission'
import { useNotificationPermission } from './useNotificationPermission'

/**
 * The session storage key that remembers this tab has asked. It holds a constant, never anything of
 * the person's: who is signed in is kept in memory only, and a change of person clears it.
 */
export const ASKED_KEY = 'aber_desktop_notifications_asked'

const wasAsked = () => {
  try { return sessionStorage.getItem(ASKED_KEY) === 'asked' } catch { return false }
}
const markAsked = () => {
  try { sessionStorage.setItem(ASKED_KEY, 'asked') } catch { /* storage unavailable */ }
}
const forgetAsked = () => {
  try { sessionStorage.removeItem(ASKED_KEY) } catch { /* storage unavailable */ }
}

/** The name and place of an alert's subject, or null once SUBJECT_WAIT_MS has gone. */
async function readSubject(alert) {
  let timer
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve(null), SUBJECT_WAIT_MS) })
  try {
    return await Promise.race([api.readAlertSubject(alert).catch(() => null), slow])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Raises a browser notification as an alert starts firing, for a person who turned them on, and
 * returns `sync(rows)`: usePlatformAlerts hands it every read of `platform_alerts_active`, which
 * carries the same visibility as the alert counter.
 *
 * One notification per occurrence (`alert.id`), when it starts firing: it is new to this tab, or
 * out of a suppression window while still firing. Not on a refresh, a repeat of the row, or the
 * first read, and not for an acknowledged or suppressed alert. Its `tag` is that id, so a second
 * tab's notification replaces this one rather than stacking. It closes when the occurrence
 * resolves, is acknowledged or becomes suppressed, and when `enabled` goes false or the hook
 * unmounts. Clicking it focuses this window and calls `onOpen(alert)`.
 *
 * `enabled` is the person's own choice. Whether the browser lets it is read from the browser each
 * time. A person who has it on in a browser that has not been asked is asked once per session, at
 * the first click or key press, which is the gesture Firefox and Safari require.
 */
export function useDesktopAlerts({ enabled, userId = null, onOpen }) {
  const enabledRef = useRef(enabled)
  const onOpenRef = useRef(onOpen)
  // Every occurrence the last read held, by id; null until the first read primes it.
  const knownRef = useRef(null)
  // The occurrences that should have a notification now: firing, unacknowledged, not suppressed.
  const wantedRef = useRef(new Set())
  const openRef = useRef(new Map())
  const pendingRef = useRef(new Set())
  const { permission, ask } = useNotificationPermission()

  useEffect(() => { enabledRef.current = enabled }, [enabled])
  useEffect(() => { onOpenRef.current = onOpen }, [onOpen])

  const close = useCallback((id) => {
    const held = openRef.current.get(id)
    openRef.current.delete(id)
    try { held?.close() } catch { /* already gone */ }
  }, [])

  const closeAll = useCallback(() => {
    for (const id of [...openRef.current.keys()]) close(id)
  }, [close])

  const raise = useCallback(async (alert) => {
    const id = alert.id
    if (!enabledRef.current || notificationPermission() !== 'granted') return
    if (openRef.current.has(id) || pendingRef.current.has(id)) return
    pendingRef.current.add(id)
    const subject = await readSubject(alert)
    pendingRef.current.delete(id)
    // It may have resolved, been acknowledged or been turned off while the subject was read.
    if (!wantedRef.current.has(id) || !enabledRef.current || notificationPermission() !== 'granted') return
    const { title, body } = alertNotificationText(alert, subject)
    try {
      const held = new window.Notification(title, {
        body, tag: id, icon: new URL(FAVICON, window.location.origin).href,
      })
      held.onclick = () => {
        try { window.focus() } catch { /* the browser decides */ }
        close(id)
        onOpenRef.current?.(alert)
      }
      held.onclose = () => { if (openRef.current.get(id) === held) openRef.current.delete(id) }
      openRef.current.set(id, held)
    } catch (err) {
      console.warn('[desktop-alerts] could not raise a notification:', err?.message)
    }
  }, [close])

  const sync = useCallback((rows = []) => {
    const was = knownRef.current
    const counted = rows.filter((a) => !isAcknowledged(a) && !isSuppressed(a))
    wantedRef.current = new Set(counted.map((a) => a.id))
    if (was) {
      for (const alert of counted) {
        const before = was.get(alert.id)
        if (!before || isSuppressed(before)) raise(alert)
      }
    }
    for (const id of [...openRef.current.keys()]) if (!wantedRef.current.has(id)) close(id)
    knownRef.current = new Map(rows.map((a) => [a.id, a]))
  }, [raise, close])

  useEffect(() => { if (!enabled) closeAll() }, [enabled, closeAll])
  useEffect(() => closeAll, [closeAll])

  // The tab remembers that it asked, not whom: signing out (the dashboard unmounts) or another
  // person's id arriving clears it, so the next person is asked. A reload keeps it.
  const personRef = useRef(userId)
  useEffect(() => {
    if (personRef.current !== userId) { forgetAsked(); personRef.current = userId }
  }, [userId])
  useEffect(() => forgetAsked, [])

  // The prompt, once per session, at the first gesture.
  useEffect(() => {
    if (!enabled || !notificationSupport().ok || permission !== 'default' || wasAsked()) return undefined
    function stop() {
      document.removeEventListener('click', onGesture, true)
      document.removeEventListener('keydown', onGesture, true)
    }
    function onGesture() { stop(); markAsked(); ask() }
    document.addEventListener('click', onGesture, true)
    document.addEventListener('keydown', onGesture, true)
    return stop
  }, [enabled, userId, permission, ask])

  return sync
}
