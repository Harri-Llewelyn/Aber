import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api'
import { AppApprovalsTable } from '../common/AppApprovalsTable'
import { Badge } from '../common/Badge'
import { ClearFilters } from '../common/ClearFilters'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { EmptyState } from '../common/EmptyState'
import { HelpTip } from '../common/HelpTip'
import { IconGlobe, IconShieldAlert, IconTrash } from '../common/Icons'
import { LoadingState } from '../common/LoadingState'
import { PersonName } from '../common/PersonName'
import { SearchInput } from '../common/SearchInput'
import { ColumnHeader, SortHeader } from '../common/SortHeader'
import { Tooltip } from '../common/Tooltip'
import { ConfirmModal } from '../modals/ConfirmModal'
import { useUrlState } from '../../hooks/useUrlState'
import { useSortableRows } from '../../hooks/useTableSort'
import { appUrl, tabUrl } from '../../routes'
import { formatDateTime, plural } from '../../utils/format'
import { appLabel, appRegistration, clientTypeLabel, removeQuestion, revokeQuestion } from '../../utils/apps'

/** The Apps table's sortable columns. Aber's own sort before the rest under Registered. */
const APP_SORT = {
  app: { type: 'text', value: a => appLabel(a.client_name) },
  registered: { type: 'time', value: a => a.created_at },
  type: { type: 'text', value: a => clientTypeLabel(a.client_type).label },
  people: { type: 'number', value: a => a.people_allowing },
}

/** The drawer's list of people, shut. */
const NO_LIST = { appId: null, rows: undefined, error: null }

/** A person as the list names them: their display name, else their email. */
const personOf = (r) => r.display_name || r.email || r.user_id

/**
 * Access Control's Apps tab: every app that signs people in with Aber, for an Administrator
 * (`list_apps()`, 0217). Each row is the app, how and when it was registered, where it sends people
 * back to, its client type and how many people allow it. A click or Enter opens its drawer
 * (`?app=<id>`), which lists the people who allowed it (`app_approvals()`) with Revoke for each
 * (`revoke_app_approval()`), and offers Remove App (`remove_app()`). Aber's own four apps are
 * marked and cannot be removed: they are registered again each time Aber starts.
 *
 * `drawerHost` is the element the drawer is drawn into, beside the page's card.
 */
