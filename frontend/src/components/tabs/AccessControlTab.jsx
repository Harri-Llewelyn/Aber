import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import CopyableId from '../common/CopyableId'
import { GatewayBundleModal } from '../modals/GatewayBundleModal'
import { GatewayCredentialModal } from '../modals/GatewayCredentialModal'
import { ServiceTokenModal } from '../modals/ServiceTokenModal'
import { ServiceTokenInventoryModal } from '../modals/ServiceTokenInventoryModal'
import { ServicePrincipalRevocationModal } from '../modals/ServicePrincipalRevocationModal'
import { IconArchive, IconDownload, IconLock, IconRefreshCw, IconShieldAlert } from '../common/Icons'
import { HelpTip } from '../common/HelpTip'
import {
  CREDENTIAL_STATES,
  brokerState,
  brokerStateExplanation,
  brokerStateLabel,
  brokerStateTone,
  credentialAction,
  credentialState,
  credentialStateExplanation,
  credentialStateLabel,
  credentialStateTone,
} from '../../utils/credentialState'
import {
  BROKER_PRINCIPALS,
  GATEWAY_ROLES,
  describePrincipal,
  isMintableFromPage,
  permissionReach,
  tokenStatus,
  tokenStatusDetail,
  tokenStatusLabel,
  tokenStatusTone,
  TOKEN_STATES,
} from '../../utils/serviceIdentities'
import { gatewayType, gatewayTypeLabel, gatewayTypeDescription, gatewayTypeTone } from '../../utils/gatewayType'

/** The plugin's ACL types, as the verbs the page prints beside a topic. */
const ACL_VERB = {
  publishClientSend: 'publish',
  publishClientReceive: 'receive',
  subscribePattern: 'subscribe',
  subscribeLiteral: 'subscribe',
  unsubscribePattern: 'unsubscribe',
  unsubscribeLiteral: 'unsubscribe',
}

/** Usernames shaped like a gateway id, which is what an orphaned account looks like. */
const GATEWAY_USERNAME = /^gwy[0-9a-f]{21}$/

/**
 * Access Control: broker credentials and service identities.
 *
 * Two sources side by side: what the platform issued and recorded (the database), and what the
 * broker holds right now (its Dynamic Security plugin, read through broker-inventory). A credential
 * issued outside a dashboard session reads `No platform record` and `Active`, which is the honest
 * pair. Administrator only, gated on the role as Settings is; the page is narrower than the RPCs
 * behind it, which also admit Shopfloor_Manager.
 */
