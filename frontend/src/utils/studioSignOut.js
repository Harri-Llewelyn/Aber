import { GITEA_URL, STUDIO_URL } from '../constants';

/**
 * Ask the gateway's Studio and forge doors to clear the cookies they keep in this browser.
 *
 * Each door keeps its own cookie, minted by Envoy's oauth2 filter. A no-cors GET of the door's
 * `/oauth2/signout` carries it, and the answer's expired Set-Cookie headers clear it, but only
 * where the browser counts the door and the dashboard as one site: hosts that share a registrable
 * domain, such as app.site.example and git.site.example. `*.localhost` hosts share none, so there
 * the cookies stay. What signs the doors out everywhere is ending their GoTrue sessions
 * (end_my_door_sessions(), in utils/signOut.js): a door then sends its next request through its own
 * sign-out.
 *
 * Best-effort, deliberately: Studio may be off, the gateway down or the address unset, and the
 * local sign-out must still happen, so this resolves rather than rejects. The timeout exists
 * because `fetch` has none, and an unreachable Studio would otherwise hang the sign-out button.
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
      // No `redirect`: the Fetch standard refuses no-cors with anything but follow, before the
      // request is sent. Following the 302 enters the door's login flow, whose opaque answer is
      // discarded; the Set-Cookie headers on the 302 apply all the same.
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
