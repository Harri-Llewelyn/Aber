import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { copyText } from '../common/CopyableId'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { IconCheck, IconCopy, IconLock, IconShieldAlert, IconX } from '../common/Icons'

const COPY_FEEDBACK_MS = 1600

/** Mirrors `service_token_max_days()`. The database refuses anything past it; this is the shortlist. */
const TTL_CHOICES = [7, 30, 90]
const DEFAULT_TTL = 30

/**
 * Mint a long-lived token for a service principal and show it exactly once.
 *
 * =================================================================================================
 * THIS BUTTON WAS REFUSED ONCE, AND WHAT CHANGED IS NOT THE UI
 *
 * The revocable-tokens roadmap item -- since shipped, so named rather than numbered -- recorded the
 * refusal and quoted the reason: *"technically neat, and it would have made an unrevocable
 * credential a button press with a tidy audit trail of a thing nobody can undo.
 * Solving the wrong half well is worse than not solving it, because the clean implementation reads
 * as safety."* The objection was never effort, and it was never the screen. It was that the product
 * would be handing out credentials it had no way to withdraw.
 *
 * 0074 built the withdrawal -- `revoke_service_token()` denylists a jti, and `auth_pre_request()`
 * refuses it on every PostgREST request after that. So this exists now because the other half does,
 * and if that half is ever removed this one must go with it.
 *
 * =================================================================================================
 * WHY THERE IS NO TYPE-THE-NAME CONFIRMATION, UNLIKE GatewayCredentialModal
 *
 * That modal confirms unconditionally because a broker holds ONE password per username, so minting
 * always REPLACES -- possibly one a running Node-RED is holding, which then fails silently. The
 * confirmation is what stands between "generate a credential" and "take a cell offline".
 *
 * NOTHING IS DESTROYED HERE. A second token is a second credential; the first keeps working until
 * it expires or is revoked. There is no running consumer to break, so a barrier shaped like that
 * one would be theatre -- and worse than theatre, because a confirmation that never protects
 * anything teaches an operator to type through the ones that do.
 *
 * What this screen owes the operator instead is the fact they will act on: that a mint ADDS rather
 * than replaces, which is the opposite of what the neighbouring modal does and the single most
 * likely thing to be assumed wrong.
 *
 * =================================================================================================
 * THE TOKEN IS NEVER PUT ANYWHERE IT COULD BE READ BACK
 *
 * Not in a toast, not in the URL, and not in `digital_thread` -- 0043 records the jti, the expiry
 * and the roles, and never the token itself, because that table is append-only and readable by
 * anyone holding the audit lane. It lives in this component's state until the modal closes and
 * then it is gone: the signature is reproducible only from JWT_SECRET, which is held by the edge
 * runtime and is not reachable from a browser or from SQL.
 */
