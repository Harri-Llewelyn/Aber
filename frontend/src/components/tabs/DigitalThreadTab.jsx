import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { downloadCSV } from '../../utils/downloadCSV'
import { AutoRefreshControl } from '../common/AutoRefreshControl'
import { IconHistory, IconDownload, IconX } from '../common/Icons'

export function DigitalThreadTab() {
  const [events, setEvents]           = useState([])
  const [loading, setLoading]         = useState(true)
  const [entityTypeFilter, setEntityTypeFilter] = useState('')
  const [entityIdFilter, setEntityIdFilter]     = useState('')

  const load = useCallback((isInitial = false) => {
    if (isInitial) setLoading(true)
    let url = '/api/v1/digital-thread?limit=200'
    if (entityTypeFilter) url += `&entity_type=${encodeURIComponent(entityTypeFilter)}`
    if (entityIdFilter)   url += `&entity_id=${encodeURIComponent(entityIdFilter)}`
    api.get(url)
      .then(d => { setEvents(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [entityTypeFilter, entityIdFilter])

  useEffect(() => {
    load(true)
  }, [load])

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Digital Thread Audit Trace Timeline <span className="section-count">{events.length}</span></h2>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <select className="form-control" style={{ width: '160px' }} value={entityTypeFilter} onChange={e => setEntityTypeFilter(e.target.value)} title="Filter by entity type">
            <option value="">All Entities</option>
            <option value="CELL">Cells</option>
            <option value="GATEWAY">Gateways</option>
            <option value="DEVICE">Devices</option>
          </select>
          <input
            className="form-control"
            style={{ width: '220px' }}
            value={entityIdFilter}
            onChange={e => setEntityIdFilter(e.target.value)}
            placeholder="Search Entity ID or keyword…"
            title="Type to search audit events by Entity ID or description keyword"
          />
          {(entityIdFilter || entityTypeFilter) && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setEntityIdFilter(''); setEntityTypeFilter(''); }} title="Clear search filters">
              <IconX size={13} /> Clear
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => downloadCSV(events, 'digital-thread-export.csv')} title="Download audit events as CSV"><IconDownload size={13} /> Export CSV</button>
          <AutoRefreshControl onRefresh={load} defaultInterval={0} />
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Complete immutable historical audit trace timeline across Cells, Gateways, and Devices with case-insensitive search and metadata inspection.
      </p>

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
                      <span className="mono" style={{ color: 'var(--accent)' }} title="Target Entity ID">[{e.entity_id}]</span>
                      <span className="badge badge-warning" title="Audit event type">{e.event_type}</span>
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
