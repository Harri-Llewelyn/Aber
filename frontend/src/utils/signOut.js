import { supabase } from '../lib/supabaseClient'
import { signOutOfForge, signOutOfStudio } from './studioSignOut'

/**
 * Sign this browser out: the account menu's Sign Out and the `/sign-out` route. signOut() ends this
 * browser's dashboard session only (scope 'local'); the person's other browsers and services keep
 * theirs. Studio and the forge sit behind sessions the gateway owns, so a beacon clears each door's
 * cookie alongside it. All three start in the same tick, so a slow console cannot delay the
 * sign-out, and signOut() is called synchronously, which navigationShell.test.jsx asserts.
 *
 * @returns {Promise<{ error: unknown }>} The dashboard's sign-out result; the beacons never reject.
 */
export async function signOutOfThisBrowser() {
  const [, , result] = await Promise.all([
    signOutOfStudio(), signOutOfForge(), supabase.auth.signOut({ scope: 'local' }),
  ])
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
