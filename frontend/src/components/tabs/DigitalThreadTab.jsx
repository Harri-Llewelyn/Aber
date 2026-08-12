import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { downloadCSV } from '../../utils/downloadCSV'
import { AutoRefreshControl } from '../common/AutoRefreshControl'
import { IconHistory, IconDownload, IconX } from '../common/Icons'

/**
 * How a machine-originated change is described. `changed_by` names WHICH user and is NULL for
 * every write no person made; `actor_source` (migration 0005) names WHAT KIND of actor it was,
 * so a blank author is no longer ambiguous between "a gateway did this" and "we lost track".
 */
const ACTOR_LABELS = {
  user:      { label: 'User',              title: 'Made by a signed-in operator' },
  ingestion: { label: 'Ingestion daemon',  title: 'Written by the Sparkplug B ingestion daemon' },
  migration: { label: 'Database migration', title: 'Written by a migration or an owner connection' },
  service:   { label: 'Service',           title: 'Written by an automated service on the service-role key' }
}

/**
 * `initialEntity` is a handover from another page's "Digital Thread" action: `{ id, type }`.
 *
 * It is applied to the ordinary filters rather than held as a separate mode, so the page an
 * operator lands on is the page they already know -- every control still works, Clear Filters
 * really does clear, and the export covers what is on screen. The id goes into the name filter
 * because that filter already matches on id as well as name (see namedEntityIds), which makes the
 * handover exact: two devices may share a name, but the id is the row.
 */
