import React from 'react'
import { ColumnHeader } from './SortHeader'
import { Tooltip } from './Tooltip'
import { formatDateTime, formatRelative } from '../../utils/format'
import { SCOPES_TIP, scopesText } from '../../utils/apps'

/**
 * Approvals of apps that sign people in, one row each, in the Sessions table's shape: who or what,
 * when it was allowed, what it may read, and Revoke. The Profile page's Security tab lists the
 * apps a person has allowed (`list_my_app_approvals()`, 0217); an app's drawer on Access Control ›
 * Apps lists the people who allowed it (`app_approvals()`).
 *
 * Each row is `{ key, label, description, granted_at, scopes }`: `label` is drawn in the first
 * column and `description` names the row in Revoke's accessible name. `onRevoke(row)` only asks,
 * through the caller's dialog. `first` is the first column's heading and tip. `className` is added
 * to the scrolling wrapper, which must stay a direct child of the card or section that holds it.
 */
export function AppApprovalsTable({ rows, onRevoke, first, className = '' }) {
  return (
    <div className={`table-wrap${className ? ` ${className}` : ''}`}>
      <table>
        <thead>
          <tr>
            <ColumnHeader title={first.tip}>{first.title}</ColumnHeader>
            <ColumnHeader title="When the app was allowed, the last time it asked.">Allowed</ColumnHeader>
            <ColumnHeader title={SCOPES_TIP}>Can read</ColumnHeader>
            <th className="row-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td className="cell-meta">
                <Tooltip text={formatDateTime(r.granted_at)}>
                  <span>{formatRelative(r.granted_at)}</span>
                </Tooltip>
              </td>
              <td className="mono cell-meta">{scopesText(r.scopes)}</td>
              <td className="row-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => onRevoke(r)}
                  aria-label={`Revoke: ${r.description}`}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
