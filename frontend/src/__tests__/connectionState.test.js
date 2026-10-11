import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  STALE_AFTER_MS,
  REALTIME_RECONCILE_WINDOW_MS,
  FAILURE_ABORTED,
  FAILURE_SESSION,
  FAILURE_UNREACHABLE,
  FAILURE_OTHER,
  CONNECTION_OK,
  CONNECTION_STALE,
  CONNECTION_SESSION_ENDED,
  classifyRefreshError,
  reportRefreshSucceeded,
  reportRefreshFailed,
  reportRealtimeStatus,
  watchBrowserConnectivity,
  getConnectionSnapshot,
  subscribeToConnection,
  resetConnectionState
} from '../lib/connectionState'
import { refreshInterval } from '../constants'

/**
 * The shared connection state behind the strip under the top bar: what marks it failing, what
 * clears it, and the threshold before anything is shown.
 */

// The shapes a failed refresh actually arrives in. supabase-js returns PostgREST errors as plain
// objects without the HTTP status, and a fetch rejection as a message.
const networkError = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }
const envoyDown = { message: 'no healthy upstream' }
const jwtExpired = { code: 'PGRST303', message: 'JWT expired', details: null, hint: null }
const permissionDenied = { code: '42501', message: 'permission denied for table devices', details: null, hint: null }

const status = () => getConnectionSnapshot().status

describe('classifyRefreshError', () => {
  it.each([
    ['a PostgREST fetch rejection', networkError],
    ['a bare fetch rejection', new TypeError('Failed to fetch')],
    ['Firefox\'s wording', new TypeError('NetworkError when attempting to fetch resource.')],
    ['Safari\'s wording', { message: 'TypeError: Load failed', code: '' }],
    ['a message rethrown without its error', new Error('TypeError: Failed to fetch')],
    ['an Envoy body with no upstream', envoyDown],
    ['an Envoy body that could not connect', { message: 'upstream connect error or disconnect/reset before headers. reset reason: connection failure' }],
    ['an NGINX 502 page', new Error('<html><head><title>502 Bad Gateway</title></head></html>')],
    ['a 503 with its status', Object.assign(new Error('Service down'), { status: 503 })],
    ['a 502 from an Edge Function response', { message: 'x', context: { status: 502 } }],
    ['PostgREST unable to reach the database', { code: 'PGRST000', message: 'Database connection error' }],
    ['PostgREST timing out on its pool', { code: 'PGRST003', message: 'Timed out acquiring connection' }],
    ['a connection exception from the database', { code: '08006', message: 'connection failure' }],
    ['the auth client unable to reach its server', { name: 'AuthRetryableFetchError', message: 'Failed', status: undefined }]
  ])('calls %s unreachable', (_label, err) => {
    expect(classifyRefreshError(err)).toBe(FAILURE_UNREACHABLE)
  })

  it.each([
    ['a 401 with its status', Object.assign(new Error('Unauthorized'), { status: 401 })],
    ['PostgREST\'s expired token', jwtExpired],
    ['PostgREST\'s undecodable token', { code: 'PGRST301', message: 'JWSError JWSInvalidSignature' }],
    ['an expired token rethrown as its message', new Error('JWT expired')]
  ])('calls %s a rejected session', (_label, err) => {
    expect(classifyRefreshError(err)).toBe(FAILURE_SESSION)
  })

  it.each([
    ['an aborted request', Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })],
    ['PostgREST\'s wrapped abort', { message: 'AbortError: The user aborted a request.', code: '' }]
  ])('calls %s aborted', (_label, err) => {
    expect(classifyRefreshError(err)).toBe(FAILURE_ABORTED)
  })

  // The server answered: a permission, a bad query or a bug says nothing about the connection.
  it.each([
    ['a 403', Object.assign(new Error('Forbidden'), { status: 403 })],
    ['a 404 that mentions a gateway', Object.assign(new Error('Bad Gateway id'), { status: 404 })],
    ['permission denied', permissionDenied],
    ['a PostgREST shape error', { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }],
    ['a programming error', new TypeError('Cannot read properties of undefined (reading \'map\')')],
    ['nothing at all', undefined]
  ])('leaves %s alone', (_label, err) => {
    expect(classifyRefreshError(err)).toBe(FAILURE_OTHER)
  })
})

