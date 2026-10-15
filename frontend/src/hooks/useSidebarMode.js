import { useCallback, useEffect, useState } from 'react'

export const SIDEBAR_MODES = [
  { id: 'hover',     label: 'Expand on hover', description: 'Icons only; labels appear while the pointer is over the rail.' },
  { id: 'expanded',  label: 'Expanded',        description: 'Labels always shown. The page makes room for the rail.' },
  { id: 'collapsed', label: 'Collapsed',       description: 'Icons only. Hover does nothing; keyboard focus still shows labels.' }
]

export const SIDEBAR_MODE_KEY = 'aber_sidebar_mode'
const DEFAULT_MODE = 'hover'

const isMode = (v) => SIDEBAR_MODES.some(m => m.id === v)

const readStored = () => {
  try {
    const v = localStorage.getItem(SIDEBAR_MODE_KEY)
    return isMode(v) ? v : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

/**
 * The rail's behaviour. localStorage keeps this browser's copy, the theme's arrangement: signed in,
 * the person's `user_settings` row is the source and this copy its cache (useUserSettings.js).
 */
export function useSidebarMode() {
  const [mode, setModeState] = useState(readStored)

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_MODE_KEY, mode) } catch { /* storage unavailable */ }
  }, [mode])

  const setMode = useCallback((next) => { if (isMode(next)) setModeState(next) }, [])
  return { mode, setMode }
}
