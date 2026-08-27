import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { GatewayBundleModal } from '../modals/GatewayBundleModal'
import { GatewayCredentialModal } from '../modals/GatewayCredentialModal'
import { IconDownload, IconLock, IconRefreshCw, IconShieldAlert } from '../common/Icons'
import {
  CREDENTIAL_STATES,
  credentialAction,
  credentialState,
  credentialStateExplanation,
  credentialStateLabel,
  credentialStateTone,
} from '../../utils/credentialState'

/**
 * Access Control — broker credentials, and where they came from.
 *
 * =================================================================================================
 * THE GAP THIS CLOSES, in roadmap §13's words: "the only way to see what credentials exist today is
 * to read `.env` and `.env.gateways` on the machine that generated them, which is a file, not a
 * view — and a file that the hand-off checklist explicitly tells you to delete."
 *
 * =================================================================================================
 * WHAT IT DELIBERATELY DOES NOT CLAIM, WHICH IS THE HARDEST PART OF THE PAGE
 *
 * It is not an inventory of the broker. Mosquitto's accounts live in a file reachable only by
 * `gateway-credential-service`, which is add-only and cannot list anything back -- and giving it a
 * LIST verb would hand whoever holds one bearer token the whole account table, which is precisely
 * the drift its header forbids.
 *
 * So this shows what the PLATFORM issued and recorded. The difference shows up immediately on a
 * demonstration stack: `npm run provision:gateways` mints four working credentials through a script,
 * and `record_gateway_credential_issued()` cannot be called on its behalf because `has_role()`
 * resolves through `auth.uid()`, which is NULL for the service-role key. Those four gateways read
 * `No platform record` here and connect perfectly well.
 *
 * THAT IS WHY THE STATE IS NAMED FOR THE RECORD AND NOT FOR THE CREDENTIAL. "No credential" would
 * be a claim about the broker; "No platform record" is a claim about this database, which is the
 * only thing the page can actually see.
 *
 * =================================================================================================
 * ADMINISTRATOR ONLY, gated the same way Settings is -- on the ROLE, not on a permission. The
 * database gates the two RPCs behind this page on `has_role(ARRAY['Administrator',
 * 'Shopfloor_Manager'])`, and the page is narrower than the API on purpose: reading who holds what
 * is an access-control question, and `authz:manage` is the permission that names it.
 */
