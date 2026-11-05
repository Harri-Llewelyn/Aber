import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Sign-out where the chart runs no Studio (VITE_STUDIO_ENABLED 'false'): no request goes to a
 * Studio door, the forge's door is still asked to clear its cookie, and the person's door sessions
 * still end in the database. The real config, constants and door modules, with the deployment's
 * config injected before they load.
 */

const GLOBAL_KEY = '__ABER_CONFIG__'

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: vi.fn(), signOut: vi.fn() },
    rpc: vi.fn(),
  },
}))

/** Load signOut.js afresh with `injected` as the deployment config. */
async function loadSignOut(injected) {
  vi.resetModules()
  globalThis[GLOBAL_KEY] = injected
  const { supabase } = await import('../lib/supabaseClient')
  supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'dashboard-token' } } })
  supabase.auth.signOut.mockResolvedValue({ error: null })
  supabase.rpc.mockImplementation(() => ({ abortSignal: () => Promise.resolve({ data: 1, error: null }) }))
  return { supabase, ...(await import('../utils/signOut')), ...(await import('../utils/studioSignOut')) }
}

let fetchImpl

beforeEach(() => {
  fetchImpl = vi.fn().mockResolvedValue({ type: 'opaque' })
  vi.stubGlobal('fetch', fetchImpl)
})

afterEach(() => {
  delete globalThis[GLOBAL_KEY]
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const STUDIO = 'https://studio.plant.example'
const FORGE = 'https://git.plant.example'

describe('signing out with Studio off', () => {
  it('beacons no Studio door, and still the forge and the door sessions', async () => {
    const { supabase, signOutOfThisBrowser } = await loadSignOut({
      VITE_STUDIO_ENABLED: 'false', VITE_STUDIO_URL: '', VITE_GITEA_URL: FORGE,
    })

    await expect(signOutOfThisBrowser()).resolves.toEqual({ error: null })

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([`${FORGE}/oauth2/signout`])
    expect(supabase.rpc).toHaveBeenCalledWith('end_my_door_sessions')
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('sends nothing to the localhost fallback either', async () => {
    const { signOutOfStudio } = await loadSignOut({ VITE_STUDIO_ENABLED: 'false', VITE_STUDIO_URL: '' })
    await expect(signOutOfStudio()).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('beacons the Studio door as before with Studio on, or with the setting absent', async () => {
    for (const injected of [
      { VITE_STUDIO_ENABLED: 'true', VITE_STUDIO_URL: STUDIO, VITE_GITEA_URL: FORGE },
      { VITE_STUDIO_URL: STUDIO, VITE_GITEA_URL: FORGE },
    ]) {
      fetchImpl.mockClear()
      const { signOutOfThisBrowser } = await loadSignOut(injected)
      await signOutOfThisBrowser()
      expect(fetchImpl.mock.calls.map(([url]) => url).sort())
        .toEqual([`${FORGE}/oauth2/signout`, `${STUDIO}/oauth2/signout`])
    }
  })
})
