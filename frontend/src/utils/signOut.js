import { supabase } from '../lib/supabaseClient'
import { signOutOfForge, signOutOfStudio } from './studioSignOut'

/** How long the sign-out waits for the door sessions to end, as the door beacons wait. */
export const DOOR_SESSIONS_TIMEOUT_MS = 2000

/**
 * End every Studio and forge door session the person holds (end_my_door_sessions(), 0208). A door
 * session belongs to a browser the dashboard cannot name, so all of them go; a door in another
 * browser signs in again by itself while the dashboard is signed in there. Skipped with no session
 * stored. Resolves false rather than rejects, within DOOR_SESSIONS_TIMEOUT_MS: a failure here must
 * not stop the sign-out.
 *
 * @returns {Promise<boolean>} Whether the database answered that it ended them.
 */
export async function endDoorSessions() {
  const abort = new AbortController()
  let timer
  const work = (async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return false
    const { error } = await supabase.rpc('end_my_door_sessions').abortSignal(abort.signal)
    if (error) console.warn('[auth] could not end the door sessions:', error.message)
    return !error
  })().catch((err) => {
    console.warn('[auth] could not end the door sessions:', err?.message)
    return false
  })
  const outOfTime = new Promise((resolve) => {
    timer = setTimeout(() => { abort.abort(); resolve(false) }, DOOR_SESSIONS_TIMEOUT_MS)
  })
  try {
    return await Promise.race([work, outOfTime])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Sign this browser out: the account menu's Sign Out and the `/sign-out` route. The person's door
 * sessions end first, because once the dashboard's own session has gone its token is refused
 * (0205). signOut() then ends this browser's dashboard session only (scope 'local'); the person's
 * other browsers, Grafana and Node-RED keep theirs. The beacons ask both doors to clear their
 * cookies here, alongside.
 *
 * @returns {Promise<{ error: unknown }>} The dashboard's sign-out result; nothing else rejects.
 */
export async function signOutOfThisBrowser() {
  const beacons = Promise.all([signOutOfStudio(), signOutOfForge()])
  await endDoorSessions()
  const result = await supabase.auth.signOut({ scope: 'local' })
  await beacons
  return { error: result?.error ?? null }
}

/** What the sign-in page says after `/sign-out`, by its `from`. Only these values are read. */
const SIGNED_OUT_FROM = {
  forge: 'You signed out of the forge.',
}

/** The notice for a `/sign-out` address's query string; an unknown or missing `from` is ignored. */
export function signedOutNotice(search = '') {
  const from = new URLSearchParams(search).get('from')
  return Object.hasOwn(SIGNED_OUT_FROM, from) ? SIGNED_OUT_FROM[from] : 'You signed out.'
}
