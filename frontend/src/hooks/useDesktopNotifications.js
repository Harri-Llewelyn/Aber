import { useCallback, useEffect, useState } from 'react'

export const DESKTOP_NOTIFICATIONS_KEY = 'aber_desktop_notifications'
// Off, as user_settings.desktop_notifications defaults to false.
const DEFAULT_ON = false

const readStored = () => {
  try {
    const v = localStorage.getItem(DESKTOP_NOTIFICATIONS_KEY)
    return v === 'on' ? true : v === 'off' ? false : DEFAULT_ON
  } catch {
    return DEFAULT_ON
  }
}

/**
 * Whether this person has asked for a desktop notification when an alert starts firing. Signed in,
 * their `user_settings` row is the source and localStorage its cache, as useSingleKeyShortcuts
 * keeps (useUserSettings.js). The browser's permission to show one is not this: it is granted per
 * browser and is read from the browser (useNotificationPermission).
 */
export function useDesktopNotifications() {
  const [on, setOnState] = useState(readStored)

  useEffect(() => {
    try { localStorage.setItem(DESKTOP_NOTIFICATIONS_KEY, on ? 'on' : 'off') } catch { /* storage unavailable */ }
  }, [on])

  const setOn = useCallback((next) => { if (typeof next === 'boolean') setOnState(next) }, [])
  return { on, setOn }
}