export function ServiceTokenModal({ principal, principalName, onClose, showToast }) {
  const [step, setStep] = useState('confirm')
  const [days, setDays] = useState(DEFAULT_TTL)
  const [minted, setMinted] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(null)

  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const mint = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.mintServiceToken(principal.principal_id, days)
      setMinted(result)
      setStep('reveal')
      showToast?.(`Token issued for ${principalName}`, 'success')
    } catch (err) {
      // THE STEP IS NOT ADVANCED, matching GatewayCredentialModal. Nothing was issued, and dropping
      // the operator onto an empty reveal screen would imply a token exists that they failed to
      // catch. The edge function discards an unrecorded token rather than returning it, so a
      // failure here genuinely means no credential was created.
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [principal, principalName, days, showToast])

  const copy = useCallback(async (label, value) => {
    const ok = await copyText(value)
    setCopied(ok ? label : null)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
    if (!ok) showToast?.('Could not reach the clipboard — select the value and copy it.', 'error')
  }, [showToast])

  const close = useCallback(() => onClose(), [onClose])
  useEscapeKey(close, true)

  const expiresOn = minted ? new Date(minted.expires_at).toLocaleDateString() : null

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Service principal token">
      <div className="modal modal-lg">
        <div className="modal-header-row">
          <div className="modal-title" style={{ marginBottom: 0 }}>
            Token for “{principalName}”
          </div>
          <button className="btn btn-ghost btn-icon" onClick={close} title="Close">
            <IconX size={14} />
          </button>
        </div>

        {step === 'confirm' && (
          <>
            <div className="form-group" style={{ fontSize: '13px' }}>
              <strong style={{ color: 'var(--warning-text)' }}>
                <IconShieldAlert size={13} /> Issue a long-lived token for this identity?
              </strong>
              <div style={{ color: 'var(--text-muted)', marginTop: '6px' }}>
                {/* THE ONE FACT THAT DIFFERS FROM THE BROKER CREDENTIAL MODAL, said first. An
                    operator who has used that dialog will assume this replaces, and act on the
                    assumption by minting to "rotate" — leaving two live credentials. */}
                This <strong>adds</strong> a credential. It does <strong>not</strong> replace any
                token this identity already holds — those keep working until they expire or are
                revoked individually.
                <div style={{ marginTop: '6px' }}>
                  The token is shown <strong>once</strong> and cannot be recovered.
                </div>
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
              {/* WHY THE CEILING EXISTS, rather than just what it is. Revocation reaches PostgREST
                  and nothing else, so for the other four services the expiry is still the only
                  bound — which is exactly why a shorter one is worth choosing. */}
              <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
                90 days is the ceiling. Prefer the shortest that works: revoking reaches the API
                only, so for storage, realtime and the edge functions the expiry is the only limit.
              </div>
            </div>

            {error && (
              <div className="form-group" style={{ color: 'var(--danger-text)', fontSize: '12px' }}>
                <IconShieldAlert size={12} /> {error}
              </div>
            )}

            <div className="modal-actions">
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
            </div>
          </>
        )}

        {step === 'reveal' && minted && (
          <>
            <div className="form-group" style={{ fontSize: '13px' }}>
              <strong style={{ color: 'var(--warning-text)' }}>
                <IconShieldAlert size={13} /> Copy this now — it is not shown again.
              </strong>
              <div style={{ color: 'var(--text-muted)', marginTop: '6px' }}>
                Closing this dialog discards the token. Nothing in the stack keeps a copy, so
                minting another is the only way back — and that adds a credential rather than
                replacing this one.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Token</label>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input className="form-control mono" readOnly value={minted.token} />
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => copy('token', minted.token)}
                  title="Copy token"
                >
                  {copied === 'token' ? <IconCheck size={13} /> : <IconCopy size={13} />}
                </button>
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
                Expires {expiresOn}. Paste it as <span className="mono">I3X_TOKEN</span> in the
                client that will present it.
              </div>
            </div>

            <div className="form-group">
              {/* THE jti IS SHOWN BECAUSE IT IS THE HANDLE FOR WITHDRAWING THIS TOKEN. Without it
                  an operator who has closed this dialog must find the TOKEN_MINTED row in the
                  Digital Thread to revoke — which is possible, and is not something to require of
                  somebody who has just realised they pasted a credential somewhere wrong. */}
              <label className="form-label">Token ID (jti)</label>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input className="form-control mono" readOnly value={minted.jti} />
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => copy('jti', minted.jti)}
                  title="Copy token ID"
                >
                  {copied === 'jti' ? <IconCheck size={13} /> : <IconCopy size={13} />}
                </button>
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
                Keep this. It is what identifies this token for revocation, and it is recorded in
                the Digital Thread — unlike the token itself.
              </div>
            </div>

            {/* THE SCOPE COMES FROM THE RESPONSE, not from a literal here, so this cannot drift
                from what 0074 actually covers if that ever widens. */}
            {minted.revocation_scope === 'postgrest' && (
              <div className="form-group" style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                <IconShieldAlert size={12} /> Revoking this token stops it reaching{' '}
                <strong>the API</strong>. Storage, realtime, the edge functions and Studio verify
                the signature independently and will keep accepting it until {expiresOn}.
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-primary" onClick={close}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
