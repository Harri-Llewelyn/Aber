import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { copyText } from '../common/CopyableId'
import { Modal } from '../common/Modal'
import { IconCheck, IconCopy, IconLock, IconShieldAlert } from '../common/Icons'
import { SegmentedControl } from '../common/SegmentedControl'
import { formatDate } from '../../utils/format'
import { i3xBaseUrl, i3xClientSetups } from '../../utils/i3xClientSetups'
import { i3xUrl } from '../../constants'
import { identityUrl } from '../../routes'
import { Tooltip } from '../common/Tooltip'

const COPY_FEEDBACK_MS = 1600
/** Said in the dialog and in a toast when the browser refuses a copy. */
const COPY_REFUSED = 'Could not reach the clipboard — select the value and copy it.'

/** Mirrors `service_token_max_days()`. The database refuses anything past it; this is the shortlist. */
const TTL_CHOICES = [7, 30, 90]
const DEFAULT_TTL = 30

/** What the Connect section's Authentication row says: the scheme, never the publishable key. */
const AUTHENTICATION = 'Bearer token'

/** One value of the Connect section, read-only, with its copy button. */
function ConnectValue({ id, label, value, copyLabel, copy, copied }) {
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={id}>{label}</label>
      <div className="gateway-copy-row">
        <input id={id} className="form-control mono" readOnly value={value} />
        <Tooltip text={`Copy ${copyLabel}`}>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => copy(id, value)}
            aria-label={`Copy ${copyLabel}`}
          >
            {copied === id ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

/**
 * How to connect a client that reads through the i3X server, with the minted token in each setup.
 * `origin` is VITE_I3X_URL; blank leaves out the address and every setup, since each names it.
 */
function ConnectSection({ origin, token, copy, copied }) {
  const setups = origin ? i3xClientSetups(origin, token) : []
  const [client, setClient] = useState(setups[0]?.id)
  const setup = setups.find(s => s.id === client) || setups[0]

  return (
    <div className="form-group token-connect" role="group" aria-labelledby="svc-token-connect">
      <div id="svc-token-connect" className="form-label">Connect</div>
      <div className="form-hint">
        For a client that reads through the i3X server. Send the token as a bearer token. The
        publishable key is refused.
      </div>
      <div className="gateway-settings">
        {origin && (
          <ConnectValue
            id="svc-connect-server"
            label="i3X server"
            value={i3xBaseUrl(origin)}
            copyLabel="i3X server address"
            copy={copy}
            copied={copied}
          />
        )}
        {/* Plain text, no copy button: a client offers it as a choice, such as Explorer's dropdown. */}
        <div className="form-group">
          <div className="form-label">Authentication</div>
          <div className="token-connect-text">{AUTHENTICATION}</div>
        </div>
      </div>
      {setup ? (
        <>
          <div className="gateway-block-head">
            <SegmentedControl
              label="Client"
              options={setups.map(s => ({ id: s.id, label: s.label }))}
              value={setup.id}
              onChange={setClient}
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(`setup-${setup.id}`, setup.text)}>
              {copied === `setup-${setup.id}`
                ? <><IconCheck size={12} /> Copied</>
                : <><IconCopy size={12} /> Copy Setup</>}
            </button>
          </div>
          <pre className="mono gateway-code gateway-code-wrap">{setup.text}</pre>
          <div className="form-hint">{setup.hint}</div>
        </>
      ) : (
        <div className="form-hint">
          This dashboard does not know the site’s i3X server address, so no client setup is shown.
        </div>
      )}
    </div>
  )
}

/**
 * Mint a long-lived token for a machine identity and show it once. This exists because revocation
 * does: `revoke_service_token()` denylists a jti and `auth_pre_request()` refuses it on every
 * PostgREST request after. If that half is removed, this goes with it.
 *
 * No type-the-name confirmation, unlike GatewayCredentialModal: nothing is destroyed here, since a
 * second token is a second credential and the first keeps working. What the operator must learn
 * instead is that a mint adds rather than replaces.
 *
 * The token lives in this component's state until the modal closes: not in a toast, the URL or
 * `audit_trail`, which records the jti, expiry and roles only.
 */
