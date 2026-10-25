/**
 * Whether the dashboard is still refreshing what it shows. usePolling and useRealtimeTable report
 * every outcome here, api.js reports an edge function's refusal of the session, and the strip under
 * the top bar and the tab title read the result. Module state rather than React state for the
 * reason lib/apiActivity gives: the reporters are hooks on every page and the reader is one bar.
 * Framework-free, so it can be tested without rendering.
 */

/** How long a failure must last before anything is shown, so one dropped request never flashes. */
export const STALE_AFTER_MS = 10000

/**
 * How long a Realtime failure is tolerated while refreshes keep working. A little above the 60 s
 * reconcile poll that every Realtime page pairs with (refreshInterval(true) in constants.js), so a
 * channel that is down while the poll still brings data never shows the strip.
 */
export const REALTIME_RECONCILE_WINDOW_MS = 90000

/** What `reportRefreshFailed` sorts an error into. */
export const FAILURE_ABORTED = 'aborted'
export const FAILURE_SESSION = 'session'
export const FAILURE_UNREACHABLE = 'unreachable'
export const FAILURE_OTHER = 'other'

/** What the strip shows. OK covers a failure younger than STALE_AFTER_MS. */
export const CONNECTION_OK = 'ok'
export const CONNECTION_STALE = 'stale'
export const CONNECTION_SESSION_ENDED = 'session-ended'

/**
 * The code api.js gives an edge function's error when the answer said the session no longer exists.
 * classifyRefreshError() calls it a rejected session.
 */
export const SESSION_REFUSED = 'SESSION_REFUSED'

// fetch() rejecting, as Chromium, Firefox, Safari and Node word it. supabase-js turns the rejection
// into an error whose message is "TypeError: <this>", and api.js sometimes rethrows only the
// message.
const NETWORK_FAILURE = /failed to fetch|networkerror|network error|load failed|fetch failed|network request failed/i
// A proxy's own error body (Envoy, NGINX). supabase-js keeps a non-JSON body as the message and
// drops the HTTP status, so the text is all that is left of a 502, 503 or 504.
const GATEWAY_FAILURE = /no healthy upstream|upstream connect error|upstream request timeout|bad gateway|service unavailable|gateway time-?out/i
// PostgREST's connection group (database unreachable, pool exhausted, schema cache not loaded),
// and SQLSTATE connection exceptions and shutdowns, which PostgREST answers with a 503.
const UNREACHABLE_CODE = /^(PGRST00\d|08[0-9A-Z]{3}|57P0[123])$/
// PostgREST's JWT group (the token is malformed, expired or missing), and the API refusing a token
// whose session has ended (0205), which uses GoTrue's code for it. All are a 401. The message form
// is for an error rethrown as its message alone.
const SESSION_CODE = /^(PGRST30[123]|session_not_found)$/
const SESSION_MESSAGE = /jwt expired|jwserror|bad_jwt|this session has ended/i

// Two flags, each cleared only by its own kind of success. A refresh failure counts at once. A
// Realtime failure counts only once no refresh has worked for REALTIME_RECONCILE_WINDOW_MS: the
// reconcile poll still brings data meanwhile, and "Not updating" would be false.
let refreshFailingSince = null
let realtimeFailingSince = null
let lastRefreshAt = null
let sessionEnded = false
// When the auth server refused the session, which no refresh clears; see reportSessionRefused.
let sessionRefusedAt = null
let timer = null
const listeners = new Set()
let snapshot = computeSnapshot(Date.now())

/** When a Realtime failure starts to count: the later of the failure and the window's end. */
function realtimeCountsFrom() {
  if (realtimeFailingSince === null) return null
  return lastRefreshAt === null
    ? realtimeFailingSince
    : Math.max(realtimeFailingSince, lastRefreshAt + REALTIME_RECONCILE_WINDOW_MS)
}

/** When the connection became failing under the rule above, or null while it is not. */
function failingSinceAt(now) {
  const realtime = realtimeCountsFrom()
  const candidates = [refreshFailingSince, realtime !== null && realtime <= now ? realtime : null]
    .filter((t) => t !== null)
  return candidates.length ? Math.min(...candidates) : null
}

function computeSnapshot(now) {
  if (sessionRefusedAt !== null) return { status: CONNECTION_SESSION_ENDED, failing: true, since: sessionRefusedAt }
  const failingSince = failingSinceAt(now)
  if (failingSince === null) return { status: CONNECTION_OK, failing: false, since: null }
  const shown = now - failingSince >= STALE_AFTER_MS
  return {
    status: !shown ? CONNECTION_OK : sessionEnded ? CONNECTION_SESSION_ENDED : CONNECTION_STALE,
    failing: true,
    // The last refresh that worked, or the first failure when nothing has worked yet.
    since: lastRefreshAt ?? failingSince
  }
}

