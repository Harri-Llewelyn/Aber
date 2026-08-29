import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import CopyableId from '../common/CopyableId'
import { GatewayBundleModal } from '../modals/GatewayBundleModal'
import { GatewayCredentialModal } from '../modals/GatewayCredentialModal'
import { IconArchive, IconDownload, IconLock, IconRefreshCw, IconShieldAlert } from '../common/Icons'
import {
  CREDENTIAL_STATES,
  credentialAction,
  credentialState,
  credentialStateExplanation,
  credentialStateLabel,
  credentialStateTone,
} from '../../utils/credentialState'
import {
  BROKER_PRINCIPALS,
  GATEWAY_ACL_PATTERN,
  describePrincipal,
  roleReach,
  tokenStatus,
  tokenStatusDetail,
  tokenStatusLabel,
  tokenStatusTone,
} from '../../utils/serviceIdentities'

/**
 * Access Control — broker credentials, and where they came from.
 *
 * =================================================================================================
 * THE GAP THIS CLOSES, in the words of Machine Identities in supabase/README.md: "the only way to see what credentials exist today is
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
  const [principals, setPrincipals] = useState([])
  const [tokens, setTokens] = useState(() => new Map())
  // ITS OWN ERROR, not folded into loadError. The two reads have DIFFERENT authority -- gateway
  // credentials accept Shopfloor_Manager, service principals are Administrator-only (0042) -- so a
  // single error state would blame the whole page for a refusal that applies to one section.
  const [principalError, setPrincipalError] = useState(null)

  const load = useCallback((isInitial = false) => {
    if (isInitial) setLoading(true)
    api.listGatewayCredentials()
      .then(d => { setRows(d); setLoadError(null); setLoading(false) })
      .catch(e => { setLoadError(e?.message || 'Could not read gateway credentials.'); setLoading(false) })

    // NOT AWAITED WITH THE OTHER, and not allowed to fail the page. This section is supplementary:
    // an Administrator who can see it should, and everyone else should still get the credential
    // inventory rather than a blank tab.
    api.listServicePrincipals()
      .then(d => { setPrincipals(d); setPrincipalError(null) })
      .catch(e => { setPrincipals([]); setPrincipalError(e?.message || 'Could not list service principals.') })

    // ITS OWN FAILURE, SWALLOWED TO AN EMPTY MAP. `digital_thread:read` is a separate permission
    // from listing principals, and a caller without it should still see the identities -- with
    // every one reading "No token on record", which is exactly what that state means from where
    // they stand. Blanking the section instead would hide the identities over a missing history.
    api.listServiceTokens()
      .then(setTokens)
      .catch(() => setTokens(new Map()))
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

  const archivedCount = useMemo(() => rows.filter(r => r.is_archived).length, [rows])

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
        {/* ONE CARD FOR ONE LIST -- title, description, controls and rows -- which is the Schemas
            page's shape and the one the rest of the app uses. This was three stacked cards for a
            single table: three borders, three sets of padding, and a heading separated from the
            rows it describes by a control bar in its own box.

            THE PAGE STILL STATES ITS OWN LIMIT BEFORE THE FIRST ROW, which is the part that has to
            survive the tidying: somebody arriving to answer "does this gateway have a credential"
            needs to know what this page can and cannot see BEFORE they read a row, not after they
            have acted on one. */}
        {/* THE REGISTERED SCHEMAS SHAPE, which is the one the rest of the app uses: a `.card-header`
            carrying the title, its count and the card's own actions on one line; the description
            full width beneath it; then the rows. This was a title stacked over two paragraphs over a
            filter bar, which spent four bands of vertical space before the first row and put the
            list's totals ABOVE the list they summarise. */}
        <div className="card">
          <div className="card-header">
            <h3 className="section-title">
              Broker credentials{' '}
              {/* FILTERED OF TOTAL when a filter is on, the same as the schema registry -- a
                  narrowed list would otherwise read as a short one, which is the wrong thing to
                  believe about an inventory of who can reach your broker. */}
              <span
                className="section-count"
                title={visible.length === rows.length
                  ? `${rows.length} gateway${rows.length === 1 ? '' : 's'}`
                  : `${visible.length} of ${rows.length} gateways shown`}
              >
                {visible.length === rows.length ? rows.length : `${visible.length}/${rows.length}`}
              </span>
            </h3>

            {/* The card's actions, in the header of the card they act on. The archived toggle is
                the Devices page's "Needs attention" control -- a btn-sm switching between
                btn-primary and btn-ghost, carrying its own count -- rather than a bare checkbox,
                which was the only control of its kind in the app and read as a form field. */}
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
            Every gateway authenticates to the broker as its own Sparkplug ID — the ACL pins the
            topic’s edge-node segment to the connecting username, so no two gateways can share a
            connection. This page shows what the platform has issued, and gives you the two ways to
            issue one.
          </p>

          {/* A SHAPE AS WELL AS A COLOUR. This was a red paragraph, which is the weakest form the
              warning can take: colour alone carries it, so it is invisible to a reader who cannot
              distinguish it and reads as mere emphasis to everyone else. The tint is deliberately
              subtle -- this is a standing property of the page, not an error that has just
              happened, and a full-strength banner that is always present is one people learn to
              look past. */}
          <div className="callout callout-warning">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>
              <strong>This is not an inventory of the broker.</strong> Mosquitto’s account file can
              only be added to, never read back, so a gateway showing <em>No platform record</em> may
              still hold a working credential — the ones <code>npm run provision:gateways</code>
              {' '}creates are issued outside the dashboard and leave no record here.
            </div>
          </div>

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
                    {/* THE USERNAME IS THE WIRE IDENTITY, not a display name -- and it is the one
                        value on this page an operator retypes elsewhere, into a broker node's
                        credential pair. Click-to-copy for the same reason every other identifier in
                        the app has it: a 24-character string transcribed by eye is a gateway that
                        authenticates and then has every publish silently dropped by the ACL. */}
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

          {/* A SUMMARY BELONGS AFTER THE THING IT SUMMARISES. These sat in a filter bar above the
              table, which read as a filter -- four numbers beside two buttons, in the band where
              every other page puts controls -- and asked the reader to hold four totals in their
              head before seeing a single row.

              Each count and its label is ONE pill so the pair cannot be split across a wrap: as
              loose text, "0 issued 0 bundle outstanding 0 revoked" scans as six tokens rather than
              three facts. */}
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

        {/* =========================================================================================
            SERVICE IDENTITIES -- the second half of the page, and the half that is TWO LISTS rather
            than one. Nothing holds an identity on both planes, which is the fact worth showing: the
            ingestion daemon connects to the broker as `factoryplus_ingestion` and reaches the
            database with the service-role key, which is not an identity at all.
            ========================================================================================= */}
        {/* A HEADING, NOT A CARD. It holds one sentence and introduces the two cards beneath it, so
            wrapping it in a card of its own gave the page a third border, a third padding, and a
            band that looked like a section with nothing in it.

            It also carried `.settings-preamble-title`, which is small-caps -- a THIRD title
            treatment on a page that already had `.section-title` above and bold 13px text below.
            One page, one way of naming a section. */}
        <div style={{ margin: '24px 4px 12px' }}>
          <h3 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <IconLock size={15} /> Service identities
          </h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '6px 0 0' }}>
            The non-human clients that can reach this stack. They are two separate lists because they
            live on two separate planes — a database identity is a role, a broker identity is an ACL
            entry, and nothing here holds both.
          </p>
        </div>

        {/* THE SAME COLUMN RHYTHM AS THE CREDENTIALS TABLE ABOVE, because it is the same kind of
            question: an identity, what it holds, what that reaches, and where it comes from. These
            were stacked prose, which meant every row repeated the label words ("The identity…",
            "Reaches:", "Token minted by") that one header says once. */}
        {/* THE DIRECTORY'S GROUPED-CARD SHAPE -- `.card` > `.card-header` > title + count > rows --
            which is what every other multi-table page in the app uses. This was a bold 13px div
            with hand-picked padding, so the same page named one section with `.section-title` and
            another with an improvised style. */}
        <div className="card" style={{ marginTop: '12px' }}>
          <div className="card-header">
            <h3 className="section-title">
              Database principals{' '}
              <span
                className="section-count"
                title={`${principals.length} machine ${principals.length === 1 ? 'identity' : 'identities'} that cannot sign in`}
              >
                {principals.length}
              </span>
            </h3>
          </div>

          <div className="card-body">
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: 0 }}>
              The identities the stack's own processes authenticate as. Each has no email and no
              password, so none of them can sign in — they exist to be named by a token, and every
              write they make goes through a gate that checks which one is calling. They hold
              <strong> Operator</strong> and can write nothing directly, which is what makes the
              gates the whole of their authority rather than a convention they follow.
            </p>
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
                  {/* ITS OWN COLUMN, matching how the Schemas page treats a schema UUID. It was
                      stacked under the name, which made it read as a subtitle rather than as the
                      value a JWT's `sub` claim has to equal. */}
                  <th>Principal ID</th>
                  <th>Holds</th>
                  <th>Reaches</th>
                  {/* WHAT IS OUTSTANDING, not when it was last minted -- see tokenStatus(). A
                      re-mint adds a live credential rather than replacing one, and nothing here
                      can revoke either. */}
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
                  const status = tokenStatus(tokens.get(p.principal_id))
                  return (
                    <tr key={p.principal_id}>
                      {/* THE PURPOSE IS A TOOLTIP NOW. It is three lines of background on a row whose
                          other four columns are the answer -- what it holds, what that reaches, and
                          where its token comes from. Read once and then in the way every time after,
                          which is what a tooltip is for.

                          The dotted underline is what says there is something to hover. A title on a
                          plain span is invisible, and an affordance nobody can see is not one. */}
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
                          {(p.roles || []).map(r => (
                            <span key={r} className="badge badge-neutral" style={{ fontSize: '11px' }}>{r}</span>
                          ))}
                          {/* STATED, NOT ASSUMED. It is the property that makes listing these safe,
                              and 0042 returns it rather than letting the page infer it from the
                              predicate it selected on. */}
                          {p.can_sign_in === false && (
                            <span className="badge badge-ok" style={{ fontSize: '11px' }}>CANNOT SIGN IN</span>
                          )}
                        </div>
                      </td>
                      <td style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '40ch' }}>
                        {roleReach(p.roles)}
                      </td>
                      <td>
                        <span
                          className={`badge badge-${tokenStatusTone(status)}`}
                          style={{ fontSize: '11px' }}
                          title={tokenStatusDetail(status)}
                        >
                          {tokenStatusLabel(status)}
                        </span>
                        <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px', maxWidth: '34ch' }}>
                          {tokenStatusDetail(status)}
                        </div>
                      </td>
                      {/* THE COMMAND, NOT A BUTTON. Minting stays on the host deliberately (roadmap
                          §13): these tokens cannot be revoked, so issuing one should cost more than
                          a click. What the page can do is remove the part that is error-prone --
                          transcribing a UUID -- so the whole line is copyable. */}
                      <td>
                        <CopyableId
                          value={`node scripts/mint-mcp-token.mjs --principal ${p.principal_id}`}
                          label="mint command"
                          title="Copy the command. It runs on the host that has .env, records the issue in the Digital Thread, and only then prints the token."
                          onNotify={showToast}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          )}

          {/* WHAT THIS INVENTORY DOES NOT SEE, ON ITS FACE — AND THE GAP IS NARROWER NOW (#101).

              This note used to say the two worker keys could NEVER appear here, and that was true
              of a ten-year token: record_service_token_issued() refuses anything past
              service_token_max_days(), because that ceiling exists precisely for credentials nobody
              can take back. Bounding them at 90 days made them recordable, and
              `scripts/rotate-service-keys.mjs` records each re-signing before it writes it.

              WHAT REMAINS UNCOVERED IS THE FIRST PAIR ONLY, and the reason is unchanged and
              unfixable by recording harder: `npm run setup` runs BEFORE this database exists, so
              there is nothing to record into. A stack that has never rotated therefore shows
              nothing for these two -- which is now a statement about that stack rather than about
              the platform, and it names the command that closes it.

              Stating the gap is not a consolation prize: this inventory is the compensating control
              README.md's Accepted risks section names, and a control whose coverage is unstated is
              one an operator will over-trust. */}
          <div className="card-footer" style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            <strong>What this list covers.</strong> Tokens minted by{' '}
            <code>scripts/mint-mcp-token.mjs</code> and re-signings by{' '}
            <code>npm run keys:rotate</code>, each of which records the issue before releasing it.
            The <strong>first</strong> <code>SUPABASE_INGESTION_KEY</code> and{' '}
            <code>SUPABASE_PLAYBACK_KEY</code> are not here and cannot be:{' '}
            <code>npm run setup</code> signs them before this database exists, so there is nothing
            to record into. Rotating once brings both under this list. They are live whether or not
            they appear here, and <code>npm run keys:check</code> reports what is in{' '}
            <code>.env</code> either way.
          </div>
        </div>

        <div className="card" style={{ marginTop: '12px' }}>
          <div className="card-header">
            <h3 className="section-title">
              Broker principals{' '}
              {/* THE PATTERN COUNTS. It is not an account -- there is no principal by that name --
                  but it IS a rule in the same file granting the same kind of access, and a count
                  that excluded it would disagree with the rows a reader can see. */}
              <span
                className="section-count"
                title={`${BROKER_PRINCIPALS.length} named principals and the pattern every gateway connects under`}
              >
                {BROKER_PRINCIPALS.length + 1}
              </span>
            </h3>
          </div>
          {/* DECLARED IN THE REPOSITORY, NOT FETCHED, and the page says so rather than implying a
              live read. Mosquitto has no API that lists its principals; check-docs-drift asserts
              this list against mosquitto.acl, in both directions and including the topic rules. */}
          <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '12px 20px 0' }}>
            Read from <code>mosquitto.acl</code> in the repository — the broker has no API that lists
            these, so they are declared alongside the file and checked against it at build time.
          </p>
          <div className="table-wrap" style={{ marginTop: '12px' }}>
          <table>
            <thead>
              <tr>
                <th>Principal</th>
                <th>Access</th>
                <th>Topic rules</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {BROKER_PRINCIPALS.map(bp => (
                <tr key={bp.username}>
                  <td className="mono" style={{ fontSize: '12px' }}>{bp.username}</td>
                  <td>
                    <span className={`badge badge-${bp.writes ? 'pending' : 'ok'}`} style={{ fontSize: '11px' }}>
                      {bp.writes ? 'CAN PUBLISH' : 'READ ONLY'}
                    </span>
                  </td>
                  {/* THE ACL'S OWN STRINGS, not a paraphrase: somebody comparing this page against
                      the file should be reading the same text on both sides. */}
                  <td className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'pre-line' }}>
                    {bp.topics.join('\n')}
                  </td>
                  <td style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '46ch' }}>{bp.purpose}</td>
                </tr>
              ))}
              {/* A ROW, NOT A TRAILING BLOCK. It is not a principal -- there is no account by this
                  name -- but it IS an entry in the same file granting the same kind of thing, and
                  rendering it as an orphaned paragraph made it read as a footnote rather than as
                  the rule most of the fleet actually connects under. The badge says what it is. */}
              <tr>
                <td style={{ fontWeight: 600 }}>Every gateway</td>
                <td>
                  <span className="badge badge-neutral" style={{ fontSize: '11px' }}>ACL PATTERN</span>
                </td>
                <td className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  pattern {GATEWAY_ACL_PATTERN.pattern}
                </td>
                <td style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '46ch' }}>
                  {GATEWAY_ACL_PATTERN.purpose}
                </td>
              </tr>
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
    </div>
  )
}