describe('the connection state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 11, 14, 0, 0))
    resetConnectionState()
  })

  afterEach(() => {
    resetConnectionState()
    vi.useRealTimers()
  })

  it('starts with nothing to say', () => {
    expect(getConnectionSnapshot()).toEqual({ status: CONNECTION_OK, failing: false, since: null })
  })

  it('shows nothing until a failure has lasted the threshold', () => {
    const seen = []
    const unsubscribe = subscribeToConnection((s) => seen.push(s.status))

    expect(reportRefreshFailed(networkError)).toBe(FAILURE_UNREACHABLE)
    expect(getConnectionSnapshot().failing).toBe(true)
    expect(status()).toBe(CONNECTION_OK)

    vi.advanceTimersByTime(STALE_AFTER_MS - 1)
    expect(status()).toBe(CONNECTION_OK)

    vi.advanceTimersByTime(1)
    expect(status()).toBe(CONNECTION_STALE)
    // Told at the moment it crossed, with no new report to prompt it.
    expect(seen.at(-1)).toBe(CONNECTION_STALE)
    unsubscribe()
  })

  it('is about ten seconds', () => {
    expect(STALE_AFTER_MS).toBe(10000)
  })

  it('counts the threshold from the first failure, not the latest', () => {
    reportRefreshFailed(networkError)
    vi.advanceTimersByTime(6000)
    reportRefreshFailed(envoyDown)
    vi.advanceTimersByTime(4000)
    expect(status()).toBe(CONNECTION_STALE)
  })

  it('clears on the first success, and a single dropped request never shows', () => {
    reportRefreshFailed(networkError)
    vi.advanceTimersByTime(3000)
    reportRefreshSucceeded()
    expect(getConnectionSnapshot()).toEqual({ status: CONNECTION_OK, failing: false, since: null })

    vi.advanceTimersByTime(STALE_AFTER_MS * 2)
    expect(status()).toBe(CONNECTION_OK)
  })

  it('goes away on the next success once shown', () => {
    reportRefreshFailed(networkError)
    vi.advanceTimersByTime(STALE_AFTER_MS)
    expect(status()).toBe(CONNECTION_STALE)

    reportRefreshSucceeded()
    expect(status()).toBe(CONNECTION_OK)
    expect(getConnectionSnapshot().failing).toBe(false)
  })

  it('says since the last refresh that worked', () => {
    reportRefreshSucceeded()
    const lastGood = Date.now()
    vi.advanceTimersByTime(2 * 60000)

    reportRefreshFailed(networkError)
    vi.advanceTimersByTime(STALE_AFTER_MS)
    expect(getConnectionSnapshot().since).toBe(lastGood)
  })

  it('says since the first failure when nothing has worked yet', () => {
    const firstFailure = Date.now()
    reportRefreshFailed(networkError)
    vi.advanceTimersByTime(STALE_AFTER_MS)
    expect(getConnectionSnapshot().since).toBe(firstFailure)
  })

  it('neither marks nor clears on an error the server answered', () => {
    expect(reportRefreshFailed(permissionDenied)).toBe(FAILURE_OTHER)
    expect(getConnectionSnapshot().failing).toBe(false)

    reportRefreshFailed(networkError)
    reportRefreshFailed(permissionDenied)
    vi.advanceTimersByTime(STALE_AFTER_MS)
    expect(status()).toBe(CONNECTION_STALE)
  })

  it('ignores an aborted refresh', () => {
    expect(reportRefreshFailed({ name: 'AbortError', message: 'aborted' })).toBe(FAILURE_ABORTED)
    expect(getConnectionSnapshot().failing).toBe(false)
  })

  describe('Realtime', () => {
    // With no refresh to vouch for the data, a channel failure counts at once.
    it('marks failing on CHANNEL_ERROR when nothing has refreshed, and clears on SUBSCRIBED', () => {
      reportRealtimeStatus('CHANNEL_ERROR')
      expect(getConnectionSnapshot().failing).toBe(true)
      vi.advanceTimersByTime(STALE_AFTER_MS)
      expect(status()).toBe(CONNECTION_STALE)

      reportRealtimeStatus('SUBSCRIBED')
      expect(status()).toBe(CONNECTION_OK)
      expect(getConnectionSnapshot().failing).toBe(false)
    })

    it('marks failing on TIMED_OUT', () => {
      reportRealtimeStatus('TIMED_OUT')
      vi.advanceTimersByTime(STALE_AFTER_MS)
      expect(status()).toBe(CONNECTION_STALE)
    })

    // CLOSED is what removing a channel on unmount reports.
    it('says nothing on CLOSED', () => {
      reportRealtimeStatus('CLOSED')
      expect(getConnectionSnapshot().failing).toBe(false)

      reportRealtimeStatus('CHANNEL_ERROR')
      reportRealtimeStatus('CLOSED')
      expect(getConnectionSnapshot().failing).toBe(true)
    })

    it('sits a little above the 60-second reconcile poll every Realtime page pairs with', () => {
      expect(REALTIME_RECONCILE_WINDOW_MS).toBe(90000)
      expect(REALTIME_RECONCILE_WINDOW_MS).toBeGreaterThan(refreshInterval(true))
    })

    // The reconcile poll still brings data, so "Not updating" would be false. Showing for 50 s and
    // hiding for 10 s each cycle would be worse than either steady state on a wall display.
    it('never shows while Realtime is down and the reconcile poll keeps working', () => {
      const seen = []
      const unsubscribe = subscribeToConnection((s) => seen.push(s.failing))
      reportRefreshSucceeded()
      reportRealtimeStatus('CHANNEL_ERROR')

      for (let cycle = 0; cycle < 6; cycle++) {
        // The channel keeps retrying and failing between polls.
        for (let t = 0; t < 6; t++) {
          vi.advanceTimersByTime(10000)
          reportRealtimeStatus(t % 2 ? 'TIMED_OUT' : 'CHANNEL_ERROR')
          expect(getConnectionSnapshot().failing).toBe(false)
        }
        reportRefreshSucceeded()
      }
      vi.advanceTimersByTime(REALTIME_RECONCILE_WINDOW_MS - 1)
      expect(getConnectionSnapshot().failing).toBe(false)
      expect(seen).not.toContain(true)
      unsubscribe()
    })

    it('shows when Realtime is down and the polls are failing too', () => {
      reportRefreshSucceeded()
      reportRealtimeStatus('CHANNEL_ERROR')
      reportRefreshFailed(networkError)
      vi.advanceTimersByTime(STALE_AFTER_MS)
      expect(status()).toBe(CONNECTION_STALE)
    })

    // A page whose channel has no paired poll, or whose poll has stopped reporting.
    it('shows once Realtime is down and no refresh has worked for the window', () => {
      reportRefreshSucceeded()
      const lastGood = Date.now()
      reportRealtimeStatus('CHANNEL_ERROR')

      vi.advanceTimersByTime(REALTIME_RECONCILE_WINDOW_MS - 1)
      expect(getConnectionSnapshot().failing).toBe(false)
      vi.advanceTimersByTime(1)
      expect(getConnectionSnapshot().failing).toBe(true)
      expect(status()).toBe(CONNECTION_OK)

      // The threshold counts from when it became failing, and "since" is the last good refresh.
      vi.advanceTimersByTime(STALE_AFTER_MS - 1)
      expect(status()).toBe(CONNECTION_OK)
      vi.advanceTimersByTime(1)
      expect(getConnectionSnapshot()).toEqual({ status: CONNECTION_STALE, failing: true, since: lastGood })
    })

    it('counts the window from the channel failing when that is later than the last refresh', () => {
      reportRefreshSucceeded()
      vi.advanceTimersByTime(REALTIME_RECONCILE_WINDOW_MS + 5000)
      reportRealtimeStatus('CHANNEL_ERROR')
      expect(getConnectionSnapshot().failing).toBe(true)
      vi.advanceTimersByTime(STALE_AFTER_MS)
      expect(status()).toBe(CONNECTION_STALE)
    })

    it('does not clear a refresh failure on SUBSCRIBED alone', () => {
      reportRefreshFailed(networkError)
      reportRealtimeStatus('SUBSCRIBED')
      vi.advanceTimersByTime(STALE_AFTER_MS)
      expect(status()).toBe(CONNECTION_STALE)

      reportRealtimeStatus('SUBSCRIBED')
      expect(status()).toBe(CONNECTION_STALE)
      reportRefreshSucceeded()
      expect(status()).toBe(CONNECTION_OK)
    })

    it('does not clear the Realtime flag on a refresh alone: it only keeps it from showing', () => {
      reportRealtimeStatus('CHANNEL_ERROR')
      vi.advanceTimersByTime(STALE_AFTER_MS)
      expect(status()).toBe(CONNECTION_STALE)

      reportRefreshSucceeded()
      expect(status()).toBe(CONNECTION_OK)
      expect(getConnectionSnapshot().failing).toBe(false)

      // Still down, and nothing has refreshed since: it counts again once the window passes.
      vi.advanceTimersByTime(REALTIME_RECONCILE_WINDOW_MS + STALE_AFTER_MS)
      expect(status()).toBe(CONNECTION_STALE)

      reportRealtimeStatus('SUBSCRIBED')
      expect(status()).toBe(CONNECTION_OK)
      vi.advanceTimersByTime(REALTIME_RECONCILE_WINDOW_MS * 3)
      expect(getConnectionSnapshot().failing).toBe(false)
    })
  })

  describe('the browser going offline', () => {
    let stop

    afterEach(() => { stop?.(); stop = undefined; vi.restoreAllMocks() })

    it('marks failing at once, and coming back online clears nothing by itself', () => {
      stop = watchBrowserConnectivity()
      window.dispatchEvent(new Event('offline'))
      expect(getConnectionSnapshot().failing).toBe(true)

      vi.advanceTimersByTime(STALE_AFTER_MS)
      expect(status()).toBe(CONNECTION_STALE)

      window.dispatchEvent(new Event('online'))
      expect(status()).toBe(CONNECTION_STALE)

      reportRefreshSucceeded()
      expect(status()).toBe(CONNECTION_OK)
    })

    it('marks failing when the page opens offline', () => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
      stop = watchBrowserConnectivity()
      expect(getConnectionSnapshot().failing).toBe(true)
    })

    it('stops listening when cleaned up', () => {
      stop = watchBrowserConnectivity()
      stop()
      window.dispatchEvent(new Event('offline'))
      expect(getConnectionSnapshot().failing).toBe(false)
    })
  })

  describe('a rejected session', () => {
    it('says the session has ended once the threshold passes', () => {
      expect(reportRefreshFailed(jwtExpired)).toBe(FAILURE_SESSION)
      expect(status()).toBe(CONNECTION_OK)
      vi.advanceTimersByTime(STALE_AFTER_MS)
      expect(status()).toBe(CONNECTION_SESSION_ENDED)
    })

    it('outranks a network failure, before and after it', () => {
      reportRefreshFailed(networkError)
      vi.advanceTimersByTime(STALE_AFTER_MS)
      expect(status()).toBe(CONNECTION_STALE)

      // The failure is already old enough to show, so the message changes at once.
      reportRefreshFailed(jwtExpired)
      expect(status()).toBe(CONNECTION_SESSION_ENDED)

      reportRefreshFailed(networkError)
      expect(status()).toBe(CONNECTION_SESSION_ENDED)
    })

    // A token the auth client refreshes a moment later lets the next poll through.
    it('clears on the next success', () => {
      reportRefreshFailed(jwtExpired)
      vi.advanceTimersByTime(STALE_AFTER_MS)
      reportRefreshSucceeded()
      expect(status()).toBe(CONNECTION_OK)

      reportRefreshFailed(networkError)
      vi.advanceTimersByTime(STALE_AFTER_MS)
      expect(status()).toBe(CONNECTION_STALE)
    })
  })

  it('forgets everything on reset, so a new session starts clean', () => {
    reportRefreshSucceeded()
    reportRefreshFailed(jwtExpired)
    vi.advanceTimersByTime(STALE_AFTER_MS)
    resetConnectionState()
    expect(getConnectionSnapshot()).toEqual({ status: CONNECTION_OK, failing: false, since: null })

    // The old threshold timer is gone too.
    vi.advanceTimersByTime(STALE_AFTER_MS)
    expect(status()).toBe(CONNECTION_OK)

    const firstFailure = Date.now()
    reportRefreshFailed(networkError)
    vi.advanceTimersByTime(STALE_AFTER_MS)
    expect(getConnectionSnapshot()).toEqual({ status: CONNECTION_STALE, failing: true, since: firstFailure })
  })

  it('keeps the same snapshot object while nothing changes', () => {
    const a = getConnectionSnapshot()
    reportRefreshSucceeded()
    expect(getConnectionSnapshot()).toBe(a)
  })
})