/** The next moment the snapshot can change with no report to prompt it, or null. */
function nextChangeAt(now) {
  const realtime = realtimeCountsFrom()
  const failingSince = failingSinceAt(now)
  const candidates = [
    realtime !== null && realtime > now ? realtime : null,
    failingSince !== null && failingSince + STALE_AFTER_MS > now ? failingSince + STALE_AFTER_MS : null
  ].filter((t) => t !== null)
  return candidates.length ? Math.min(...candidates) : null
}

/** Recompute, tell the listeners if anything changed, and wake again at the next change. */
function reevaluate() {
  const now = Date.now()
  const next = computeSnapshot(now)
  if (next.status !== snapshot.status || next.failing !== snapshot.failing || next.since !== snapshot.since) {
    snapshot = next
    for (const fn of listeners) fn(snapshot)
  }
  if (timer) { clearTimeout(timer); timer = null }
  const at = nextChangeAt(now)
  if (at !== null) timer = setTimeout(reevaluate, at - now)
}

function markRefreshFailing() {
  if (refreshFailingSince === null) refreshFailingSince = Date.now()
  reevaluate()
}

/**
 * Sort a refresh's error by what it says about the connection. The HTTP status is usually gone by
 * the time an error reaches a poll (see the patterns above), so the code and the message are read
 * too. Anything else, such as a 403 or a bad query, says the server answered: FAILURE_OTHER.
 */
export function classifyRefreshError(err) {
  if (!err) return FAILURE_OTHER
  const message = String(err.message ?? err)
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR' || /^AbortError\b/.test(message)) return FAILURE_ABORTED

  const status = typeof err.status === 'number' ? err.status
    : typeof err.context?.status === 'number' ? err.context.status
      : undefined
  const code = typeof err.code === 'string' ? err.code : ''

  if (status === 401 || SESSION_CODE.test(code) || code === SESSION_REFUSED) return FAILURE_SESSION
  if (status === 0 || status >= 500 || UNREACHABLE_CODE.test(code)) return FAILURE_UNREACHABLE
  if (status === undefined) {
    if (SESSION_MESSAGE.test(message)) return FAILURE_SESSION
    if (err.name === 'AuthRetryableFetchError' || err.name === 'FunctionsFetchError') return FAILURE_UNREACHABLE
    if (NETWORK_FAILURE.test(message) || GATEWAY_FAILURE.test(message)) return FAILURE_UNREACHABLE
  }
  return FAILURE_OTHER
}

/**
 * A refresh worked: the page is current again. Clears a refresh failure, and keeps a Realtime
 * failure from counting for the next REALTIME_RECONCILE_WINDOW_MS without clearing it.
 */
export function reportRefreshSucceeded() {
  lastRefreshAt = Date.now()
  refreshFailingSince = null
  sessionEnded = false
  reevaluate()
}

/**
 * A refresh failed. Marks the connection failing for an unreachable server or a rejected session,
 * and leaves it alone otherwise. Returns the kind, which usePolling uses to choose its next delay.
 */
export function reportRefreshFailed(err) {
  const kind = classifyRefreshError(err)
  if (kind === FAILURE_SESSION) {
    // Set before marking, so a failure already old enough to show switches message at once.
    sessionEnded = true
    markRefreshFailing()
  } else if (kind === FAILURE_UNREACHABLE) {
    markRefreshFailing()
  }
  return kind
}

/**
 * The auth server refused the session: an edge function, which asks it on every call, answered
 * that the session no longer exists. Shown at once, and kept until resetConnectionState(): Storage
 * and Realtime check only the token's signature, so a refresh through them can still work on the
 * dead session and must not clear it, and no refreshed token can arrive, since the session's
 * refresh tokens went with it.
 */
export function reportSessionRefused() {
  if (sessionRefusedAt === null) sessionRefusedAt = Date.now()
  reevaluate()
}

/**
 * A Realtime channel's subscribe status. An error or a timeout sets the Realtime flag and only
 * SUBSCRIBED clears it; CLOSED is a channel being removed, and says nothing.
 */
export function reportRealtimeStatus(status) {
  if (status === 'SUBSCRIBED') realtimeFailingSince = null
  else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && realtimeFailingSince === null) {
    realtimeFailingSince = Date.now()
  } else return
  reevaluate()
}

/**
 * Follow the browser's own view of the network: offline marks refreshes failing at once. Coming
 * back online clears nothing; the next refresh that works does. Returns the cleanup.
 */
export function watchBrowserConnectivity(target = window) {
  const onOffline = () => markRefreshFailing()
  if (typeof navigator !== 'undefined' && navigator.onLine === false) markRefreshFailing()
  target.addEventListener('offline', onOffline)
  return () => target.removeEventListener('offline', onOffline)
}

export function getConnectionSnapshot() {
  return snapshot
}

/** Subscribe to the snapshot. Returns an unsubscribe function. */
export function subscribeToConnection(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Forget everything: a new session starts with a clean state, so a failure from the last one
 * cannot show the moment someone signs in. Keeps the listeners, which belong to mounted readers.
 */
export function resetConnectionState() {
  refreshFailingSince = null
  realtimeFailingSince = null
  lastRefreshAt = null
  sessionEnded = false
  sessionRefusedAt = null
  reevaluate()
}
