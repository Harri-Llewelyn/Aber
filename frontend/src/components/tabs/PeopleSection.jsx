import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { api } from '../../api'
import { Badge } from '../common/Badge'
import { ClearFilters } from '../common/ClearFilters'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { EmptyState } from '../common/EmptyState'
import {
  IconArchive, IconInbox, IconLock, IconLogOut, IconPencil, IconPlus, IconRefreshCw, IconShieldAlert, IconUser,
} from '../common/Icons'
import { LoadingState } from '../common/LoadingState'
import { PersonName } from '../common/PersonName'
import { SearchInput } from '../common/SearchInput'
import { useUrlState } from '../../hooks/useUrlState'
import { useSortableRows } from '../../hooks/useTableSort'
import { rankIn, severityRank } from '../../utils/tableSort'
import { SortHeader } from '../common/SortHeader'
import { Tooltip } from '../common/Tooltip'
import { AddPersonModal } from '../modals/AddPersonModal'
import { ChangeEmailModal } from '../modals/ChangeEmailModal'
import { DisplayNameModal } from '../modals/DisplayNameModal'
import { ConfirmModal } from '../modals/ConfirmModal'
import { NewPasswordModal } from '../modals/NewPasswordModal'
import { formatDateTime } from '../../utils/format'
import { personUrl, tabUrl } from '../../routes'
import { personLabel } from '../../utils/displayName'
import {
  NO_ROLE,
  PERSON_ROLES,
  PERSON_STATUSES,
  accessRemoved,
  emailChangeBlocked,
  passwordSetBlocked,
  personRoleLabel,
  personStatus,
  removalBlocked,
  roleChangeBlocked,
  sessionsEndBlocked,
} from '../../utils/people'

/**
 * The People table's sortable columns. Role runs in the order roles are listed everywhere,
 * Administrator first, and someone holding none goes last, as does someone who never signed in.
 */
const PEOPLE_SORT = {
  person: { type: 'text', value: p => p.display_name || p.email || p.user_id },
  role: { type: 'rank', value: p => rankIn(PERSON_ROLES.map(r => r.name), p.role) },
  status: { type: 'rank', value: p => severityRank(personStatus(p).tone) },
  last_sign_in: { type: 'time', value: p => p.last_sign_in_at }
}

/** What a person is found by in the address (`?person=`): their email, which personUrl() writes. */
const personKey = (p) => p.email || p.user_id

/**
 * Access Control's People tab: every person who can sign in, with their role, for an
 * Administrator to add, re-role, rename, re-address, sign out, remove or restore, or to give a new
 * password. A row is the person, their role (changed in place), status and last sign-in; a click
 * or Enter opens their drawer (`?person=<email>`), which holds every other action. A person is
 * drawn by their display name with their email beside it, or by the email alone.
 *
 * Roles go through set_person_role(), names through set_display_name(), and ending sessions
 * through end_person_sessions(); adding, removing, restoring, a new password and a new address go
 * through manage-people, which holds GoTrue's secret key. The database refuses your own role,
 * access, password, address and sessions, and the last Administrator who can sign in; the
 * controls are disabled for those with the reason as their tooltip.
 *
 * The list is searched by name and email and filtered by role and status, in the browser:
 * list_people() returns every account, and a site has tens of them. A removed account is hidden until Show
 * removed is on; a removal that has not finished (Sign-in still open) is never hidden, because it
 * still needs Remove Access again. The filters are in the address.
 *
 * `drawerHost` is the element the drawer is drawn into, beside the page's card, where every page's
 * drawer sits; without one it is drawn in place.
 */
