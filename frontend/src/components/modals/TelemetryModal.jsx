import React, { useState, useCallback, useEffect } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { formatTelemetryValue, telemetryValueClass } from '../../utils/telemetryValue'
import { IconActivity, IconDownload, IconLock, IconX } from '../common/Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'

/**
 * Per-device telemetry inspector: what each of this device's metrics last read, and when. A modal
 * because it is a four-column table and needs the width. Not realtime: `public.telemetry` is a
 * postgres_fdw view over the standalone TimescaleDB, whose rows never enter Supabase's WAL, so a
 * postgres_changes subscription on it silently delivers nothing. Read once on open. The metric list
 * is declared (`devices.last_birth_metrics`) union observed (distinct names in the historian inside
 * the lookback window), so a metric that stopped reporting shows as "— no data —" rather than
 * vanishing.
 */

const LOOKBACK_MINUTES = 1440
const NO_DATA = '— no data —'

/** Newest-first, then alphabetical, so a metric that has never reported sinks to the bottom. */
function sortMetrics(a, b) {
  if (a.row && !b.row) return -1
  if (!a.row && b.row) return 1
  return a.name.localeCompare(b.name)
}

export function TelemetryModal({ device, hasPermission, onExport, onClose }) {
  // Escape closes through the shared stack, so a ConfirmModal opened on top takes the keypress.
  useEscapeKey(onClose)

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
    // `declared` is derived from the device row each render; keying on its content rather than its
    // identity avoids refetching on every parent poll.
    //
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, declared.join('|')])

  // On open rather than on expand: the modal has no collapsed state to defer the request to, and
  // opening it is already the deliberate act the accordion used its first expand for.
  useEffect(() => { if (canRead) load() }, [canRead, load])

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
    <div className="modal-overlay" onClick={onClose}>
      {/* Wide, because this is a table. `.modal`'s 480px default is sized for a form. */}
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header-row">
          <div className="modal-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <IconActivity size={17} style={{ color: 'var(--accent)' }} />
            <span>Telemetry — {device?.asset_name}</span>
            <span className="badge badge-neutral" style={{ fontSize: '11px' }}>
              {loading ? declared.length : metrics.length}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {canRead && selected.size > 0 && (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => onExport?.(device, [...selected])}
                title={`Export ${selected.size} selected metric${selected.size === 1 ? '' : 's'} as CSV`}
              >
                <IconDownload size={12} /> Export CSV ({selected.size})
              </button>
            )}
            <button className="context-panel-close" onClick={onClose} title="Close (Esc)" aria-label="Close telemetry">
              <IconX size={15} />
            </button>
          </div>
        </div>

        {!canRead ? (
          // An explicit refusal, not an empty table that reads as "this device has never
          // reported anything".
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text-muted)', padding: '20px 4px' }}>
            <IconLock size={14} /> <span>Your role does not include telemetry access.</span>
          </div>
        ) : loading ? (
          <div className="loading-wrap" style={{ padding: '32px' }}>
            <div className="spinner" /> Loading telemetry…
          </div>
        ) : error ? (
          <div style={{ fontSize: '13px', color: 'var(--danger-text)', padding: '20px 4px' }}>
            Telemetry query failed: {error}
          </div>
        ) : metrics.length === 0 ? (
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '20px 4px' }}>
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

            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '10px' }}>
              {withData} of {metrics.length} metric{metrics.length === 1 ? '' : 's'} reported in the
              last 24 hours. Tick metrics and use Export CSV to download a longer history.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
