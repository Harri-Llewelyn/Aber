import React, { useState, useEffect } from 'react'
import { api } from '../../api'
import { SPARKPLUG_TYPES } from '../../constants'
import { IconClipboardList, IconShieldAlert, IconFileCode, IconCheck, IconAlertTriangle } from '../common/Icons'

export function AssetConfigModal({ asset, schemas, onClose }) {
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
  const schema = (schemas || []).find(s => s.schema_uuid === asset.schema_id)

  // Expected-vs-actual: every metric the schema requires (present or missing), plus anything the
  // device actually reported that the schema doesn't account for.
  let comparisonRows = []
  if (schema) {
    const configByName = new Map(config.map(row => [row.metric_name, row]))
    const requiredMetrics = Array.isArray(schema.schema_definition?.required) ? schema.schema_definition.required : []
    comparisonRows = [
      ...requiredMetrics.map(name => ({
        metric_name: name,
        reported: configByName.get(name) || null,
        status: configByName.has(name) ? 'present' : 'missing'
      })),
      ...config.filter(row => !requiredMetrics.includes(row.metric_name)).map(row => ({
        metric_name: row.metric_name,
        reported: row,
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
        <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)', border: '1px solid var(--warning)' }} title="Required by the schema but not reported yet">
          <IconAlertTriangle size={10} /> Missing
        </span>
      )
    }
    return <span className="badge badge-neutral" title="Reported by the device but not part of its assigned schema">Unmodeled</span>
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconClipboardList size={18} />
          <span>Device Configuration Parameters — <span className="mono">{asset.asset_id}</span></span>
        </div>

        {schema && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            <IconFileCode size={13} />
            <span>Compared against assigned schema <strong>{schema.schema_name}</strong></span>
          </div>
        )}

        {isOffline && (
          <div style={{
            background: 'rgba(255,179,0,0.12)', border: '1px solid var(--warning)', color: 'var(--warning)',
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
        ) : schema ? (
          comparisonRows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><IconClipboardList size={36} /></div>
              <div className="empty-text">This schema has no required metrics.</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th title="Metric parameter key">Metric Parameter</th><th title="Conformance to the assigned schema">Status</th><th title="Reported value">Reported Value</th><th title="Sparkplug B datatype">Datatype</th><th title="Last updated timestamp">Last Updated</th></tr>
                </thead>
                <tbody>
                  {comparisonRows.map(row => (
                    <tr key={row.metric_name}>
                      <td><strong>{row.metric_name}</strong></td>
                      <td>{statusBadge(row.status)}</td>
                      <td className="telemetry-value">{fmtVal(row.reported)}</td>
                      <td>{row.reported ? <span className="badge badge-neutral">{SPARKPLUG_TYPES[row.reported.datatype] || row.reported.datatype || '—'}</span> : '—'}</td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
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
            <div className="empty-icon"><IconClipboardList size={36} /></div>
            <div className="empty-text">No DBIRTH parameters received for this device yet.</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th title="Metric parameter key">Metric Parameter</th><th title="Reported value">Value</th><th title="Sparkplug B datatype">Datatype</th><th title="Last updated timestamp">Last Updated</th></tr>
              </thead>
              <tbody>
                {config.map(row => (
                  <tr key={row.metric_name}>
                    <td><strong>{row.metric_name}</strong></td>
                    <td className="telemetry-value">{fmtVal(row)}</td>
                    <td><span className="badge badge-neutral">{SPARKPLUG_TYPES[row.datatype] || row.datatype || '—'}</span></td>
                    <td style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                      {new Date(row.updated_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} title="Close modal">Close</button>
        </div>
      </div>
    </div>
  )
}
