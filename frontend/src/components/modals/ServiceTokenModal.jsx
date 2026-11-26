import React, { useCallback, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Callout } from '../common/Callout'
import { CopyBlock, CopyField } from '../common/CopyField'
import { Modal } from '../common/Modal'
import { IconLock } from '../common/Icons'
import { SegmentedControl } from '../common/SegmentedControl'
import { StaticField } from '../common/StaticField'
import { formatDate } from '../../utils/format'
import { i3xBaseUrl, i3xClientSetups } from '../../utils/i3xClientSetups'
import { i3xUrl } from '../../constants'
import { identityUrl } from '../../routes'
import { REVOCATION_REACHES, SIGNATURE_ONLY } from '../../utils/revocationScope'

/** Mirrors `service_token_max_days()`. The database refuses anything past it; this is the shortlist. */
const TTL_CHOICES = [7, 30, 90]
const DEFAULT_TTL = 30

/** What the Connect section's Authentication row says: the scheme, never the publishable key. */
const AUTHENTICATION = 'Bearer token'

/**
 * How to connect a client that reads through the i3X server, with the minted token in each setup.
 * `origin` is VITE_I3X_URL; blank leaves out the address and every setup, since each names it.
 */
function ConnectSection({ origin, token }) {
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
          <CopyField
            id="svc-connect-server"
            label="i3X Server"
            value={i3xBaseUrl(origin)}
            copyLabel="i3X server address"
          />
        )}
        {/* Plain text, no copy button: a client offers it as a choice, such as Explorer's dropdown. */}
        <StaticField label="Authentication" value={AUTHENTICATION} className="token-connect-text" />
      </div>
      {setup ? (
        <CopyBlock
          text={setup.text}
          copyLabel="Copy Setup"
          head={(
            <SegmentedControl
              label="Client"
              options={setups.map(s => ({ id: s.id, label: s.label }))}
              value={setup.id}
              onChange={setClient}
            />
          )}
        >
          {setup.hint}
        </CopyBlock>
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

  const expiresOn = minted ? formatDate(minted.expires_at) : null
  // Without telemetry:read an identity sees nothing through i3X, so a setup would only mislead.
  const readsTelemetry = (principal.permissions || []).includes('telemetry:read')

  const confirming = step === 'confirm'

  return (
    <Modal
      title="Issue Token"
      subject={principalName}
      icon={<IconLock size={18} />}
      size="lg"
      busy={busy}
      onClose={onClose}
      lead="Issues a long-lived token for this identity."
      error={confirming ? error : null}
      dismiss={confirming ? 'Cancel' : 'Done'}
      footer={confirming ? (
        <ActionButton
          pending={busy}
          pendingLabel="Issuing…"
          className="btn btn-primary"
          onClick={mint}
          title="Sign a token and show it once"
        >
          <IconLock size={14} /> Issue Token
        </ActionButton>
      ) : null}
    >
      {confirming && (
        <>
          <Callout tone="warning">
            {/* The one fact that differs from the broker credential modal, said first: minting
                to rotate would leave two live credentials. */}
            <div>
              This <strong>adds</strong> a credential. It does <strong>not</strong> replace any
              token this identity already holds — those keep working until they expire or are
              revoked individually.
            </div>
            <div>The token is shown <strong>once</strong> and cannot be recovered.</div>
          </Callout>

          <div className="form-group">
            <label className="form-label" htmlFor="svc-token-ttl">Valid For</label>
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
            {/* Why the ceiling exists: for the services that check only the signature, the expiry
                is the only bound. */}
            <div className="form-hint">
              90 days is the ceiling. Prefer the shortest that works: revoking stops a token at
              {' '}{REVOCATION_REACHES}, but {SIGNATURE_ONLY} check only its signature, so for them
              the expiry is the only limit.
            </div>
          </div>
        </>
      )}

      {step === 'reveal' && minted && (
        <>
          <Callout tone="warning" title="Copy this now — it is not shown again.">
            Closing this dialog discards the token. Nothing in the stack keeps a copy, so
            minting another is the only way back — and that adds a credential rather than
            replacing this one.
          </Callout>

          <CopyField
            id="svc-token"
            label="Token"
            value={minted.token}
            hint={`Expires ${expiresOn}. Give it to the client that will present it, as its bearer token.`}
          />

          {/* The jti is the handle for revoking this token; without it an operator must find the
              TOKEN_MINTED row in the Audit Trail. */}
          <CopyField
            id="svc-token-jti"
            label="Token ID (jti)"
            value={minted.jti}
            copyLabel="token ID"
            hint={<>
              Keep this. It is what identifies this token for revocation, and it is recorded in
              the Audit Trail — unlike the token itself.
            </>}
          />

          {/* The scope comes from the response (`revocation_scope`, set by mint-service-token), not
              from a literal here, so this cannot drift from what revocation covers. */}
          {minted.revocation_scope === 'postgrest' && (
            <Callout tone="info">
              Revoking this token stops it at <strong>{REVOCATION_REACHES}</strong> from their
              next request. {SIGNATURE_ONLY} verify the signature themselves and will keep
              accepting it until {expiresOn}.
            </Callout>
          )}

          {/* Built from the minted token in this component's state, so the setups go with it. */}
          {readsTelemetry && (
            <ConnectSection origin={i3xUrl()} token={minted.token} />
          )}
        </>
      )}
    </Modal>
  )
}