export function AccessControlTab({ showToast }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  // The broker's own account list, or null when it could not be read. Its own error, because a
  // stack whose credential service is down should still show what the platform recorded.
  const [inventory, setInventory] = useState(null)
  const [inventoryError, setInventoryError] = useState(null)
  const [showArchived, setShowArchived] = useState(false)
  const [bundleForGw, setBundleForGw] = useState(null)
  const [credentialForGw, setCredentialForGw] = useState(null)
  const [principals, setPrincipals] = useState([])
  const [tokens, setTokens] = useState(() => new Map())
  // { principal, name } while the mint dialog is open. The name is carried rather than re-derived,
  // so an undocumented principal is labelled once.
  const [mintFor, setMintFor] = useState(null)
  // { principal, name, status } while the inventory dialog is open. The status is passed, so the
  // dialog lists exactly what the badge counted.
  const [tokensFor, setTokensFor] = useState(null)
  // The jtis auth_pre_request() is refusing. Its own state because it is its own read with its own
  // authority: an Auditor can see the denylist, a Shopfloor_Manager cannot, and tokenStatus()
  // degrades on an empty set rather than claiming everything is live.
  const [revokedJtis, setRevokedJtis] = useState(() => new Set())
  // Principal id -> its `revoked_service_principals` row (0076). A MAP, not a Set: the row carries
  // when and why, and both are shown.
  const [revokedPrincipals, setRevokedPrincipals] = useState(() => new Map())
  // { principal, name, revocation, activeTokens } while the withdraw/reinstate dialog is open.
  const [revokeIdentity, setRevokeIdentity] = useState(null)
  // Its own error: gateway credentials accept Shopfloor_Manager, service principals are
  // Administrator-only, and one error state would blame the whole page for a refusal that applies
  // to one section.
  const [principalError, setPrincipalError] = useState(null)

  const load = useCallback((isInitial = false) => {
    if (isInitial) setLoading(true)
    api.listGatewayCredentials()
      .then(d => { setRows(d); setLoadError(null); setLoading(false) })
      .catch(e => { setLoadError(e?.message || 'Could not read gateway credentials.'); setLoading(false) })

    // The broker, live. Not allowed to fail the page: the Broker column reads Not read and the
    // reason is shown once, above the table.
    api.listBrokerInventory()
      .then(d => { setInventory(d); setInventoryError(null) })
      .catch(e => { setInventory(null); setInventoryError(e?.message || 'Could not read the broker.') })

    // Not awaited with the other and not allowed to fail the page: everyone else still gets the
    // credential inventory.
    api.listServicePrincipals()
      .then(d => { setPrincipals(d); setPrincipalError(null) })
      .catch(e => { setPrincipals([]); setPrincipalError(e?.message || 'Could not list service principals.') })

    // Its own failure, swallowed to an empty map: `digital_thread:read` is a separate permission,
    // and a caller without it still sees the identities, each reading No token on record.
    api.listServiceTokens()
      .then(setTokens)
      .catch(() => setTokens(new Map()))

    // The third read keeps the count honest: without it a badge reads 5 active tokens after four
    // were withdrawn. api.listRevokedServiceTokens() already resolves to an empty Set on a refusal,
    // so the .catch is for transport failure.
    api.listRevokedServiceTokens()
      .then(setRevokedJtis)
      .catch(() => setRevokedJtis(new Set()))

    // The fourth read (0076). Its own, for the same reason as the third: different table,
    // different authority, and an identity list that renders beats one blanked by a refusal.
    api.listRevokedServicePrincipals()
      .then(setRevokedPrincipals)
      .catch(() => setRevokedPrincipals(new Map()))
  }, [])

  useEffect(() => { load(true) }, [load])

  // Not Realtime and not polled: nothing on this page changes on its own.
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

  const archivedCount = useMemo(() => rows.filter(r => r.is_archived).length, [rows])

  const clientsByUsername = useMemo(
    () => new Map((inventory?.clients || []).map(c => [c.username, c])),
    [inventory]
  )
  const rolesByName = useMemo(
    () => new Map((inventory?.roles || []).map(r => [r.rolename, r])),
    [inventory]
  )

  // Broker accounts shaped like a gateway id that no gateway row claims: a credential whose row was
  // deleted straight from the broker, or one issued on the host for a gateway that never had a row.
  // Only when the inventory was actually read -- an unread inventory is not evidence of absence.
  const orphanAccounts = useMemo(() => {
    if (!inventory) return []
    const known = new Set(rows.map(r => r.sparkplug_id))
    return (inventory.clients || [])
      .filter(c => GATEWAY_USERNAME.test(c.username) && !known.has(c.username))
      .sort((a, b) => a.username.localeCompare(b.username))
  }, [inventory, rows])

  const afterAction = useCallback(() => {
    setCredentialForGw(null)
    setBundleForGw(null)
    load()
  }, [load])

  if (loading) {
    return (
      <div className="page-layout"><div className="page-main">
        <div className="card" style={{ padding: '12px var(--inset)' }}>
          <div className="loading-wrap"><div className="spinner" /> Loading credentials…</div>
        </div>
      </div></div>
    )
  }

  return (
    <div className="page-layout">
      <div className="page-main">
        {/* One card for one list: title, description, controls and rows. The page states its own
            limit before the first row, so a reader knows what it can and cannot see before acting
            on one. */}
        <div className="card">
          <div className="card-header">
            <h3 className="section-title">
              Broker credentials{' '}
              {/* Filtered of total when a filter is on, so a narrowed inventory does not read as a
                  short one. */}
              <span
                className="section-count"
                title={visible.length === rows.length
                  ? `${rows.length} gateway${rows.length === 1 ? '' : 's'}`
                  : `${visible.length} of ${rows.length} gateways shown`}
              >
                {visible.length === rows.length ? rows.length : `${visible.length}/${rows.length}`}
              </span>
            </h3>

            {/* The card's actions in its header. The archived toggle is the Devices page's Needs
                attention control, a btn-sm carrying its own count. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <button
                className={`btn btn-sm ${showArchived ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setShowArchived(v => !v)}
                aria-pressed={showArchived}
                title="Archived gateways keep their row and their history, and 0038 has already rotated their broker credential to a password nobody holds. They can be issued a new one only after being restored."
              >
                <IconArchive size={14} /> Archived ({archivedCount})
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => load()} title="Re-read credentials">
                <IconRefreshCw size={14} /> Refresh
              </button>
            </div>
          </div>

          <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '12px 20px 0' }}>
            Every gateway authenticates to the broker as its own Sparkplug ID, confined by its own
            role to that edge node, so no two gateways can share a connection. The{' '}
            <strong>Credential</strong> column is what the platform issued and recorded; the{' '}
            <strong>Broker</strong> column is what the broker holds right now, read live from its
            Dynamic Security plugin.
          </p>

          {/* Shown only when the broker could not be read: the Broker column then reads Not read for
              every row, and this says why once rather than on each. When it WAS read, the column is
              the statement and no callout is needed. */}
          {inventoryError && (
            <div className="callout callout-warning">
              <IconShieldAlert size={14} className="callout-icon" />
              <div>
                <strong>The broker was not read.</strong> The Broker column reads <em>Not read</em>{' '}
                for every row. {inventoryError} Reading it requires an Administrator and a reachable
                credential service; the Credential column, from the database, is unaffected.
              </div>
            </div>
          )}

          {loadError && (
            <div className="callout" style={{ borderColor: 'var(--danger)', color: 'var(--danger-text)' }}>
              <IconShieldAlert size={14} className="callout-icon" />
              <div>{loadError}</div>
            </div>
          )}

          <div className="table-wrap" style={{ marginTop: '12px' }}>
          <table>
            <thead>
              <tr>
                <th>Gateway</th>
                <th title="The kind of gateway: Remote (an appliance on the plant network), Host (inside this stack), Simulated (readings generated), Shadow (republishes recorded captures)">Type</th>
                <th>MQTT username</th>
                <th title="What the platform issued and recorded, from the database">Credential</th>
                <th title="What the broker holds right now, read live from its Dynamic Security plugin">Broker</th>
                <th style={{ textAlign: 'right' }}>Issue</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={6} style={{ color: 'var(--text-muted)', padding: '14px' }}>
                  No gateways registered. Create one on the Gateways tab —{' '}
                  <code>tutorial/README.md</code> walks through it.
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
                      {/* The same four words as the Gateways and Capture pages, from the same
                          helper: a simulator and a shadow gateway hold a credential for different
                          reasons. */}
                      <span
                        className={`badge badge-${gatewayTypeTone(gatewayType(g))}`}
                        style={{ fontSize: '11px' }}
                        title={gatewayTypeDescription(gatewayType(g))}
                      >
                        {gatewayTypeLabel(gatewayType(g))}
                      </span>
                    </td>
                    {/* The username is the wire identity, retyped into a broker node's credential
                        pair. Click-to-copy, because a transcription error is a gateway whose every
                        publish is silently dropped by the ACL. */}
                    <td>
                      <CopyableId
                        value={g.sparkplug_id}
                        label="MQTT username"
                        title={`Copy ${g.sparkplug_id} — the username this gateway authenticates as`}
                        onNotify={showToast}
                      />
                    </td>
                    <td>
                      {/* The badge carries the explanation as its title as well, so the meaning is
                          reachable from the row without the legend having to be on screen. */}
                      <span
                        className={`badge badge-${credentialStateTone(state)}`}
                        style={{ fontSize: '11px' }}
                        title={credentialStateExplanation(state, g)}
                      >
                        {credentialStateLabel(state)}
                      </span>
                      {(g.issued_at || g.enrolled_at) && state !== CREDENTIAL_STATES.REVOKED && (
                        <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
                          {new Date(g.issued_at || g.enrolled_at).toLocaleString()}
                        </div>
                      )}
                    </td>
                    {/* The live broker state beside the recorded one. The pair is the point: a
                        gateway can read No platform record and Active (issued on the host), or
                        Issued and Disabled (revoked at the broker since). */}
                    <td>
                      {(() => {
                        const bs = brokerState(clientsByUsername.get(g.sparkplug_id), !!inventory)
                        return (
                          <span
                            className={`badge badge-${brokerStateTone(bs)}`}
                            style={{ fontSize: '11px' }}
                            title={brokerStateExplanation(bs)}
                          >
                            {brokerStateLabel(bs)}
                          </span>
                        )
                      })()}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {action === 'mint' && (
                        <button
                          className="btn btn-ghost"
                          onClick={() => setCredentialForGw({
                            gateway_id: g.id, gateway_name: g.name, sparkplug_id: g.sparkplug_id,
                            // Decides which .env pairing the dialog prints. Without it a playback
                            // gateway is told to edit a Node-RED node it does not have.
                            is_shadow: g.is_shadow
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

          {/* A summary belongs after the thing it summarises. Each count and its label is one pill,
              so the pair cannot split across a wrap. */}
          <div className="table-summary">
            <span className={`table-summary-pill${summary.issued ? '' : ' table-summary-pill-zero'}`}>
              <strong>{summary.issued}</strong> issued
            </span>
            <span className={`table-summary-pill${summary.awaiting ? '' : ' table-summary-pill-zero'}`}>
              <strong>{summary.awaiting}</strong> bundle outstanding
            </span>
            <span className={`table-summary-pill${summary.revoked ? '' : ' table-summary-pill-zero'}`}>
              <strong>{summary.revoked}</strong> revoked
            </span>
            <span className={`table-summary-pill${summary.unrecorded ? '' : ' table-summary-pill-zero'}`}>
              <strong>{summary.unrecorded}</strong> no record
            </span>
          </div>
        </div>

        {/* Accounts the broker holds that no gateway row claims. Shown only when the broker was read
            AND there is at least one: an empty section on every healthy stack is noise. This is the
            half the old page could never show -- a credential outliving its gateway used to be
            invisible here. */}
        {orphanAccounts.length > 0 && (
          <div className="card" style={{ marginTop: 'var(--stack)' }}>
            <div className="card-header">
              <h3 className="section-title">
                Accounts with no gateway
                <span className="section-count">{orphanAccounts.length}</span>
                <HelpTip
                  label="About orphaned accounts"
                  text="Broker accounts shaped like a gateway id that no gateway row claims. Either the gateway was deleted straight from the broker, or an account was issued on the host for a gateway that never had a row. scripts/revoke-orphaned-broker-accounts.mjs disables these; it never deletes."
                />
              </h3>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '12px 20px 0' }}>
              These authenticate as a gateway but match no gateway on this platform.{' '}
              <code>scripts/revoke-orphaned-broker-accounts.mjs</code> lists and disables them; it
              never deletes an account.
            </p>
            <div className="table-wrap" style={{ marginTop: '12px' }}>
            <table>
              <thead>
                <tr>
                  <th>MQTT username</th>
                  <th>Roles</th>
                  <th>Broker</th>
                </tr>
              </thead>
              <tbody>
                {orphanAccounts.map(c => {
                  const bs = brokerState(c, true)
                  return (
                    <tr key={c.username}>
                      <td>
                        <CopyableId
                          value={c.username}
                          label="MQTT username"
                          title={`Copy ${c.username}`}
                          onNotify={showToast}
                        />
                      </td>
                      <td className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {(c.roles || []).join(', ') || '—'}
                      </td>
                      <td>
                        <span
                          className={`badge badge-${brokerStateTone(bs)}`}
                          style={{ fontSize: '11px' }}
                          title={brokerStateExplanation(bs)}
                        >
                          {brokerStateLabel(bs)}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {/* Service identities: two lists rather than one, because nothing holds an identity on both
            planes. The ingestion daemon connects to the broker as `factoryplus_ingestion` and
            reaches the database with the service-role key. */}
        {/* A heading, not a card: one sentence introducing the two cards beneath, in the page's one
            title treatment. */}
        <div style={{ margin: 'calc(var(--stack) * 1.5) 0 10px' }}>
          <h3 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <IconLock size={15} /> Service identities
          </h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '6px 0 0' }}>
            The non-human clients that can reach this stack. They are two separate lists because they
            live on two separate planes — a database identity is a set of permissions, a broker
            identity is an ACL entry, and nothing here holds both.
          </p>
        </div>

        {/* The same column rhythm as the credentials table: an identity, what it holds, what that
            reaches, where it comes from. */}
        <div className="card" style={{ marginTop: 'var(--stack)' }}>
          <div className="card-header">
            <h3 className="section-title">
              Database principals
              <HelpTip
                label="About database principals"
                text="The identities the stack's own processes authenticate as. None has an email or password, so none can sign in: each is named by a token, holds permissions of its own rather than a person's role, and writes only through gates that check which one is calling."
              />
            </h3>
          </div>

          {principalError && (
            <div className="callout" style={{ borderColor: 'var(--danger)', color: 'var(--danger-text)' }}>
              <IconShieldAlert size={14} className="callout-icon" />
              <div>{principalError}</div>
            </div>
          )}
          {!principalError && (
            <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Identity</th>
                  {/* Its own column, as the Schemas page treats a UUID: it is the value a JWT's
                      `sub` claim has to equal. */}
                  <th>Principal ID</th>
                  <th>Holds</th>
                  <th>Reaches</th>
                  {/* What is outstanding, not when it was last minted (tokenStatus()): a re-mint
                      adds a live credential rather than replacing one. */}
                  <th title="Long-lived tokens signed for this identity that have not yet expired">
                    Tokens
                  </th>
                  <th>Mint</th>
                </tr>
              </thead>
              <tbody>
                {principals.length === 0 && (
                  <tr><td colSpan={6} style={{ color: 'var(--text-muted)', padding: '14px' }}>
                    No machine identities are registered. Every account on this stack belongs to a person.
                  </td></tr>
                )}
                {principals.map(p => {
                  const meta = describePrincipal(p.principal_id)
                  // The denylist is passed so a withdrawn token stops counting as active.
                  // `Date.now()` is spelled out because the third argument cannot be reached past a
                  // defaulted second.
                  const status = tokenStatus(tokens.get(p.principal_id), Date.now(), revokedJtis)
                  const revocation = revokedPrincipals.get(p.principal_id) || null
                  return (
                    <tr key={p.principal_id}>
                      {/* The purpose is a tooltip: three lines of background on a row whose other
                          columns are the answer. The dotted underline says there is something to
                          hover. */}
                      <td>
                        <span
                          title={meta.purpose}
                          style={{
                            fontWeight: 600,
                            textDecoration: 'underline dotted var(--text-muted)',
                            textUnderlineOffset: '3px',
                            cursor: 'help',
                          }}
                        >
                          {meta.name}
                        </span>
                      </td>
                      <td>
                        <CopyableId
                          value={p.principal_id}
                          label="principal id"
                          title={`Copy ${p.principal_id} — the subject a token for this identity must name`}
                          onNotify={showToast}
                        />
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                          {/* Permissions, not a role: these identities no longer hold `Operator`,
                              whose every widening silently re-granted the stack's own processes. */}
                          {(p.permissions || []).map(perm => (
                            <span key={perm} className="badge badge-neutral" style={{ fontSize: '11px' }}>{perm}</span>
                          ))}
                          {/* Stated, not assumed: `can_sign_in` is returned by the RPC rather than
                              inferred from the predicate it selected on. */}
                          {p.can_sign_in === false && (
                            <span className="badge badge-ok" style={{ fontSize: '11px' }}>CANNOT SIGN IN</span>
                          )}
                          {/* Beside the grants, because a revocation is a fact about the identity
                              and outranks its tokens. */}
                          {revocation && (
                            <span
                              className="badge badge-danger"
                              style={{ fontSize: '11px', cursor: 'help' }}
                              title={`Withdrawn ${new Date(revocation.revoked_at).toLocaleString()}`
                                + (revocation.reason ? ` — ${revocation.reason}` : '')
                                + '. Every token naming this identity is refused by the API, including any issued afterwards.'}
                            >
                              REVOKED
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '40ch' }}>
                        {permissionReach(p.permissions)}
                      </td>
                      {/* Said once, as a tooltip with the dotted underline that says so. */}
                      {/* The badge is the way in: a principal has N tokens and
                          `revoke_service_token()` takes a jti, so a row-level Revoke would have to
                          pick one. A plain badge when there is nothing to list. */}
                      <td>
                        {status.rows.length > 0 ? (
                          <button
                            type="button"
                            className={`badge badge-${tokenStatusTone(status)}`}
                            style={{
                              fontSize: '11px',
                              border: 'none',
                              cursor: 'pointer',
                              textDecoration: 'underline dotted currentColor',
                              textUnderlineOffset: '3px',
                            }}
                            onClick={() => setTokensFor({ principal: p, name: meta.name, status })}
                            title={`${tokenStatusDetail(status)} Click to list them and withdraw one.`}
                          >
                            {tokenStatusLabel(status)}
                          </button>
                        ) : (
                          <span
                            className={`badge badge-${tokenStatusTone(status)}`}
                            style={{
                              fontSize: '11px',
                              textDecoration: 'underline dotted var(--text-muted)',
                              textUnderlineOffset: '3px',
                              cursor: 'help',
                            }}
                            title={tokenStatusDetail(status)}
                          >
                            {tokenStatusLabel(status)}
                          </span>
                        )}
                      </td>
                      {/* A button where a token is actually read, and the command everywhere else.
                          `isMintableFromPage()` decides: the two environment-key identities take
                          their key from the environment at boot, so a minted token for them would
                          be a second privileged credential nothing reads. They keep the rotate
                          command. */}
                      <td>
                        {isMintableFromPage(meta) ? (
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                            {/* Minting is not offered for a withdrawn identity:
                                record_service_token_issued() refuses it. Reinstating is the action
                                available, so it is the one shown. */}
                            {revocation ? (
                              <button
                                className="btn btn-ghost"
                                onClick={() => setRevokeIdentity({
                                  principal: p, name: meta.name, revocation, activeTokens: status.outstanding,
                                })}
                                title="This identity is withdrawn and cannot be issued a token. Reinstate it first — its previous tokens stay withdrawn."
                              >
                                Reinstate
                              </button>
                            ) : (
                              <button
                                className="btn btn-ghost"
                                onClick={() => setMintFor({ principal: p, name: meta.name })}
                                title="Sign a token for this identity and show it once. Recorded in the Digital Thread before it is returned, and revocable against the API afterwards."
                              >
                                <IconLock size={13} /> Issue Token
                              </button>
                            )}
                            {/* Withdrawing is offered wherever minting is. */}
                            {!revocation && (
                              <button
                                className="btn btn-ghost"
                                onClick={() => setRevokeIdentity({
                                  principal: p, name: meta.name, revocation: null, activeTokens: status.outstanding,
                                })}
                                title="Withdraw this identity. Every token naming it is refused by the API, including any issued afterwards — which is what makes this different from withdrawing tokens one at a time."
                              >
                                Withdraw
                              </button>
                            )}
                            {/* Kept beside it: `mint-mcp-token.mjs` survives as break-glass for a
                                stack whose only Administrator cannot sign in. */}
                            <CopyableId
                              value={meta.mintCommand.replace('{id}', p.principal_id)}
                              label="mint command"
                              display="Copy Command"
                              variant="button"
                              title={`Copy \`${meta.mintCommand.replace('{id}', p.principal_id)}\` — the break-glass path, which works when nobody can sign in to this page.`}
                              onNotify={showToast}
                            />
                          </div>
                        ) : (
                          <CopyableId
                            value={meta.mintCommand.replace('{id}', p.principal_id)}
                            label="rotate command"
                            display="Copy Command"
                            variant="button"
                            // The tooltip carries the distinction the label cannot: this is `npm
                            // run keys:rotate`, because the identity's key lives in .env and is
                            // read at boot.
                            title={`Copy \`${meta.mintCommand.replace('{id}', p.principal_id)}\` — this identity's key lives in .env and is read at boot, so ROTATING it, not minting a new token, is what changes what the process presents. It records the issue before writing, and names the containers to restart.`}
                            onNotify={showToast}
                          />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          )}

          {/* Shown only while it is true of this stack. On a stack that has never rotated, the
              token list is empty for the two most powerful credentials, because `npm run setup`
              signs them before the database exists. The per-row badge says so; this footer restates
              it only while it applies. */}
        </div>

        <div className="card" style={{ marginTop: 'var(--stack)' }}>
          <div className="card-header">
            <h3 className="section-title">
              Broker roles
              <HelpTip
                label="About broker roles"
                text="The roles the Dynamic Security plugin enforces: what each account may publish, receive and subscribe to. The rules are read live from the broker; what a role is FOR is declared in the repository (mosquitto/dynsec-roles.json) and checked against the policy at build time."
              />
            </h3>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '12px 20px 0' }}>
            {inventory
              ? 'The rules below are read live from the broker; the purpose beside each is declared in the repository.'
              : 'The broker was not read, so the rules cannot be shown. Each role and its purpose are declared in mosquitto/dynsec-roles.json.'}
          </p>
          <div className="table-wrap" style={{ marginTop: '12px' }}>
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Access</th>
                <th>Rules</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {/* Declared roles in policy order, each annotated with the live rules the broker
                  reports. The gateway row stands for every gateway: the shared role plus the
                  per-gateway role the reconcile generates, which is what actually confines one. */}
              {[
                ...BROKER_PRINCIPALS.map(bp => ({ rolename: bp.role, purpose: bp.purpose, writes: bp.writes })),
                {
                  rolename: GATEWAY_ROLES.shared,
                  purpose: GATEWAY_ROLES.purpose,
                  writes: false,
                  extra: `+ ${GATEWAY_ROLES.perGateway} per gateway (${GATEWAY_ROLES.perGatewayTopic})`,
                },
              ].map(entry => {
                const live = rolesByName.get(entry.rolename)
                const allowed = (live?.acls || []).filter(a => a.allow)
                const writes = live ? allowed.some(a => a.acltype === 'publishClientSend') : entry.writes
                return (
                  <tr key={entry.rolename}>
                    <td className="mono" style={{ fontSize: '12px' }}>{entry.rolename}</td>
                    <td>
                      <span className={`badge badge-${writes ? 'pending' : 'ok'}`} style={{ fontSize: '11px' }}>
                        {writes ? 'CAN PUBLISH' : 'READ ONLY'}
                      </span>
                    </td>
                    {/* THE PLUGIN'S OWN RULES, verb and topic, when the broker was read; a dash
                        otherwise. Not a paraphrase: someone comparing this against the policy should
                        read the same topics on both sides. */}
                    <td className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'pre-line' }}>
                      {live
                        ? (allowed.map(a => `${ACL_VERB[a.acltype] || a.acltype} ${a.topic}`).join('\n') || '—')
                        : '—'}
                      {entry.extra && <div style={{ marginTop: '4px', fontStyle: 'italic' }}>{entry.extra}</div>}
                    </td>
                    <td style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '46ch' }}>{entry.purpose}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
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

      {/* Not `afterAction`, which reloads the credential inventory; this reloads the token
          inventory so the mint appears in the badge. `load()` refreshes all three reads. */}
      {mintFor && (
        <ServiceTokenModal
          principal={mintFor.principal}
          principalName={mintFor.name}
          onClose={() => { setMintFor(null); load() }}
          showToast={showToast}
        />
      )}

      {/* `onChanged` rather than reloading on every close: the dialog is opened to look as often as
          to act. */}
      {tokensFor && (
        <ServiceTokenInventoryModal
          principalName={tokensFor.name}
          status={tokensFor.status}
          onClose={() => setTokensFor(null)}
          onChanged={load}
          showToast={showToast}
        />
      )}

      {revokeIdentity && (
        <ServicePrincipalRevocationModal
          principal={revokeIdentity.principal}
          principalName={revokeIdentity.name}
          revocation={revokeIdentity.revocation}
          activeTokens={revokeIdentity.activeTokens}
          onClose={() => setRevokeIdentity(null)}
          onChanged={load}
          showToast={showToast}
        />
      )}
    </div>
  )
}
