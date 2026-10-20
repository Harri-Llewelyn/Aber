import { useCallback, useEffect, useState } from 'react'

export const SINGLE_KEY_SHORTCUTS_KEY = 'aber_single_key_shortcuts'
// On, as user_settings.single_key_shortcuts defaults to true.
const DEFAULT_ON = true

const readStored = () => {
  try {
    const v = localStorage.getItem(SINGLE_KEY_SHORTCUTS_KEY)
    return v === 'off' ? false : v === 'on' ? true : DEFAULT_ON
  } catch {
    return DEFAULT_ON
  }
}

/**
 * Whether `?`, `/`, `[` and `]` act (shortcuts.js). localStorage keeps this browser's copy, the
 * theme's arrangement: signed in, the person's `user_settings` row is the source and this copy its
 * cache (useUserSettings.js), so a person who turned them off is not given them on the first paint.
 */
export function useSingleKeyShortcuts() {
  const [on, setOnState] = useState(readStored)

  useEffect(() => {
    try { localStorage.setItem(SINGLE_KEY_SHORTCUTS_KEY, on ? 'on' : 'off') } catch { /* storage unavailable */ }
  }, [on])

  const setOn = useCallback((next) => { if (typeof next === 'boolean') setOnState(next) }, [])
  return { on, setOn }
}
