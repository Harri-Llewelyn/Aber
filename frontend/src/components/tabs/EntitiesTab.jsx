import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { RouteLink } from '../common/RouteLink'
import { entityUrl, trailUrl } from '../../routes'
import { ENTITY_FIND_LIMIT, PERMISSION_UUIDS } from '../../constants'
import { requiresRolesTitle, rolesHolding } from '../../hooks/usePermissions'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'
import CopyableId from '../common/CopyableId'
// Restore and delete run from inside a ConfirmModal, which owns its own pending state; the export
// is the one action that runs from the row. The drawers' Restore asks with the same dialog.
import { ConfirmModal } from '../modals/ConfirmModal'
import { RestoreEntityModal } from '../modals/RestoreEntityModal'
import { DeviceExportModal } from '../modals/DeviceExportModal'
import { gatewayRepositoryUrl } from '../common/GatewayRepositoryPanel'
import { CardHeading } from '../common/CardHeading'
import { TabStrip } from '../common/TabStrip'
import { useUrlList, useUrlState, useUrlTab } from '../../hooks/useUrlState'
import { ENTITIES_TABS } from '../../navigation'
import { ClearFilters } from '../common/ClearFilters'
import { rowSelectHandler } from '../common/ContextPanel'
import { FilterDropdown } from '../common/FilterChecklist'
import { ListFoot } from '../common/ListFoot'
import { OverflowText } from '../common/OverflowText'
import { SearchInput } from '../common/SearchInput'
import { EntityDrawer } from './EntityDrawer'
import { useSortableRows } from '../../hooks/useTableSort'
import { useDisplayNames } from '../../hooks/useDisplayNames'
import { PersonName } from '../common/PersonName'
import { SortHeader } from '../common/SortHeader'
import { Tooltip } from '../common/Tooltip'
import { IconArchive, IconRefreshCw, IconTrash, IconDownload, IconHistory, IconExternalLink, IconAlertTriangle, IconLock } from '../common/Icons'
import { Badge } from '../common/Badge'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { hadEnrolled } from '../../utils/credentialState'
import {
  ENTITY_KINDS, PINNED_IDENTITY_ROWS, byKindThenName, entityKey, findText, isWholeId, kindLabel, mergeFound, personRow,
  variantBadge,
} from '../../utils/entities'
import { formatDate, formatDateTime, plural } from '../../utils/format'
import { applyFacets } from '../../utils/listFilters'

/** The page's singular row type -> the Audit Trail page's handover type. */
const TRAIL_TYPE = { area: 'AREA', cell: 'CELL', gateway: 'GATEWAY', device: 'DEVICE' }

/** How close the auto-purge may come before its date turns the danger colour. */
const PURGE_SOON_DAYS = 7

/** True when the purge is due within PURGE_SOON_DAYS, or already overdue. */
export function purgeIsSoon(at, now = Date.now()) {
  return new Date(at).getTime() - now <= PURGE_SOON_DAYS * 24 * 60 * 60 * 1000
}

/** The three states, in tab order (navigation.jsx). The description is the tab's tooltip; the help page has the rest. */
export const STAGES = ENTITIES_TABS

/** Hoisted: a list filter's default is compared, not copied. */
const NONE = Object.freeze([])

/** The roles the tombstones' policy admits, as a sentence names them: either permission's. */
const RETIRED_ROLES = (() => {
  const roles = [...new Set([PERMISSION_UUIDS.ARCHIVE_MANAGE, PERMISSION_UUIDS.AUDIT_TRAIL_READ].flatMap(rolesHolding))]
  return `${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}`
})()

/** Rows the Active tab first draws, and how many Show more adds: it lists the site, which can be thousands. */
export const ACTIVE_PAGE = 200

/** How long the typing rests before a search asks the database. */
const FIND_SETTLE_MS = 200

/** The Active table's sortable columns, the first three the other tables' own. */
const ACTIVE_SORT = {
  name: { type: 'text', value: e => e.name },
  type: { type: 'text', value: e => kindLabel(e.kind) },
  entity_id: { type: 'text', value: e => e.id },
  second_ids: { type: 'text', value: e => e.second_ids.join(' · ') }
}

