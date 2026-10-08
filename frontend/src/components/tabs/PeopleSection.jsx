import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Badge } from '../common/Badge'
import { EmptyState } from '../common/EmptyState'
import { IconPlus, IconRefreshCw, IconShieldAlert, IconUser } from '../common/Icons'
import { LoadingState } from '../common/LoadingState'
import { AddPersonModal } from '../modals/AddPersonModal'
import { ConfirmModal } from '../modals/ConfirmModal'
import { NewPasswordModal } from '../modals/NewPasswordModal'
import { formatDateTime } from '../../utils/format'
import {
  PERSON_ROLES,
  passwordSetBlocked,
  personRoleLabel,
  personStatus,
  removalBlocked,
  roleChangeBlocked,
} from '../../utils/people'

/**
 * Access Control's People tab: every person who can sign in, with their role, for an
 * Administrator to add, re-role, remove or restore, or to give a new password. Roles are set
 * through set_person_role(); adding, removing, restoring and setting a password go through
 * manage-people, which holds GoTrue's secret key. The database refuses your own role, access or
 * password and the last Administrator who can sign in; the controls are disabled for those with
 * the reason as their tooltip. A new password is shown once, in NewPasswordModal.
 */
export function PeopleSection({ showToast, currentUserId }) {
  const [people, setPeople] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  // { act: 'remove' | 'restore' | 'password', person } while the confirmation is open.
  const [confirming, setConfirming] = useState(null)
  // { email, password } while a new password is on screen; gone when its dialog closes.
  const [newPassword, setNewPassword] = useState(null)
  // The user_id whose role is being saved, so its select shows the wait.
  const [savingRole, setSavingRole] = useState(null)

  const load = useCallback(() => {
    api.listPeople()
      .then(d => { setPeople(d); setError(null); setLoading(false) })
      .catch(e => { setError(e?.message || 'Could not list people.'); setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

  const changeRole = useCallback(async (person, role) => {
    if (!role || role === person.role) return
    setSavingRole(person.user_id)
    try {
      await api.setPersonRole(person.user_id, role)
      showToast?.(`${person.email} is now ${personRoleLabel(role)}`, 'success')
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setSavingRole(null)
      load()
    }
  }, [load, showToast])

  const confirmAct = useCallback(async () => {
    const { act, person } = confirming
    try {
      if (act === 'remove') {
        await api.removePersonAccess(person.user_id)
        showToast?.(`${person.email} can no longer sign in`, 'success')
      } else if (act === 'password') {
        const result = await api.managePeople({ action: 'set-password', user_id: person.user_id })
        setNewPassword({ email: person.email, password: result.password })
        showToast?.(`${person.email} has a new password`, 'success')
      } else {
        const result = await api.restorePersonAccess(person.user_id)
        showToast?.(
          `${person.email} can sign in again${result?.role ? ` as ${personRoleLabel(result.role)}` : ''}`,
          'success'
        )
      }
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setConfirming(null)
      load()
    }
  }, [confirming, load, showToast])

  return (
    <>
      {!error && (
        <div className="filter-bar">
          <div className="filter-bar-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => load()} title="Read the list again">
              <IconRefreshCw size={14} /> Refresh
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setAdding(true)}
              title="Add a person with a role. They get an invitation by email, or a password you give them."
            >
              <IconPlus size={13} /> Add Person
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="card-body">
          <div className="callout callout-danger">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>{error}</div>
          </div>
        </div>
      )}

      {!error && (loading ? <LoadingState label="people" /> : people.length === 0 ? (
        <EmptyState icon={<IconUser size={36} />} message="No person can sign in to this site yet." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last signed in</th>
                <th className="row-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {people.map(p => {
                const status = personStatus(p)
                const roleBlocked = roleChangeBlocked(p, people, currentUserId)
                const removeBlocked = removalBlocked(p, people, currentUserId)
                const passwordBlocked = passwordSetBlocked(p, currentUserId)
                const removed = p.status === 'removed'
                const isSelf = p.user_id === currentUserId
                return (
                  <tr key={p.user_id}>
                    <td>
                      <span>{p.email || p.user_id}</span>
                      {isSelf && <Badge size="sm" className="badge-follow" title="The account you are signed in with">YOU</Badge>}
                    </td>
                    <td>
                      <select
                        className="form-control"
                        aria-label={`Role for ${p.email || p.user_id}`}
                        value={p.role || ''}
                        disabled={!!roleBlocked || savingRole === p.user_id}
                        title={roleBlocked || 'Change their role. It applies from their next request.'}
                        onChange={e => changeRole(p, e.target.value)}
                      >
                        {!p.role && <option value="" disabled>No role</option>}
                        {PERSON_ROLES.map(r => (
                          <option key={r.name} value={r.name} title={r.description}>{r.label}</option>
                        ))}
                      </select>
                      {removed && p.role_on_restore && (
                        <div className="cell-meta">{personRoleLabel(p.role_on_restore)} when restored</div>
                      )}
                    </td>
                    <td>
                      <Badge size="sm" tone={status.tone} title={status.title}>{status.label}</Badge>
                    </td>
                    <td className="cell-meta">{p.last_sign_in_at ? formatDateTime(p.last_sign_in_at) : 'Never'}</td>
                    <td className="row-actions">
                      <ActionButton
                        className="btn btn-ghost btn-sm"
                        permitted={!passwordBlocked}
                        deniedTitle={passwordBlocked}
                        onClick={() => setConfirming({ act: 'password', person: p })}
                        title="Make them a new password, shown to you once. Their current one stops working."
                      >
                        Set New Password
                      </ActionButton>
                      {removed && (
                        <ActionButton
                          className="btn btn-ghost btn-sm"
                          permitted={!isSelf}
                          deniedTitle="You cannot restore your own access. Ask another Administrator."
                          onClick={() => setConfirming({ act: 'restore', person: p })}
                          title="Let them sign in again, with the role they had."
                        >
                          Restore Access
                        </ActionButton>
                      )}
                      {/* Offered again while sign-in is still open: removing again finishes the ban. */}
                      {(!removed || !p.sign_in_blocked) && (
                        <ActionButton
                          className="btn btn-sm btn-danger btn-danger-reveal"
                          permitted={!removeBlocked}
                          deniedTitle={removeBlocked}
                          onClick={() => setConfirming({ act: 'remove', person: p })}
                          title="Block their sign-in and remove their role. Their account and its history stay."
                        >
                          Remove Access
                        </ActionButton>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}

      {adding && (
        <AddPersonModal
          onClose={() => setAdding(false)}
          onAdded={load}
          showToast={showToast}
        />
      )}

      {confirming?.act === 'remove' && (
        <ConfirmModal
          title={`Remove access for ${confirming.person.email}`}
          message={(
            <>
              They can no longer sign in, and their role
              {confirming.person.role ? ` (${personRoleLabel(confirming.person.role)})` : ''} is
              removed at once, so nothing that needs a role works for them here. Sessions they
              already have, here or in Node-RED, Grafana and Studio, end on their own rather than at
              once; the page help says when. Their account and its history stay, and Restore Access
              gives the role back.
            </>
          )}
          confirmLabel="Remove Access"
          pendingLabel="Removing…"
          onConfirm={confirmAct}
          onCancel={() => setConfirming(null)}
        />
      )}

      {confirming?.act === 'password' && (
        <ConfirmModal
          title={`Set a new password for ${confirming.person.email}`}
          message={(
            <>
              Aber makes a new password and shows it to you once, for you to give them. Their
              current password stops working at once, and the dashboard signs them out within the
              hour. Their role, their account and its history stay as they are.
            </>
          )}
          confirmLabel="Set New Password"
          pendingLabel="Setting…"
          confirmClassName="btn btn-primary"
          onConfirm={confirmAct}
          onCancel={() => setConfirming(null)}
        />
      )}

      {newPassword && (
        <NewPasswordModal
          email={newPassword.email}
          password={newPassword.password}
          onClose={() => setNewPassword(null)}
          showToast={showToast}
        />
      )}

      {confirming?.act === 'restore' && (
        <ConfirmModal
          title={`Restore access for ${confirming.person.email}`}
          message={(confirming.person.role_on_restore || confirming.person.role)
            ? `They can sign in again, as ${personRoleLabel(confirming.person.role_on_restore || confirming.person.role)}.`
            : 'They can sign in again. They hold no role, so set one afterwards.'}
          confirmLabel="Restore Access"
          pendingLabel="Restoring…"
          confirmClassName="btn btn-primary"
          onConfirm={confirmAct}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  )
}
