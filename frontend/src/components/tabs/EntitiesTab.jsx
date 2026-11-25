import React, { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react'
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
import { ExpandAllToggle } from '../common/ExpandAllToggle'
import { GroupHeading } from '../common/GroupHeading'
import { ListFoot } from '../common/ListFoot'
import { OverflowText } from '../common/OverflowText'
import { SearchInput } from '../common/SearchInput'
import { EntityDrawer } from './EntityDrawer'
import { useTableSort } from '../../hooks/useTableSort'
import { useDisplayNames } from '../../hooks/useDisplayNames'
import { useLocalEntities } from '../../hooks/useLocalEntities'
import { useOpenGroups } from '../../hooks/useOpenGroups'
import { PersonName } from '../common/PersonName'
import { SortHeader } from '../common/SortHeader'
import { Tooltip } from '../common/Tooltip'
import { IconArchive, IconRefreshCw, IconTrash, IconDownload, IconHistory, IconExternalLink, IconAlertTriangle, IconLock } from '../common/Icons'
import { Badge } from '../common/Badge'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { hadEnrolled } from '../../utils/credentialState'
import {
  ENTITY_KINDS, byKindThenName, entityKey, findText, groupByKind, isWholeId, kindCount, kindPlural, lastDeleted, mergeFound, nextPurge,
  purgeIsHeld, purgeIsSoon, variantBadge,
} from '../../utils/entities'
import { KIND_ICONS } from '../../utils/entityPages'
import { formatDate, formatDateTime, plural } from '../../utils/format'

/** The page's singular row type -> the Audit Trail page's handover type. */
const TRAIL_TYPE = { area: 'AREA', cell: 'CELL', gateway: 'GATEWAY', device: 'DEVICE' }

/** The three states, in tab order (navigation.jsx). The description is the tab's tooltip; the help page has the rest. */
export const STAGES = ENTITIES_TABS

/** Hoisted: a list's default is compared, not copied. */
const NONE = Object.freeze([])

/** Every kind, for Collapse all, which closes the groups a search left out as well as those it shows. */
const EVERY_KIND = ENTITY_KINDS.map(k => k.kind)

/** The roles the tombstones' policy admits, as a sentence names them: either permission's. */
const RETIRED_ROLES = (() => {
  const roles = [...new Set([PERMISSION_UUIDS.ARCHIVE_MANAGE, PERMISSION_UUIDS.AUDIT_TRAIL_READ].flatMap(rolesHolding))]
  return `${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}`
})()

/** Rows an open group first draws, and how many its Show more adds: a site can have thousands of devices. */
export const GROUP_PAGE = 200

/** How long the typing rests before a search asks the database. */
const FIND_SETTLE_MS = 200

/** The Active table's sortable columns, the first two the other tables' own. Each table sorts inside its groups. */
const ACTIVE_SORT = {
  name: { type: 'text', value: e => e.name },
  entity_id: { type: 'text', value: e => e.id },
  second_ids: { type: 'text', value: e => e.second_ids.join(' · ') }
}

/** An archived or a retired row with the kind, the id and the state entity_directory has for it: the rows are named in the singular. */
const ofState = (state) => (row) => ({ ...row, kind: `${row.entity_type}s`, id: row.entity_id, state })
const ofArchived = ofState('archived')
const ofRetired = ofState('retired')

/** The Archived table's sortable columns. An entity with no auto-purge timer goes last. */
const ARCHIVED_SORT = {
  name: { type: 'text', value: a => a.name },
  entity_id: { type: 'text', value: a => a.entity_id },
  archived_at: { type: 'time', value: a => a.archived_at },
  auto_purge: { type: 'time', value: a => a.auto_delete_at }
}

/** The Retired table's sortable columns, each on what its cell shows. */
const RETIRED_SORT = {
  name: { type: 'text', value: r => r.name },
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
 * still keyed by. Each tab's rows are groups by kind, closed to begin with, in one table whose first two
 * columns the three tabs share.
 *
 * One search covers the three. `?find=` is asked of find_entities(), which reads the view, so a tab lists
 * only what the search found; a whole id that names one row opens that row, on its own tab. `?kind=` names
 * the groups that start open, and leaves the address once a person opens or closes one.
 *
 * `unmappedMetricsTo` is handed to the export dialog, whose warning about metrics with no semantic
 * id then links to the Metrics page. Omit it for a reader who cannot open that page.
 */
export function EntitiesTab({ showToast, userRole, hasPermission, onViewTrail, unmappedMetricsTo }) {
  const [active, setActive]     = useState({ rows: NONE, loaded: false, error: null })
  const [archives, setArchives] = useState([])
  const [retired, setRetired]   = useState([])
  const [exports, setExports]   = useState([])
  const [loading, setLoading]   = useState(true)
  // The tab, in the path: `/entities`, `/entities/archived` or `/entities/retired`. The search is the
  // page's, so it goes along; the kinds that start open and the sort are the tab's.
  const [stage, setStage, stageHref] = useUrlTab('entities', STAGES.map(s => s.id), 'active', { keep: ['find'] })
  const [find, setFind] = useUrlState('find')
  const [kinds, setKinds] = useUrlList('kind', NONE, { allowed: ENTITY_KINDS.map(k => k.kind) })
  const text = findText(find)

  // People and the pinned identities, which no table the view reads holds.
  const { rows: local, loaded: localLoaded } = useLocalEntities(userRole)

  /* What the search found, for the text it was asked with. `found.text` lags `text` while one is typed and
     while the answer is on its way, and what is listed is always one answer's. Asked again after an act on
     the page (`version`), since a restored entity is on another tab. */
  const [found, setFound] = useState({ text: '', rows: NONE, error: null })
  const [version, setVersion] = useState(0)
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
  }, [text, version])
  const searching = text !== found.text
  const matches = useMemo(
    () => (found.text === '' ? NONE : mergeFound(found.rows, local, found.text)),
    [found, local]
  )
  const everyActive = useMemo(
    () => [...active.rows, ...local].sort(byKindThenName),
    [active.rows, local]
  )
  const everyArchived = useMemo(() => archives.map(ofArchived), [archives])
  // Who deleted each one: the email stamped at the time, and their display name read live. Only
  // people this viewer can already see here are answered; anyone else is drawn by email alone.
  const retirerNames = useDisplayNames(useMemo(() => retired.map(r => r.retired_by), [retired]))
  const everyRetired = useMemo(
    () => retired.map(r => ({ ...ofRetired(r), retired_by_name: retirerNames.get(r.retired_by) || null })),
    [retired, retirerNames]
  )
  /** A tab's rows, or those of them the search found, as groups. */
  const listed = useCallback((rows) => {
    if (found.text === '') return groupByKind(rows)
    const matched = new Set(matches.map(entityKey))
    return groupByKind(rows.filter(row => matched.has(entityKey(row))))
  }, [found.text, matches])
  // The search answers the Active rows itself, in its own order.
  const activeGroups = useMemo(
    () => groupByKind(found.text === '' ? everyActive : matches.filter(row => row.state === 'active')),
    [found.text, everyActive, matches]
  )
  const archivedGroups = useMemo(() => listed(everyArchived), [listed, everyArchived])
  const retiredGroups = useMemo(() => listed(everyRetired), [listed, everyRetired])
  const groups = { active: activeGroups, archived: archivedGroups, retired: retiredGroups }[stage]
  const activeSort = useTableSort(ACTIVE_SORT, { active: stage === 'active' })
  const archivedSort = useTableSort(ARCHIVED_SORT, { active: stage === 'archived' })
  const retiredSort = useTableSort(RETIRED_SORT, { active: stage === 'retired' })

  /* Which groups are open, each tab's its own. The kinds the address names start open and no other; one
     this tab has no rows of names nothing. */
  const groupKey = (kind) => `${stage}:${kind}`
  const named = kinds.filter(kind => groups.some(g => g.kind === kind)).map(groupKey)
  const narrowed = found.text !== ''
  const openGroups = useOpenGroups(narrowed, key => (named.length > 0 ? named.includes(key) : narrowed || groups.length === 1))
  /** The groups the address opened become the person's, as they are, and the address lets go of them. */
  const takeGroups = () => {
    if (kinds.length === 0) return
    if (named.length > 0) for (const g of groups) openGroups.setOpen([groupKey(g.kind)], named.includes(groupKey(g.kind)))
    setKinds(NONE)
  }
  const setGroups = (which, isOpen) => {
    takeGroups()
    openGroups.setOpen(which.map(groupKey), isOpen)
  }
  const searchFor = (value) => {
    // A search opens every group it matches, whichever the address named.
    if (narrowed) setKinds(NONE)
    else takeGroups()
    setFind(value)
  }

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

  // The Active row whose drawer is open, in the address as `?entity=`.
  const inService = (id) => everyActive.find(row => row.id === id)
    ?? matches.find(row => row.state === 'active' && row.id === id) ?? null
  const [selectedId, setSelectedId] = useUrlState('entity', '', {
    // A row only the search found is known once it has answered.
    allowed: active.loaded && localLoaded && !searching ? id => inService(id) !== null : null
  })
  const selected = stage === 'active' && selectedId ? inService(selectedId) : null
  const toggle = useCallback((row) => setSelectedId(id => (id === row.id ? '' : row.id)), [setSelectedId])
  // An arrival opens the group its row is in: `?entity=`, or a whole id. A press is on a row of an open one.
  const arrived = useRef(null)
  arrived.current = () => {
    if (selected && !openGroups.isOpen(groupKey(selected.kind))) setGroups([selected.kind], true)
  }
  const selectedKey = selected ? entityKey(selected) : null
  useEffect(() => { if (selectedKey) arrived.current() }, [selectedKey])
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
    setConfirmRestore(null); load(); setVersion(v => v + 1)
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
    load(); setVersion(v => v + 1)
    showToast(`Entity '${item.name}' permanently deleted`, 'success')
  }

  const downloadExport = useCallback(async (row) => {
    try {
      const url = await api.assetExportDownloadUrl(row)
      window.open(url, '_blank', 'noopener')
    } catch (e) { showToast(e.message, 'error') }
  }, [showToast])

  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  const deniedTitle = requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  // aas-export refuses the bundle to a reader without audit_trail:read, since it carries the trail.
  const canReadTrail = hasPermission(PERMISSION_UUIDS.AUDIT_TRAIL_READ)
  // The tombstones' policy: either permission. Anyone else is told so, rather than that there are none.
  const readsRetired = canArchive || canReadTrail
  const latestExports = useMemo(() => {
    const latest = new Map()
    for (const x of exports) if (!latest.has(x.entity_id)) latest.set(x.entity_id, x)
    return latest
  }, [exports])
  const archivedActs = useMemo(
    () => ({ canArchive, deniedTitle, latestExports, onRestore: setConfirmRestore, onExport: setExportFor, onPurge: setConfirmPurge }),
    [canArchive, deniedTitle, latestExports]
  )
  const retiredActs = useMemo(() => ({ onViewTrail, onDownload: downloadExport }), [onViewTrail, downloadExport])

  // What else the search found, on the tabs that are not open. Nothing is said while an answer is due.
  const elsewhere = found.text === '' || searching ? [] : STAGES
    .filter(s => s.id !== stage)
    .map(s => ({ ...s, count: matches.filter(row => row.state === s.id).length }))
    .filter(s => s.count > 0)
  const cutShort = !searching && found.rows.length >= ENTITY_FIND_LIMIT
  // Before the first answer there is nothing to list: the whole table would flash past.
  const waiting = searching && found.text === ''
  const nothingMatches = (what) => <>No {what} entity matches <strong>{find.trim()}</strong>.</>
  const settled = !waiting && (stage === 'active' ? active.loaded && !active.error : !loading)

  /** The open tab's groups, as the table's bodies: a heading each, and the rows of the open ones. */
  const bodies = ({ columns, sort, Row, detailOf, acts }) => groups.map(group => {
    const key = groupKey(group.kind)
    const isOpen = openGroups.isOpen(key)
    const Icon = KIND_ICONS[group.kind]
    const rowsId = `entities-${stage}-${group.kind}`
    return (
      <React.Fragment key={key}>
        <tbody>
          <tr className="table-group-row">
            <td colSpan={columns}>
              <GroupHeading
                open={isOpen}
                onToggle={() => setGroups([group.kind], !isOpen)}
                label={kindPlural(group.kind)}
                count={group.rows.length}
                countLabel={kindCount(group.kind, group.rows.length)}
                detail={detailOf?.(group.rows)}
                icon={Icon && <Icon size={12} />}
                controls={rowsId}
              />
            </td>
          </tr>
        </tbody>
        <tbody id={rowsId} hidden={!isOpen}>
          {/* The key starts a search's rows at the first page again. */}
          {isOpen && (
            <KindRows
              key={found.text}
              rows={group.rows}
              columns={columns}
              sort={sort}
              Row={Row}
              selectedId={selectedId}
              onSelect={toggle}
              notify={showToast}
              acts={acts}
            />
          )}
        </tbody>
      </React.Fragment>
    )
  })

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
      <div className="card card-fill">
        <CardHeading
          icon={<IconArchive size={15} />}
          title="Entities"
          description="Every entity in service, archived or deleted, found by any ID or name. An archived one restores intact; a retired one links to what survives it."
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
            onChange={searchFor}
            placeholder="Search by any ID or name…"
            ariaLabel="Search entities by any ID or name"
          />
          <div className="filter-bar-actions">
            <ClearFilters count={find ? 1 : 0} onClear={() => searchFor('')} />
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

        {/* The control that acts on the groups sits at the start of the row over them, not in the
            toolbar. Drawn with the table: an empty list has no group to open. */}
        {settled && groups.length > 0 && (
          <div className="groups-header">
            <ExpandAllToggle
              anyOpen={groups.some(g => openGroups.isOpen(groupKey(g.kind)))}
              onExpandAll={() => setGroups([...EVERY_KIND, ...groups.map(g => g.kind)], true)}
              onCollapseAll={() => setGroups([...EVERY_KIND, ...groups.map(g => g.kind)], false)}
              noun="groups"
            />
          </div>
        )}

        {stage === 'active' && (<>
        {active.error ? (
          <div className="callout callout-danger" role="status">
            <IconAlertTriangle size={14} className="callout-icon" />
            <div>The entities could not be read: {active.error}</div>
          </div>
        ) : !active.loaded || waiting ? <LoadingState label="entities" /> :
         groups.length === 0 ? (
           <EmptyState
             icon={<IconArchive size={36} />}
             filtered={narrowed}
             message="Nothing is in service yet."
             filteredMessage={nothingMatches('active')}
           />
         ) : (
           <div className="table-wrap">
             <table className="table-entities">
               <thead>
                 <tr>
                   <SortHeader sort={activeSort} column="name">Name</SortHeader>
                   <SortHeader sort={activeSort} column="entity_id" title="The entity's own ID. Nothing changes it, and a deleted one's is not used again.">UUID</SortHeader>
                   <SortHeader sort={activeSort} column="second_ids" title="The other IDs it goes by, such as a Sparkplug ID or a semantic ID. Open the row to copy one.">Second IDs</SortHeader>
                 </tr>
               </thead>
               {bodies({ columns: 3, sort: activeSort, Row: ActiveRow })}
             </table>
           </div>
         )}
        </>)}

        {stage === 'archived' && (<>
        {loading || waiting ? <LoadingState label="archived entities" /> :
         groups.length === 0 ? (
           <EmptyState
             icon={<IconArchive size={36} />}
             filtered={narrowed && archives.length > 0}
             message="Nothing is archived."
             filteredMessage={nothingMatches('archived')}
           />
         ) : (
           <div className="table-wrap">
             <table>
               <thead>
                 <tr>
                   <SortHeader sort={archivedSort} column="name">Name</SortHeader>
                   <SortHeader sort={archivedSort} column="entity_id">UUID</SortHeader>
                   <SortHeader sort={archivedSort} column="archived_at">Archived At</SortHeader>
                   <SortHeader sort={archivedSort} column="auto_purge" title="When the auto-purge timer deletes the record for good. Never: no timer runs, so it stays until someone deletes it.">Auto-Purge</SortHeader>
                   <th className="row-actions">Actions</th>
                 </tr>
               </thead>
               {bodies({ columns: 5, sort: archivedSort, Row: ArchivedRow, detailOf: nextPurge, acts: archivedActs })}
             </table>
           </div>
         )}
        </>)}

        {/* The second stage: the row is gone and this is what is left of it. */}
        {stage === 'retired' && (<>
        {loading || waiting ? <LoadingState label="retired entities" /> :
         groups.length === 0 ? (
           <EmptyState
             icon={<IconTrash size={36} />}
             filtered={narrowed && retired.length > 0}
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
                   <SortHeader sort={retiredSort} column="entity_id">UUID</SortHeader>
                   <SortHeader sort={retiredSort} column="retired_at" title="When the row was deleted">Retired At</SortHeader>
                   <SortHeader sort={retiredSort} column="by" title="Who deleted it, or the retention job">By</SortHeader>
                   <SortHeader sort={retiredSort} column="historian_id" title="The historian keys this entity's readings by this id">Historian ID</SortHeader>
                   <th className="row-actions">What Survives</th>
                 </tr>
               </thead>
               {bodies({ columns: 6, sort: retiredSort, Row: RetiredRow, detailOf: lastDeleted, acts: retiredActs })}
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
          title={`Permanently Delete ${confirmPurge.entity_type[0].toUpperCase()}${confirmPurge.entity_type.slice(1)}`}
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
          confirmLabel={`Permanently Delete ${confirmPurge.entity_type[0].toUpperCase()}${confirmPurge.entity_type.slice(1)}`}
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
 * An open group's rows, GROUP_PAGE at a time. Memoised, as each row is: a keystroke in the search draws
 * none of them again, and a selection draws the two it changes.
 */
const KindRows = memo(function KindRows({ rows, columns, sort, Row, selectedId, ...shared }) {
  const [drawn, setDrawn] = useState(GROUP_PAGE)
  const sorted = useMemo(() => sort.apply(rows), [sort, rows])
  return (
    <>
      {sorted.slice(0, drawn).map(row => <Row key={entityKey(row)} row={row} selected={selectedId === row.id} {...shared} />)}
      {sorted.length > GROUP_PAGE && (
        <tr className="table-group-foot">
          <td colSpan={columns}>
            <ListFoot
              shown={Math.min(drawn, sorted.length)}
              total={sorted.length}
              step={GROUP_PAGE}
              counted
              onMore={() => setDrawn(n => n + GROUP_PAGE)}
            />
          </td>
        </tr>
      )}
    </>
  )
})

/** Enter or Space on a row itself acts as its click; a key on a control inside it is that control's. */
const rowKeyHandler = (onSelect) => (e) => {
  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
  if (e.key === ' ') e.preventDefault()
  onSelect()
}

const ActiveRow = memo(function ActiveRow({ row, selected, onSelect, notify }) {
  const badge = variantBadge(row)
  const seconds = row.second_ids.join(' · ')
  const select = () => onSelect(row)
  return (
    <tr
      className={`row-selectable${selected ? ' row-selected' : ''}`}
      tabIndex={0}
      onClick={rowSelectHandler(select)}
      onKeyDown={rowKeyHandler(select)}
    >
      <td>
        <strong>{row.name || '—'}</strong>
        {badge && <Badge size="sm" tone={badge.tone} title={badge.title} className="badge-follow">{badge.label}</Badge>}
      </td>
      <td><CopyableId value={row.id} label="uuid" onNotify={notify} /></td>
      <td>
        {seconds
          ? <Tooltip text={seconds}><span className="entity-second-ids mono"><OverflowText>{seconds}</OverflowText></span></Tooltip>
          : <span className="cell-meta">—</span>}
      </td>
    </tr>
  )
})

const ArchivedRow = memo(function ArchivedRow({ row: a, notify, acts }) {
  const { canArchive, deniedTitle, latestExports, onRestore, onExport, onPurge } = acts
  const latestExport = a.kind === 'devices' ? latestExports.get(a.id) : null
  return (
    <tr>
      <td>
        <strong>{a.name}</strong>
        {latestExport && (
          <Tooltip text={`A bundle of this device was taken ${formatDateTime(latestExport.taken_at)} and is kept beside the cold tier`}>
            <div className="cell-meta">Exported {formatDate(latestExport.taken_at)}</div>
          </Tooltip>
        )}
      </td>
      <td><CopyableId value={a.entity_id} label="uuid" onNotify={notify} /></td>
      <td className="cell-meta">{formatDateTime(a.archived_at)}</td>
      <td>
        {purgeIsHeld(a) ? (
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
            onClick={() => canArchive && onRestore(a)}
          >
            <IconRefreshCw size={12} /> Restore
          </button>
        </Tooltip>
        {a.entity_type === 'device' && (
          <Tooltip text={!canArchive ? deniedTitle : 'An AASX bundle of its shell, audit trail and live telemetry, with a copy kept beside the cold tier'}>
            <button
              className={`btn btn-sm btn-ghost ${!canArchive ? 'btn-disabled' : ''}`}
              disabled={!canArchive}
              onClick={() => canArchive && onExport(a)}
            >
              <IconDownload size={12} /> Export Bundle…
            </button>
          </Tooltip>
        )}
        <Tooltip text={!canArchive ? deniedTitle : null}>
          <button
            className={`btn btn-sm btn-danger btn-danger-reveal ${!canArchive ? 'btn-disabled' : ''}`}
            disabled={!canArchive}
            onClick={() => canArchive && onPurge(a)}
          >
            <IconTrash size={12} /> Permanent Delete
          </button>
        </Tooltip>
      </td>
    </tr>
  )
})

const RetiredRow = memo(function RetiredRow({ row: r, notify, acts }) {
  return (
    <tr>
      <td><strong>{r.name || '—'}</strong></td>
      <td><CopyableId value={r.entity_id} label="uuid" onNotify={notify} /></td>
      <Tooltip text={r.archived_at ? `Archived ${formatDateTime(r.archived_at)}` : null}>
        <td className="cell-meta">{formatDateTime(r.retired_at)}</td>
      </Tooltip>
      {/* The name with the email on hover, where the column is narrow. */}
      <td className="cell-meta">{r.retired_by_email
        ? <PersonName name={r.retired_by_name} email={r.retired_by_email} emailOnHover />
        : (r.retired_by ? <span className="mono">{String(r.retired_by).slice(0, 8)}…</span> : 'retention timer')}</td>
      <td>{r.sparkplug_id ? <CopyableId value={r.sparkplug_id} label="historian id" onNotify={notify} /> : <span className="cell-meta">—</span>}</td>
      <td className="row-actions"><Survivors row={r} {...acts} /></td>
    </tr>
  )
})

/** What survives a retired entity, as links; derived from the tombstone's row and its exports. */
function Survivors({ row: r, onViewTrail, onDownload }) {
  return (
    <>
      {onViewTrail && (
        <RouteLink
          className="btn btn-sm btn-ghost"
          to={trailUrl(r.entity_id, TRAIL_TYPE[r.entity_type], true)}
          onNavigate={() => onViewTrail({ id: r.entity_id, type: TRAIL_TYPE[r.entity_type], purged: true })}
          title="Open this entity's audit trace on the Audit Trail page, deleted entities shown"
        >
          <IconHistory size={12} /> Audit Trail
        </RouteLink>
      )}
      {/* Derived from the id as it is everywhere else. */}
      {r.entity_type === 'gateway' && r.old_data?.forge_repository_at && r.sparkplug_id && (
        <Tooltip text="Its repository in the forge: archived, read-only, every branch and wiki page kept">
          <a
            className="btn btn-sm btn-ghost"
            href={gatewayRepositoryUrl({ sparkplug_id: r.sparkplug_id })}
            target="_blank"
            rel="noopener noreferrer"
          >
            <IconExternalLink size={12} /> Forge repository
          </a>
        </Tooltip>
      )}
      {(r.exports || []).map(x => (
        <Tooltip key={x.id} text={`The bundle taken ${formatDateTime(x.taken_at)}${x.taken_by_email ? ` by ${x.taken_by_email}` : ''}: shell, audit trail, live telemetry and the cold-object manifest`}>
          <button className="btn btn-sm btn-ghost" onClick={() => onDownload(x)}>
            <IconDownload size={12} /> Bundle {formatDate(x.taken_at)}
          </button>
        </Tooltip>
      ))}
    </>
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
