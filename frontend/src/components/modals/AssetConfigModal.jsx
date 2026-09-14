import React, { useState, useEffect } from 'react'
import { api } from '../../api'
import { SPARKPLUG_TYPES } from '../../constants'
import { modelledMetricsAcross, schemasForDevice } from '../../utils/deviceTags'
import { IconFileText, IconShieldAlert, IconClipboardList, IconCheck, IconAlertTriangle } from '../common/Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'

// showToast/hasPermission are gone with the 3D uploader: this modal now only reads. Everything
// it displays comes from asset_config and the device's own row.
export function AssetConfigModal({ asset, schemas, onClose }) {
  // Escape closes through the shared stack, so a ConfirmModal opened on top takes the keypress.
  useEscapeKey(onClose)

  const [config, setConfig]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  useEffect(() => {
    api.get(`/api/v1/devices/${asset.asset_id}/config`)
      .then(d => { setConfig(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [asset.asset_id])

  const fmtVal = row => {
    if (!row) return '—'
    if (row.val_bool !== null && row.val_bool !== undefined) return String(row.val_bool)
    if (row.val_string !== null && row.val_string !== undefined) return row.val_string
    if (row.val_double !== null && row.val_double !== undefined) return row.val_double
    return '—'
  }

  const isOffline = asset.status === 'OFFLINE'
  // Every schema attached through device_submodels (archived migration 0034), or the legacy 1:1 one.
  const attachedSchemas = schemasForDevice(asset, schemas)

  // Expected-vs-actual: every metric the schema models (present or missing), plus anything the
  // device reported that the schema does not account for. "Reported" is the union of asset_config
  // (birth parameter values, so it omits a metric declared without one) and
  // devices.last_birth_metrics (the full declared name set).
  let comparisonRows = []
  if (attachedSchemas.length > 0) {
    const configByName = new Map(config.map(row => [row.metric_name, row]))
    // Across every attached submodel -- a metric modelled by any of them belongs in this table.
    const modelled = modelledMetricsAcross(attachedSchemas) || new Set()
    const declared = Array.isArray(asset.last_birth_metrics) ? asset.last_birth_metrics : []
    const reported = new Set([...configByName.keys(), ...declared])

    comparisonRows = [
      ...[...modelled].map(name => ({
        metric_name: name,
        reported: configByName.get(name) || null,
        status: reported.has(name) ? 'present' : 'missing'
      })),
      ...[...reported].filter(name => !modelled.has(name)).sort().map(name => ({
        metric_name: name,
        reported: configByName.get(name) || null,
        status: 'extra'
      }))
    ]
  }

  const statusBadge = (status) => {
    if (status === 'present') {
      return <span className="badge badge-online" title="Required by the schema and reported by the device"><IconCheck size={10} /> Present</span>
    }
    if (status === 'missing') {
      return (
        <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)' }} title="Required by the schema but not reported yet">
          <IconAlertTriangle size={10} /> Missing
        </span>
      )
    }
    return <span className="badge badge-neutral" title="Declared by the device but not part of its assigned schema">Unmodelled</span>
  }

  return (
    <div className="modal-overlay">
      {/* Wide, like TelemetryModal: a five-column table, and at 640px the metric-name column
          clipped the middle of a Sparkplug path, which is the part that distinguishes `Axes/X/...`
          from `Axes/Y/...`. */}
      <div className="modal modal-wide">
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconFileText size={18} />
          <span>Device Configuration Parameters — <span className="mono">{asset.asset_id}</span></span>
        </div>

        {attachedSchemas.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            <IconClipboardList size={13} />
            <span>
              Compared against {attachedSchemas.length === 1 ? 'assigned schema' : `${attachedSchemas.length} attached submodels`}{' '}
              <strong>{attachedSchemas.map(s => s.schema_name).join(', ')}</strong>
            </span>
          </div>
        )}

        {isOffline && (
          <div style={{
            background: 'rgba(255,179,0,0.12)', border: '1px solid var(--warning)', color: 'var(--warning-text)',
            padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', fontSize: '13px',
            display: 'flex', alignItems: 'center', gap: '8px'
          }}>
            <IconShieldAlert size={16} />
            <span><strong>Device Offline (DDEATH Received):</strong> This asset received a Sparkplug B disconnect payload via gateway <strong>{asset.active_gateway_id || '—'}</strong>. Telemetry ingestion is suspended.</span>
          </div>
        )}

        {loading ? (
          <div className="loading-wrap"><div className="spinner" /> Loading DBIRTH parameters…</div>
        ) : error ? (
          <div className="empty-state"><div className="empty-text">{error}</div></div>
        ) : attachedSchemas.length > 0 ? (
          comparisonRows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><IconFileText size={36} /></div>
              <div className="empty-text">This schema has no required metrics.</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="modal-table">
                {/* Proportions, not content-sizing, so the name column is not left with whatever
                    the fixed-width badges leave. */}
                <colgroup>
                  <col style={{ width: '35%' }} />
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '20%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '18%' }} />
                </colgroup>
                <thead>
                  <tr><th title="Metric parameter key">Metric Parameter</th><th title="Conformance to the assigned schema">Status</th><th title="Reported value">Reported Value</th><th title="Sparkplug B datatype">Datatype</th><th title="Last updated timestamp">Last Updated</th></tr>
                </thead>
                <tbody>
                  {comparisonRows.map(row => (
                    <tr key={row.metric_name}>
                      {/* Wraps at the path separators rather than truncating, and carries the full
                          name in `title` for a squeezed column. */}
                      <td className="config-metric-name"><strong title={row.metric_name}>{row.metric_name}</strong></td>
                      <td>{statusBadge(row.status)}</td>
                      <td className="telemetry-value" title={String(fmtVal(row.reported))}>{fmtVal(row.reported)}</td>
                      <td>{row.reported ? <span className="badge badge-neutral">{SPARKPLUG_TYPES[row.reported.datatype] || row.reported.datatype || '—'}</span> : '—'}</td>
                      <td className="cell-meta">
                        {row.reported ? new Date(row.reported.updated_at).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : config.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><IconFileText size={36} /></div>
            <div className="empty-text">No DBIRTH parameters received for this device yet.</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="modal-table">
              {/* Same proportions with the Status column absent -- its 15% goes to the metric
                  name, which is the column that was short in the first place. */}
              <colgroup>
                <col style={{ width: '45%' }} />
                <col style={{ width: '23%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '19%' }} />
              </colgroup>
              <thead>
                <tr><th title="Metric parameter key">Metric Parameter</th><th title="Reported value">Value</th><th title="Sparkplug B datatype">Datatype</th><th title="Last updated timestamp">Last Updated</th></tr>
              </thead>
              <tbody>
                {config.map(row => (
                  <tr key={row.metric_name}>
                    <td className="config-metric-name"><strong title={row.metric_name}>{row.metric_name}</strong></td>
                    <td className="telemetry-value" title={String(fmtVal(row))}>{fmtVal(row)}</td>
                    <td><span className="badge badge-neutral">{SPARKPLUG_TYPES[row.datatype] || row.datatype || '—'}</span></td>
                    <td className="cell-meta">
                      {new Date(row.updated_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* The 3D model uploader lives in the device row's Attached Document Links accordion;
            everything here is a read-only view of what the device reported at birth. */}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} title="Close modal">Close</button>
        </div>
      </div>
    </div>
  )
}
