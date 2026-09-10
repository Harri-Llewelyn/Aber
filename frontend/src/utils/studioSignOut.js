import { GITEA_URL, STUDIO_URL } from '../constants';

/**
 * End the sessions the gateway holds in front of Studio and the forge, which are not this
 * application's session.
 *
 * =================================================================================================
 * WHY THIS EXISTS
 *
 * Studio has no login of its own; the gateway holds one in front of it (the `studio` listener in
 * supabase/envoy.yaml, registered by migration 0081). That listener keeps its OWN cookie, minted
 * by Envoy's oauth2 filter, and verifies the token in it locally against the shared HS256 secret.
 * It never asks GoTrue whether the session behind that token still exists.
 *
 * So `supabase.auth.signOut()` does not close Studio. It revokes the token GoTrue signed -- that
 * much is real, and a revoked token is refused by GoTrue's own /user endpoint -- but Envoy is not
 * asking, so the console stays open on the signed-out identity until the cached token expires.
 *
 * THAT IS NOT HYPOTHETICAL. It is what an admin sign-out followed by an operator sign-in did on
 * this stack: the operator reached Studio as the previous admin, because the browser still held
 * Envoy's cookie and nothing in the sign-out path had ever touched it.
 *
 * THE FORGE HAS THE SAME DOOR (the `forge` listener; 0094) and therefore the same cookie and the
 * same failure, so it gets the same beacon. The two are separate calls to separate origins, and
 * each is best-effort on its own: a deployment without a forge must still close Studio, and the
 * other way round.
 *
 * =================================================================================================
 * WHY A FETCH AND NOT A LINK
 *
 * `/oauth2/signout` answers 302 with five expired Set-Cookie headers. Following it in the current
 * tab would navigate the user away from the dashboard mid-sign-out; an iframe would then chase the
 * redirect back into the login flow. A no-cors GET takes the Set-Cookie headers and discards the
 * rest, which is all this needs.
 *
 * IT WORKS CROSS-ORIGIN BECAUSE IT IS NOT CROSS-SITE. SameSite is about the registrable domain and
 * ignores the port, so the dashboard on `:3000` and Studio on `:54323` are one site and the cookies
 * ride along -- and on Kubernetes `app.<domain>` and `studio.<domain>` are one site for the same
 * reason. What it does NOT survive is a host mismatch: see STUDIO_URL's note in constants.js.
 *
 * =================================================================================================
 * IT IS BEST-EFFORT, DELIBERATELY
 *
 * Signing out must not depend on a second origin being reachable. Studio may be off (Kubernetes
 * ships `routes.studio: false`), the gateway may be down, the address may be wrong on a deployment
 * that never set one. In every one of those cases the local sign-out must still happen, so this
 * resolves rather than rejects and the caller does not wait on it.
 *
 * The session cap on the listener is the backstop for whatever this misses -- including the case
 * this can never cover, which is the tab nobody signs out of at all.
 *
 * HENCE THE TIMEOUT. `fetch` has no default one, and an unreachable Studio holds a connection open
 * until the browser gives up minutes later. Without this the sign-out button would appear to hang
 * on a deployment that does not even run Studio -- a worse failure than the one being fixed.
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
      // The 302 is the answer, not a step on the way to one. Following it would pull the browser
      // into the door's login flow to no purpose, and its Set-Cookie headers have already been
      // applied by the time this resolves.
      redirect: 'manual',
      cache: 'no-store',
    });
    return true;
  } catch {
    // An opaque response is indistinguishable from a network failure here, so this catch cannot
    // tell "not deployed" from "did not answer" -- and must treat both the same. The abort above
    // lands here too.
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
