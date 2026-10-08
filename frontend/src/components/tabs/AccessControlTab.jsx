import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import CopyableId from '../common/CopyableId'
import { GatewayBundleModal } from '../modals/GatewayBundleModal'
import { GatewayCredentialModal } from '../modals/GatewayCredentialModal'
import { ServiceTokenModal } from '../modals/ServiceTokenModal'
import { ServiceTokenInventoryModal } from '../modals/ServiceTokenInventoryModal'
import { ServicePrincipalRevocationModal } from '../modals/ServicePrincipalRevocationModal'
import { ServicePrincipalCreateModal } from '../modals/ServicePrincipalCreateModal'
import { ServicePrincipalDescribeModal } from '../modals/ServicePrincipalDescribeModal'
import { PeopleSection } from './PeopleSection'
import {
  IconBot, IconDownload, IconLock, IconPencil, IconPlus, IconRadio, IconRefreshCw, IconShieldAlert,
  IconShieldCheck,
} from '../common/Icons'
import { Badge, ArchivedBadge } from '../common/Badge'
import { CardHeading } from '../common/CardHeading'
import { ClearFilters } from '../common/ClearFilters'
import { EmptyState } from '../common/EmptyState'
import { HelpTip } from '../common/HelpTip'
import { LoadingState } from '../common/LoadingState'
import { TabStrip } from '../common/TabStrip'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { formatDateTime } from '../../utils/format'
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
  describeBrokerAccount,
  describePrincipal,
  isMintableFromPage,
  permissionReach,
  tokenStatus,
  tokenStatusDetail,
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
 * The declared broker roles in policy order, each annotated with the live rules the broker reports.
 * The gateway row stands for every gateway: the shared role plus the per-gateway role the reconcile
 * generates, which is what actually confines one.
 */
const ROLE_ENTRIES = [
  ...BROKER_PRINCIPALS.map(bp => ({ rolename: bp.role, purpose: bp.purpose, writes: bp.writes })),
  {
    rolename: GATEWAY_ROLES.shared,
    purpose: GATEWAY_ROLES.purpose,
    writes: false,
    perGateway: `${GATEWAY_ROLES.perGateway} — ${GATEWAY_ROLES.perGatewayTopic}`,
  },
]

/** People comes first, and only for an Administrator; see AccessControlTab. */
const PEOPLE_SECTION = { id: 'people', label: 'People', title: 'Everyone who can sign in, and their role' }

/** The page's lists, one per tab, in tab order. A search-bar card opens one by its id. */
const SECTIONS = [
  { id: 'credentials', label: 'Broker credentials', title: "Every gateway's broker credential, recorded and live" },
  { id: 'identities', label: 'Machine identities', title: "The stack's own processes, on the database side" },
  { id: 'accounts', label: 'Broker accounts', title: "The broker's own accounts, and any no gateway claims" },
  { id: 'roles', label: 'Broker roles', title: 'What each broker role may publish, receive and subscribe to' },
]

/** Each tab's "?", drawn in the tab bar for the selected tab. */
const SECTION_HELP = {
  people: {
    label: 'About people',
    text: 'Everyone who signs in to the dashboard, with their role. Add a person, change a role, or remove access. Removing access blocks sign-in and removes the role at once; the account and its history stay. You cannot change your own role or access.',
  },
  credentials: {
    label: 'About broker credentials',
    text: 'Each gateway connects to the broker as its own Sparkplug ID, confined to its edge node. Credential is what the platform issued and recorded; Broker is what the broker holds now, read live from Dynamic Security.',
  },
  identities: {
    label: 'About machine identities',
    text: "Identities for the stack's own processes. None can sign in: each is named by a token and holds permissions of its own, not a person's role. They reach the database only, never the broker.",
  },
  accounts: {
    label: 'About broker accounts',
    text: "The broker's accounts, read live. mosquitto-init creates the stack's own at boot from each MQTT_<NAME>_USER and _PASSWORD pair. No gateway marks a gateway-shaped account no gateway claims; scripts/revoke-orphaned-broker-accounts.mjs disables those.",
  },
  roles: {
    label: 'About broker roles',
    text: 'What each role may publish, receive and subscribe to, read live from Dynamic Security. Open a role to read its rules. Purposes are declared in mosquitto/dynsec-roles.json and checked at build time.',
  },
}