/** An archived or retired row's kind, as entity_directory says it: the rows here are named in the singular. */
const kindOfRow = (row) => `${row.entity_type}s`

/** The Archived table's sortable columns. An entity with no auto-purge timer goes last. */
const ARCHIVED_SORT = {
  name: { type: 'text', value: a => a.name },
  type: { type: 'text', value: a => a.entity_type },
  entity_id: { type: 'text', value: a => a.entity_id },
  archived_at: { type: 'time', value: a => a.archived_at },
  auto_purge: { type: 'time', value: a => a.auto_delete_at }
}

/** The Retired table's sortable columns, each on what its cell shows. */
const RETIRED_SORT = {
  name: { type: 'text', value: r => r.name },
  type: { type: 'text', value: r => r.entity_type },
  entity_id: { type: 'text', value: r => r.entity_id },
  retired_at: { type: 'time', value: r => r.retired_at },
  by: { type: 'text', value: r => r.retired_by_name || r.retired_by_email || r.retired_by || 'retention timer' },
  historian_id: { type: 'text', value: r => r.sparkplug_id }
}

/**
 * One card, three tabs, the three states of one lifecycle. Active is entity_directory (0321): everything
 * in service this reader's own policies admit, of every kind, with people and the pinned identities beside it
 * for the two roles that may read them. Archived is what archiving leaves: the row still in its table,
 * restorable, its retention timer running. Retired is what deleting leaves: the row gone, a tombstone
 * written by the database on the DELETE, with links to what survives it -- the audit trail, a gateway's
 * repository in the forge, any bundle exported while it was alive, and the historian id its readings are
 * still keyed by. The three tables share their first three columns.
 *
 * One search covers the three. `?find=` is asked of find_entities(), which reads the view, so a tab lists
 * only what the search found; a whole id that names one row opens that row, on its own tab.
 *
 * `unmappedMetricsTo` is handed to the export dialog, whose warning about metrics with no semantic
 * id then links to the Metrics page. Omit it for a reader who cannot open that page.
 */
