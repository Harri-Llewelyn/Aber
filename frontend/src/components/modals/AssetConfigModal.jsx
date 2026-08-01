import React, { useState, useEffect } from 'react'
import { api } from '../../api'
import { SPARKPLUG_TYPES, PERMISSION_UUIDS } from '../../constants'
import { modelledMetricsAcross, schemasForDevice } from '../../utils/deviceTags'
import { Model3DUploader } from '../common/Model3DUploader'
import { IconClipboardList, IconShieldAlert, IconFileCode, IconCheck, IconAlertTriangle } from '../common/Icons'

export function AssetConfigModal({ asset, schemas, onClose, showToast, hasPermission }) {
  const [config, setConfig]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  // Held locally so attaching or removing a model updates this modal immediately, rather than
  // waiting for the Devices list to refetch behind it.
  const [modelPath, setModelPath] = useState(asset.model_3d_path || null)

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
  // Every schema attached through device_submodels (migration 0034), or the legacy 1:1 one.
  const attachedSchemas = schemasForDevice(asset, schemas)

  // Expected-vs-actual: every metric the schema models (present or missing), plus anything the
  // device reported that the schema doesn't account for.
  //
  // "Reported" is the union of asset_config and devices.last_birth_metrics, because the two
  // differ deliberately: asset_config holds birth parameter *values* and so omits any metric
  // declared without one, while last_birth_metrics is the full declared name set. Taking only
  // the former would let a valueless unmodelled metric show as a badge on the Devices list and
  // then be missing from this table.
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
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconClipboardList size={18} />
          <span>Device Configuration Parameters — <span className="mono">{asset.asset_id}</span></span>
        </div>

        {attachedSchemas.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            <IconFileCode size={13} />
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

        <Model3DUploader
          device={{ ...asset, model_3d_path: modelPath }}
          canManage={hasPermission ? hasPermission(PERMISSION_UUIDS.DEVICE_MANAGE) : false}
          showToast={showToast}
          onChange={setModelPath}
        />

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} title="Close modal">Close</button>
        </div>
      </div>
    </div>
  )
}
