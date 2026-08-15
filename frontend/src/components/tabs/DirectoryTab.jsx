import React, { useState, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, POLL_INTERVAL_MS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { describeAuthFailure } from '../../utils/sessionError'
import { StatusBadge } from '../common/StatusBadge'
import { ConfirmModal } from '../modals/ConfirmModal'
import { IconGitBranch, IconRefreshCw, IconExternalLink } from '../common/Icons'

/**
 * The stack, in the order an operator looks for it: something to open, the path telemetry
 * arrives on, then the stores behind it.
 *
 * Replaces one flat alphabetical list of a dozen rows -- alphabetical being the order the
 * registry happened to store them in rather than an order anyone reads in, so Grafana, Kong,
 * Mosquitto and PostgREST sat interleaved with no cue as to which of them an engineer chasing
 * a missing message should look at.
 *
 * KEYED ON service_type, NOT ON service_name. The name is free text an operator can edit --
 * grouping on it would put a renamed service in the wrong section, or in none. The type is the
 * category the service declared when it registered.
 *
 * The order of `types` within a group is the render order within its table, so a group reads
 * front-to-back (broker, then ingestion, then the gateway they arrive through) rather than
 * alphabetically. Names break ties inside one type.
 */
const SERVICE_GROUPS = [
  {
    title: 'Applications & User Interfaces',
    types: ['MONITORING', 'EDGE_NODE', 'GRAPHICAL_UI', 'DOCUMENTATION']
  },
  {
    title: 'Ingestion & Messaging',
    types: ['MQTT_BROKER', 'INGESTION', 'API_GATEWAY']
  },
  {
    title: 'Data & Backend Infrastructure',
    types: ['REST_API', 'AUTHENTICATION', 'SERVERLESS', 'DATABASE', 'TIME_SERIES_DB']
  }
]

/**
 * Where a service whose type is in no group above lands.
 *
 * NOT a dropped row. `directory_services` is a registry anything can register into -- the same
 * reason the old type filter derived its options from the rows instead of hardcoding them -- so
 * a fixed set of groups WILL eventually meet a type nobody anticipated. Showing it under a
 * heading that admits as much is the only option here that cannot silently hide a running
 * service from the page whose whole job is to list them.
 */
const UNGROUPED_TITLE = 'Other Registered Services'

/** Splits the flat directory into the sections above, dropping any that came back empty. */
export function groupServices(services) {
  // service_type -> [group index, position within that group].
  const rank = new Map()
  SERVICE_GROUPS.forEach((g, gi) => g.types.forEach((t, ti) => rank.set(t, [gi, ti])))

  const byName = (a, b) => String(a.service_name || '').localeCompare(String(b.service_name || ''))

  const sections = SERVICE_GROUPS.map(g => ({ title: g.title, rows: [] }))
  const ungrouped = { title: UNGROUPED_TITLE, rows: [] }

  for (const s of services) {
    const at = rank.get(s.service_type)
    if (at) sections[at[0]].rows.push(s)
    else ungrouped.rows.push(s)
  }

  for (const section of sections) {
    section.rows.sort((a, b) => (rank.get(a.service_type)[1] - rank.get(b.service_type)[1]) || byName(a, b))
  }
  ungrouped.rows.sort(byName)

  return [...sections, ungrouped].filter(s => s.rows.length > 0)
}

/**
 * One group's table. Shared markup rather than three copies -- and `.table-directory` pins the
 * column widths so the three tables line up as one list broken into sections instead of three
 * tables that each sized their columns from their own rows.
 */
function ServiceTable({ rows }) {
  return (
    <div className="table-wrap">
      <table className="table-directory">
        <thead>
          <tr>
            <th title="Service name">Service Name</th>
            <th title="Architecture category">Service Type</th>
            <th title="HTTP/MQTT endpoint URL">Endpoint URL</th>
            <th title="Heartbeat status">Status</th>
            <th title="Last heartbeat timestamp">Last Heartbeat</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.service_uuid}>
              <td><strong>{s.service_name}</strong></td>
              <td><span className="badge badge-neutral">{s.service_type}</span></td>
              <td className="cell-endpoint">
                <a className="mono" href={s.endpoint_url} target="_blank" rel="noreferrer" title="Click to open endpoint URL">
                  {s.endpoint_url} <IconExternalLink size={10} />
                </a>
              </td>
              <td><StatusBadge status={s.status} /></td>
              {/* .cell-meta rather than the inline 11px/muted pair this and the Archives
                  table were each carrying their own copy of. */}
              <td className="cell-meta">{new Date(s.last_heartbeat).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function DirectoryTab({ showToast, hasPermission }) {
  const [services, setServices] = useState([])
  const [loading, setLoading]   = useState(true)
  const [confirmSync, setConfirmSync] = useState(false)

  const loadAll = useCallback(async (signal) => {
    try {
      setServices(await api.get('/api/v1/directory', { signal }))
      setLoading(false)
    } catch (e) {
      if (e.name !== 'AbortError') setLoading(false)
      // Rethrown so usePolling can back off on a failing backend rather than hammering it.
      throw e
    }
  }, [])

  /**
   * The page's only refresh. The manual "Refresh Directory" button is gone: it re-ran exactly
   * this call, next to a table that now reloads on its own, and read as a control over the
   * GitOps panel it sat under.
   *
   * POLL_INTERVAL_MS, not refreshInterval(). That helper slows to the 60s reconciliation
   * interval when Realtime is on, which is correct ONLY for a tab that also holds a channel
   * carrying its updates -- and `directory_services` is not in the `supabase_realtime`
   * publication (see 0001, which publishes cells, gateways and devices and nothing else). A
   * tab with no channel that polled at the reconciliation interval would show a heartbeat up
   * to a minute stale and look, from the page, exactly like a service that had gone quiet.
   */
  usePolling(loadAll, POLL_INTERVAL_MS)

  const triggerGitopsSync = async () => {
    try {
      const res = await api.post('/api/v1/gitops/deploy-flow', { commit_message: 'Manual GitOps Flow Sync from Dashboard UI' })
      // Dismissed on success only. This deploy pushes a whole flow set to Node-RED and is the
      // slowest action on the page; closing on the click meant the operator watched an idle
      // screen with no way to tell the push from a no-op. On failure the dialog stays put, with
      // the error toast beside it, so the retry is one click rather than a re-navigation.
      setConfirmSync(false)
      showToast(res.message, 'success')
      loadAll().catch(() => {})
    } catch (e) {
      // Deploy runs through an Edge Function, which validates the session server-side.
      showToast(await describeAuthFailure(e, 'GitOps flow deployment failed'), 'error')
    }
  }

  // gitops:manage, not gateway:manage -- deploying edge flows is its own
  // privilege. Seeded to Administrator and Shopfloor_Manager only, which is the
  // same pair the deploy-nodered Edge Function enforces server-side.
  const canManageGitops = hasPermission(PERMISSION_UUIDS.GITOPS_MANAGE)

  const groups = groupServices(services)

  return (
    <>
      {/* Heading and description removed: the top bar names the page, and the sections below
          -- the GitOps panel and the service groups -- already say what each of them is. */}

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
          pendingLabel="Syncing…"
          onConfirm={triggerGitopsSync}
          onCancel={() => setConfirmSync(false)}
        />
      )}

      {/* The search box and type picker went with the filter bar. They were solving the flat
          list's problem -- twelve unordered rows are hard to scan -- and the grouping solves it
          without a control to operate first. */}
      {loading ? <div className="loading-wrap"><div className="spinner" /> Loading directory…</div> : (
        groups.map(g => (
          <div className="card directory-group" key={g.title}>
            <div className="card-header">
              <h3 className="section-title">{g.title} <span className="section-count">{g.rows.length}</span></h3>
            </div>
            <ServiceTable rows={g.rows} />
          </div>
        ))
      )}

      {!loading && groups.length === 0 && (
        <div className="empty-state">
          <div className="empty-text">No services are registered in the directory.</div>
        </div>
      )}
    </>
  )
}
