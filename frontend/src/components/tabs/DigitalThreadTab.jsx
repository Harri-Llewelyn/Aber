import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { deviceHasTag, schemasForDevice, availableTags } from '../../utils/deviceTags'
import { downloadCSV } from '../../utils/downloadCSV'
import { AutoRefreshControl } from '../common/AutoRefreshControl'
import { IconHistory, IconDownload, IconX } from '../common/Icons'

export function DigitalThreadTab() {
  const [events, setEvents]           = useState([])
  const [loading, setLoading]         = useState(true)
  const [entityTypeFilter, setEntityTypeFilter] = useState('')
  const [entityIdFilter, setEntityIdFilter]     = useState('')
  const [tagFilter, setTagFilter]     = useState('')
  const [devices, setDevices]         = useState([])
  const [schemas, setSchemas]         = useState([])

  useEffect(() => {
    // Device tags are derived from each device's schema, so both lists are needed to turn a tag
    // into the set of entity ids to trace.
    Promise.all([api.get('/api/v1/devices'), api.get('/api/v1/schemas')])
      .then(([d, s]) => { setDevices(d); setSchemas(s) })
      .catch(() => {})
  }, [])

  const tagOptions = useMemo(() => availableTags(devices, schemas), [devices, schemas])

  const taggedDeviceIds = useMemo(() => {
    if (!tagFilter) return null
    return devices
      .filter(d => deviceHasTag(d, schemasForDevice(d, schemas), tagFilter))
      .map(d => d.asset_id)
  }, [tagFilter, devices, schemas])

  const load = useCallback((isInitial = false) => {
    if (isInitial) setLoading(true)
    let url = '/api/v1/digital-thread?limit=200'
    if (entityTypeFilter) url += `&entity_type=${encodeURIComponent(entityTypeFilter)}`
    if (entityIdFilter)   url += `&entity_id=${encodeURIComponent(entityIdFilter)}`
    if (taggedDeviceIds)  url += `&entity_ids=${encodeURIComponent(taggedDeviceIds.join(','))}`
    api.get(url)
      .then(d => { setEvents(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [entityTypeFilter, entityIdFilter, taggedDeviceIds])

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
          <select
            className="form-control"
            style={{ width: '170px' }}
            value={tagFilter}
            onChange={e => setTagFilter(e.target.value)}
            disabled={tagOptions.length === 0}
            title={tagOptions.length === 0
              ? 'No device carries a tag yet — tags come from the metric groups a device\'s schema models'
              : 'Trace only devices that currently carry this tag'}
          >
            <option value="">Any device type</option>
            {tagOptions.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          {(entityIdFilter || entityTypeFilter || tagFilter) && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setEntityIdFilter(''); setEntityTypeFilter(''); setTagFilter(''); }} title="Clear search filters">
              <IconX size={13} /> Clear
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => downloadCSV(events, 'digital-thread-export.csv')} title="Download audit events as CSV"><IconDownload size={13} /> Export CSV</button>
          <AutoRefreshControl onRefresh={handleRefresh} defaultInterval={0} />
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Complete immutable historical audit trace timeline across Cells, Gateways, and Devices with case-insensitive search and metadata inspection.
      </p>
      {tagFilter && (
        // Said plainly because the distinction is real: tags are derived from a device's schema
        // as it stands now, and the log records what was true then. This shows the history of
        // devices that are Robots today -- not events that happened while they were Robots.
        <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '-12px', marginBottom: '20px' }}>
          Showing the full audit history of devices that <strong>currently</strong> carry the{' '}
          <span className="mono">{tagFilter}</span> tag — including events recorded before they did.
        </p>
      )}

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
