import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { EmptyState } from '../common/EmptyState'
import { IconLogOut, IconShieldAlert } from '../common/Icons'
import { LoadingState } from '../common/LoadingState'
import { SessionsTable } from '../common/SessionsTable'
import { Tooltip } from '../common/Tooltip'
import { ConfirmModal } from '../modals/ConfirmModal'
import { tabUrl } from '../../routes'
import { plural } from '../../utils/format'
import { endSessionQuestion, sessionLabel, sortSessions } from '../../utils/sessions'

/** Where every message about a session links: this list. */
const SESSIONS_URL = tabUrl('profile', 'sessions')

/**
 * Profile's Sessions tab: every session the signed-in person holds, in every browser
 * and service (`list_my_sessions()`, 0206), the one in use first, in the table a person's drawer
 * on People shares. End ends one other session (`end_my_session()`), and Sign Out of All Other
 * Sessions ends all of them at once (`end_my_other_sessions()`, 0211), each after a dialog that
 * says what it ends. Both are recorded in the Audit Trail. Each act reads the list again.
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

  // Both run from a dialog, which shows a refusal and stays open. Read again either way.
  const end = async () => {
    const session = confirmingEnd
    try {
      await api.endMySession(session.id)
      setConfirmingEnd(null)
      showToast?.(`Session ended: ${sessionLabel(session)}.`, 'success', { to: SESSIONS_URL })
    } finally {
      await load()
    }
  }

  const endOthers = async () => {
    try {
      const ended = await api.signOutOtherSessions()
      setConfirmingOthers(false)
      showToast?.(
        ended > 0 ? `Signed out of ${plural(ended, 'other session')}.` : 'You had no other sessions to sign out of.',
        ended > 0 ? 'success' : 'info',
        { to: SESSIONS_URL },
      )
    } finally {
      await load()
    }
  }

  const others = (sessions || []).filter(s => !s.is_current).length

  // A fragment, not a wrapper: the table must stay a direct child of the card, which scrolls it.
  return (
    <>
      {/* The tab explains itself in its tooltip; the row under the bar holds only its button. */}
      {isPerson && (
        <div className="filter-bar">
          <div className="filter-bar-actions">
            <Tooltip text={sessions && others === 0 ? 'You have no other sessions.' : null}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!sessions || others === 0}
                onClick={() => setConfirmingOthers(true)}
              >
                <IconLogOut size={13} /> Sign Out of All Other Sessions
              </button>
            </Tooltip>
          </div>
        </div>
      )}

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
        <SessionsTable sessions={sessions} onEnd={setConfirmingEnd} />
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