export function EntitiesTab({ showToast, userRole, hasPermission, onViewTrail, unmappedMetricsTo }) {
  const [active, setActive]     = useState({ rows: NONE, loaded: false, error: null })
  const [people, setPeople]     = useState({ rows: NONE, loaded: false })
  const [archives, setArchives] = useState([])
  const [retired, setRetired]   = useState([])
  const [exports, setExports]   = useState([])
  const [loading, setLoading]   = useState(true)
  // The tab, in the path: `/entities`, `/entities/archived` or `/entities/retired`. The search is the
  // page's, so it goes along; the kinds and the sort are the tab's.
  const [stage, setStage, stageHref] = useUrlTab('entities', STAGES.map(s => s.id), 'active', { keep: ['find'] })
  const [find, setFind] = useUrlState('find')
  const [kinds, setKinds] = useUrlList('kind', NONE, { allowed: ENTITY_KINDS.map(k => k.kind) })
  const text = findText(find)

  /* People and the pinned identities, which no table the view reads holds: the read of people an
     Administrator has, and the one an Auditor has. Nobody else has one, so nobody else asks. */
  const seesIdentities = userRole === 'Administrator' || userRole === 'Auditor'
  const local = useMemo(
    () => (seesIdentities ? [...PINNED_IDENTITY_ROWS, ...people.rows.map(personRow)] : NONE),
    [seesIdentities, people]
  )

  /* What the search found, for the text it was asked with. `found.text` lags `text` while one is typed and
     while the answer is on its way, and what is listed is always one answer's. */
  const [found, setFound] = useState({ text: '', rows: NONE, error: null })
  useEffect(() => {
    if (text === '') {
      setFound({ text: '', rows: NONE, error: null })
      return undefined
    }
    let live = true
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => api.findEntities(text))
        .then(rows => { if (live) setFound({ text, rows: Array.isArray(rows) ? rows : NONE, error: null }) })
        .catch(e => { if (live) setFound({ text, rows: NONE, error: e?.message || 'The search failed.' }) })
    }, FIND_SETTLE_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [text])
  const searching = text !== found.text
  const matches = useMemo(
    () => (found.text === '' ? NONE : mergeFound(found.rows, local, found.text)),
    [found, local]
  )
  /** The archived or retired rows the search and the kinds let through, and each kind's count. */
  const listed = useCallback((state, rows) => {
    const matched = found.text === '' ? null : new Set(matches.map(entityKey))
    return applyFacets(rows, [{ key: 'kind', chosen: kinds, values: row => [kindOfRow(row)] }],
      row => !matched || matched.has(entityKey({ state, kind: kindOfRow(row), id: row.entity_id })))
  }, [found.text, matches, kinds])

  const everyActive = useMemo(
    () => [...active.rows, ...local].sort(byKindThenName),
    [active.rows, local]
  )
  const { rows: activeShown, counts: activeCounts } = useMemo(
    () => applyFacets(found.text === '' ? everyActive : matches.filter(row => row.state === 'active'),
      [{ key: 'kind', chosen: kinds, values: row => [row.kind] }]),
    [found.text, everyActive, matches, kinds]
  )
  const [activeRows, activeSort] = useSortableRows(activeShown, ACTIVE_SORT, { active: stage === 'active' })
  const [drawn, setDrawn] = useState(ACTIVE_PAGE)
  useEffect(() => { setDrawn(ACTIVE_PAGE) }, [found.text, kinds])

  const { rows: archivedShown, counts: archivedCounts } = useMemo(() => listed('archived', archives), [listed, archives])
  const [archivedRows, archivedSort] = useSortableRows(archivedShown, ARCHIVED_SORT, { active: stage === 'archived' })
  // Who deleted each one: the email stamped at the time, and their display name read live. Only
  // people this viewer can already see here are answered; anyone else is drawn by email alone.
  const retirerNames = useDisplayNames(useMemo(() => retired.map(r => r.retired_by), [retired]))
  const retiredNamed = useMemo(
    () => retired.map(r => ({ ...r, retired_by_name: retirerNames.get(r.retired_by) || null })),
    [retired, retirerNames]
  )
  const { rows: retiredShown, counts: retiredCounts } = useMemo(() => listed('retired', retiredNamed), [listed, retiredNamed])
  const [retiredRows, retiredSort] = useSortableRows(retiredShown, RETIRED_SORT, { active: stage === 'retired' })
  const [confirmPurge, setConfirmPurge] = useState(null)
  const [confirmRestore, setConfirmRestore] = useState(null)
  // The archived device whose export dialog is open, or null.
  const [exportFor, setExportFor] = useState(null)

  const loadActive = useCallback(() => {
    api.get('/api/v1/entities')
      .then(rows => setActive({ rows: Array.isArray(rows) ? rows : NONE, loaded: true, error: null }))
      .catch(e => setActive({ rows: NONE, loaded: true, error: e?.message || 'the request failed' }))
  }, [])

  const load = useCallback(() => {
    loadActive()
    Promise.all([
      api.get('/api/v1/archives'),
      // Both tolerated: a reader may lack what the tombstones or the exports table asks for, and the
      // archived list is still the tab.
      api.get('/api/v1/archives/retired').catch(() => []),
      api.get('/api/v1/archives/exports').catch(() => [])
    ]).then(([a, r, x]) => {
      setArchives(Array.isArray(a) ? a : [])
      setRetired((Array.isArray(r) ? r : []).filter(row => row && row.retired_at))
      setExports((Array.isArray(x) ? x : []).filter(row => row && row.object_key))
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [loadActive])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!seesIdentities) { setPeople({ rows: NONE, loaded: true }); return undefined }
    let live = true
    const settle = (rows) => { if (live) setPeople({ rows: Array.isArray(rows) ? rows : NONE, loaded: true }) }
    // list_people() says whose access was removed and is an Administrator's; list_user_accounts() is the
    // read an Auditor has.
    Promise.resolve()
      .then(() => (userRole === 'Administrator' ? api.listPeople() : api.listUserAccounts()))
      .then(settle, () => settle(NONE))
    return () => { live = false }
  }, [seesIdentities, userRole])

  // The Active row whose drawer is open, in the address as `?entity=`.
  const inService = (id) => everyActive.find(row => row.id === id)
    ?? matches.find(row => row.state === 'active' && row.id === id) ?? null
  const [selectedId, setSelectedId] = useUrlState('entity', '', {
    // A row only the search found is known once it has answered.
    allowed: active.loaded && people.loaded && !searching ? id => inService(id) !== null : null
  })
  const selected = stage === 'active' && selectedId ? inService(selectedId) : null
  const toggle = (row) => setSelectedId(id => (id === row.id ? '' : row.id))
  // Enter or Space on the row itself acts as its click; a key on a control inside it is that control's.
  const onRowKey = (row) => (e) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    if (e.key === ' ') e.preventDefault()
    toggle(row)
  }
  const nameOf = (kind, id) => everyActive.find(row => row.kind === kind && row.id === id)?.name

  // A whole id that names one row opens it: an Active row's drawer, or the tab that lists another.
  const exact = searching ? NONE : matches.filter(row => isWholeId(row, found.text))
  useArrivalSelection(found.text, exact.length === 1 ? exact : NONE, () => true, (row) => {
    // Replaced, not pushed: Back from here should leave the page, not land on the arrival again.
    if (row.state !== stage) setStage(row.state, { replace: true })
    if (row.state === 'active') setSelectedId(row.id)
  })

  // Restore and Permanent Delete run from their dialogs, which show a refusal and stay open.
  const restore = async (item) => {
    await api.post(`/api/v1/${item.entity_type}s/${item.entity_id}/restore`, {})
    setConfirmRestore(null); load()
    showToast(`Entity '${item.name}' restored to active service`, 'success', { to: entityUrl(item.entity_type, item.entity_id) })
  }

  /**
   * Permanent Delete: a real DELETE, now. The row leaves the table, the audit trail keeps its
   * history, and the database writes the tombstone the Retired tab lists. An area's plan is
   * removed here; when the auto-purge deletes an area, the hourly area-plan sweep removes it.
   */
  const purge = async (item) => {
    await api.delete(`/api/v1/${item.entity_type}s/${item.entity_id}`)
    // Dismissed after the delete, so the action runs while the confirmation is on screen.
    setConfirmPurge(null)
    load(); showToast(`Entity '${item.name}' permanently deleted`, 'success')
  }

  const downloadExport = async (row) => {
    try {
      const url = await api.assetExportDownloadUrl(row)
      window.open(url, '_blank', 'noopener')
    } catch (e) { showToast(e.message, 'error') }
  }

  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  const deniedTitle = requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  // aas-export refuses the bundle to a reader without audit_trail:read, since it carries the trail.
  const canReadTrail = hasPermission(PERMISSION_UUIDS.AUDIT_TRAIL_READ)
  // The tombstones' policy: either permission. Anyone else is told so, rather than that there are none.
  const readsRetired = canArchive || canReadTrail
  const latestExportOf = (entityId) => exports.find(x => x.entity_id === entityId) || null

  /** What survives a retired entity, as links; derived from the tombstone's row and its exports. */
  const survivors = (r) => {
    const items = []
    if (onViewTrail) {
      items.push(
        <RouteLink
          key="trail"
          className="btn btn-sm btn-ghost"
          to={trailUrl(r.entity_id, TRAIL_TYPE[r.entity_type], true)}
          onNavigate={() => onViewTrail({ id: r.entity_id, type: TRAIL_TYPE[r.entity_type], purged: true })}
          title="Open this entity's audit trace on the Audit Trail page, deleted entities shown"
        >
          <IconHistory size={12} /> Audit Trail
        </RouteLink>
      )
    }
    if (r.entity_type === 'gateway' && r.old_data?.forge_repository_at && r.sparkplug_id) {
      // Derived from the id as it is everywhere else.
      items.push(
        <Tooltip key="forge" text="Its repository in the forge: archived, read-only, every branch and wiki page kept">
          <a
            className="btn btn-sm btn-ghost"
            href={gatewayRepositoryUrl({ sparkplug_id: r.sparkplug_id })}
            target="_blank"
            rel="noopener noreferrer"
          >
            <IconExternalLink size={12} /> Forge repository
          </a>
        </Tooltip>
      )
    }
    for (const x of r.exports || []) {
      items.push(
        <Tooltip key={x.id} text={`The bundle taken ${formatDateTime(x.taken_at)}${x.taken_by_email ? ` by ${x.taken_by_email}` : ''}: shell, audit trail, live telemetry and the cold-object manifest`}>
          <button className="btn btn-sm btn-ghost" onClick={() => downloadExport(x)}>
            <IconDownload size={12} /> Bundle {formatDate(x.taken_at)}
          </button>
        </Tooltip>
      )
    }
    return items
  }

  // The kinds the open tab can hold, and any chosen one.
  const ofTab = stage === 'active' ? everyActive.map(row => row.kind) : ['areas', 'cells', 'gateways', 'devices']
  const kindOptions = ENTITY_KINDS
    .filter(k => ofTab.includes(k.kind) || kinds.includes(k.kind))
    .map(k => ({ value: k.kind, label: k.plural, short: k.plural }))
  const counts = { active: activeCounts, archived: archivedCounts, retired: retiredCounts }[stage].kind
  const filterCount = (find ? 1 : 0) + (kinds.length ? 1 : 0)
  // What else the search found, on the tabs that are not open. Nothing is said while an answer is due.
  const elsewhere = found.text === '' || searching ? [] : STAGES
    .filter(s => s.id !== stage)
    .map(s => ({ ...s, count: matches.filter(row => row.state === s.id).length }))
    .filter(s => s.count > 0)
  const cutShort = !searching && found.rows.length >= ENTITY_FIND_LIMIT
  // Before the first answer there is nothing to list: the whole table would flash past.
  const waiting = searching && found.text === ''
  /** An emptied list's sentence: what was searched for, else the filter. */
  const nothingMatches = (what) => (found.text
    ? <>No {what} entity matches <strong>{find.trim()}</strong>.</>
    : `No ${what} entities match this filter.`)

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
      <div className="card card-fill">
        <CardHeading
          icon={<IconArchive size={15} />}
          title="Entities"
          description="Everything this site has, found by any ID or name. An archived one restores intact; a retired one was deleted, and links to what survives it."
        />
        <TabStrip
          ariaLabel="Entities"
          value={stage}
          onChange={setStage}
          hrefFor={stageHref}
          tabs={STAGES}
        />

        <div className="filter-bar">
          <SearchInput
            value={find}
            onChange={setFind}
            placeholder="Search by any ID or name…"
            ariaLabel="Search entities by any ID or name"
          />
          <FilterDropdown
            label="Kind"
            noun="kind"
            plural="kinds"
            options={kindOptions}
            value={kinds}
            onChange={setKinds}
            counts={counts}
            width="sm"
          />
          <div className="filter-bar-actions">
            <ClearFilters count={filterCount} onClear={() => { setFind(''); setKinds(NONE) }} />
          </div>
        </div>

        {found.error && !searching && (
          <div className="callout callout-danger" role="status">
            <IconAlertTriangle size={14} className="callout-icon" />
            <div>The search could not be made: {found.error}</div>
          </div>
        )}
        {/* Where else the search found something, so a match on another tab is not missed. */}
        {(elsewhere.length > 0 || cutShort) && (
          <p className="entities-found" role="status">
            {elsewhere.length > 0 && (
              <>
                Also found:{' '}
                {elsewhere.map((s, i) => (
                  <React.Fragment key={s.id}>
                    {i > 0 && ', '}
                    <RouteLink className="count-link" to={stageHref(s.id)} onNavigate={() => setStage(s.id)} title={`Show them on the ${s.label} tab`}>
                      {s.count} {s.label.toLowerCase()}
                    </RouteLink>
                  </React.Fragment>
                ))}
                .{' '}
              </>
            )}
            {cutShort && `Only the first ${ENTITY_FIND_LIMIT} matches are listed. Type more of the ID or the name.`}
          </p>
        )}

        {stage === 'active' && (<>
        {active.error ? (
          <div className="callout callout-danger" role="status">
            <IconAlertTriangle size={14} className="callout-icon" />
            <div>The entities could not be read: {active.error}</div>
          </div>
        ) : !active.loaded || waiting ? <LoadingState label="entities" /> :
         activeRows.length === 0 ? (
           <EmptyState
             icon={<IconArchive size={36} />}
             filtered={filterCount > 0}
             message="Nothing is in service yet."
             filteredMessage={nothingMatches('active')}
           />
         ) : (<>
           <div className="table-wrap">
             <table className="table-entities">
               <thead>
                 <tr>
                   <SortHeader sort={activeSort} column="name">Name</SortHeader>
                   <SortHeader sort={activeSort} column="type">Kind</SortHeader>
                   <SortHeader sort={activeSort} column="entity_id" title="The entity's own ID. Nothing changes it, and a deleted one's is not used again.">UUID</SortHeader>
                   <SortHeader sort={activeSort} column="second_ids" title="The other IDs it goes by, such as a Sparkplug ID or a semantic ID. Open the row to copy one.">Second IDs</SortHeader>
                 </tr>
               </thead>
               <tbody>
                 {activeRows.slice(0, drawn).map(row => {
                   const badge = variantBadge(row)
                   const seconds = row.second_ids.join(' · ')
                   return (
                   <tr
                     key={entityKey(row)}
                     className={`row-selectable${selectedId === row.id ? ' row-selected' : ''}`}
                     tabIndex={0}
                     onClick={rowSelectHandler(() => toggle(row))}
                     onKeyDown={onRowKey(row)}
                   >
                     <td>
                       <strong className="entity-name">{row.name || '—'}</strong>
                       {badge && <Badge size="sm" tone={badge.tone} title={badge.title} className="badge-follow">{badge.label}</Badge>}
                     </td>
                     <td><Badge size="sm" className="entity-kind">{kindLabel(row.kind)}</Badge></td>
                     <td><CopyableId value={row.id} label="uuid" onNotify={showToast} /></td>
                     <td>
                       {seconds
                         ? <Tooltip text={seconds}><span className="entity-second-ids mono"><OverflowText>{seconds}</OverflowText></span></Tooltip>
                         : <span className="cell-meta">—</span>}
                     </td>
                   </tr>
                   )
                 })}
               </tbody>
             </table>
           </div>
           <ListFoot
             shown={Math.min(drawn, activeRows.length)}
             total={activeRows.length}
             step={ACTIVE_PAGE}
             counted
             onMore={() => setDrawn(n => n + ACTIVE_PAGE)}
           />
         </>)}
        </>)}

        {stage === 'archived' && (<>
        {loading || waiting ? <LoadingState label="archived entities" /> :
         archivedRows.length === 0 ? (
           <EmptyState
             icon={<IconArchive size={36} />}
             filtered={filterCount > 0 && archives.length > 0}
             message="Nothing is archived."
             filteredMessage={nothingMatches('archived')}
           />
         ) : (
           <div className="table-wrap">
             <table>
               <thead>
                 <tr>
                   <SortHeader sort={archivedSort} column="name">Name</SortHeader>
                   <SortHeader sort={archivedSort} column="type">Kind</SortHeader>
                   <SortHeader sort={archivedSort} column="entity_id">UUID</SortHeader>
                   <SortHeader sort={archivedSort} column="archived_at">Archived At</SortHeader>
                   <SortHeader sort={archivedSort} column="auto_purge" title="When the auto-purge timer deletes the record for good. Never: no timer runs, so it stays until someone deletes it.">Auto-Purge</SortHeader>
                   <th className="row-actions">Actions</th>
                 </tr>
               </thead>
               <tbody>
                 {archivedRows.map(a => {
                   const latestExport = a.entity_type === 'device' ? latestExportOf(a.entity_id) : null
                   return (
                   <tr key={`${a.entity_type}-${a.entity_id}`}>
                     <td>
                       <strong>{a.name}</strong>
                       {latestExport && (
                         <Tooltip text={`A bundle of this device was taken ${formatDateTime(latestExport.taken_at)} and is kept beside the cold tier`}>
                           <div className="cell-meta">Exported {formatDate(latestExport.taken_at)}</div>
                         </Tooltip>
                       )}
                     </td>
                     <td><Badge size="sm">{a.entity_type.toUpperCase()}</Badge></td>
                     <td><CopyableId value={a.entity_id} label="uuid" onNotify={showToast} /></td>
                     <td className="cell-meta">{formatDateTime(a.archived_at)}</td>
                     <td>
                       {a.auto_delete_at && a.playbacks > 0 ? (
                         <PurgeHeld at={a.auto_delete_at} playbacks={a.playbacks} />
                       ) : a.auto_delete_at ? (
                         <PurgeDate at={a.auto_delete_at} />
                       ) : (
                         <Badge size="sm">Never auto-purged</Badge>
                       )}
                     </td>
                     {/* Restore is the ordinary move and Permanent Delete the irreversible one, so
                         they are not peers: delete only takes its danger colour when pointed at.
                         Export Bundle, for a device, is what to do before the delete. */}
                     <td className="row-actions">
                       <Tooltip text={!canArchive ? deniedTitle : null}>
                         <button
                           className={`btn btn-sm btn-ghost ${!canArchive ? 'btn-disabled' : ''}`}
                           disabled={!canArchive}
                           onClick={() => canArchive && setConfirmRestore(a)}
                         >
                           <IconRefreshCw size={12} /> Restore
                         </button>
                       </Tooltip>
                       {a.entity_type === 'device' && (
                         <Tooltip text={!canArchive ? deniedTitle : 'An AASX bundle of its shell, audit trail and live telemetry, with a copy kept beside the cold tier'}>
                           <button
                             className={`btn btn-sm btn-ghost ${!canArchive ? 'btn-disabled' : ''}`}
                             disabled={!canArchive}
                             onClick={() => canArchive && setExportFor(a)}
                           >
                             <IconDownload size={12} /> Export Bundle…
                           </button>
                         </Tooltip>
                       )}
                       <Tooltip text={!canArchive ? deniedTitle : null}>
                         <button
                           className={`btn btn-sm btn-danger btn-danger-reveal ${!canArchive ? 'btn-disabled' : ''}`}
                           disabled={!canArchive}
                           onClick={() => canArchive && setConfirmPurge(a)}
                         >
                           <IconTrash size={12} /> Permanent Delete
                         </button>
                       </Tooltip>
                     </td>
                   </tr>
                   )
                 })}
               </tbody>
             </table>
           </div>
         )}
        </>)}

        {/* The second stage: the row is gone and this is what is left of it. */}
        {stage === 'retired' && (<>
        {loading || waiting ? <LoadingState label="retired entities" /> :
         retiredRows.length === 0 ? (
           <EmptyState
             icon={<IconTrash size={36} />}
             filtered={filterCount > 0 && retired.length > 0}
             message={readsRetired
               ? 'Nothing has been retired: no archived entity has been deleted yet.'
               : `Your role cannot see retired entities. They are for ${RETIRED_ROLES}.`}
             filteredMessage={nothingMatches('retired')}
           />
         ) : (
           <div className="table-wrap">
             <table>
               <thead>
                 <tr>
                   <SortHeader sort={retiredSort} column="name">Name</SortHeader>
                   <SortHeader sort={retiredSort} column="type">Kind</SortHeader>
                   <SortHeader sort={retiredSort} column="entity_id">UUID</SortHeader>
                   <SortHeader sort={retiredSort} column="retired_at" title="When the row was deleted">Retired At</SortHeader>
                   <SortHeader sort={retiredSort} column="by" title="Who deleted it, or the retention job">By</SortHeader>
                   <SortHeader sort={retiredSort} column="historian_id" title="The historian keys this entity's readings by this id">Historian ID</SortHeader>
                   <th className="row-actions">What Survives</th>
                 </tr>
               </thead>
               <tbody>
                 {retiredRows.map(r => (
                   <tr key={`${r.entity_type}-${r.entity_id}`}>
                     <td><strong>{r.name || '—'}</strong></td>
                     <td><Badge size="sm">{String(r.entity_type).toUpperCase()}</Badge></td>
                     <td><CopyableId value={r.entity_id} label="uuid" onNotify={showToast} /></td>
                     <Tooltip text={r.archived_at ? `Archived ${formatDateTime(r.archived_at)}` : null}>
                       <td className="cell-meta">{formatDateTime(r.retired_at)}</td>
                     </Tooltip>
                     {/* The name with the email on hover, where the column is narrow. */}
                     <td className="cell-meta">{r.retired_by_email
                       ? <PersonName name={r.retired_by_name} email={r.retired_by_email} emailOnHover />
                       : (r.retired_by ? <span className="mono">{String(r.retired_by).slice(0, 8)}…</span> : 'retention timer')}</td>
                     <td>{r.sparkplug_id ? <CopyableId value={r.sparkplug_id} label="historian id" onNotify={showToast} /> : <span className="cell-meta">—</span>}</td>
                     <td className="row-actions">{survivors(r)}</td>
                   </tr>
                 ))}
               </tbody>
             </table>
           </div>
         )}
        </>)}
      </div>
      </div>

      <EntityDrawer
        entity={selected}
        nameOf={nameOf}
        onClose={() => setSelectedId('')}
        showToast={showToast}
        userRole={userRole}
        hasPermission={hasPermission}
      />

      {confirmRestore && (
        <RestoreEntityModal
          type={confirmRestore.entity_type}
          name={confirmRestore.name}
          credentialRevoked={Boolean(confirmRestore.credential_revoked_at)}
          forgeArchived={Boolean(confirmRestore.forge_archived_at)}
          enrolled={hadEnrolled(confirmRestore)}
          onConfirm={() => restore(confirmRestore)}
          onCancel={() => setConfirmRestore(null)}
        />
      )}

      {exportFor && (
        <DeviceExportModal
          device={{ id: exportFor.entity_id, name: exportFor.name }}
          initialFormat="bundle"
          bundleDisabledReason={canReadTrail ? null : `The bundle carries the Audit Trail. ${requiresRolesTitle(PERMISSION_UUIDS.AUDIT_TRAIL_READ)}.`}
          onClose={() => { setExportFor(null); load() }}
          showToast={showToast}
          unmappedMetricsTo={unmappedMetricsTo}
        />
      )}
      {confirmPurge && (
        <ConfirmModal
          title={`Permanently delete ${confirmPurge.entity_type}`}
          icon={<IconTrash size={18} />}
          message={
            `Permanently delete the ${confirmPurge.entity_type} '${confirmPurge.name}'? ` +
            'This removes the record from the database immediately. It cannot be restored, and ' +
            'it does not wait for the retention timer. Its audit trail history is kept, and a ' +
            'tombstone is left on this page.' +
            // What happens to what was inside it, for the two types that hold other assets.
            (confirmPurge.entity_type === 'cell'
              ? ' Anything still filed into it — gateways and devices alike — is un-filed rather' +
                ' than deleted, and appears as Unassigned.'
              : '') +
            // An archived area holds no Area-Wide asset (0199), so nothing refuses its delete.
            (confirmPurge.entity_type === 'area'
              ? ' Its cells are kept and become unfiled' +
                (confirmPurge.plan_path ? '; its area plan is deleted' : '') + '.'
              : '') +
            (confirmPurge.entity_type === 'device'
              ? ' Any replay lane recorded from it is deleted with it. Export a bundle first if' +
                ' its record and readings are to leave with it.'
              : '')
          }
          pendingLabel="Deleting…"
          requireTyped={confirmPurge.name}
          requireTypedLabel={`${confirmPurge.entity_type} name`}
          onConfirm={() => purge(confirmPurge)}
          onCancel={() => setConfirmPurge(null)}
        />
      )}
    </div>
  )
}

