import { useState, useEffect, useCallback } from 'react'

export const THEMES = ['dark', 'light']
export const THEME_KEY = 'aber_theme'
const DEFAULT_THEME = 'dark'

const isTheme = (v) => THEMES.includes(v)

const readStored = () => {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return isTheme(v) ? v : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/**
 * The light/dark theme, painted on `<html data-theme>`. localStorage keeps this browser's copy, so
 * the first paint and the sign-in screen are in the last theme used here. Signed in, the person's
 * `user_settings` row is the source and this copy its cache (useUserSettings.js).
 */
export function useTheme() {
  const [theme, setThemeState] = useState(readStored)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem(THEME_KEY, theme) } catch { /* storage unavailable */ }
  }, [theme])

  const setTheme = useCallback((next) => { if (isTheme(next)) setThemeState(next) }, [])

  const toggleTheme = useCallback(() => {
    setThemeState(t => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  return {
    theme,
    setTheme,
    toggleTheme
  }
}