export function DigitalThreadTab({ initialEntity, onClearEntity }) {
  const [events, setEvents]           = useState([])
  const [loading, setLoading]         = useState(true)
  const [entityTypeFilter, setEntityTypeFilter] = useState(initialEntity?.type || '')
  const [nameFilter, setNameFilter]   = useState(initialEntity?.id || '')
  const [actionFilter, setActionFilter] = useState('')
  const [devices, setDevices]         = useState([])
  const [gateways, setGateways]       = useState([])
  const [cells, setCells]             = useState([])

  useEffect(() => {
    // Cells and gateways join devices here so the audit log can be searched by the NAME an
    // operator knows an asset by. The log itself stores only entity_id -- names live on the
    // entity, and deliberately carry no identity of their own (they are editable), so resolving
    // one is a client-side join rather than something the audit row could have recorded.
    Promise.all([
      api.get('/api/v1/devices'),
      api.get('/api/v1/gateways'),
      api.get('/api/v1/cells')
    ])
      .then(([d, g, c]) => { setDevices(d); setGateways(g); setCells(c) })
      .catch(() => {})
  }, [])

  /** entity_id -> display name, across all three audited tables. */
  const entityNames = useMemo(() => {
    const m = new Map()
    for (const c of cells)    m.set(c.cell_id, c.cell_name)
    for (const g of gateways) m.set(g.gateway_id, g.gateway_name)
    for (const d of devices)  m.set(d.asset_id, d.asset_name)
    return m
  }, [cells, gateways, devices])

  /**
   * A name search resolves to the ids that match it, rather than filtering the fetched page.
   *
   * The row limit is applied by the database, so filtering after the fact would page through 200
   * mixed rows and then show whichever fraction happened to match -- the same reason the action
   * filter is a SQL predicate. Resolving to ids first keeps the limit meaningful.
   */
  const namedEntityIds = useMemo(() => {
    const q = nameFilter.trim().toLowerCase()
    if (!q) return null
    return [...entityNames.entries()]
      .filter(([id, name]) =>
        String(name || '').toLowerCase().includes(q) || String(id).toLowerCase().includes(q))
      .map(([id]) => id)
  }, [nameFilter, entityNames])

  const load = useCallback((isInitial = false) => {
    if (isInitial) setLoading(true)
    let url = '/api/v1/digital-thread?limit=200'
    if (entityTypeFilter) url += `&entity_type=${encodeURIComponent(entityTypeFilter)}`
    if (actionFilter)     url += `&action=${encodeURIComponent(actionFilter)}`
    if (namedEntityIds)   url += `&entity_ids=${encodeURIComponent(namedEntityIds.join(','))}`
    api.get(url)
      .then(d => { setEvents(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [entityTypeFilter, actionFilter, namedEntityIds])

  // A later handover -- clicking Digital Thread on a second device without leaving the page --
  // replaces the filter rather than being ignored because state was already initialised.
  useEffect(() => {
    if (!initialEntity?.id) return
    setEntityTypeFilter(initialEntity.type || '')
    setNameFilter(initialEntity.id)
  }, [initialEntity?.id, initialEntity?.type])

  const activeFilterCount =
    (entityTypeFilter ? 1 : 0) + (nameFilter ? 1 : 0) + (actionFilter ? 1 : 0)

  const resetFilters = () => {
    setEntityTypeFilter(''); setNameFilter(''); setActionFilter('')
    // Also drop the handover, or the effect above would immediately re-apply it and Clear Filters
    // would appear to do nothing.
    onClearEntity?.()
  }

  // Same wrapper TelemetryTab needs: AutoRefreshControl wires onRefresh straight to onClick, so
  // passing `load` directly hands the click event in as `isInitial` -- truthy -- and blanks the
  // timeline on every manual refresh.
  const handleRefresh = useCallback(() => load(false), [load])

  useEffect(() => {
    load(true)
  }, [load])

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Digital Thread Audit Trace Timeline <span className="section-count">{events.length}</span></h2>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => downloadCSV(events, 'digital-thread-export.csv')} title="Download audit events as CSV"><IconDownload size={13} /> Export CSV</button>
          <AutoRefreshControl onRefresh={handleRefresh} defaultInterval={0} />
        </div>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Complete immutable historical audit trace timeline across Cells, Gateways, and Devices with case-insensitive search and metadata inspection.
      </p>

      {/* Moved out of the section header into the same `.filter-bar` the Gateways and Devices
          pages use. Two filter surfaces on one page crowded the header and put the filters in a
          different place on every tab; this is the one shape an operator learns once. */}
      <div className="filter-bar">
        <select
          className="form-control"
          style={{ width: '150px' }}
          value={entityTypeFilter}
          onChange={e => setEntityTypeFilter(e.target.value)}
          title="Show only events against one kind of asset"
        >
          <option value="">All entities</option>
          <option value="CELL">Cells</option>
          <option value="GATEWAY">Gateways</option>
          <option value="DEVICE">Devices</option>
        </select>

        <input
          className="form-control"
          style={{ width: '220px' }}
          value={nameFilter}
          onChange={e => setNameFilter(e.target.value)}
          placeholder="Search by entity name or ID…"
          title="Filter by the asset's name, or by its id"
        />

        <select
          className="form-control"
          style={{ width: '150px' }}
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
          title="Show only one kind of audit event"
        >
          <option value="">Any event</option>
          <option value="INSERT">Created</option>
          <option value="UPDATE">Updated</option>
          <option value="DELETE">Deleted</option>
        </select>

        {activeFilterCount > 0 && (
          <button className="btn btn-ghost btn-sm filter-bar-spacer" onClick={resetFilters} title="Clear every filter">
            <IconX size={13} /> Clear filters ({activeFilterCount})
          </button>
        )}
      </div>

      <div className="card" style={{ padding: '24px' }}>
        {loading ? (
          <div className="loading-wrap"><div className="spinner" /> Loading digital thread trace sequence…</div>
        ) : events.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><IconHistory size={36} /></div>
            <div className="empty-text">No digital thread events match the filter criteria.</div>
          </div>
        ) : (
          <div className="timeline">
            {events.map(e => (
              <div key={e.event_id} className="timeline-item">
                <div className="timeline-dot" />
                <div className="timeline-content">
                  <div className="timeline-header">
                    <div className="timeline-title">
                      <span className="badge badge-neutral" title="Entity category">{e.entity_type}</span>
                      {/* The name leads and the id follows: an operator recognises the asset, not
                          its UUID. A deleted entity has no name left to resolve, so the id is
                          what remains and is shown alone. */}
                      {entityNames.get(e.entity_id)
                        ? <strong title="Asset name">{entityNames.get(e.entity_id)}</strong>
                        : null}
                      <span className="mono" style={{ color: 'var(--accent)', fontSize: '11px' }} title="Target Entity ID">[{e.entity_id}]</span>
                      <span className="badge badge-warning" title="Audit event type">{e.event_type}</span>
                      {/* Who, or failing that what. actor_source is never null on a row written
                          since migration 0005, so "Unattributed" now means a real gap rather
                          than the ordinary case it used to be. */}
                      <span
                        className="badge badge-neutral"
                        title={e.changed_by
                          ? `Changed by user ${e.changed_by}`
                          : (ACTOR_LABELS[e.actor_source]?.title || 'No actor recorded for this change')}
                      >
                        {e.actor_source === 'user' || e.changed_by
                          ? (ACTOR_LABELS.user.label)
                          : (ACTOR_LABELS[e.actor_source]?.label || '⚠ Unattributed')}
                      </span>
                    </div>
                    <div className="timeline-time" title="Event timestamp">{new Date(e.timestamp).toLocaleString()}</div>
                  </div>
                  <div className="timeline-desc">{e.description}</div>
                  {e.metadata && Object.keys(e.metadata).length > 0 && (
                    <div className="timeline-meta" title="Event metadata payload">
                      {JSON.stringify(e.metadata)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
