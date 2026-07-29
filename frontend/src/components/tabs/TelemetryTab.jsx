import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api, TELEMETRY_PAGE_SIZE } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { downloadCSV } from '../../utils/downloadCSV'
import { effectiveSparkplugId } from '../../utils/sparkplugId'
import { AutoRefreshControl } from '../common/AutoRefreshControl'
import { IconDownload } from '../common/Icons'

export function TelemetryTab({ initialAssetFilter, onClearFilter, hasPermission }) {
  const [rows, setRows]               = useState([])
  const [loading, setLoading]         = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore]         = useState(false)
  const [error, setError]             = useState(null)
  // Union of every metric name seen so far. Never shrinks, so filtering to one metric
  // does not remove the other options from the dropdown.
  const [knownMetrics, setKnownMetrics] = useState([])

  const getInitialAsset = () => {
    const params = new URLSearchParams(window.location.search)
    return params.get('asset_id') || params.get('asset') || initialAssetFilter || ''
  }

  const [assetFilter, setAssetFilter] = useState(getInitialAsset)
  const [metricFilter, setMetricFilter] = useState('')
  const [timeRange, setTimeRange]     = useState('')
  const [assets, setAssets]           = useState([])
  const [catalog, setCatalog]         = useState([])

  // Check telemetry permission
  const hasTelemetryPermission = hasPermission(PERMISSION_UUIDS.TELEMETRY_READ)

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

  const rememberMetrics = useCallback((fetched) => {
    setKnownMetrics(prev => {
      const merged = new Set(prev)
      fetched.forEach(r => r.metric_name && merged.add(r.metric_name))
      return merged.size === prev.length ? prev : [...merged].sort()
    })
  }, [])

  const buildQuery = useCallback((offset) => {
    const params = []
    if (assetFilter)  params.push(`asset_id=${encodeURIComponent(assetFilter)}`)
    if (metricFilter) params.push(`metric_name=${encodeURIComponent(metricFilter)}`)
    if (timeRange)    params.push(`minutes=${encodeURIComponent(timeRange)}`)
    params.push(`limit=${TELEMETRY_PAGE_SIZE}`)
    if (offset) params.push(`offset=${offset}`)
    return params.join('&')
  }, [assetFilter, metricFilter, timeRange])

  // Replaces the whole result set: used on mount, on filter change, and on refresh.
  const load = useCallback((isInitial = false) => {
    if (isInitial) setLoading(true)
    setError(null)

    api.get(`/api/v1/telemetry?${buildQuery(0)}`)
      .then(d => {
        setRows(d)
        rememberMetrics(d)
        // A short page means the server had nothing more to give.
        setHasMore(d.length === TELEMETRY_PAGE_SIZE)
        setLoading(false)
      })
      .catch(err => {
        // Previously swallowed, which is what made an empty table indistinguishable
        // from a failed query.
        console.error('[TelemetryTab] telemetry query failed:', err)
        setError(err.message || 'Telemetry query failed')
        setLoading(false)
      })
  }, [buildQuery, rememberMetrics])

  const loadMore = useCallback(() => {
    setLoadingMore(true)
    api.get(`/api/v1/telemetry?${buildQuery(rows.length)}`)
      .then(d => {
        setRows(prev => [...prev, ...d])
        rememberMetrics(d)
        setHasMore(d.length === TELEMETRY_PAGE_SIZE)
        setLoadingMore(false)
      })
      .catch(err => {
        console.error('[TelemetryTab] telemetry page fetch failed:', err)
        setError(err.message || 'Telemetry query failed')
        setLoadingMore(false)
      })
  }, [buildQuery, rows.length, rememberMetrics])

  // AutoRefreshControl wires onRefresh straight to onClick, so without this wrapper the
  // click event would arrive as `isInitial` and blank the table on every manual refresh.
  const handleRefresh = useCallback(() => load(false), [load])

  useEffect(() => { api.get('/api/v1/devices').then(d => setAssets(d)).catch(() => {}) }, [])
  useEffect(() => {
    // The metric catalog is the registry of metrics devices are *meant* to publish. Without it
    // the dropdown could only offer metrics already present in the loaded page, so a metric that
    // exists but hasn't been paged to yet was simply unselectable.
    api.get('/api/v1/metric-catalog').then(d => setCatalog(d)).catch(() => {})
  }, [])
  useEffect(() => {
    load(true)
  }, [load])

  // Two groups, because the difference is diagnostic rather than cosmetic:
  //   - Catalog: registered metrics, whether or not any have arrived yet. Selecting one that
  //     returns nothing is itself the finding -- a device is not publishing what it should.
  //   - Uncatalogued: metrics seen in the stream that no catalog entry covers. Usually a typo in
  //     a device's metric name, or a metric someone forgot to register.
  const { catalogMetrics, uncataloguedMetrics } = useMemo(() => {
    const active = catalog.filter(m => !m.deprecated).map(m => m.name)
    const catalogNames = new Set(active)
    const seen = new Set(knownMetrics)
    if (metricFilter) seen.add(metricFilter)
    return {
      catalogMetrics: [...catalogNames].sort(),
      uncataloguedMetrics: [...seen].filter(n => !catalogNames.has(n)).sort()
    }
  }, [catalog, knownMetrics, metricFilter])

  const fmtVal = row => {
    if (row.val_bool !== null && row.val_bool !== undefined) return <span className={`telemetry-value val-bool-${row.val_bool}`}>{String(row.val_bool)}</span>
    if (row.val_string !== null && row.val_string !== undefined) return <span className="telemetry-value val-string">"{row.val_string}"</span>
    if (row.val_double !== null && row.val_double !== undefined) return <span className="telemetry-value val-double">{row.val_double}</span>
    return <span style={{ color: 'var(--text-dim)' }}>null</span>
  }

  // If user doesn't have telemetry permission, show a restricted view
  if (!hasTelemetryPermission) {
    return (
      <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
        <div style={{ fontSize: '64px', marginBottom: '16px' }}>🔒</div>
        <h3>Access Restricted</h3>
        <p style={{ color: 'var(--text-muted)' }}>
          You do not have permission to view telemetry data. Please contact your administrator.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Telemetry Stream <span className="section-count">{rows.length}</span></h2>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="form-control" style={{ width: '220px' }} value={assetFilter} onChange={e => handleAssetFilterChange(e.target.value)} title="Filter telemetry by device">
            <option value="">All Devices</option>
            {/* Labelled by name and Sparkplug ID -- the UUID this is valued by means nothing to
                an engineer reading the stream. */}
            {assets.map(a => <option key={a.asset_id} value={a.asset_id}>{a.asset_name} — {effectiveSparkplugId(a)}</option>)}
          </select>
          <select className="form-control" style={{ width: '190px' }} value={metricFilter} onChange={e => setMetricFilter(e.target.value)} title="Filter by a registered catalog metric, or by one seen in the stream that no catalog entry covers">
            <option value="">All Metrics</option>
            {catalogMetrics.length > 0 && (
              <optgroup label="Metric catalog">
                {catalogMetrics.map(m => <option key={m} value={m}>{m}</option>)}
              </optgroup>
            )}
            {uncataloguedMetrics.length > 0 && (
              <optgroup label="Uncatalogued (seen in stream)">
                {uncataloguedMetrics.map(m => <option key={m} value={m}>{m}</option>)}
              </optgroup>
            )}
          </select>
          <select className="form-control" style={{ width: '140px' }} value={timeRange} onChange={e => setTimeRange(e.target.value)} title="Filter telemetry by time window">
            <option value="">All History</option>
            <option value="15">Last 15m</option>
            <option value="60">Last 1 Hour</option>
            <option value="1440">Last 24 Hours</option>
          </select>
          <button className="btn btn-ghost btn-sm" onClick={() => downloadCSV(rows, 'telemetry-export.csv')} title="Download telemetry as CSV"><IconDownload size={13} /> Export CSV</button>
          <AutoRefreshControl onRefresh={handleRefresh} defaultInterval={0} />
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Real-time and historical time-series metric updates, filterable by device, metric and time window.
        The metric list is drawn from the Schemas page's metric catalog, so a registered metric can be
        selected even before any sample has arrived — an empty result is then itself the finding.
      </p>

      {error && (
        <div style={{ marginBottom: '16px', background: 'rgba(239,68,68,0.12)', border: '1px solid var(--danger)', borderRadius: 'var(--radius)', padding: '12px 16px', fontSize: '13px', color: 'var(--danger)' }}>
          <strong>Telemetry query failed:</strong> {error}
          <div style={{ color: 'var(--text-muted)', marginTop: '4px', fontSize: '12px' }}>
            Telemetry is served from TimescaleDB through the <span className="mono">telemetry</span> PostgREST view.
            Check that the stack's TimescaleDB container is running.
          </div>
        </div>
      )}

      <div className="card">
        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading…</div> : rows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-text">
              {error ? 'No telemetry could be loaded.' : 'No telemetry records match the selected device, metric, and time window.'}
            </div>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th title="Message timestamp">Timestamp</th><th title="Source device asset ID">Device ID</th><th title="Metric key name">Metric</th><th title="Parsed metric value">Value</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.time}-${r.asset_id}-${r.metric_name}-${i}`}>
                      <td style={{ color: 'var(--text-muted)', fontFamily: 'JetBrains Mono', fontSize: '11px' }}>{new Date(r.time).toLocaleString()}</td>
                      <td><span className="mono">{r.asset_id}</span></td>
                      <td>{r.metric_name}</td>
                      <td>{fmtVal(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Showing {rows.length} record{rows.length === 1 ? '' : 's'}
                {hasMore ? ' — more available' : ' — end of stream for this filter'}
              </span>
              {hasMore && (
                <button className="btn btn-ghost btn-sm" onClick={loadMore} disabled={loadingMore} title={`Fetch the next ${TELEMETRY_PAGE_SIZE} records`}>
                  {loadingMore ? 'Loading…' : `Load ${TELEMETRY_PAGE_SIZE} More`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  )
}
