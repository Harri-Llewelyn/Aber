import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { Badge } from '../common/Badge'
import { EmptyState } from '../common/EmptyState'
import { HelpTip } from '../common/HelpTip'
import { IconLogOut, IconShieldAlert } from '../common/Icons'
import { LoadingState } from '../common/LoadingState'
import { ColumnHeader } from '../common/SortHeader'
import { Tooltip } from '../common/Tooltip'
import { ConfirmModal } from '../modals/ConfirmModal'
import { tabUrl } from '../../routes'
import { formatDate, formatDateTime, formatRelative, plural } from '../../utils/format'
import { sessionLabel, sortSessions } from '../../utils/sessions'

/** Where every message about a session links: this list. */
const SESSIONS_URL = tabUrl('profile', 'security')

/** How long ago, in words for a sentence: "5 minutes ago", "2 days ago", "on 25 Sept 2026". */
function agoInWords(ts, now) {
  const t = new Date(ts ?? NaN).getTime()
  if (Number.isNaN(t)) return null
  const seconds = Math.max(0, Math.round((now - t) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${plural(Math.floor(seconds / 60), 'minute')} ago`
  if (seconds < 86400) return `${plural(Math.floor(seconds / 3600), 'hour')} ago`
  const days = Math.floor(seconds / 86400)
  return days < 30 ? `${plural(days, 'day')} ago` : `on ${formatDate(t)}`
}

/**
 * The End dialog's question: the session as the Where column names it, when it was last active,
 * and what has to sign in again, a browser, a program or a service. Reads sessionLabel()'s words:
 * "A program (…)", "A browser on …" and "Not recorded" are describeUserAgent()'s.
 */
export function endSessionQuestion(session, now = Date.now()) {
  const label = sessionLabel(session)
  const when = agoInWords(session?.last_active_at, now)
  const lastActive = when ? `, last active ${when}` : ''
  if (session?.service_name) {
    return `End the session in ${label}${lastActive}? ${label} has to sign you in again.`
  }
  if (label === 'Not recorded') {
    return `End the session with no browser recorded${lastActive}? Whatever used it has to sign in again.`
  }
  const lowered = label.replace(/^A /, 'a ')
  if (label.startsWith('A program')) {
    return `End the session of ${lowered}${lastActive}? That program has to sign in again.`
  }
  return `End the session in ${lowered}${lastActive}? That browser has to sign in again.`
}

/**
 * The Security tab's Sessions section: every session the signed-in person holds, in every browser
 * and service (`list_my_sessions()`, 0206), the one in use first. End ends one other session
 * (`end_my_session()`), and Sign Out of All Other Sessions ends all of them at once
 * (`end_my_other_sessions()`, 0211), each after a dialog that says what it ends. Both are
 * recorded in the Audit Trail. Each act reads the list again.
 *
 * `isPerson` is false for a machine identity, which signs in with a token and has nothing to list.
 */
export function SessionsSection({ isPerson = true, showToast }) {
  // undefined while the first read runs; the rows stay on screen while a later one does.
  const [sessions, setSessions] = useState(undefined)
  const [error, setError] = useState(null)
  // The session End asks about, while its dialog is open.
  const [confirmingEnd, setConfirmingEnd] = useState(null)
  const [confirmingOthers, setConfirmingOthers] = useState(false)

  const load = useCallback(async () => {
    try {
      setSessions(sortSessions(await api.listMySessions()))
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { if (isPerson) load() }, [isPerson, load])

  const end = async () => {
    const session = confirmingEnd
    try {
      await api.endMySession(session.id)
      showToast?.(`Session ended: ${sessionLabel(session)}.`, 'success', { to: SESSIONS_URL })
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setConfirmingEnd(null)
      await load()
    }
  }

  const endOthers = async () => {
    try {
      const ended = await api.signOutOtherSessions()
      showToast?.(
        ended > 0 ? `Signed out of ${plural(ended, 'other session')}.` : 'You had no other sessions to sign out of.',
        ended > 0 ? 'success' : 'info',
        { to: SESSIONS_URL },
      )
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setConfirmingOthers(false)
      await load()
    }
  }

  const others = (sessions || []).filter(s => !s.is_current).length

  // A fragment, not a wrapper: the table must stay a direct child of the card, which scrolls it.
  return (
    <>
      <div className="card-body profile-section-head">
        <div className="profile-section-heading">
          <h4 className="profile-section-title">Sessions</h4>
          <HelpTip
            label="About sessions"
            text="Ending a session stops its access to the API at once. Grafana and Node-RED notice a little later. A session nobody uses for 7 days, or the time your site sets, ends by itself."
          />
          {isPerson && (
            <div className="profile-section-actions">
              <Tooltip text={sessions && others === 0 ? 'You have no other sessions.' : null}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={!sessions || others === 0}
                  onClick={() => setConfirmingOthers(true)}
                >
                  <IconLogOut size={13} /> Sign Out of All Other Sessions
                </button>
              </Tooltip>
            </div>
          )}
        </div>
        <p className="profile-section-note">
          Every browser and service you are signed in to. A service signs you in from its own server,
          so it shows no device. No address is recorded.
        </p>
      </div>

      {!isPerson ? (
        <EmptyState message="A machine identity signs in with a token, so it has no sessions to list." />
      ) : error ? (
        <div className="card-body">
          <div className="callout callout-danger" role="status">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>{error}</div>
          </div>
        </div>
      ) : sessions === undefined ? (
        <LoadingState label="sessions" />
      ) : sessions.length === 0 ? (
        <EmptyState message="No sessions are open." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <ColumnHeader title="The browser and system you signed in from, or the service that signed you in.">Where</ColumnHeader>
                <ColumnHeader title="When you signed in.">Started</ColumnHeader>
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
                          onClick={() => setConfirmingEnd(s)}
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
      )}

      {confirmingEnd && (
        <ConfirmModal
          title="End Session"
          icon={<IconLogOut size={18} />}
          message={endSessionQuestion(confirmingEnd)}
          confirmLabel="End Session"
          pendingLabel="Ending…"
          onConfirm={end}
          onCancel={() => setConfirmingEnd(null)}
        />
      )}

      {confirmingOthers && (
        <ConfirmModal
          title="Sign Out of All Other Sessions"
          icon={<IconLogOut size={18} />}
          message="This ends every session but the one you are using: your other browsers and programs, and your Grafana, Node-RED, Studio and forge sign-ins, in this browser too. This browser stays signed in to the dashboard."
          confirmLabel="Sign Out of All Other Sessions"
          pendingLabel="Signing out…"
          onConfirm={endOthers}
          onCancel={() => setConfirmingOthers(false)}
        />
      )}
    </>
  )
}
