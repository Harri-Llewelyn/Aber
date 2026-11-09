import { useCallback, useEffect, useState } from 'react'
import { askNotificationPermission, notificationPermission, notificationSupport } from '../utils/notificationPermission'

/**
 * What this browser says about desktop notifications: `support` (`{ ok }`, or `{ ok: false, reason }`),
 * `permission` ('default', 'granted', 'denied', or null where there is none) and `ask()`, which
 * raises the browser's prompt and resolves to the answer. Call `ask()` from a click or a key press.
 * The answer is read again when the window regains focus, because the person may have changed it in
 * the browser's site settings.
 */
export function useNotificationPermission() {
  const [permission, setPermission] = useState(notificationPermission)

  useEffect(() => {
    const read = () => setPermission(notificationPermission())
    window.addEventListener('focus', read)
    return () => window.removeEventListener('focus', read)
  }, [])

  const ask = useCallback(async () => {
    const answer = await askNotificationPermission()
    setPermission(answer)
    return answer
  }, [])

  return { support: notificationSupport(), permission, ask }
}
