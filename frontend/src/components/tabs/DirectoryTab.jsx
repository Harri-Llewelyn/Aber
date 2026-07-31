import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { describeAuthFailure } from '../../utils/sessionError'
import { StatusBadge } from '../common/StatusBadge'
import { ConfirmModal } from '../modals/ConfirmModal'
import { IconRefresh, IconGitBranch, IconRefreshCw, IconExternalLink } from '../common/Icons'

export function DirectoryTab({ showToast, hasPermission }) {
  const [services, setServices] = useState([])
  const [loading, setLoading]   = useState(true)
  const [confirmSync, setConfirmSync] = useState(false)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      setServices(await api.get('/api/v1/directory'))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const triggerGitopsSync = async () => {
    setConfirmSync(false)
    try {
      const res = await api.post('/api/v1/gitops/deploy-flow', { commit_message: 'Manual GitOps Flow Sync from Dashboard UI' })
      showToast(res.message, 'success')
      loadAll()
    } catch (e) {
      // Deploy runs through an Edge Function, which validates the session server-side.
      showToast(await describeAuthFailure(e, 'GitOps flow deployment failed'), 'error')
    }
  }

  // gitops:manage, not gateway:manage -- deploying edge flows is its own
  // privilege. Seeded to Administrator and Shopfloor_Manager only, which is the
  // same pair the deploy-nodered Edge Function enforces server-side.
  const canManageGitops = hasPermission(PERMISSION_UUIDS.GITOPS_MANAGE)

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Factory+ Service Directory</h2>
        <button className="btn btn-ghost btn-sm" onClick={loadAll} title="Refresh service directory heartbeats"><IconRefresh size={14} /> Refresh Directory</button>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Catalog tracking microservice health heartbeats, HTTP/MQTT service endpoints, and Edge GitOps deployment flow synchronization.
      </p>

      {/* No deployment status is shown: nothing here can observe what Node-RED is
          actually running, and a badge asserting a state it has not checked is
          worse than no badge. The button is a one-way push of the repo flow. */}
      <div style={{ marginBottom: '24px', background: 'var(--bg-glass)', border: '1px solid var(--border-hover)', borderRadius: 'var(--radius)', padding: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '15px', fontWeight: 600 }}>
            <IconGitBranch size={18} /> Edge GitOps Deployment Manager
          </div>
          <button
            className={`btn btn-primary ${!canManageGitops ? 'btn-disabled' : ''}`}
            disabled={!canManageGitops}
            onClick={() => canManageGitops && setConfirmSync(true)}
            title={!canManageGitops ? 'Requires Administrator or Shopfloor Manager' : 'Overwrite the running Node-RED flows with the repository flow'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <IconRefreshCw size={14} /> Sync Edge Flows via GitOps
          </button>
        </div>
      </div>

      {/* Destructive: a full deployment replaces every flow in the running
          Node-RED, so anything edited at :1880 and not committed is lost. */}
      {confirmSync && (
        <ConfirmModal
          message={
            'This replaces ALL flows running in Node-RED with the flow committed to the repository ' +
            '(node_red_flow.json). Any changes made in the Node-RED editor that are not in the ' +
            'repository will be permanently lost. Continue?'
          }
          onConfirm={triggerGitopsSync}
          onCancel={() => setConfirmSync(false)}
        />
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
