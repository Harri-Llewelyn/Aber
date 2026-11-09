/**
 * What this browser says about desktop notifications, and the words the Profile tab uses for it:
 * whether it can raise one, whether it has been allowed to, and how to ask. It imports nothing, so
 * the Profile page does not pull in the alerts' code. A person's own choice is
 * `user_settings.desktop_notifications` (0264); the browser's permission is granted per browser
 * and is never stored.
 */

/** Why the switch is unavailable. A reason is a key of UNAVAILABLE_WORDS. */
export const UNAVAILABLE_WORDS = {
  // The clipboard has the same condition (common/CopyableId.jsx): a secure context only. A site
  // reached over plain HTTP by its IP address has neither; `*.localhost` counts as secure.
  insecure: 'Not available on this address. Browsers allow notifications only over HTTPS or on localhost, and this page is served over plain HTTP.',
  missing: 'Not available in this browser. It does not support desktop notifications.',
}

/** What to say, and how to allow it, when the browser has refused. */
export const REFUSED_WORDS = 'This browser has blocked notifications from this site. To allow them, open the site settings (usually from the icon at the left of the address bar), set Notifications to Allow, then reload this page.'
export const NOT_ASKED_WORDS = 'This browser has not been asked yet. Select Allow Notifications, and the browser will ask.'
export const SAVE_ASKS_WORDS = 'Select Save, and the browser will ask whether to allow notifications.'
export const ALLOWED_WORDS = 'Allowed in this browser. A notification appears when an alert starts firing, while a dashboard tab is open.'

/**
 * `{ ok: true }`, or `{ ok: false, reason }` with the reason a key of UNAVAILABLE_WORDS. A page that
 * is not a secure context is told so before the API is looked for: some browsers hide
 * `Notification` there and some leave it in and refuse every request.
 */
export function notificationSupport() {
  if (typeof window === 'undefined') return { ok: false, reason: 'missing' }
  if (window.isSecureContext === false) return { ok: false, reason: 'insecure' }
  if (typeof window.Notification === 'undefined') return { ok: false, reason: 'missing' }
  return { ok: true }
}

/** 'default' (not asked), 'granted' or 'denied'; null where the browser has no such thing. */
export function notificationPermission() {
  if (!notificationSupport().ok) return null
  const held = window.Notification.permission
  return held === 'granted' || held === 'denied' || held === 'default' ? held : null
}

// The prompt in flight: a click that two listeners both answer asks the browser once.
let asking = null

/**
 * Ask the browser's permission, which it answers with the same three words. Call it from a click
 * or a key press: Firefox and Safari refuse to prompt from anywhere else. It never rejects; a
 * browser that throws, or that has nothing to ask, answers as it already stands.
 */
export function askNotificationPermission() {
  asking ??= new Promise((resolve) => {
    const standing = () => notificationPermission()
    if (!notificationSupport().ok) { resolve(standing()); return }
    let settled = false
    const done = (answer) => {
      if (settled) return
      settled = true
      resolve(answer === 'granted' || answer === 'denied' || answer === 'default' ? answer : standing())
    }
    try {
      // Older Safari takes a callback and returns nothing; the rest return a promise.
      const pending = window.Notification.requestPermission(done)
      if (pending && typeof pending.then === 'function') pending.then(done, () => done(standing()))
    } catch {
      done(standing())
    }
  }).finally(() => { asking = null })
  return asking
}
