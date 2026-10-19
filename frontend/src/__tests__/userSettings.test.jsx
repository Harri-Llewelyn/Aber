/**
 * A person's theme and sidebar layout follow them (useUserSettings.js): their `user_settings` row is
 * the source, and this browser's localStorage copy is its cache. What would go wrong quietly: the
 * cache beating the row, so a shared PC shows the last person's choice; a first sign-in losing the
 * choice the browser already had; a seed overwriting a row another tab wrote; a slow read undoing
 * a choice made while it was in flight; and an unreachable row breaking the page.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUserSettings } from '../hooks/useUserSettings'
import { THEME_KEY } from '../hooks/useTheme'
import { SIDEBAR_MODE_KEY } from '../hooks/useSidebarMode'
import { readUserSettings, seedUserSettings, saveUserSetting } from '../utils/userSettings'

vi.mock('../utils/userSettings', () => ({
  readUserSettings: vi.fn(),
  seedUserSettings: vi.fn(),
  saveUserSetting: vi.fn(),
}))

const ALICE = 'a1ce0000-0000-4000-8000-000000000001'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  seedUserSettings.mockResolvedValue(undefined)
  saveUserSetting.mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

const settle = async (result) => waitFor(() => expect(result.current.source).not.toBe('loading'))

describe('the row and the browser copy', () => {
  it('lets the row win over the browser copy, and refreshes the copy from it', async () => {
    // The last person on this PC chose light and collapsed; Alice's row says dark and expanded.
    localStorage.setItem(THEME_KEY, 'light')
    localStorage.setItem(SIDEBAR_MODE_KEY, 'collapsed')
    readUserSettings.mockResolvedValue({ theme: 'dark', sidebar_mode: 'expanded' })

    const { result } = renderHook(() => useUserSettings(ALICE))
    // The first paint is the cache's, before the row has answered.
    expect(result.current.theme).toBe('light')
    expect(result.current.source).toBe('loading')

    await settle(result)
    expect(result.current).toMatchObject({ theme: 'dark', sidebarMode: 'expanded', source: 'account' })
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('expanded')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(seedUserSettings).not.toHaveBeenCalled()
  })

  it("seeds a person with no row from the browser's copy, so nobody loses a choice", async () => {
    localStorage.setItem(THEME_KEY, 'light')
    localStorage.setItem(SIDEBAR_MODE_KEY, 'collapsed')
    readUserSettings
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ theme: 'light', sidebar_mode: 'collapsed' })

    const { result } = renderHook(() => useUserSettings(ALICE))
    await settle(result)

    expect(seedUserSettings).toHaveBeenCalledWith(ALICE, { theme: 'light', sidebarMode: 'collapsed' })
    expect(result.current).toMatchObject({ theme: 'light', sidebarMode: 'collapsed', source: 'account' })
  })

  it('reads again after the seed, and takes the row another tab created meanwhile', async () => {
    // The seed is ON CONFLICT DO NOTHING: if another tab got there first, its row is the one kept,
    // and the second read is how this tab learns which won.
    localStorage.setItem(THEME_KEY, 'light')
    readUserSettings
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ theme: 'dark', sidebar_mode: 'expanded' })

    const { result } = renderHook(() => useUserSettings(ALICE))
    await settle(result)

    expect(readUserSettings).toHaveBeenCalledTimes(2)
    expect(result.current).toMatchObject({ theme: 'dark', sidebarMode: 'expanded' })
  })

  it('does not let a slow read undo a choice made while it was in flight', async () => {
    let answer
    readUserSettings.mockReturnValue(new Promise(resolve => { answer = resolve }))
    const { result } = renderHook(() => useUserSettings(ALICE))

    act(() => result.current.setTheme('light'))
    await act(async () => { answer({ theme: 'dark', sidebar_mode: 'expanded' }) })
    await settle(result)

    // The theme the person just chose stands; the layout they did not touch comes from the row.
    expect(result.current).toMatchObject({ theme: 'light', sidebarMode: 'expanded' })
    expect(saveUserSetting).toHaveBeenCalledWith(ALICE, 'theme', 'light')
  })
})

describe('a choice', () => {
  beforeEach(() => readUserSettings.mockResolvedValue({ theme: 'dark', sidebar_mode: 'hover' }))

  it('goes to the row and the browser copy alike', async () => {
    const { result } = renderHook(() => useUserSettings(ALICE))
    await settle(result)

    act(() => result.current.setSidebarMode('collapsed'))
    expect(result.current.sidebarMode).toBe('collapsed')
    expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('collapsed')
    expect(saveUserSetting).toHaveBeenCalledWith(ALICE, 'sidebar_mode', 'collapsed')
  })

  /** The account menu's theme switch and Profile > Appearance write the one value, through setTheme. */
  it('from the account menu is the same write as one from the Profile page', async () => {
    const { result } = renderHook(() => useUserSettings(ALICE))
    await settle(result)

    act(() => result.current.setTheme('light'))
    expect(result.current.theme).toBe('light')
    expect(saveUserSetting).toHaveBeenLastCalledWith(ALICE, 'theme', 'light')

    act(() => result.current.setTheme('dark'))
    expect(saveUserSetting).toHaveBeenLastCalledWith(ALICE, 'theme', 'dark')
  })

  it('that the dashboard does not offer is ignored and never sent', async () => {
    const { result } = renderHook(() => useUserSettings(ALICE))
    await settle(result)

    act(() => result.current.setTheme('blue'))
    act(() => result.current.setSidebarMode('sideways'))
    expect(result.current).toMatchObject({ theme: 'dark', sidebarMode: 'hover' })
    expect(saveUserSetting).not.toHaveBeenCalled()
  })
})

describe('when the row cannot be reached', () => {
  it('keeps working from the browser copy and says so', async () => {
    localStorage.setItem(THEME_KEY, 'light')
    readUserSettings.mockRejectedValue(new Error('Failed to fetch'))

    const { result } = renderHook(() => useUserSettings(ALICE))
    await settle(result)

    expect(result.current).toMatchObject({ theme: 'light', source: 'browser' })
  })

  it('keeps a choice in this browser when the save is refused', async () => {
    readUserSettings.mockResolvedValue({ theme: 'dark', sidebar_mode: 'hover' })
    saveUserSetting.mockRejectedValue(new Error('relation "public.user_settings" does not exist'))

    const { result } = renderHook(() => useUserSettings(ALICE))
    await settle(result)
    act(() => result.current.setTheme('light'))

    await waitFor(() => expect(result.current.source).toBe('browser'))
    expect(result.current.theme).toBe('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
  })

  it('reads nothing with no person signed in', () => {
    const { result } = renderHook(() => useUserSettings(undefined))
    expect(result.current.source).toBe('browser')
    expect(readUserSettings).not.toHaveBeenCalled()
  })
})
