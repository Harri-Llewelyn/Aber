import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Badge } from '../common/Badge'
import { ClearFilters } from '../common/ClearFilters'
import { EmptyState } from '../common/EmptyState'
import { IconArchive, IconPlus, IconShieldAlert, IconUser } from '../common/Icons'
import { LoadingState } from '../common/LoadingState'
import { RouteLink } from '../common/RouteLink'
import { SearchInput } from '../common/SearchInput'
import { useUrlState } from '../../hooks/useUrlState'
import { useSortableRows } from '../../hooks/useTableSort'
import { rankIn, severityRank } from '../../utils/tableSort'
import { SortHeader } from '../common/SortHeader'
import { AddPersonModal } from '../modals/AddPersonModal'
import { ConfirmModal } from '../modals/ConfirmModal'
import { NewPasswordModal } from '../modals/NewPasswordModal'
import { formatDateTime } from '../../utils/format'
import { personUrl, tabUrl } from '../../routes'
import {
  NO_ROLE,
  PERSON_ROLES,
  PERSON_STATUSES,
  accessRemoved,
  passwordSetBlocked,
  personRoleLabel,
  personStatus,
  removalBlocked,
  roleChangeBlocked,
} from '../../utils/people'

/**
 * The People table's sortable columns. Role runs in the order roles are listed everywhere,
 * Administrator first, and someone holding none goes last, as does someone who never signed in.
 */
const PEOPLE_SORT = {
  person: { type: 'text', value: p => p.email || p.user_id },
  role: { type: 'rank', value: p => rankIn(PERSON_ROLES.map(r => r.name), p.role) },
  status: { type: 'rank', value: p => severityRank(personStatus(p).tone) },
  last_sign_in: { type: 'time', value: p => p.last_sign_in_at }
}

