import React from 'react'
import { Badge } from './Badge'
import { ColumnHeader } from './SortHeader'
import { Tooltip } from './Tooltip'
import { formatDateTime, formatRelative } from '../../utils/format'
import { sessionLabel } from '../../utils/sessions'

/**
 * A list of sessions, one row each: Where, Started, Last active and End. The Profile page's
 * Security tab lists the signed-in person's own (`list_my_sessions()`, 0206), and a person's
 * drawer on People lists theirs (`person_sessions()`, 0212), so the two read alike.
 *
 * `onEnd(session)` is what a row's End does; End only asks, through the caller's dialog. The
 * session in use (`is_current`, which only the person's own list has) is marked This browser and
 * has no End. `theirs` words the column tips for another person's sessions. `className` is added
 * to the scrolling wrapper, which must stay a direct child of the card or section that holds it.
 */
export function SessionsTable({ sessions, onEnd, theirs = false, className = '' }) {
  return (
    <div className={`table-wrap${className ? ` ${className}` : ''}`}>
      <table>
        <thead>
          <tr>
            <ColumnHeader title={theirs
              ? 'The browser and system they signed in from, or the service that signed them in.'
              : 'The browser and system you signed in from, or the service that signed you in.'}
            >
              Where
            </ColumnHeader>
            <ColumnHeader title={theirs ? 'When they signed in.' : 'When you signed in.'}>Started</ColumnHeader>
            <ColumnHeader title="When the session last renewed its access. An open dashboard renews about once an hour.">Last active</ColumnHeader>
            <th className="row-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map(s => {
            const label = sessionLabel(s)
            return (
              <tr key={s.id} data-session={s.id}>
                <td>
                  {/* The browser's own words behind the short ones; a service's are GoTrue's. */}
                  <Tooltip text={s.service_name ? null : s.user_agent || null}>
                    <span className="session-where">{label}</span>
                  </Tooltip>
                  {s.service_name && <Badge size="sm" className="session-badge">Service</Badge>}
                  {s.is_current && <Badge size="sm" tone="info" className="session-badge">This browser</Badge>}
                </td>
                <td className="cell-meta">{formatDateTime(s.created_at)}</td>
                <td className="cell-meta">
                  <Tooltip text={formatDateTime(s.last_active_at)}>
                    <span>{formatRelative(s.last_active_at)}</span>
                  </Tooltip>
                </td>
                <td className="row-actions">
                  {!s.is_current && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onEnd(s)}
                      aria-label={`End the session: ${label}`}
                    >
                      End
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
