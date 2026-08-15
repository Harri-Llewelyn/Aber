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
  const [search, setSearch]     = useState('')
  const [typeFilter, setTypeFilter] = useState('')

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

  // Derived from the rows rather than hardcoded: the directory is a registry anything can
  // register into, so a fixed <option> list would silently hide a service type nobody thought
  // of when this select was written.
  const serviceTypes = [...new Set(services.map(s => s.service_type).filter(Boolean))].sort()

  const visible = services.filter(s => {
    if (typeFilter && s.service_type !== typeFilter) return false
    const q = search.trim().toLowerCase()
    if (!q) return true
    return [s.service_name, s.service_type, s.endpoint_url]
      .some(v => String(v || '').toLowerCase().includes(q))
  })

  return (
    <>
      {/* Heading and description removed: the top bar names the page, and the two sections below
          -- the GitOps panel and the microservices card -- already say what each of them is. */}

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

      {/* Active Stack Microservices. The heading moved INSIDE the card for the same reason as the
          one on the Archives page: as a `.section-header` above it, it was a standalone 36px row
          for one line of text; as a `.card-header` it rides the top edge the card already had. */}
      {/* The page's own controls, in the same `.filter-bar` the Gateways and Devices pages use.
          Refresh moved in from a `.page-actions` row of its own above the GitOps panel, where it
          read as an action on the GitOps deployment rather than on the table it actually
          reloads. The search and type picker are new: a stack with an ingestion daemon, a broker,
          Node-RED, Kong, PostgREST and a handful of Edge Functions is already past the point
          where scanning is quicker than filtering. */}
      <div className="filter-bar">
        <input
          className="form-control"
          style={{ width: '240px' }}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search services…"
          title="Filter by service name, type or endpoint URL"
        />

        <select
          className="form-control"
          style={{ width: '170px' }}
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          title="Show only one kind of service"
        >
          <option value="">All service types</option>
          {serviceTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        <div className="filter-bar-spacer filter-bar-actions">
          <button className="btn btn-ghost btn-sm" onClick={loadAll} title="Refresh service directory heartbeats"><IconRefresh size={14} /> Refresh Directory</button>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          {/* The count follows the filter. A heading that says 9 above a table showing 2 is
              worse than no count, because it is the number the operator will quote. */}
          <h3 className="section-title">Active Stack Microservices <span className="section-count">{visible.length}</span></h3>
        </div>
        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading directory…</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th title="Service name">Service Name</th><th title="Architecture category">Service Type</th><th title="HTTP/MQTT endpoint URL">Endpoint URL</th><th title="Heartbeat status">Status</th><th title="Last heartbeat timestamp">Last Heartbeat</th></tr></thead>
              <tbody>
                {visible.map(s => (
                  <tr key={s.service_uuid}>
                    <td><strong>{s.service_name}</strong></td>
                    <td><span className="badge badge-neutral">{s.service_type}</span></td>
                    <td><a className="mono" href={s.endpoint_url} target="_blank" rel="noreferrer" title="Click to open endpoint URL">{s.endpoint_url} <IconExternalLink size={10} /></a></td>
                    <td><StatusBadge status={s.status} /></td>
                    {/* .cell-meta rather than the inline 11px/muted pair this and the Archives
                        table were each carrying their own copy of. */}
                    <td className="cell-meta">{new Date(s.last_heartbeat).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && visible.length === 0 && (
          <div className="empty-state">
            <div className="empty-text">No services match the filter.</div>
          </div>
        )}
      </div>
    </>
  )
}