/**
 * Access Control's People tab: every person who can sign in, with their role, for an
 * Administrator to add, re-role, remove or restore, or to give a new password. Roles are set
 * through set_person_role(); adding, removing, restoring and setting a password go through
 * manage-people, which holds GoTrue's secret key. The database refuses your own role, access or
 * password and the last Administrator who can sign in; the controls are disabled for those with
 * the reason as their tooltip. A new password is shown once, in NewPasswordModal.
 *
 * The list is searched by email and filtered by role and status, in the browser: list_people()
 * returns every account, and a site has tens of them. A removed account is hidden until Show
 * removed is on; a removal that has not finished (Sign-in still open) is never hidden, because it
 * still needs Remove Access again. The filters are in the address.
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
  const [search, setSearch] = useUrlState('search')
  const [roleFilter, setRoleFilter] = useUrlState('role', '', { allowed: [...PERSON_ROLES.map(r => r.name), NO_ROLE] })
  const [showRemoved, setShowRemoved] = useUrlState('removed', false)
  // Access removed is offered only while removed accounts are shown.
  const [statusFilter, setStatusFilter] = useUrlState('status', '', {
    allowed: PERSON_STATUSES.map(st => st.key).filter(key => showRemoved || key !== 'removed')
  })

  const load = useCallback(() => {
    api.listPeople()
      .then(d => { setPeople(d); setError(null); setLoading(false) })
      .catch(e => { setError(e?.message || 'Could not list people.'); setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

  const removedCount = useMemo(() => people.filter(accessRemoved).length, [people])
  // What the role and status options count: everyone the removed toggle lets in.
  const listed = useMemo(() => people.filter(p => showRemoved || !accessRemoved(p)), [people, showRemoved])
  const query = search.trim().toLowerCase()
  const matching = useMemo(() => listed.filter(p => {
    if (roleFilter && (p.role || NO_ROLE) !== roleFilter) return false
    if (statusFilter && personStatus(p).key !== statusFilter) return false
    return !query || String(p.email || p.user_id).toLowerCase().includes(query)
  }), [listed, roleFilter, statusFilter, query])
  const [shown, sort] = useSortableRows(matching, PEOPLE_SORT)
  const roleCount = (name) => listed.filter(p => (p.role || NO_ROLE) === name).length
  const statusCount = (key) => listed.filter(p => personStatus(p).key === key).length
  const filterCount = [search, roleFilter, statusFilter].filter(Boolean).length + (showRemoved ? 1 : 0)
  const clearFilters = () => { setSearch(''); setRoleFilter(''); setStatusFilter(''); setShowRemoved(false) }

  // The toggle shows only while there is something to show, so an address that turns it on with
  // nothing removed is tidied once the list is in.
  useEffect(() => {
    if (!loading && !error && showRemoved && removedCount === 0) setShowRemoved(false)
  }, [loading, error, showRemoved, removedCount, setShowRemoved])

  const changeRole = useCallback(async (person, role) => {
    if (!role || role === person.role) return
    setSavingRole(person.user_id)
    try {
      await api.setPersonRole(person.user_id, role)
      showToast?.(`${person.email} is now ${personRoleLabel(role)}`, 'success', { to: personUrl(person.email) })
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
        showToast?.(`${person.email} can no longer sign in`, 'success', { to: personUrl(person.email, true) })
      } else if (act === 'password') {
        const result = await api.managePeople({ action: 'set-password', user_id: person.user_id })
        setNewPassword({ email: person.email, password: result.password })
        showToast?.(`${person.email} has a new password`, 'success', { to: personUrl(person.email) })
      } else {
        const result = await api.restorePersonAccess(person.user_id)
        showToast?.(
          `${person.email} can sign in again${result?.role ? ` as ${personRoleLabel(result.role)}` : ''}`,
          'success',
          { to: personUrl(person.email) }
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
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search by email…"
            ariaLabel="Search people by email"
          />
          <select
            className="form-control control-md"
            value={roleFilter}
            onChange={e => setRoleFilter(e.target.value)}
            aria-label="Filter people by role"
            title="Filter by the Role column"
          >
            <option value="">All roles ({listed.length})</option>
            {PERSON_ROLES.map(r => (
              <option key={r.name} value={r.name}>{r.label} ({roleCount(r.name)})</option>
            ))}
            <option value={NO_ROLE}>No role ({roleCount(NO_ROLE)})</option>
          </select>
          <select
            className="form-control control-md"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            aria-label="Filter people by status"
            title="Filter by the Status column"
          >
            <option value="">Any status ({listed.length})</option>
            {PERSON_STATUSES
              // Sign-in still open only while someone is in that state; Access removed only while
              // removed accounts are shown.
              .filter(st => (st.key === 'removed' ? showRemoved
                : st.key === 'sign-in-open' ? statusCount(st.key) > 0 || statusFilter === st.key
                  : true))
              .map(st => (
                <option key={st.key} value={st.key}>{st.label} ({statusCount(st.key)})</option>
              ))}
          </select>
          {/* Offered only while an account is removed; the count is what it would list. */}
          {removedCount > 0 && (
            <button
              type="button"
              className={`btn btn-sm ${showRemoved ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setShowRemoved(v => !v)}
              aria-pressed={showRemoved}
              title="People whose access is removed are left off the list. Their accounts and history stay, and Restore Access gives the role back."
            >
              <IconArchive size={13} /> Show removed ({removedCount})
            </button>
          )}
          <div className="filter-bar-actions">
            <ClearFilters count={filterCount} onClear={clearFilters} />
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

      {!error && (loading ? <LoadingState label="people" /> : shown.length === 0 ? (
        <EmptyState
          icon={<IconUser size={36} />}
          filtered={people.length > 0}
          message="No person can sign in to this site yet."
          filteredMessage="No person matches these filters."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortHeader sort={sort} column="person">Person</SortHeader>
                <SortHeader sort={sort} column="role">Role</SortHeader>
                <SortHeader sort={sort} column="status">Status</SortHeader>
                <SortHeader sort={sort} column="last_sign_in">Last signed in</SortHeader>
                <th className="row-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(p => {
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
                      {/* Your own password is changed on Profile, so your row links there instead. */}
                      {isSelf ? (
                        <RouteLink to={tabUrl('profile')} className="btn btn-ghost btn-sm"
                          title="Your own password, theme and sidebar layout are on your Profile page">
                          <IconUser size={13} /> Open Profile
                        </RouteLink>
                      ) : (
                        <ActionButton
                          className="btn btn-ghost btn-sm"
                          permitted={!passwordBlocked}
                          deniedTitle={passwordBlocked}
                          onClick={() => setConfirming({ act: 'password', person: p })}
                          title="Make them a new password, shown to you once. Their current one stops working."
                        >
                          Set New Password
                        </ActionButton>
                      )}
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
