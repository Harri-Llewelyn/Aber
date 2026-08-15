import { useState, useEffect, useCallback } from 'react'

/**
 * Custom hook to manage application light/dark UI theme and localStorage persistence.
 */
export function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('acs_cymru_theme') || 'dark')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('acs_cymru_theme', theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  return {
    theme,
    setTheme,
    toggleTheme
  }
}
