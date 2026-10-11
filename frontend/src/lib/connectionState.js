/**
 * Whether the dashboard is still refreshing what it shows. usePolling and useRealtimeTable report
 * every outcome here, and the strip under the top bar and the tab title read the result. Module
 * state rather than React state for the reason lib/apiActivity gives: the reporters are hooks on
 * every page and the reader is one bar. Framework-free, so it can be tested without rendering.
 */

/** How long a failure must last before anything is shown, so one dropped request never flashes. */
export const STALE_AFTER_MS = 10000

/** What `reportRefreshFailed` sorts an error into. */
export const FAILURE_ABORTED = 'aborted'
export const FAILURE_SESSION = 'session'
export const FAILURE_UNREACHABLE = 'unreachable'
export const FAILURE_OTHER = 'other'

/** What the strip shows. OK covers a failure younger than STALE_AFTER_MS. */
export const CONNECTION_OK = 'ok'
export const CONNECTION_STALE = 'stale'
export const CONNECTION_SESSION_ENDED = 'session-ended'

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
// PostgREST's JWT group: the token is malformed, expired or missing. All are a 401. The message
// form is for an error rethrown as its message alone.
const SESSION_CODE = /^PGRST30[123]$/
const SESSION_MESSAGE = /jwt expired|jwserror|bad_jwt/i

let failingSince = null
let lastRefreshAt = null
let sessionEnded = false
let shownTimer = null
const listeners = new Set()
let snapshot = computeSnapshot()

function computeSnapshot() {
  if (failingSince === null) return { status: CONNECTION_OK, failing: false, since: null }
  const shown = Date.now() - failingSince >= STALE_AFTER_MS
  return {
    status: !shown ? CONNECTION_OK : sessionEnded ? CONNECTION_SESSION_ENDED : CONNECTION_STALE,
    failing: true,
    // The last refresh that worked, or the first failure when nothing has worked yet.
    since: lastRefreshAt ?? failingSince
  }
}

function emit() {
  const next = computeSnapshot()
  if (next.status === snapshot.status && next.failing === snapshot.failing && next.since === snapshot.since) return
  snapshot = next
  for (const fn of listeners) fn(snapshot)
}

function markFailing() {
  if (failingSince === null) {
    failingSince = Date.now()
    // Re-evaluated once the failure is old enough to show; nothing else would emit at that moment.
    shownTimer = setTimeout(() => { shownTimer = null; emit() }, STALE_AFTER_MS)
  }
  emit()
}

function clearFailing() {
  failingSince = null
  sessionEnded = false
  if (shownTimer) { clearTimeout(shownTimer); shownTimer = null }
  emit()
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

  if (status === 401 || SESSION_CODE.test(code)) return FAILURE_SESSION
  if (status === 0 || status >= 500 || UNREACHABLE_CODE.test(code)) return FAILURE_UNREACHABLE
  if (status === undefined) {
    if (SESSION_MESSAGE.test(message)) return FAILURE_SESSION
    if (err.name === 'AuthRetryableFetchError' || err.name === 'FunctionsFetchError') return FAILURE_UNREACHABLE
    if (NETWORK_FAILURE.test(message) || GATEWAY_FAILURE.test(message)) return FAILURE_UNREACHABLE
  }
  return FAILURE_OTHER
}

/** A refresh worked: the page is current again. */
export function reportRefreshSucceeded() {
  lastRefreshAt = Date.now()
  clearFailing()
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
    markFailing()
  } else if (kind === FAILURE_UNREACHABLE) {
    markFailing()
  }
  return kind
}

/** A Realtime channel's subscribe status. CLOSED is a channel being removed, and says nothing. */
export function reportRealtimeStatus(status) {
  if (status === 'SUBSCRIBED') clearFailing()
  else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') markFailing()
}

/**
 * Follow the browser's own view of the network: offline marks the connection failing at once.
 * Coming back online clears nothing; the next refresh that works does. Returns the cleanup.
 */
export function watchBrowserConnectivity(target = window) {
  const onOffline = () => markFailing()
  if (typeof navigator !== 'undefined' && navigator.onLine === false) markFailing()
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
  failingSince = null
  lastRefreshAt = null
  sessionEnded = false
  if (shownTimer) { clearTimeout(shownTimer); shownTimer = null }
  emit()
}