export function ServiceTokenModal({ principal, principalName, onClose, showToast }) {
  const [step, setStep] = useState('confirm')
  const [days, setDays] = useState(DEFAULT_TTL)
  const [minted, setMinted] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(null)
  const [copyFailed, setCopyFailed] = useState(false)

  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const mint = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.mintServiceToken(principal.principal_id, days)
      setMinted(result)
      setStep('reveal')
      showToast?.(`Token issued for ${principalName}`, 'success', { to: identityUrl(principalName) })
    } catch (err) {
      // The step is not advanced, matching GatewayCredentialModal: the edge function discards an
      // unrecorded token, so a failure here means no credential was created.
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [principal, principalName, days, showToast])

  const copy = useCallback(async (label, value) => {
    const ok = await copyText(value)
    setCopied(ok ? label : null)
    setCopyFailed(!ok)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
    if (!ok) showToast?.(COPY_REFUSED, 'error')
  }, [showToast])

  const close = useCallback(() => onClose(), [onClose])

  const expiresOn = minted ? formatDate(minted.expires_at) : null
  // Without telemetry:read an identity sees nothing through i3X, so a setup would only mislead.
  const readsTelemetry = (principal.permissions || []).includes('telemetry:read')

  const confirming = step === 'confirm'

  return (
    <Modal
      title={`Token for “${principalName}”`}
      size="lg"
      onClose={close}
      error={confirming ? error : copyFailed ? COPY_REFUSED : null}
      footer={confirming ? (
        <>
          <button className="btn btn-ghost" onClick={close}>Cancel</button>
          <ActionButton
            pending={busy}
            pendingLabel="Issuing…"
            className="btn btn-primary"
            onClick={mint}
            title="Sign a token and show it once"
          >
            <IconLock size={14} /> Issue Token
          </ActionButton>
        </>
      ) : (
        <button className="btn btn-primary" onClick={close}>Done</button>
      )}
    >
      {confirming && (
        <>
          <div className="callout callout-warning">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>
              <strong>Issue a long-lived token for this identity?</strong>
              {/* The one fact that differs from the broker credential modal, said first: minting
                  to rotate would leave two live credentials. */}
              <div>
                This <strong>adds</strong> a credential. It does <strong>not</strong> replace any
                token this identity already holds — those keep working until they expire or are
                revoked individually.
              </div>
              <div>The token is shown <strong>once</strong> and cannot be recovered.</div>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="svc-token-ttl">Valid for</label>
            <select
              id="svc-token-ttl"
              className="form-control"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {TTL_CHOICES.map(d => (
                <option key={d} value={d}>{d} days</option>
              ))}
            </select>
            {/* Why the ceiling exists: revocation reaches PostgREST and nothing else, so for the
                other services the expiry is the only bound. */}
            <div className="form-hint">
              90 days is the ceiling. Prefer the shortest that works: revoking reaches the API
              only, so for storage, realtime, the edge functions and Studio the expiry is the only
              limit.
            </div>
          </div>
        </>
      )}

      {step === 'reveal' && minted && (
        <>
          <div className="callout callout-warning">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>
              <strong>Copy this now — it is not shown again.</strong>
              <div>
                Closing this dialog discards the token. Nothing in the stack keeps a copy, so
                minting another is the only way back — and that adds a credential rather than
                replacing this one.
              </div>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Token</label>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input className="form-control mono" readOnly value={minted.token} />
              <Tooltip text="Copy token">
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => copy('token', minted.token)}
                  aria-label="Copy token"
                >
                  {copied === 'token' ? <IconCheck size={13} /> : <IconCopy size={13} />}
                </button>
              </Tooltip>
            </div>
            <div className="form-hint">
              Expires {expiresOn}. Give it to the client that will present it, as its bearer token.
            </div>
          </div>

          <div className="form-group">
            {/* The jti is the handle for revoking this token; without it an operator must find the
                TOKEN_MINTED row in the Audit Trail. */}
            <label className="form-label">Token ID (jti)</label>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input className="form-control mono" readOnly value={minted.jti} />
              <Tooltip text="Copy token ID">
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => copy('jti', minted.jti)}
                  aria-label="Copy token ID"
                >
                  {copied === 'jti' ? <IconCheck size={13} /> : <IconCopy size={13} />}
                </button>
              </Tooltip>
            </div>
            <div className="form-hint">
              Keep this. It is what identifies this token for revocation, and it is recorded in
              the Audit Trail — unlike the token itself.
            </div>
          </div>

          {/* The scope comes from the response (`revocation_scope`, set by mint-service-token), not
              from a literal here, so this cannot drift from what revocation covers. */}
          {minted.revocation_scope === 'postgrest' && (
            <div className="callout">
              <IconShieldAlert size={14} className="callout-icon" />
              <div>
                Revoking this token stops it reaching <strong>the API</strong>. Storage, realtime,
                the edge functions and Studio verify the signature independently and will keep
                accepting it until {expiresOn}.
              </div>
            </div>
          )}

          {/* Built from the minted token in this component's state, so the setups go with it. */}
          {readsTelemetry && (
            <ConnectSection origin={i3xUrl()} token={minted.token} copy={copy} copied={copied} />
          )}
        </>
      )}
    </Modal>
  )
}
