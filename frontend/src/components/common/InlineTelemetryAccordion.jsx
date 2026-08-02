import React, { useState, useCallback, useEffect } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { formatTelemetryValue, telemetryValueClass } from '../../utils/telemetryValue'
import { IconChevronRight, IconChevronDown, IconActivity, IconDownload, IconLock } from './Icons'

/**
 * Per-device telemetry drawer: what each of this device's metrics last read, and when.
 *
 * REPLACES THE STANDALONE TELEMETRY PAGE. That page browsed the whole fleet and made you pick a
 * device from a dropdown to get here -- so the common case (looking at one machine) cost a tab
 * switch and a filter, and the device you were already looking at was not the one selected.
 * Scoped to a row, most of that page's machinery disappears: no device filter, no tag filter, no
 * `IN` list over a whole tag, and therefore none of the unbounded-query problem that forced the
 * old page to require a time window whenever a tag was active.
 *
 * DELIBERATELY NOT REALTIME, and this is inherited from the page it replaces rather than an
 * oversight. `public.telemetry` is a postgres_fdw view over the standalone TimescaleDB: its rows
 * enter TimescaleDB's WAL, never Supabase's, so a postgres_changes subscription on it emits
 * nothing at all. Adding it to the publication does not error -- it silently delivers no events,
 * which is the worse failure. Refreshed on expand instead.
 *
 * THE METRIC LIST IS DECLARED UNION OBSERVED:
 *   * declared -- `devices.last_birth_metrics`, the names announced in the most recent DBIRTH.
 *     Already on the row; costs no request.
 *   * observed -- distinct metric names in the historian inside the lookback window.
 *
 * The union matters. Observed-only would drop a metric the moment it stopped reporting, which is
 * exactly the fault an operator is looking for -- a silent sensor would simply vanish from the
 * list rather than show as stale. Declared-only would miss anything the device publishes without
 * having declared it. A declared metric with no rows reads "— no data —", which is a statement,
 * not an absence.
 */

const LOOKBACK_MINUTES = 1440
const NO_DATA = '— no data —'

/** Newest-first, then alphabetical, so a metric that has never reported sinks to the bottom. */
function sortMetrics(a, b) {
  if (a.row && !b.row) return -1
  if (!a.row && b.row) return 1
  return a.name.localeCompare(b.name)
}

export function InlineTelemetryAccordion({ device, hasPermission, onExport }) {
  const [expanded, setExpanded] = useState(false)
  const [metrics, setMetrics]   = useState([])
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)
  const [selected, setSelected] = useState(() => new Set())

  const canRead = hasPermission?.(PERMISSION_UUIDS.TELEMETRY_READ) ?? false
  const deviceId = device?.asset_id || device?.id

  const declared = Array.isArray(device?.last_birth_metrics) ? device.last_birth_metrics : []

  const load = useCallback(() => {
    if (!deviceId) return
    setLoading(true)
    setError(null)
    api.get(`/api/v1/devices/${deviceId}/telemetry/latest?minutes=${LOOKBACK_MINUTES}`)
      .then(rows => {
        const byName = new Map()
        for (const row of rows || []) byName.set(row.metric_name, row)
        // The union: every declared name, plus anything observed that was not declared.
        const names = new Set([...declared, ...byName.keys()])
        setMetrics([...names].map(name => ({ name, row: byName.get(name) || null })).sort(sortMetrics))
        setLoading(false)
      })
      .catch(e => { setError(e.message || 'Telemetry query failed'); setLoading(false) })
    // `declared` is derived from the device row each render; keying on its content rather than
    // its identity avoids refetching on every parent poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, declared.join('|')])

  // Refresh an OPEN drawer when the device row changes -- a rebirth can change the declared set.
  useEffect(() => { if (expanded) load() }, [expanded, load])

  const toggleExpand = () => {
    const next = !expanded
    setExpanded(next)
    if (next && metrics.length === 0) load()
  }

  const toggleMetric = (name) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }

  const allSelected = metrics.length > 0 && selected.size === metrics.length
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(metrics.map(m => m.name)))

  const withData = metrics.filter(m => m.row).length

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden', background: 'var(--bg-glass)', marginTop: '8px' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px', cursor: 'pointer', userSelect: 'none',
          background: expanded ? 'rgba(255,255,255,0.03)' : 'transparent',
          borderBottom: expanded ? '1px solid var(--border)' : 'none'
        }}
        onClick={toggleExpand}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
          {expanded ? <IconChevronDown size={14} style={{ color: 'var(--accent)' }} /> : <IconChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}
          <IconActivity size={14} style={{ color: 'var(--accent)' }} />
          <span>Telemetry</span>
          <span className="badge badge-neutral" style={{ fontSize: '10px', padding: '2px 7px' }}>
            {expanded && !loading ? metrics.length : declared.length}
          </span>
        </div>

        {expanded && canRead && selected.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }} onClick={e => e.stopPropagation()}>
            <button
              className="btn btn-primary btn-sm"
              style={{ padding: '3px 8px', fontSize: '11px', gap: '4px' }}
              onClick={() => onExport?.(device, [...selected])}
              title={`Export ${selected.size} selected metric${selected.size === 1 ? '' : 's'} as CSV`}
            >
              <IconDownload size={11} /> Export CSV ({selected.size})
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div style={{ padding: '12px', background: 'var(--bg-base)' }}>
          {!canRead ? (
            // Same posture the standalone page took: an explicit refusal, not an empty table
            // that reads as "this device has never reported anything".
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-muted)', padding: '4px 6px' }}>
              <IconLock size={13} /> <span>Your role does not include telemetry access.</span>
            </div>
          ) : loading ? (
            <div className="loading-wrap" style={{ padding: '12px', fontSize: '12px' }}>
              <div className="spinner" style={{ width: 14, height: 14 }} /> Loading telemetry…
            </div>
          ) : error ? (
            <div style={{ fontSize: '12px', color: 'var(--danger-text)', padding: '4px 6px' }}>
              Telemetry query failed: {error}
            </div>
          ) : metrics.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '4px 6px' }}>
              This device has not declared or reported any metrics yet.
            </div>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '32px' }}>
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleAll}
                          aria-label="Select all metrics"
                          title="Select every metric"
                        />
                      </th>
                      <th title="Metric name as published on the wire">Metric</th>
                      <th title="When this metric last reported">Last Updated</th>
                      <th title="Most recent value">Latest Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.map(m => (
                      <tr key={m.name}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(m.name)}
                            onChange={() => toggleMetric(m.name)}
                            aria-label={`Select ${m.name}`}
                          />
                        </td>
                        <td><strong>{m.name}</strong></td>
                        <td style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                          {m.row ? new Date(m.row.time).toLocaleString() : '—'}
                        </td>
                        <td className={m.row ? telemetryValueClass(m.row) : undefined}
                            style={m.row ? undefined : { color: 'var(--text-dim)', fontStyle: 'italic' }}>
                          {formatTelemetryValue(m.row, NO_DATA)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
                {withData} of {metrics.length} metric{metrics.length === 1 ? '' : 's'} reported in the
                last 24 hours. Tick metrics and use Export CSV to download a longer history.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
