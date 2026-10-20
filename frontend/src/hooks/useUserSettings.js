import { useCallback, useEffect, useRef, useState } from 'react'
import { useTheme, THEMES } from './useTheme'
import { useSidebarMode, SIDEBAR_MODES } from './useSidebarMode'
import { useSingleKeyShortcuts } from './useSingleKeyShortcuts'
import { readUserSettings, seedUserSettings, saveUserSetting } from '../utils/userSettings'

/**
 * The signed-in person's theme, sidebar layout and single-key shortcuts: their `user_settings` row,
 * with the browser's copy (useTheme, useSidebarMode, useSingleKeyShortcuts) as its cache.
 *
 * The page paints from the cache, then the row arrives and wins, and the cache follows it. A person
 * with no row gets one seeded from the cache's theme and layout, so a choice made before rows
 * existed is kept; the shortcuts take the column's default, on. Each
 * change goes to the cache at once and to the row behind it; a choice made before the row arrived
 * is not overwritten by it.
 *
 * `source` says where the values on screen came from: 'loading' until the first read answers,
 * 'account' once the row has been read or written, 'browser' when it could not be (offline, or a
 * database without the table). In 'browser' the page works as before rows existed: each choice
 * holds in this browser only.
 */
export function useUserSettings(userId) {
  const { theme, setTheme } = useTheme()
  const { mode: sidebarMode, setMode: setSidebarModeOnly } = useSidebarMode()
  const { on: singleKeyShortcuts, setOn: setSingleKeyOnly } = useSingleKeyShortcuts()
  const [source, setSource] = useState(userId ? 'loading' : 'browser')

  // What the seed copies, and which choices were made since this person's read began.
  const cached = useRef({ theme, sidebarMode })
  cached.current = { theme, sidebarMode }
  const chosen = useRef(new Set())

  useEffect(() => {
    if (!userId) { setSource('browser'); return undefined }
    let alive = true
    chosen.current = new Set()
    setSource('loading')
    ;(async () => {
      try {
        let row = await readUserSettings(userId)
        if (!row) {
          await seedUserSettings(userId, cached.current)
          row = await readUserSettings(userId)
        }
        if (!alive) return
        if (row) {
          if (!chosen.current.has('theme')) setTheme(row.theme)
          if (!chosen.current.has('sidebar_mode')) setSidebarModeOnly(row.sidebar_mode)
          if (!chosen.current.has('single_key_shortcuts')) setSingleKeyOnly(row.single_key_shortcuts)
        }
        setSource(row ? 'account' : 'browser')
      } catch (err) {
        if (!alive) return
        console.warn('[useUserSettings] could not read your settings; using this browser\'s:', err?.message)
        setSource('browser')
      }
    })()
    return () => { alive = false }
  }, [userId, setTheme, setSidebarModeOnly, setSingleKeyOnly])

  const save = useCallback((column, value) => {
    chosen.current.add(column)
    if (!userId) return
    saveUserSetting(userId, column, value)
      .then(() => setSource('account'))
      .catch((err) => {
        console.warn('[useUserSettings] could not save your settings; kept in this browser:', err?.message)
        setSource('browser')
      })
  }, [userId])

  const chooseTheme = useCallback((next) => {
    if (!THEMES.includes(next)) return
    setTheme(next)
    save('theme', next)
  }, [setTheme, save])

  const chooseSidebarMode = useCallback((next) => {
    if (!SIDEBAR_MODES.some(m => m.id === next)) return
    setSidebarModeOnly(next)
    save('sidebar_mode', next)
  }, [setSidebarModeOnly, save])

  const chooseSingleKeyShortcuts = useCallback((next) => {
    if (typeof next !== 'boolean') return
    setSingleKeyOnly(next)
    save('single_key_shortcuts', next)
  }, [setSingleKeyOnly, save])

  return {
    theme,
    setTheme: chooseTheme,
    sidebarMode,
    setSidebarMode: chooseSidebarMode,
    singleKeyShortcuts,
    setSingleKeyShortcuts: chooseSingleKeyShortcuts,
    source,
  }
}