export function AppsSection({ showToast, drawerHost = null }) {
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useUrlState('search')
  const [openApp, setOpenApp] = useUrlState('app', '', { allowed: loading ? null : apps.map(a => a.id) })
  const selected = useMemo(() => apps.find(a => a.id === openApp) || null, [apps, openApp])
  const [people, setPeople] = useState(NO_LIST)
  // { act: 'revoke', app, person } or { act: 'remove', app } while its dialog is open.
  const [confirming, setConfirming] = useState(null)

  const load = useCallback(() => {
    api.listApps()
      .then(d => { setApps(d); setError(null); setLoading(false) })
      .catch(e => { setError(e?.message || 'Could not list the apps.'); setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

  // Who allows the open app, read when its drawer opens and again after a Revoke. The rows stay on
  // screen while a new read runs for the same app.
  const readPeople = useCallback((appId) => {
    if (!appId) return
    setPeople(l => (l.appId === appId ? l : { appId, rows: undefined, error: null }))
    api.appApprovals(appId)
      .then(rows => setPeople(l => (l.appId === appId ? { appId, rows, error: null } : l)))
      .catch(e => setPeople(l => (l.appId === appId
        ? { ...l, error: e?.message || 'Could not list who allows it.' }
        : l)))
  }, [])
  const selectedId = selected?.id || null
  useEffect(() => {
    if (selectedId) readPeople(selectedId)
    else setPeople(NO_LIST)
  }, [selectedId, readPeople])

  const query = search.trim().toLowerCase()
  const matching = useMemo(() => apps.filter(a => !query
    || [a.client_name, appLabel(a.client_name), ...(a.redirect_uris || [])]
      .some(v => String(v || '').toLowerCase().includes(query))), [apps, query])
  const [shown, sort] = useSortableRows(matching, APP_SORT)

  const confirmAct = useCallback(async () => {
    const { act, app, person } = confirming
    const name = appLabel(app.client_name)
    try {
      if (act === 'revoke') {
        const ended = await api.revokeAppApproval(person.user_id, app.id)
        showToast?.(
          `${personOf(person)} no longer allows ${name}: ${plural(ended, 'session')} ended.`,
          'success',
          { to: appUrl(app.id) },
        )
      } else {
        const result = await api.removeApp(app.id)
        setOpenApp('')
        showToast?.(
          `${name} is removed: ${plural(result.approvals_ended, 'approval')} and ${plural(result.sessions_ended, 'session')} ended.`,
          'success',
          { to: tabUrl('access-control', 'apps') },
        )
      }
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setConfirming(null)
      if (act === 'revoke') readPeople(app.id)
      load()
    }
  }, [confirming, load, readPeople, setOpenApp, showToast])

  const drawer = (() => {
    const a = selected
    const registration = a ? appRegistration(a) : null
    const type = a ? clientTypeLabel(a.client_type) : null
    const list = a && people.appId === a.id ? people : null
    return (
      <ContextPanel
        open={!!a}
        onClose={() => setOpenApp('')}
        subject="app"
        onCopy={showToast}
        title={a ? appLabel(a.client_name) : ''}
        icon={<IconGlobe size={16} />}
        subtitle={a?.part_of_stack && <Badge size="sm" tone="info" title={registration.detail}>PART OF ABER</Badge>}
        fields={a ? [
          { label: 'Registered as', value: a.client_name || 'No name', full: true },
          {
            label: 'Registered',
            value: `${registration.label}, ${formatDateTime(a.created_at)}`,
            help: registration.detail,
            full: true,
          },
          { label: 'Client type', value: type.label, help: type.detail || undefined },
          {
            label: 'People allowing',
            value: String(a.people_allowing ?? 0),
            help: 'How many people have allowed it to sign them in. Each one is listed below.',
          },
          ...(a.client_uri ? [{ label: 'Address', value: a.client_uri, mono: true, full: true }] : []),
          {
            label: 'Sends people back to',
            value: (a.redirect_uris || []).length
              ? a.redirect_uris.map(uri => <div key={uri}>{uri}</div>)
              : 'None',
            mono: true,
            full: true,
            help: 'The addresses the sign-in service may return a person to after they sign in. Any other is refused.',
          },
          { label: 'App ID', value: a.id, copyable: true, mono: true, full: true },
        ] : []}
        beforeActions={a && (
          <section aria-label={`People who allow ${appLabel(a.client_name)}`}>
            <div className="context-panel-section-label">People who allow it</div>
            {list?.error ? (
              <div className="callout callout-danger" role="status">
                <IconShieldAlert size={14} className="callout-icon" />
                <div>{list.error}</div>
              </div>
            ) : !list || list.rows === undefined ? (
              <div className="context-field-empty" role="status">Reading who allows it…</div>
            ) : list.rows.length === 0 ? (
              <div className="context-field-empty">Nobody allows it at the moment.</div>
            ) : (
              <AppApprovalsTable
                rows={list.rows.map(r => ({
                  key: r.user_id,
                  label: <PersonName name={r.display_name} email={r.email} id={r.user_id} stacked />,
                  description: personOf(r),
                  granted_at: r.granted_at,
                  scopes: r.scopes,
                  person: r,
                }))}
                first={{ title: 'Person', tip: 'Who allowed the app to sign them in.' }}
                onRevoke={r => setConfirming({ act: 'revoke', app: a, person: r.person })}
                className="app-approvals-table"
              />
            )}
          </section>
        )}
        actions={a ? [
          {
            label: 'Remove App', icon: <IconTrash size={13} />,
            onClick: () => setConfirming({ act: 'remove', app: a }),
            disabled: a.part_of_stack,
            danger: true,
            title: a.part_of_stack
              ? 'Aber registers this app each time it starts, so it cannot be removed.'
              : 'Stop it signing anyone in. Every approval of it, and every session it holds, ends.',
          },
        ] : []}
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
            placeholder="Search by name or address…"
            ariaLabel="Search apps by name or the address they send people back to"
          />
          <div className="filter-bar-actions">
            <ClearFilters count={query ? 1 : 0} onClear={() => setSearch('')} />
            <HelpTip
              label="About apps"
              text="An app signs people in with their Aber account, and each person allows it once. Aber's own four are Grafana, Node-RED, Studio and the forge. Revoke one person's approval in an app's drawer, or remove an app that is not Aber's own."
            />
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

      {!error && (loading ? <LoadingState label="apps" /> : shown.length === 0 ? (
        <EmptyState
          icon={<IconGlobe size={36} />}
          filtered={apps.length > 0}
          message="No app can sign people in with Aber."
          filteredMessage="No app matches this search."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortHeader sort={sort} column="app">App</SortHeader>
                <SortHeader sort={sort} column="registered" title="How the app was registered, and when.">Registered</SortHeader>
                <ColumnHeader title="Where the sign-in service may send a person back to after they sign in.">Sends people back to</ColumnHeader>
                <SortHeader sort={sort} column="type" title="Confidential: it holds a secret, on a server. Public: it holds none.">Type</SortHeader>
                <SortHeader sort={sort} column="people" title="How many people have allowed it to sign them in.">People</SortHeader>
              </tr>
            </thead>
            <tbody>
              {shown.map(a => {
                const registration = appRegistration(a)
                const type = clientTypeLabel(a.client_type)
                // A click on the row, or Enter or Space on it, opens the drawer.
                const toggle = () => setOpenApp(open => (open === a.id ? '' : a.id))
                return (
                  <tr
                    key={a.id}
                    className={`row-selectable${openApp === a.id ? ' row-selected' : ''}`}
                    onClick={rowSelectHandler(toggle)}
                    onKeyDown={e => {
                      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                      e.preventDefault()
                      toggle()
                    }}
                    tabIndex={0}
                  >
                    <td>
                      <div>{appLabel(a.client_name)}</div>
                      {a.client_name && appLabel(a.client_name) !== a.client_name && (
                        <div className="cell-meta">{a.client_name}</div>
                      )}
                    </td>
                    <td>
                      <Badge size="sm" tone={a.part_of_stack ? 'info' : undefined} title={registration.detail}>
                        {registration.label}
                      </Badge>
                      <div className="cell-meta">{formatDateTime(a.created_at)}</div>
                    </td>
                    <td className="mono cell-meta" style={{ maxWidth: '40ch', overflowWrap: 'anywhere' }}>
                      {(a.redirect_uris || []).map(uri => <div key={uri}>{uri}</div>)}
                    </td>
                    <td>
                      <Tooltip text={type.detail}><span>{type.label}</span></Tooltip>
                    </td>
                    <td>{a.people_allowing ?? 0}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}

      {drawerHost ? createPortal(drawer, drawerHost) : drawer}

      {confirming?.act === 'revoke' && (
        <ConfirmModal
          title={`Revoke ${personOf(confirming.person)}'s approval of ${appLabel(confirming.app.client_name)}`}
          icon={<IconShieldAlert size={18} />}
          message={revokeQuestion(confirming.app.client_name, personOf(confirming.person))}
          confirmLabel="Revoke Approval"
          pendingLabel="Revoking…"
          onConfirm={confirmAct}
          onCancel={() => setConfirming(null)}
        />
      )}

      {confirming?.act === 'remove' && (
        <ConfirmModal
          title={`Remove ${appLabel(confirming.app.client_name)}`}
          icon={<IconTrash size={18} />}
          message={removeQuestion(confirming.app)}
          confirmLabel="Remove App"
          pendingLabel="Removing…"
          onConfirm={confirmAct}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  )
}
