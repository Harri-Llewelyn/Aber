import React, { useLayoutEffect, useRef } from 'react'
import { IconAlertCircle, IconLock } from './Icons'
import { formatClockTime } from '../../utils/format'
import { CONNECTION_STALE, CONNECTION_SESSION_ENDED } from '../../lib/connectionState'

/**
 * The row under the top bar that says the page has stopped updating, or that the session has
 * ended. It sits in the shell's column, so it pushes the page down rather than covering it. The
 * live region is always rendered, empty while all is well, so a screen reader already knows it
 * when a message arrives (the toast stack does the same).
 *
 * Its height is published as --connection-strip-height on the shell, for the drawer that overlays
 * the page on a narrow screen and must start below it.
 */
export function ConnectionStrip({ status, since, onSignInAgain }) {
  const regionRef = useRef(null)

  useLayoutEffect(() => {
    const region = regionRef.current
    const shell = region?.parentElement
    if (!region || !shell || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      shell.style.setProperty('--connection-strip-height', `${region.getBoundingClientRect().height}px`)
    })
    observer.observe(region)
    return () => {
      observer.disconnect()
      shell.style.removeProperty('--connection-strip-height')
    }
  }, [])

  return (
    <div ref={regionRef} className="connection-strip-region" role="status" aria-live="polite">
      {status === CONNECTION_STALE && (
        <div className="connection-strip">
          <IconAlertCircle size={15} className="connection-strip-icon" aria-hidden="true" />
          <span className="connection-strip-text">
            Not updating since {formatClockTime(since)}. Retrying. Values on this page may be out of date.
          </span>
        </div>
      )}
      {status === CONNECTION_SESSION_ENDED && (
        <div className="connection-strip">
          <IconLock size={15} className="connection-strip-icon" aria-hidden="true" />
          <span className="connection-strip-text">Your session has ended.</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={onSignInAgain}>
            Sign In Again
          </button>
        </div>
      )}
    </div>
  )
}
