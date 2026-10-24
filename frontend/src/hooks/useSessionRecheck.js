import { useEffect, useRef } from 'react'
import { askAuthServer } from '../utils/sessionError'

/** The least time between two checks, so moving between windows does not keep asking. */
export const SESSION_RECHECK_MS = 60000

/**
 * Ask the auth server about the session each time the tab is shown again, at most once a
 * SESSION_RECHECK_MS. This catches a session that ended while the person was in another window (a
 * Sign Out elsewhere, a password change), which nothing else notices: PostgREST checks only the
 * token's signature. `onRejected(error)` runs only for a refusal; an unreachable auth server changes
 * nothing.
 *
 * @param {boolean} enabled True while signed in. The session was checked on the way in, so the
 * first check waits SESSION_RECHECK_MS from then.
 *
 * @param {(error: unknown) => void} onRejected Called even if `enabled` has turned false meanwhile,
 * since auth-js drops a refused session before getUser() returns.
 */
export function useSessionRecheck(enabled, onRejected) {
  const onRejectedRef = useRef(onRejected)
  useEffect(() => { onRejectedRef.current = onRejected }, [onRejected])

  useEffect(() => {
    if (!enabled) return undefined
    let lastAsked = Date.now()
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastAsked < SESSION_RECHECK_MS) return
      lastAsked = now
      askAuthServer()
        .then(answer => { if (answer.rejected) onRejectedRef.current(answer.error) })
        .catch(err => console.warn('[auth] could not re-check the session:', err?.message))
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [enabled])
}
