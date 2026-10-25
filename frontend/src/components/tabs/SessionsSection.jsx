import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Badge } from '../common/Badge'
import { EmptyState } from '../common/EmptyState'
import { HelpTip } from '../common/HelpTip'
import { IconLogOut, IconShieldAlert } from '../common/Icons'
import { LoadingState } from '../common/LoadingState'
import { ColumnHeader } from '../common/SortHeader'
import { Tooltip } from '../common/Tooltip'
import { ConfirmModal } from '../modals/ConfirmModal'
import { tabUrl } from '../../routes'
import { formatDateTime, formatRelative } from '../../utils/format'
import { sessionLabel, sortSessions } from '../../utils/sessions'

/** Where every message about a session links: this list. */
const SESSIONS_URL = tabUrl('profile', 'security')

/**
 * The Security tab's Sessions section: every session the signed-in person holds, in every browser
 * and service (`list_my_sessions()`, 0206), the one in use first. End ends one other session
 * (`end_my_session()`); Sign Out of All Other Sessions ends all of them at once (GoTrue's
 * `scope=others`), after a dialog that says what that ends. Each act reads the list again.
 *
 * `isPerson` is false for a machine identity, which signs in with a token and has nothing to list.
 */
export function SessionsSection({ isPerson = true, showToast }) {
  // undefined while the first read runs; the rows stay on screen while a later one does.
  const [sessions, setSessions] = useState(undefined)
  const [error, setError] = useState(null)
  const [ending, setEnding] = useState(null)
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

  const end = async (session) => {
    setEnding(session.id)
    try {
      await api.endMySession(session.id)
      showToast?.(`Session ended: ${sessionLabel(session)}.`, 'success', { to: SESSIONS_URL })
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setEnding(null)
      await load()
    }
  }

  const endOthers = async () => {
    try {
      await api.signOutOtherSessions()
      showToast?.('Signed out of all your other sessions.', 'success', { to: SESSIONS_URL })
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setConfirmingOthers(false)
      await load()
    }
  }

  const others = (sessions || []).filter(s => !s.is_current).length

  return (
    <section className="profile-section" aria-labelledby="profile-sessions-title">
      <div className="card-body profile-section-head">
        <div className="profile-section-heading">
          <h4 className="profile-section-title" id="profile-sessions-title">Sessions</h4>
          <HelpTip
            label="About sessions"
            text="Ending a session stops its access to the API at once. Grafana and Node-RED notice a little later. Studio and forge sign-ins outlive Sign Out until you end them here or they time out."
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
                        <ActionButton
                          className="btn btn-ghost btn-sm"
                          pending={ending === s.id}
                          pendingLabel="Ending…"
                          disabled={ending !== null}
                          onClick={() => end(s)}
                          aria-label={`End the session: ${label}`}
                        >
                          End
                        </ActionButton>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmingOthers && (
        <ConfirmModal
          title="Sign Out of All Other Sessions"
          icon={<IconLogOut size={18} />}
          message="This ends every session but the one you are using: your other browsers and programs, and your Grafana, Node-RED, Studio and forge sign-ins, in this browser too. This browser stays signed in to the dashboard."
          confirmLabel="Sign Out Others"
          pendingLabel="Signing out…"
          onConfirm={endOthers}
          onCancel={() => setConfirmingOthers(false)}
        />
      )}
    </section>
  )
}
