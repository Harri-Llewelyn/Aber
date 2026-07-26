import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { downloadCSV } from '../../utils/downloadCSV'
import { AutoRefreshControl } from '../common/AutoRefreshControl'
import { IconDownload } from '../common/Icons'

export function TelemetryTab({ initialAssetFilter, onClearFilter }) {
  const [rows, setRows]               = useState([])
  const [loading, setLoading]         = useState(true)

  const getInitialAsset = () => {
    const params = new URLSearchParams(window.location.search)
    return params.get('asset_id') || params.get('asset') || initialAssetFilter || ''
  }

  const [assetFilter, setAssetFilter] = useState(getInitialAsset)
  const [metricFilter, setMetricFilter] = useState('')
  const [timeRange, setTimeRange]     = useState('')
  const [assets, setAssets]           = useState([])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlAsset = params.get('asset_id') || params.get('asset')
    if (urlAsset) {
      setAssetFilter(urlAsset)
    } else if (initialAssetFilter) {
      setAssetFilter(initialAssetFilter)
    }
  }, [initialAssetFilter])

  const handleAssetFilterChange = (val) => {
    setAssetFilter(val)
    if (!val) {
      if (window.location.search) {
        window.history.replaceState({}, '', window.location.pathname)
      }
      if (onClearFilter) onClearFilter()
    }
  }

  const load = useCallback((isInitial = false) => {
    if (isInitial) setLoading(true)
    let params = []
    if (assetFilter)  params.push(`asset_id=${encodeURIComponent(assetFilter)}`)
    if (metricFilter) params.push(`metric_name=${encodeURIComponent(metricFilter)}`)
    if (timeRange)    params.push(`minutes=${encodeURIComponent(timeRange)}`)
    params.push('limit=500')

    api.get(`/api/v1/telemetry?${params.join('&')}`)
      .then(d => { setRows(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [assetFilter, metricFilter, timeRange])

  useEffect(() => { api.get('/api/v1/devices').then(d => setAssets(d)).catch(() => {}) }, [])
  useEffect(() => {
    load(true)
  }, [load])

  const fmtVal = row => {
    if (row.val_bool !== null && row.val_bool !== undefined) return <span className={`telemetry-value val-bool-${row.val_bool}`}>{String(row.val_bool)}</span>
    if (row.val_string !== null && row.val_string !== undefined) return <span className="telemetry-value val-string">"{row.val_string}"</span>
    if (row.val_double !== null && row.val_double !== undefined) return <span className="telemetry-value val-double">{row.val_double}</span>
    return <span style={{ color: 'var(--text-dim)' }}>null</span>
  }

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Telemetry Stream <span className="section-count">{rows.length}</span></h2>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="form-control" style={{ width: '180px' }} value={assetFilter} onChange={e => handleAssetFilterChange(e.target.value)} title="Filter telemetry by specific device ID">
            <option value="">All Devices</option>
            {assets.map(a => <option key={a.asset_id} value={a.asset_id}>{a.asset_name} ({a.asset_id})</option>)}
          </select>
          <select className="form-control" style={{ width: '150px' }} value={metricFilter} onChange={e => setMetricFilter(e.target.value)} title="Filter telemetry by metric name">
            <option value="">All Metrics</option>
            <option value="temperature">Temperature</option>
            <option value="status">Status</option>
            <option value="safety_ok">Safety OK</option>
          </select>
          <select className="form-control" style={{ width: '140px' }} value={timeRange} onChange={e => setTimeRange(e.target.value)} title="Filter telemetry by time window">
            <option value="">All History</option>
            <option value="15">Last 15m</option>
            <option value="60">Last 1 Hour</option>
            <option value="1440">Last 24 Hours</option>
          </select>
          <button className="btn btn-ghost btn-sm" onClick={() => downloadCSV(rows, 'telemetry-export.csv')} title="Download telemetry as CSV"><IconDownload size={13} /> Export CSV</button>
          <AutoRefreshControl onRefresh={load} defaultInterval={0} />
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Real-time and historical time-series metric updates with filtering by device ID, metric name, and custom time windows.
      </p>

      <div className="card">
        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading…</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th title="Message timestamp">Timestamp</th><th title="Source device asset ID">Device ID</th><th title="Metric key name">Metric</th><th title="Parsed metric value">Value</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ color: 'var(--text-muted)', fontFamily: 'JetBrains Mono', fontSize: '11px' }}>{new Date(r.time).toLocaleString()}</td>
                    <td><span className="mono">{r.asset_id}</span></td>
                    <td>{r.metric_name}</td>
                    <td>{fmtVal(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
