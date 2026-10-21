import { useCallback, useEffect, useState } from 'react'

export const HELP_EXPANDED_KEY = 'aber_help_expanded'

const readStored = () => {
  try {
    return localStorage.getItem(HELP_EXPANDED_KEY) === 'on'
  } catch {
    return false
  }
}

/**
 * Whether the help panel is expanded to half the window. This browser's choice, kept in
 * localStorage as the rail's mode is, but not in the person's `user_settings` row: how wide a panel
 * suits a screen belongs to the screen.
 */
export function useHelpExpanded() {
  const [expanded, setExpandedState] = useState(readStored)

  useEffect(() => {
    try { localStorage.setItem(HELP_EXPANDED_KEY, expanded ? 'on' : 'off') } catch { /* storage unavailable */ }
  }, [expanded])

  const setExpanded = useCallback((next) => { if (typeof next === 'boolean') setExpandedState(next) }, [])
  return { expanded, setExpanded }
}
