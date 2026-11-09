import React from 'react'
import { RouteLink } from './RouteLink'

/**
 * The key to the alert shading, beside a History tab's status line: its swatch named in words, and
 * how many alerts fired in the window, a link to them on the Alerts tab (`to`).
 */
export function AlertKey({ count, to }) {
  return (
    <p className="history-alert-key">
      <span className="history-alert-swatch" aria-hidden="true" />
      Shaded while an alert was firing:{' '}
      <RouteLink to={to} className="count-link" title="List them on the Alerts tab">
        {count} {count === 1 ? 'alert' : 'alerts'} in this window
      </RouteLink>
    </p>
  )
}