/**
 * An archived row's auto-purge date, as a plain date. Within a week of the purge it takes the
 * danger colour and a warning icon, so colour is not the only signal, and says so to a reader.
 */
function PurgeDate({ at }) {
  const soon = purgeIsSoon(at)
  return (
    <Tooltip text={`Deleted for good ${formatDateTime(at)}, unless restored first`}>
      <span className={soon ? 'cell-purge-date cell-purge-date-soon' : 'cell-purge-date'}>
        {soon && <IconAlertTriangle size={12} />}
        {soon && <span className="sr-only">Within a week: </span>}
        {formatDate(at)}
      </span>
    </Tooltip>
  )
}

/**
 * In place of the date on a gateway a playback names. The record of each playback is kept for
 * good and names the gateway it was published as, so neither the purge nor Permanent Delete
 * removes the gateway, and the date would never be kept.
 */
function PurgeHeld({ at, playbacks }) {
  return (
    <Tooltip text={`Due ${formatDate(at)}, but each playback published as this gateway is kept on record, so neither the auto-purge nor Permanent Delete removes it. Restore it, or leave it archived.`}>
      <span className="cell-purge-date cell-purge-held">
        <IconLock size={12} />
        Held: {plural(playbacks, 'playback')} {playbacks === 1 ? 'names' : 'name'} this gateway
      </span>
    </Tooltip>
  )
}