export function PeopleSection({ showToast, currentUserId, drawerHost = null }) {
  const [people, setPeople] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  // { act: 'remove' | 'restore' | 'password' | 'sessions', person } while the confirmation is open.
  const [confirming, setConfirming] = useState(null)
  // { email, password } while a new password is on screen; gone when its dialog closes.
  const [newPassword, setNewPassword] = useState(null)
  // The person whose name, or address, the Change Name or Change Email dialog is open for.
  const [naming, setNaming] = useState(null)
  const [readdressing, setReaddressing] = useState(null)
  // The user_id whose role is being saved, so its select shows the wait.
  const [savingRole, setSavingRole] = useState(null)
  // The open drawer's session count, for the person it was read for.
  const [sessions, setSessions] = useState({ userId: null, summary: null, error: null })
  const [search, setSearch] = useUrlState('search')
  const [roleFilter, setRoleFilter] = useUrlState('role', '', { allowed: [...PERSON_ROLES.map(r => r.name), NO_ROLE] })
  const [showRemoved, setShowRemoved] = useUrlState('removed', false)
  // Access removed is offered only while removed accounts are shown.
  const [statusFilter, setStatusFilter] = useUrlState('status', '', {
    allowed: PERSON_STATUSES.map(st => st.key).filter(key => showRemoved || key !== 'removed')
  })
  // Whoever the list holds, filtered out or not: a link to a removed person opens their drawer.
  const [openPerson, setOpenPerson] = useUrlState('person', '', { allowed: loading ? null : people.map(personKey) })
  const selected = useMemo(() => people.find(p => personKey(p) === openPerson) || null, [people, openPerson])

  const load = useCallback(() => {
    api.listPeople()
      .then(d => { setPeople(d); setError(null); setLoading(false) })
      .catch(e => { setError(e?.message || 'Could not list people.'); setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

  // Read when a drawer opens, and again after an act that ends sessions. The last count stays on
  // screen while a new one is read for the same person.
  const readSessions = useCallback((userId) => {
    if (!userId) return
    setSessions(s => (s.userId === userId ? s : { userId, summary: null, error: null }))
    api.personSessionSummary(userId)
      .then(summary => setSessions(s => (s.userId === userId ? { userId, summary, error: null } : s)))
      .catch(e => setSessions(s => (s.userId === userId
        ? { userId, summary: null, error: e?.message || 'Could not read their sessions.' }
        : s)))
  }, [])
  const selectedId = selected?.user_id || null
  useEffect(() => { readSessions(selectedId) }, [selectedId, readSessions])

  const removedCount = useMemo(() => people.filter(accessRemoved).length, [people])
  // What the role and status options count: everyone the removed toggle lets in.
  const listed = useMemo(() => people.filter(p => showRemoved || !accessRemoved(p)), [people, showRemoved])
  const query = search.trim().toLowerCase()
  const matching = useMemo(() => listed.filter(p => {
    if (roleFilter && (p.role || NO_ROLE) !== roleFilter) return false
    if (statusFilter && personStatus(p).key !== statusFilter) return false
    return !query || [p.display_name, p.email || p.user_id].some(v => String(v || '').toLowerCase().includes(query))
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
      showToast?.(`${personLabel(person)} is now ${personRoleLabel(role)}`, 'success', { to: personUrl(person.email) })
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setSavingRole(null)
      load()
    }
  }, [load, showToast])

  // The address is the drawer's key in the URL. The list takes the new one first, committed at
  // once, so the drawer and a search for the old address move with it rather than being tidied away.
  const emailChanged = useCallback((person, result) => {
    flushSync(() => setPeople(ps => ps.map(p => (p.user_id === person.user_id ? { ...p, email: result.email } : p))))
    if (openPerson === person.email) setOpenPerson(result.email)
    if (search.trim().toLowerCase() === String(person.email || '').toLowerCase()) setSearch(result.email)
    readSessions(person.user_id)
    load()
  }, [openPerson, setOpenPerson, search, setSearch, readSessions, load])

  const confirmAct = useCallback(async () => {
    const { act, person } = confirming
    try {
      if (act === 'remove') {
        await api.removePersonAccess(person.user_id)
        showToast?.(`${personLabel(person)} can no longer sign in`, 'success', { to: personUrl(person.email, true) })
      } else if (act === 'password') {
        const result = await api.managePeople({ action: 'set-password', user_id: person.user_id })
        setNewPassword({ email: person.email, password: result.password })
        showToast?.(`${personLabel(person)} has a new password`, 'success', { to: personUrl(person.email) })
      } else if (act === 'sessions') {
        const ended = await api.endPersonSessions(person.user_id)
        showToast?.(
          ended === 0
            ? `${personLabel(person)} had no session to end`
            : `${personLabel(person)} is signed out everywhere: ${ended} session${ended === 1 ? '' : 's'} ended`,
          'success',
          { to: personUrl(person.email, accessRemoved(person)) }
        )
      } else {
        const result = await api.restorePersonAccess(person.user_id)
        showToast?.(
          `${personLabel(person)} can sign in again${result?.role ? ` as ${personRoleLabel(result.role)}` : ''}`,
          'success',
          { to: personUrl(person.email) }
        )
      }
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setConfirming(null)
      // Each act can end sessions: a new password ends them all, and so does a removal's ban.
      readSessions(person.user_id)
      load()
    }
  }, [confirming, load, readSessions, showToast])

  const drawer = (() => {
    const p = selected
    const isSelf = p?.user_id === currentUserId
    const removed = p?.status === 'removed'
    const status = p ? personStatus(p) : null
    const read = p && sessions.userId === p.user_id ? sessions : null
    const sessionText = !read || (!read.summary && !read.error) ? 'Reading…'
      : read.error ? <Tooltip text={read.error}><span className="cell-meta hint-underline" tabIndex={0}>Not read</span></Tooltip>
        : read.summary.open_sessions === 0 ? 'None'
          : `${read.summary.open_sessions} open${read.summary.last_active_at
            ? `, last active ${formatDateTime(read.summary.last_active_at)}` : ''}`
    const emailBlocked = p ? emailChangeBlocked(p, currentUserId) : null
    const passwordBlocked = p ? passwordSetBlocked(p, currentUserId) : null
    const sessionsBlocked = p ? sessionsEndBlocked(p, currentUserId) : null
    const removeBlocked = p ? removalBlocked(p, people, currentUserId) : null
    return (
      <ContextPanel
        open={!!p}
        onClose={() => setOpenPerson('')}
        subject="person"
        onCopy={showToast}
        // A name is anyone's to type, so the email is always in the drawer beside it.
        title={p ? p.display_name || p.email || p.user_id : ''}
        icon={<IconUser size={16} />}
        subtitle={isSelf && <Badge size="sm" className="badge-follow" title="The account you are signed in with">YOU</Badge>}
        fields={p ? [
          { label: 'Email', value: p.email, full: true },
          { label: 'Display name', value: p.display_name || '' },
          { label: 'Role', value: personRoleLabel(p.role) },
          {
            label: 'Status',
            value: (
              <>
                <Badge size="sm" tone={status.tone} title={status.title}>{status.label}</Badge>
                {removed && p.role_on_restore && (
                  <div className="cell-meta">{personRoleLabel(p.role_on_restore)} when restored</div>
                )}
              </>
            ),
          },
          { label: 'Last sign-in', value: p.last_sign_in_at ? formatDateTime(p.last_sign_in_at) : 'Never' },
          {
            label: 'Sessions',
            value: sessionText,
            help: 'Each sign-in, to the dashboard in one browser or to a service such as Grafana, is a session. How many they hold, and when one was last used.',
          },
        ] : []}
        actions={p ? [
          {
            label: 'Change Name', icon: <IconPencil size={13} />,
            onClick: () => setNaming(p),
            title: p.display_name
              ? 'Change or clear the name shown beside their email address. Their email address does not change.'
              : 'Give them a name, shown beside their email address. Their email address does not change.',
          },
          {
            label: 'Change Email', icon: <IconInbox size={13} />,
            onClick: () => setReaddressing(p),
            disabled: !!emailBlocked,
            title: emailBlocked || 'Give them a new address to sign in with. Their sessions end, so they sign in again.',
          },
          // Your own password is changed on Profile, so your drawer links there instead.
          isSelf ? {
            label: 'Open Profile', icon: <IconUser size={13} />,
            to: tabUrl('profile'),
            title: 'Your own password, theme and sidebar layout are on your Profile page',
          } : {
            label: 'Set New Password', icon: <IconLock size={13} />,
            onClick: () => setConfirming({ act: 'password', person: p }),
            disabled: !!passwordBlocked,
            title: passwordBlocked || 'Make them a new password, shown to you once. Their current one stops working.',
          },
          {
            label: 'End Sessions', icon: <IconLogOut size={13} />,
            onClick: () => setConfirming({ act: 'sessions', person: p }),
            disabled: !!sessionsBlocked,
            title: sessionsBlocked || 'Sign them out of every browser and service. They keep their role, and can sign in again.',
          },
          removed && {
            label: 'Restore Access', icon: <IconRefreshCw size={13} />,
            onClick: () => setConfirming({ act: 'restore', person: p }),
            disabled: isSelf,
            title: isSelf ? 'You cannot restore your own access. Ask another Administrator.' : 'Let them sign in again, with the role they had.',
          },
          // Offered again while sign-in is still open: removing again finishes the ban.
          (!removed || !p.sign_in_blocked) && {
            label: 'Remove Access', icon: <IconShieldAlert size={13} />,
            onClick: () => setConfirming({ act: 'remove', person: p }),
            disabled: !!removeBlocked,
            danger: true,
            title: removeBlocked || 'Block their sign-in and remove their role. Their account and its history stay.',
          },
        ].filter(Boolean) : []}
      />
    )
  })()

  return (
    <>
      {!error && (
        <div className="filter-bar">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search by name or email…"
            ariaLabel="Search people by name or email"
          />
          <select
            className="form-control control-md"
            value={roleFilter}
            onChange={e => setRoleFilter(e.target.value)}
            aria-label="Filter people by role"
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
            <Tooltip text="People whose access is removed are left off the list. Their accounts and history stay.">
              <button
                type="button"
                className={`btn btn-sm ${showRemoved ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setShowRemoved(v => !v)}
                aria-pressed={showRemoved}
              >
                <IconArchive size={13} /> Show removed ({removedCount})
              </button>
            </Tooltip>
          )}
          <div className="filter-bar-actions">
            <ClearFilters count={filterCount} onClear={clearFilters} />
            <Tooltip text="They get an invitation by email, or a password you give them.">
              <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
                <IconPlus size={13} /> Add Person
              </button>
            </Tooltip>
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
                <SortHeader sort={sort} column="role" title="A change of role applies from the person's next request.">Role</SortHeader>
                <SortHeader sort={sort} column="status">Status</SortHeader>
                <SortHeader sort={sort} column="last_sign_in">Last signed in</SortHeader>
              </tr>
            </thead>
            <tbody>
              {shown.map(p => {
                const status = personStatus(p)
                const roleBlocked = roleChangeBlocked(p, people, currentUserId)
                const removed = p.status === 'removed'
                const isSelf = p.user_id === currentUserId
                const key = personKey(p)
                // A click on the row, or Enter or Space on it, opens the drawer; the role select
                // and anything else inside keep their own clicks and keys.
                const toggle = () => setOpenPerson(open => (open === key ? '' : key))
                return (
                  <tr
                    key={p.user_id}
                    className={`row-selectable${openPerson === key ? ' row-selected' : ''}`}
                    onClick={rowSelectHandler(toggle)}
                    onKeyDown={e => {
                      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                      e.preventDefault()
                      toggle()
                    }}
                    tabIndex={0}
                  >
                    <td>
                      {/* The email stays in view beside a name: two people can share one. */}
                      <PersonName name={p.display_name} email={p.email} id={p.user_id} stacked />
                      {isSelf && <Badge size="sm" className="badge-follow" title="The account you are signed in with">YOU</Badge>}
                    </td>
                    <td>
                      {/* Says why it cannot change, or what the role chosen allows: an option's
                          own description never reaches a keyboard. */}
                      <Tooltip text={roleBlocked || PERSON_ROLES.find(r => r.name === p.role)?.description}>
                        <select
                          className="form-control"
                          aria-label={`Role for ${personLabel(p)}`}
                          value={p.role || ''}
                          disabled={!!roleBlocked || savingRole === p.user_id}
                          onChange={e => changeRole(p, e.target.value)}
                        >
                          {!p.role && <option value="" disabled>No role</option>}
                          {PERSON_ROLES.map(r => (
                            <option key={r.name} value={r.name}>{r.label}</option>
                          ))}
                        </select>
                      </Tooltip>
                      {removed && p.role_on_restore && (
                        <div className="cell-meta">{personRoleLabel(p.role_on_restore)} when restored</div>
                      )}
                    </td>
                    <td>
                      <Badge size="sm" tone={status.tone} title={status.title}>{status.label}</Badge>
                    </td>
                    <td className="cell-meta">{p.last_sign_in_at ? formatDateTime(p.last_sign_in_at) : 'Never'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}

      {drawerHost ? createPortal(drawer, drawerHost) : drawer}

      {adding && (
        <AddPersonModal
          onClose={() => setAdding(false)}
          onAdded={load}
          showToast={showToast}
        />
      )}

      {naming && (
        <DisplayNameModal
          person={naming}
          onClose={() => setNaming(null)}
          onSaved={load}
          showToast={showToast}
        />
      )}

      {readdressing && (
        <ChangeEmailModal
          person={readdressing}
          onClose={() => setReaddressing(null)}
          onChanged={result => emailChanged(readdressing, result)}
          showToast={showToast}
        />
      )}

      {confirming?.act === 'remove' && (
        <ConfirmModal
          title={`Remove access for ${personLabel(confirming.person)}`}
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
          title={`Set a new password for ${personLabel(confirming.person)}`}
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

      {confirming?.act === 'sessions' && (
        <ConfirmModal
          title={`End every session for ${personLabel(confirming.person)}`}
          message={(
            <>
              Every sign-in they have ends: the dashboard in each browser, and Studio, the forge,
              Node-RED and Grafana. The API refuses their access at once, and Studio and the forge
              at their next request. Node-RED signs them out within a minute, and Grafana within
              the hour. They keep their role and can sign in again. To stop them signing in, use
              Remove Access.
            </>
          )}
          confirmLabel="End Sessions"
          pendingLabel="Ending…"
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
          title={`Restore access for ${personLabel(confirming.person)}`}
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