/**
 * Access Control: people, broker credentials and machine identities, as tabs of one card.
 *
 * People is the people who sign in, for an Administrator to add, re-role and remove (PeopleSection).
 * It is offered only when `userRole` is Administrator, and the page opens on it; the functions behind
 * it check the role again. `currentUserId` is the signed-in account, whose own controls are disabled.
 *
 * Broker credentials is the per-gateway list, with two sources side by side: what the platform
 * issued and recorded (the database), and what the broker holds right now (its Dynamic Security
 * plugin, read through broker-inventory). A credential issued outside a dashboard session reads `No
 * platform record` and `Active`, which is the honest pair. The other three tabs are the non-human
 * identities on both planes. Administrator only, gated on the role as Settings is; the page is
 * narrower than the RPCs behind it, which also admit Shopfloor_Manager. The card scrolls.
 *
 * `initialSection` is a SECTIONS id handed over by the search bar; `onClearSection` drops it once
 * the tab is open.
 */
export function AccessControlTab({ showToast, initialSection = '', onClearSection, userRole = null, currentUserId = null }) {
  const showPeople = userRole === 'Administrator'
  const sections = useMemo(() => (showPeople ? [PEOPLE_SECTION, ...SECTIONS] : SECTIONS), [showPeople])
  const [section, setSection] = useState(showPeople ? 'people' : 'credentials')
  // The role whose rules the drawer shows, by name; null when closed.
  const [openRole, setOpenRole] = useState(null)
  const [rows, setRows] = useState([])
  // One flag per read a card waits on, so a card that is still loading says so instead of reading
  // as empty.
  const [loading, setLoading] = useState(true)
  const [inventoryLoading, setInventoryLoading] = useState(true)
  const [principalsLoading, setPrincipalsLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  // The broker's own account list, or null when it could not be read. Its own error, because a
  // stack whose credential service is down should still show what the platform recorded.
  const [inventory, setInventory] = useState(null)
  const [inventoryError, setInventoryError] = useState(null)
  // One of the credential filter's values: a credential state, every active gateway, or the archive.
  const [credentialFilter, setCredentialFilter] = useState('active')
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
  // Principal id -> its `revoked_service_principals` row. A MAP, not a Set: the row carries when and
  // why, and both are shown.
  const [revokedPrincipals, setRevokedPrincipals] = useState(() => new Map())
  // { principal, name, revocation, activeTokens } while the withdraw/reinstate dialog is open.
  const [revokeIdentity, setRevokeIdentity] = useState(null)
  // True while the create dialog is open. On success the token dialog opens for the new identity,
  // so the first token is shown once the way every other is.
  const [creating, setCreating] = useState(false)
  // The principal row whose name and purpose are being edited, or null.
  const [describing, setDescribing] = useState(null)
  // Its own error: gateway credentials accept Shopfloor_Manager, machine identities are
  // Administrator-only, and one error state would blame the whole page for a refusal that applies
  // to one section.
  const [principalError, setPrincipalError] = useState(null)

  const load = useCallback((isInitial = false) => {
    if (isInitial) {
      setLoading(true)
      setInventoryLoading(true)
      setPrincipalsLoading(true)
    }
    api.listGatewayCredentials()
      .then(d => { setRows(d); setLoadError(null); setLoading(false) })
      .catch(e => { setLoadError(e?.message || 'Could not read gateway credentials.'); setLoading(false) })

    // The broker, live. Not allowed to fail the page: the Broker column reads Not read and the
    // reason is shown once, above the table.
    api.listBrokerInventory()
      .then(d => { setInventory(d); setInventoryError(null); setInventoryLoading(false) })
      .catch(e => {
        setInventory(null)
        setInventoryError(e?.message || 'Could not read the broker.')
        setInventoryLoading(false)
      })

    // Not awaited with the others and not allowed to fail the page: everyone else still gets the
    // credential inventory.
    api.listServicePrincipals()
      .then(d => { setPrincipals(d); setPrincipalError(null); setPrincipalsLoading(false) })
      .catch(e => {
        setPrincipals([])
        setPrincipalError(e?.message || 'Could not list machine identities.')
        setPrincipalsLoading(false)
      })

    // Its own failure, swallowed to an empty map: the token history is the Audit Trail's security
    // lane, which only an Administrator or Auditor may read. A caller without it still sees the
    // identities, each reading No token on record.
    api.listServiceTokens()
      .then(setTokens)
      .catch(() => setTokens(new Map()))

    // Keeps the count honest: without it a badge reads 5 active tokens after four were revoked.
    // api.listRevokedServiceTokens() already resolves to an empty Set on a refusal, so the .catch
    // is for transport failure.
    api.listRevokedServiceTokens()
      .then(setRevokedJtis)
      .catch(() => setRevokedJtis(new Set()))

    // Its own read, for the same reason: different table, different authority, and an identity
    // list that renders beats one blanked by a refusal.
    api.listRevokedServicePrincipals()
      .then(setRevokedPrincipals)
      .catch(() => setRevokedPrincipals(new Map()))
  }, [])

  useEffect(() => { load(true) }, [load])

  // The drawer belongs to Broker roles, so leaving that tab closes it.
  const selectSection = useCallback((id) => {
    setSection(id)
    if (id !== 'roles') setOpenRole(null)
  }, [])

  // Opens the tab a search-bar card named, then drops the request so a later visit starts on the
  // default.
  useEffect(() => {
    if (!initialSection) return
    if (sections.some(s => s.id === initialSection)) selectSection(initialSection)
    onClearSection?.()
  }, [initialSection, onClearSection, selectSection, sections])

  // Counts per filter value, over the whole list, so the dropdown answers "is there any?" without
  // being selected. Archived rows count only under Archived: archiving rotated their credential to
  // a password nobody holds, so their state is not one of the four.
  const filterCounts = useMemo(() => {
    const counts = { active: 0, archived: 0 }
    for (const s of Object.values(CREDENTIAL_STATES)) counts[s] = 0
    for (const r of rows) {
      if (r.is_archived) { counts.archived += 1; continue }
      counts.active += 1
      counts[credentialState(r, r.issued_at)] += 1
    }
    return counts
  }, [rows])

  const visible = useMemo(() => rows.filter(r => {
    if (credentialFilter === 'archived') return r.is_archived
    if (r.is_archived) return false
    return credentialFilter === 'active' || credentialState(r, r.issued_at) === credentialFilter
  }), [rows, credentialFilter])

  const clientsByUsername = useMemo(
    () => new Map((inventory?.clients || []).map(c => [c.username, c])),
    [inventory]
  )
  const rolesByName = useMemo(
    () => new Map((inventory?.roles || []).map(r => [r.rolename, r])),
    [inventory]
  )

  // Broker accounts shaped like a gateway id that no gateway row claims and nothing declares: a
  // credential whose row was deleted straight from the broker, or one issued on the host for a
  // gateway that never had a row. A declared fixture is a platform account and is listed with
  // those. Only when the inventory was actually read -- an unread inventory is not evidence of
  // absence.
  const orphanAccounts = useMemo(() => {
    if (!inventory) return []
    const known = new Set(rows.map(r => r.sparkplug_id))
    return (inventory.clients || [])
      .filter(c => GATEWAY_USERNAME.test(c.username) && !known.has(c.username) && !describeBrokerAccount(c.username))
      .sort((a, b) => a.username.localeCompare(b.username))
  }, [inventory, rows])

  // The broker's own accounts: everything that is not a gateway, plus any declared fixture. Each
  // with the purpose of the platform role it holds, or its own declaration. In policy order, so
  // the list reads the same way as Broker roles.
  const platformAccounts = useMemo(() => {
    if (!inventory) return []
    const order = new Map(ROLE_ENTRIES.map((e, i) => [e.rolename, i]))
    const purposeOf = c => {
      const declared = describeBrokerAccount(c.username)
      if (declared) return { name: declared.name, purpose: declared.purpose }
      const role = (c.roles || []).find(r => order.has(r) && r !== GATEWAY_ROLES.shared)
      return role ? { name: null, purpose: ROLE_ENTRIES[order.get(role)].purpose } : { name: null, purpose: null }
    }
    const rank = c => Math.min(...(c.roles || []).map(r => order.has(r) ? order.get(r) : order.size), order.size)
    return (inventory.clients || [])
      .filter(c => !GATEWAY_USERNAME.test(c.username) || describeBrokerAccount(c.username))
      .map(c => ({ ...c, ...purposeOf(c) }))
      .sort((a, b) => rank(a) - rank(b) || a.username.localeCompare(b.username))
  }, [inventory])

  // Broker accounts lists both: the platform's own in policy order, then any no gateway claims.
  const brokerAccounts = useMemo(
    () => [...platformAccounts, ...orphanAccounts.map(c => ({ ...c, noGateway: true }))],
    [platformAccounts, orphanAccounts]
  )

  const afterAction = useCallback(() => {
    setCredentialForGw(null)
    setBundleForGw(null)
    load()
  }, [load])

  const brokerBadge = (bs) => (
    <Badge size="sm" tone={brokerStateTone(bs)} title={brokerStateExplanation(bs)}>
      {brokerStateLabel(bs)}
    </Badge>
  )

  // The credential filter is the only control on the page that can be off its default.
  const filterCount = credentialFilter !== 'active' ? 1 : 0

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        <div className="card card-fill">
          <CardHeading
            icon={<IconLock size={15} />}
            title="Access Control"
            description="Who may reach Aber: the people who sign in, and the credentials that let gateways and the stack's own processes reach the broker and the database."
          />

          <TabStrip
            ariaLabel="Access Control list"
            value={section}
            onChange={selectSection}
            tabs={sections}
            help={<HelpTip label={SECTION_HELP[section].label} text={SECTION_HELP[section].text} />}
          />

          {section === 'people' && showPeople && (
            <PeopleSection showToast={showToast} currentUserId={currentUserId} />
          )}

          {section === 'credentials' && (<>
          <div className="filter-bar">
            <select
              className="form-control control-lg"
              value={credentialFilter}
              onChange={e => setCredentialFilter(e.target.value)}
              aria-label="Filter gateways by credential state"
              title="Filter by the Credential column. An archived gateway's credential was rotated to a password nobody holds; it can be issued a new one only after being restored."
            >
              <option value="active">Active ({filterCounts.active})</option>
              <option value={CREDENTIAL_STATES.ISSUED}>Issued ({filterCounts[CREDENTIAL_STATES.ISSUED]})</option>
              <option value={CREDENTIAL_STATES.AWAITING_ENROLMENT}>Setup outstanding ({filterCounts[CREDENTIAL_STATES.AWAITING_ENROLMENT]})</option>
              <option value={CREDENTIAL_STATES.REVOKED}>Revoked ({filterCounts[CREDENTIAL_STATES.REVOKED]})</option>
              <option value={CREDENTIAL_STATES.UNRECORDED}>No platform record ({filterCounts[CREDENTIAL_STATES.UNRECORDED]})</option>
              <option value="archived">Archived ({filterCounts.archived})</option>
            </select>
            {/* Clear sits in the actions group: two auto margins in one bar would split the row. */}
            <div className="filter-bar-actions">
              <ClearFilters count={filterCount} onClear={() => setCredentialFilter('active')} />
              <button className="btn btn-ghost btn-sm" onClick={() => load()} title="Re-read credentials">
                <IconRefreshCw size={14} /> Refresh
              </button>
            </div>
          </div>

          {(inventoryError || loadError) && (
          <div className="card-body">
            {/* Shown only when the broker could not be read: the Broker column then reads Not read
                for every row, and this says why once rather than on each. When it WAS read, the
                column is the statement and no callout is needed. */}
            {inventoryError && (
              <div className="callout callout-warning">
                <IconShieldAlert size={14} className="callout-icon" />
                <div>
                  <strong>The broker was not read.</strong> The Broker column reads <em>Not read</em>{' '}
                  for every row. {inventoryError} Reading it requires an Administrator and a
                  reachable credential service; the Credential column, from the database, is
                  unaffected.
                </div>
              </div>
            )}

            {loadError && (
              <div className="callout callout-danger">
                <IconShieldAlert size={14} className="callout-icon" />
                <div>{loadError}</div>
              </div>
            )}
          </div>
          )}

          {/* A failed read shows its callout alone: an empty state beside it would say nothing is
              registered when the page simply could not tell. */}
          {loading ? <LoadingState label="credentials" /> : loadError && rows.length === 0 ? null : visible.length === 0 ? (
            <EmptyState
              icon={<IconRadio size={36} />}
              filtered={rows.length > 0}
              message={<>
                No gateways registered. Create one on the Gateways page —{' '}
                <code>tutorial/README.md</code> walks through it.
              </>}
              filteredMessage="No gateway matches this filter."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Gateway</th>
                    <th title="The kind of gateway: Remote (an appliance on the plant network), Host (inside this stack), Simulated (readings generated), Playback (republishes recorded captures)">Type</th>
                    <th>MQTT username</th>
                    <th title="What the platform issued and recorded, from the database">Credential</th>
                    <th title="What the broker holds right now, read live from its Dynamic Security plugin">Broker</th>
                    <th className="row-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(g => {
                    const state = credentialState(g, g.issued_at)
                    const action = credentialAction(g)
                    return (
                      <tr key={g.id} className={g.is_archived ? 'row-archived' : undefined}>
                        <td>
                          <div>{g.name}</div>
                          {g.is_archived && <ArchivedBadge size="sm" />}
                        </td>
                        <td>
                          {/* The same four words as the Gateways and Capture pages, from the same
                              helper: a simulator and a playback gateway hold a credential for
                              different reasons. */}
                          <Badge
                            size="sm"
                            tone={gatewayTypeTone(gatewayType(g))}
                            title={gatewayTypeDescription(gatewayType(g))}
                          >
                            {gatewayTypeLabel(gatewayType(g))}
                          </Badge>
                        </td>
                        {/* The username is the wire identity, retyped into a broker node's
                            credential pair. Click-to-copy, because a transcription error is a
                            gateway whose every publish is silently dropped by the ACL. */}
                        <td>
                          <CopyableId
                            value={g.sparkplug_id}
                            label="MQTT username"
                            title={`Copy ${g.sparkplug_id} — the username this gateway authenticates as`}
                            onNotify={showToast}
                          />
                        </td>
                        <td>
                          {/* The badge carries the explanation as its title as well, so the meaning
                              is reachable from the row without the legend having to be on screen. */}
                          <Badge
                            size="sm"
                            tone={credentialStateTone(state)}
                            title={credentialStateExplanation(state, g)}
                          >
                            {credentialStateLabel(state)}
                          </Badge>
                          {(g.issued_at || g.enrolled_at) && state !== CREDENTIAL_STATES.REVOKED && (
                            <div className="cell-meta">{formatDateTime(g.issued_at || g.enrolled_at)}</div>
                          )}
                        </td>
                        {/* The live broker state beside the recorded one. The pair is the point: a
                            gateway can read No platform record and Active (issued on the host), or
                            Issued and Disabled (revoked at the broker since). */}
                        <td>{brokerBadge(brokerState(clientsByUsername.get(g.sparkplug_id), !!inventory))}</td>
                        <td className="row-actions">
                          {action === 'mint' && (
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => setCredentialForGw({
                                gateway_id: g.id, gateway_name: g.name, sparkplug_id: g.sparkplug_id,
                                // Decides which .env pairing the dialog prints. Without it a
                                // playback gateway is told to edit a Node-RED node it does not have.
                                is_shadow: g.is_shadow
                              })}
                              title="Mint a broker credential and show it once"
                            >
                              <IconLock size={13} /> Generate
                            </button>
                          )}
                          {action === 'bundle' && (
                            <button
                              className="btn btn-ghost btn-sm"
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
                          {!action && <span className="cell-meta">Restore to issue</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          </>)}

          {/* Machine identities and the broker, as separate tabs: nothing holds an identity on both
              planes. The ingestion daemon connects to the broker as `aber_ingestion` and reaches the
              database as Service_Ingestor. */}
          {section === 'identities' && (<>
          {/* Offered only when the list could be read: a caller the RPC refused would be refused
              here too, and a button that opens a dialog to fail is worse than none. The row holds
              nothing else, so it goes with the button. */}
          {!principalError && (
            <div className="filter-bar">
              <div className="filter-bar-actions">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => setCreating(true)}
                  title="Create a machine identity for a process that uses this stack through the API. It reaches the database only, never the broker, and holds no token until one is issued."
                >
                  <IconPlus size={13} /> New Machine Identity
                </button>
              </div>
            </div>
          )}

          {principalError && (
            <div className="card-body">
              <div className="callout callout-danger">
                <IconShieldAlert size={14} className="callout-icon" />
                <div>{principalError}</div>
              </div>
            </div>
          )}
          {!principalError && (principalsLoading ? <LoadingState label="machine identities" /> :
            principals.length === 0 ? (
              <EmptyState
                icon={<IconBot size={36} />}
                message="No machine identities are registered. Every account on this stack belongs to a person."
              />
            ) : (
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
                    <th className="row-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {principals.map(p => {
                    // The row carries `name` and `purpose` for an identity created from the page;
                    // the registry answers for the three a migration pinned.
                    const meta = describePrincipal(p.principal_id, p)
                    // The denylist is passed so a revoked token stops counting as active.
                    // `Date.now()` is spelled out because the third argument cannot be reached past
                    // a defaulted second.
                    const status = tokenStatus(tokens.get(p.principal_id), Date.now(), revokedJtis)
                    const revocation = revokedPrincipals.get(p.principal_id) || null
                    return (
                      <tr key={p.principal_id}>
                        {/* The purpose is a tooltip: three lines of background on a row whose other
                            columns are the answer. The dotted underline says there is something to
                            hover. */}
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            <strong className="hint-underline" title={meta.purpose}>{meta.name}</strong>
                            {/* Only a row with a name of its own can be renamed: the three pinned
                                identities are named in the registry, and the RPC refuses them. */}
                            {p.name && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-icon"
                                onClick={() => setDescribing(p)}
                                title={`Rename ${meta.name} or change its purpose`}
                                aria-label={`Describe ${meta.name}`}
                              >
                                <IconPencil size={12} />
                              </button>
                            )}
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
                            {(p.permissions || []).map(perm => (
                              <Badge key={perm} size="sm">{perm}</Badge>
                            ))}
                            {/* Stated, not assumed: `can_sign_in` is returned by the RPC rather
                                than inferred from the predicate it selected on. */}
                            {p.can_sign_in === false && <Badge size="sm" tone="success">CANNOT SIGN IN</Badge>}
                            {/* Beside the grants, because a withdrawal is a fact about the
                                identity and outranks its tokens. */}
                            {revocation && (
                              <Badge
                                size="sm"
                                tone="danger"
                                title={`Withdrawn ${formatDateTime(revocation.revoked_at)}`
                                  + (revocation.reason ? ` — ${revocation.reason}` : '')
                                  + '. Every token naming this identity is refused by the API, including any issued afterwards.'}
                              >
                                WITHDRAWN
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="cell-meta" style={{ maxWidth: '40ch' }}>
                          {permissionReach(p.permissions)}
                        </td>
                        {/* The count is the way in: an identity has N tokens and
                            `revoke_service_token()` takes a jti, so a row-level Revoke would have
                            to pick one. A dash when nothing is recorded to list. */}
                        <td>
                          {status.rows.length > 0 ? (
                            <button
                              type="button"
                              className="count-link"
                              onClick={() => setTokensFor({ principal: p, name: meta.name, status })}
                              title={`${tokenStatusDetail(status)} Click to list them and revoke one.`}
                            >
                              {status.outstanding} active
                            </button>
                          ) : (
                            <span title={tokenStatusDetail(status)}>—</span>
                          )}
                        </td>
                        {/* A button where a token is actually read, and the command everywhere
                            else. `isMintableFromPage()` decides: the two environment-key identities
                            take their key from the environment at boot, so a minted token for them
                            would be a second privileged credential nothing reads. They keep the
                            rotate command. */}
                        <td className="row-actions">
                          {isMintableFromPage(meta) ? (
                            <>
                              {/* Minting is not offered for a withdrawn identity:
                                  record_service_token_issued() refuses it. Reinstating is the
                                  action available, so it is the one shown. */}
                              {revocation ? (
                                <button
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => setRevokeIdentity({
                                    principal: p, name: meta.name, revocation, activeTokens: status.outstanding,
                                  })}
                                  title="This identity is withdrawn and cannot be issued a token. Reinstate it first — its previous tokens stay revoked."
                                >
                                  Reinstate
                                </button>
                              ) : (
                                <button
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => setMintFor({ principal: p, name: meta.name })}
                                  title="Sign a token for this identity and show it once. Recorded in the Audit Trail before it is returned, and revocable against the API afterwards."
                                >
                                  <IconLock size={13} /> Issue Token
                                </button>
                              )}
                              {/* Withdrawing is offered wherever minting is. */}
                              {!revocation && (
                                <button
                                  className="btn btn-sm btn-danger btn-danger-reveal"
                                  onClick={() => setRevokeIdentity({
                                    principal: p, name: meta.name, revocation: null, activeTokens: status.outstanding,
                                  })}
                                  title="Withdraw this identity. Every token naming it is refused by the API, including any issued afterwards — which is what makes this different from revoking tokens one at a time."
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
                                className="btn-sm"
                                title={`Copy \`${meta.mintCommand.replace('{id}', p.principal_id)}\` — the break-glass path, which works when nobody can sign in to this page.`}
                                onNotify={showToast}
                              />
                            </>
                          ) : (
                            <CopyableId
                              value={meta.mintCommand.replace('{id}', p.principal_id)}
                              label="rotate command"
                              display="Copy Command"
                              variant="button"
                              className="btn-sm"
                              // The tooltip carries the distinction the label cannot: this is `npm
                              // run keys:rotate`, because the identity's key is in the release
                              // Secret and its Deployment reads it at start.
                              title={`Copy \`${meta.mintCommand.replace('{id}', p.principal_id)}\` — this key is ${meta.secretKey || 'a key'} in the release Secret, read by the ${meta.deployment || 'worker'} Deployment at start. Rotating it, not minting a token, changes what the process presents. With --apply it patches the Secret and restarts the Deployment.`}
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
          ))}
          </>)}

          {/* The broker's own accounts, live. Every account that is not a gateway's, and any gateway
              -shaped account the repository declares as a fixture: those are created by the boot
              reconcile from the MQTT_*_USER pairs, not issued against a row. Then any gateway-shaped
              account no gateway claims, marked No gateway. */}
          {section === 'accounts' && (<>
          {inventoryLoading ? <LoadingState label="broker accounts" /> : !inventory ? (
            <EmptyState
              icon={<IconRadio size={36} />}
              message="The broker was not read, so its accounts cannot be listed."
            />
          ) : brokerAccounts.length === 0 ? (
            <EmptyState
              icon={<IconRadio size={36} />}
              message="The broker holds no platform account. Every account it has belongs to a gateway."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>MQTT username</th>
                    <th>Roles</th>
                    <th>Purpose</th>
                    <th>Broker</th>
                  </tr>
                </thead>
                <tbody>
                  {brokerAccounts.map(c => (
                    <tr key={c.username}>
                      <td>
                        <CopyableId
                          value={c.username}
                          label="MQTT username"
                          title={`Copy ${c.username}`}
                          onNotify={showToast}
                        />
                        {c.noGateway && (
                          <Badge
                            size="sm"
                            className="badge-follow"
                            title="No gateway claims this account and nothing declares it. scripts/revoke-orphaned-broker-accounts.mjs lists and disables such accounts; it never deletes one."
                          >
                            No gateway
                          </Badge>
                        )}
                      </td>
                      <td className="mono cell-meta">{(c.roles || []).join(', ') || '—'}</td>
                      <td className="cell-meta" style={{ maxWidth: '46ch' }}>
                        {c.name && <strong>{c.name}. </strong>}
                        {c.noGateway
                          ? 'Shaped like a gateway’s account, but no gateway claims it and nothing declares it.'
                          : c.purpose || 'Holds no platform role; nothing in the repository declares it.'}
                      </td>
                      <td>{brokerBadge(brokerState(c, true))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </>)}

          {section === 'roles' && (<>
          {!inventoryLoading && !inventory && (
            <div className="card-body">
              <div className="callout callout-warning">
                <IconShieldAlert size={14} className="callout-icon" />
                <div>
                  <strong>The broker was not read,</strong> so the rules cannot be shown. Each role
                  and its purpose are declared in mosquitto/dynsec-roles.json.
                </div>
              </div>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Access</th>
                  <th title="How many rules the broker reports for the role; open the role to read them">Rules</th>
                  <th>Purpose</th>
                </tr>
              </thead>
              <tbody>
                {ROLE_ENTRIES.map(entry => {
                  const live = rolesByName.get(entry.rolename)
                  const allowed = (live?.acls || []).filter(a => a.allow)
                  const writes = live ? allowed.some(a => a.acltype === 'publishClientSend') : entry.writes
                  // A count in the table and the rules in the drawer: the ingestion role alone is
                  // nine lines, and the table is for comparing roles. Only a role the broker
                  // reported opens, since there is nothing else to show. Enter or Space on the row
                  // itself toggles it as a click does; keys on a control inside are ignored.
                  const toggle = () => setOpenRole(r => (r === entry.rolename ? null : entry.rolename))
                  const opens = live ? {
                    className: `row-selectable${openRole === entry.rolename ? ' row-selected' : ''}`,
                    onClick: rowSelectHandler(toggle),
                    onKeyDown: e => {
                      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                      e.preventDefault()
                      toggle()
                    },
                    tabIndex: 0,
                    title: `Open the rules the broker holds for ${entry.rolename}`,
                  } : {}
                  return (
                    <tr key={entry.rolename} {...opens}>
                      <td className="mono">{entry.rolename}</td>
                      <td>
                        <Badge size="sm" tone={writes ? 'pending' : 'success'}>
                          {writes ? 'CAN PUBLISH' : 'READ ONLY'}
                        </Badge>
                      </td>
                      <td>{live ? allowed.length : <span className="cell-meta">Not read</span>}</td>
                      <td className="cell-meta" style={{ maxWidth: '46ch' }}>{entry.purpose}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          </>)}
        </div>
      </div>

      {/* One role at a time, beside the table it came from. */}
      {(() => {
        const entry = ROLE_ENTRIES.find(e => e.rolename === openRole) || null
        const live = entry ? rolesByName.get(entry.rolename) : null
        const acls = live?.acls || []
        const allowed = acls.filter(a => a.allow)
        const denied = acls.filter(a => !a.allow)
        const writes = allowed.some(a => a.acltype === 'publishClientSend')
        const holders = entry
          ? (inventory?.clients || []).filter(c => (c.roles || []).includes(entry.rolename)).length
          : 0
        return (
          <ContextPanel
            open={!!entry}
            onClose={() => setOpenRole(null)}
            subject="role"
            onCopy={showToast}
            title={entry?.rolename || ''}
            icon={<IconShieldCheck size={16} />}
            subtitle={entry && (
              <Badge size="sm" tone={writes ? 'pending' : 'success'}>
                {writes ? 'CAN PUBLISH' : 'READ ONLY'}
              </Badge>
            )}
            fields={entry ? [
              { label: 'Purpose', value: entry.purpose, full: true },
              {
                label: 'Held by',
                value: `${holders} account${holders === 1 ? '' : 's'}`,
                title: 'Broker accounts holding this role at the moment of the read',
              },
              ...(entry.perGateway ? [{
                label: 'Per gateway',
                value: entry.perGateway,
                mono: true,
                full: true,
                title: 'Generated when the credential is issued; it is what confines one gateway to its own edge node',
              }] : []),
            ] : []}
          >
            {entry && (
              <div>
                <div className="context-panel-section-label">Rules</div>
                {/* The plugin's own rules, verb and topic. Not a paraphrase: someone comparing this
                    against the policy should read the same topics on both sides. */}
                {allowed.length === 0 ? (
                  <div className="cell-meta">The broker reports no rule for this role.</div>
                ) : (
                  <ul className="mono" style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '11px' }}>
                    {allowed.map((a, i) => (
                      <li key={i} style={{ padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ color: 'var(--text-muted)', display: 'inline-block', minWidth: '9ch' }}>{ACL_VERB[a.acltype] || a.acltype}</span>
                        {a.topic}
                      </li>
                    ))}
                  </ul>
                )}
                {denied.length > 0 && (
                  <div className="cell-meta" style={{ fontSize: '11px', marginTop: '8px' }}>
                    {denied.length} explicit den{denied.length === 1 ? 'ial' : 'ials'} not listed; the policy denies by default.
                  </div>
                )}
              </div>
            )}
          </ContextPanel>
        )
      })()}

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
          inventory so the mint appears in the badge. `load()` refreshes every read. */}
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

      {/* Create, then straight into the token dialog for the new row: the id comes from the RPC's
          return and the name from the dialog that sent it, rather than waiting for the reload.
          `load()` runs as well so the row is listed behind the dialog. */}
      {creating && (
        <ServicePrincipalCreateModal
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            load()
            setMintFor({
              principal: { principal_id: created.principal_id, permissions: created.permissions, can_sign_in: false },
              name: created.name,
            })
          }}
          showToast={showToast}
        />
      )}

      {describing && (
        <ServicePrincipalDescribeModal
          principal={describing}
          onClose={() => setDescribing(null)}
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
