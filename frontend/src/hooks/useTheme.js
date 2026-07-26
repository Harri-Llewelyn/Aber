import { useState, useEffect, useCallback } from 'react'

/**
 * Custom hook to manage application light/dark UI theme and localStorage persistence.
 */
export function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('factoryplus_theme') || 'dark')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('factoryplus_theme', theme)
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