export function AccessControlTab({ showToast }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [showArchived, setShowArchived] = useState(false)
  const [bundleForGw, setBundleForGw] = useState(null)
  const [credentialForGw, setCredentialForGw] = useState(null)

  const load = useCallback((isInitial = false) => {
    if (isInitial) setLoading(true)
    api.listGatewayCredentials()
      .then(d => { setRows(d); setLoadError(null); setLoading(false) })
      .catch(e => { setLoadError(e?.message || 'Could not read gateway credentials.'); setLoading(false) })
  }, [])

  useEffect(() => { load(true) }, [load])

  // NOT REALTIME, and not polled. Nothing on this page changes on its own: a credential changes
  // when somebody on this page changes it, or when a gateway is archived from another tab. A 3s
  // poll would re-read the audit table forever to show the same six rows.
  const visible = useMemo(
    () => rows.filter(r => showArchived || !r.is_archived),
    [rows, showArchived]
  )

  const summary = useMemo(() => {
    const counts = { issued: 0, revoked: 0, unrecorded: 0, awaiting: 0 }
    for (const r of rows.filter(x => !x.is_archived)) {
      const state = credentialState(r, r.issued_at)
      if (state === CREDENTIAL_STATES.ISSUED) counts.issued += 1
      else if (state === CREDENTIAL_STATES.REVOKED) counts.revoked += 1
      else if (state === CREDENTIAL_STATES.AWAITING_ENROLMENT) counts.awaiting += 1
      else counts.unrecorded += 1
    }
    return counts
  }, [rows])

  const afterAction = useCallback(() => {
    setCredentialForGw(null)
    setBundleForGw(null)
    load()
  }, [load])

  if (loading) {
    return (
      <div className="page-layout"><div className="page-main">
        <div className="card" style={{ padding: '16px' }}>
          <div className="loading-wrap"><div className="spinner" /> Loading credentials…</div>
        </div>
      </div></div>
    )
  }

  return (
    <div className="page-layout">
      <div className="page-main">
        {/* THE PAGE STATES ITS OWN LIMIT FIRST, the way Settings does, and for the same reason:
            somebody arriving here to answer "does this gateway have a credential" needs to know
            what this page can and cannot see BEFORE they read a row, not after they act on one. */}
        <div className="settings-preamble card">
          <div className="settings-preamble-title">
            <IconLock size={15} /> Broker credentials
          </div>
          <p>
            Every gateway authenticates to the broker as its own Sparkplug ID — the ACL pins the
            topic’s edge-node segment to the connecting username, so no two gateways can share a
            connection. This page shows what the platform has issued, and gives you the two ways to
            issue one.
          </p>
          <p className="settings-preamble-warning">
            <strong>This is not an inventory of the broker.</strong> Mosquitto’s account file can
            only be added to, never read back, so a gateway showing{' '}
            <em>No platform record</em> may still hold a working credential — the ones{' '}
            <code>npm run provision:gateways</code> creates are issued outside the dashboard and
            leave no record here.
          </p>
        </div>

        {loadError && (
          <div className="card" style={{ padding: '12px', color: 'var(--danger)' }}>
            <IconShieldAlert size={13} /> {loadError}
          </div>
        )}

        <div className="card" style={{ padding: '12px', marginTop: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: '14px', fontSize: '12px', color: 'var(--text-muted)' }}>
              <span><strong style={{ color: 'var(--text-primary)' }}>{summary.issued}</strong> issued</span>
              <span><strong style={{ color: 'var(--text-primary)' }}>{summary.awaiting}</strong> bundle outstanding</span>
              <span><strong style={{ color: 'var(--text-primary)' }}>{summary.revoked}</strong> revoked</span>
              <span><strong style={{ color: 'var(--text-primary)' }}>{summary.unrecorded}</strong> no record</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <label style={{ fontSize: '12px', display: 'flex', gap: '5px', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={e => setShowArchived(e.target.checked)}
                />
                Show archived
              </label>
              <button className="btn btn-ghost" onClick={() => load()} title="Re-read credentials">
                <IconRefreshCw size={13} /> Refresh
              </button>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: '12px', overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Gateway</th>
                <th>Kind</th>
                <th>MQTT username</th>
                <th>Credential</th>
                <th style={{ textAlign: 'right' }}>Issue</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={5} style={{ color: 'var(--text-muted)', padding: '14px' }}>
                  No gateways registered. Create one on the Gateways tab, or run{' '}
                  <code>npm run provision:gateways</code> for the demonstration shopfloor.
                </td></tr>
              )}
              {visible.map(g => {
                const state = credentialState(g, g.issued_at)
                const action = credentialAction(g)
                return (
                  <tr key={g.id}>
                    <td>
                      <div>{g.name}</div>
                      {g.is_archived && (
                        <span className="badge badge-neutral" style={{ fontSize: '11px' }}>ARCHIVED</span>
                      )}
                    </td>
                    <td>
                      <span className="badge badge-neutral" style={{ fontSize: '11px' }}>
                        {g.is_virtual ? '⚡ VIRTUAL' : 'PHYSICAL'}
                      </span>
                    </td>
                    {/* THE USERNAME IS THE WIRE IDENTITY, not a display name, and is shown in mono
                        so it reads as the string the ACL matches rather than as a label. */}
                    <td className="mono" style={{ fontSize: '12px' }}>{g.sparkplug_id}</td>
                    <td>
                      <span className={`badge badge-${credentialStateTone(state)}`} style={{ fontSize: '11px' }}>
                        {credentialStateLabel(state)}
                      </span>
                      <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px', maxWidth: '46ch' }}>
                        {credentialStateExplanation(state, g)}
                      </div>
                      {(g.issued_at || g.enrolled_at) && state !== CREDENTIAL_STATES.REVOKED && (
                        <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '2px' }}>
                          {new Date(g.issued_at || g.enrolled_at).toLocaleString()}
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {action === 'mint' && (
                        <button
                          className="btn btn-ghost"
                          onClick={() => setCredentialForGw({
                            gateway_id: g.id, gateway_name: g.name, sparkplug_id: g.sparkplug_id
                          })}
                          title="Mint a broker credential and show it once"
                        >
                          <IconLock size={13} /> Generate
                        </button>
                      )}
                      {action === 'bundle' && (
                        <button
                          className="btn btn-ghost"
                          onClick={() => setBundleForGw({
                            gateway_id: g.id,
                            gateway_name: g.name,
                            sparkplug_id: g.sparkplug_id,
                            status: g.status,
                            confirmFirst: true
                          })}
                          title="Generate the bootstrap bundle; the appliance mints its own credential"
                        >
                          <IconDownload size={13} /> Bundle
                        </button>
                      )}
                      {!action && (
                        <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                          Restore to issue
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {credentialForGw && (
        <GatewayCredentialModal
          gateway={credentialForGw}
          onClose={afterAction}
          showToast={showToast}
        />
      )}

      {bundleForGw && (
        <GatewayBundleModal
          gateway={bundleForGw}
          confirmFirst={bundleForGw.confirmFirst}
          onClose={afterAction}
          showToast={showToast}
        />
      )}
    </div>
  )
}
