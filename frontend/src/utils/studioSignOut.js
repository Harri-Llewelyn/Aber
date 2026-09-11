import { GITEA_URL, STUDIO_URL } from '../constants';

/**
 * End the sessions the gateway holds in front of Studio and the forge, which are not this
 * application's session.
 *
 * Each listener keeps its own cookie, minted by Envoy's oauth2 filter and verified locally against
 * the shared secret, so `supabase.auth.signOut()` leaves both consoles open on the signed-out
 * identity until the token expires. A no-cors GET of `/oauth2/signout` takes the expired Set-Cookie
 * headers and discards the 302. It works cross-origin because SameSite ignores the port, and on
 * Kubernetes the subdomains are one site.
 *
 * Best-effort, deliberately: Studio may be off, the gateway down or the address unset, and the
 * local sign-out must still happen, so this resolves rather than rejects and the caller does not
 * wait. The timeout exists because `fetch` has none, and an unreachable Studio would otherwise hang
 * the sign-out button.
 */
const SIGNOUT_TIMEOUT_MS = 2000;

/** Beacon one door's signout path. Resolves true if the request was made, false otherwise. */
export async function signOutOfDoor(doorUrl, fetchImpl = globalThis.fetch) {
  if (!doorUrl || typeof fetchImpl !== 'function') return false;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SIGNOUT_TIMEOUT_MS);

  try {
    await fetchImpl(`${doorUrl}/oauth2/signout`, {
      method: 'GET',
      mode: 'no-cors',
      credentials: 'include',
      signal: abort.signal,
      // The 302 is the answer: its Set-Cookie headers are applied by the time this resolves, and
      // following it would enter the door's login flow.
      redirect: 'manual',
      cache: 'no-store',
    });
    return true;
  } catch {
    // An opaque response is indistinguishable from a network failure, so not deployed and did not
    // answer are treated the same. The abort lands here too.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function signOutOfStudio(fetchImpl = globalThis.fetch) {
  return signOutOfDoor(STUDIO_URL, fetchImpl);
}

export function signOutOfForge(fetchImpl = globalThis.fetch) {
  return signOutOfDoor(GITEA_URL, fetchImpl);
}
