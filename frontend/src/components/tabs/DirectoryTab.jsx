import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { StatusBadge } from '../common/StatusBadge'
import { IconRefresh, IconGitBranch, IconRefreshCw, IconExternalLink } from '../common/Icons'

export function DirectoryTab({ showToast, hasPermission }) {
  const [services, setServices] = useState([])
  const [gitops, setGitops]     = useState(null)
  const [loading, setLoading]   = useState(true)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [s, g] = await Promise.all([
        api.get('/api/v1/directory'),
        api.get('/api/v1/gitops/status'),
      ])
      setServices(s); setGitops(g)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const triggerGitopsSync = async () => {
    try {
      const res = await api.post('/api/v1/gitops/deploy-flow', { commit_message: 'Manual GitOps Flow Sync from Dashboard UI' })
      showToast(res.message, 'success')
      loadAll()
    } catch (e) { showToast(e.message, 'error') }
  }

  const canManageGateway = hasPermission(PERMISSION_UUIDS.GATEWAY_MANAGE)

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Factory+ Service Directory</h2>
        <button className="btn btn-ghost btn-sm" onClick={loadAll} title="Refresh service directory heartbeats"><IconRefresh size={14} /> Refresh Directory</button>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Catalog tracking microservice health heartbeats, HTTP/MQTT service endpoints, and Edge GitOps deployment flow synchronization.
      </p>

      {/* Edge GitOps Manager Banner */}
      {gitops && (
        <div style={{ marginBottom: '24px', background: 'var(--bg-glass)', border: '1px solid var(--border-hover)', borderRadius: 'var(--radius)', padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '15px', fontWeight: 600 }}>
                <IconGitBranch size={18} /> Edge GitOps Deployment Manager
                <span className="badge badge-online" title="Edge deployment status">STATUS: {gitops.gitops_status}</span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Commit: <span className="mono">{gitops.active_commit_sha}</span> | Repo: <span className="mono">{gitops.repository_url}</span>
              </div>
            </div>
            <button
              className={`btn btn-primary ${!canManageGateway ? 'btn-disabled' : ''}`}
              disabled={!canManageGateway}
              onClick={() => canManageGateway && triggerGitopsSync()}
              title={!canManageGateway ? 'Requires Admin permissions' : 'Hot-reload Node-RED flows from repository SHA'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <IconRefreshCw size={14} /> Sync Edge Flows via GitOps
            </button>
          </div>
        </div>
      )}

      {/* Active Stack Microservices */}
      <div className="section-header">
        <h3 className="section-title" style={{ fontSize: '16px' }}>Active Stack Microservices <span className="section-count">{services.length}</span></h3>
      </div>
      <div className="card">
        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading directory…</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th title="Service name">Service Name</th><th title="Architecture category">Service Type</th><th title="HTTP/MQTT endpoint URL">Endpoint URL</th><th title="Heartbeat status">Status</th><th title="Last heartbeat timestamp">Last Heartbeat</th></tr></thead>
              <tbody>
                {services.map(s => (
                  <tr key={s.service_uuid}>
                    <td><strong>{s.service_name}</strong></td>
                    <td><span className="badge badge-neutral">{s.service_type}</span></td>
                    <td><a className="mono" href={s.endpoint_url} target="_blank" rel="noreferrer" title="Click to open endpoint URL">{s.endpoint_url} <IconExternalLink size={10} /></a></td>
                    <td><StatusBadge status={s.status} /></td>
                    <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{new Date(s.last_heartbeat).toLocaleString()}</td>
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
