/**
 * Where a person's first page load through the forge's door goes. Gitea registers a login while it
 * serves that login's first request, after the door has answered, so a first page load is sent
 * through Gitea's sign-in path and comes back as a login that can be placed (supabase/README.md,
 * "The forge's door"). Measured against gitea/gitea:28.3.0: that path registers an unknown login and
 * answers 303 to a `redirect_to` on its own site, and to `/` for one on another host, one starting
 * `//`, or a path holding a backslash, encoded or not.
 *
 * At most one bounce for one visit, whatever Gitea answers: the return address carries
 * BOUNCED_PARAM, and a request carrying it for its own login is let through.
 */

/** Gitea's sign-in path. Let through for a login Gitea does not know, since it is what registers it. */
export const REGISTERING_PATH = "/user/login";

/**
 * Added to the return address, holding the login that was bounced. Holding the login, a link copied
 * from one person's address bar still bounces the next person.
 */
export const BOUNCED_PARAM = "aber_first_visit";

/** The listener's `path_prefix` (supabase/envoy.yaml): the path the browser asked for follows it. */
export const PATH_PREFIX = "/forge-membership";

/** A person's own page load. A browser sends no Sec-Fetch-Mode over plain HTTP, and there Accept tells it. */
export function isPageLoad(method: string, headers: Headers): boolean {
  if (method !== "GET") return false;
  const mode = headers.get("sec-fetch-mode");
  if (mode !== null) return mode === "navigate";
  return (headers.get("accept") ?? "").split(",").some((type) => type.split(";")[0].trim().toLowerCase() === "text/html");
}

/**
 * The path and query the browser asked the forge for, or null for a request the listener did not
 * send, or an address that could leave this host: one starting `//`, or holding a backslash.
 */
export function pathAskedFor(url: string): { path: string; query: string } | null {
  if (url.includes("\\")) return null;
  const { pathname, search } = new URL(url);
  if (!pathname.startsWith(`${PATH_PREFIX}/`)) return null;
  const path = pathname.slice(PATH_PREFIX.length);
  if (path.startsWith("//") || path.toLowerCase().includes("%5c")) return null;
  return { path, query: search };
}

/**
 * The address to send this request to, for a login the door admits and Gitea does not know; null to
 * let it through, as every request that is not a page load is.
 */
export function firstVisitBounce(req: Pick<Request, "method" | "url" | "headers">, login: string): string | null {
  if (!isPageLoad(req.method, req.headers)) return null;
  const asked = pathAskedFor(req.url);
  if (asked === null || asked.path === REGISTERING_PATH) return null;
  if (new URLSearchParams(asked.query).getAll(BOUNCED_PARAM).includes(login)) return null;
  const back = `${asked.path}${asked.query ? `${asked.query}&` : "?"}${BOUNCED_PARAM}=${login}`;
  return `${REGISTERING_PATH}?redirect_to=${encodeURIComponent(back)}`;
}
