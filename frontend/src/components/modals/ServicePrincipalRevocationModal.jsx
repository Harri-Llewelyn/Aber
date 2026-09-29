import React, { useCallback, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { IconShieldAlert, IconX } from '../common/Icons'

/**
 * Withdraw a whole service identity, or put one back. One dialog for both directions because what a
 * reader needs is the same: what happens to the tokens. Revoking the identity makes
 * `auth_pre_request()` refuse on the `sub` claim, which reaches every token naming the principal,
 * including ones this stack has no record of and ones issued afterwards; withdrawing jtis one by
 * one in the inventory dialog does not. Reinstatement restores the identity, not the credentials:
 * revoking also denylists each outstanding token, and `revoke_service_token()` has no inverse.
 */
export function ServicePrincipalRevocationModal({
  principal, principalName, revocation, activeTokens = 0, onClose, onChanged, showToast,
}) {
  const reinstating = !!revocation
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const close = useCallback(() => onClose(), [onClose])
  useEscapeKey(close, true)

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      if (reinstating) {
        await api.reinstateServicePrincipal(principal.principal_id)
        showToast?.(`${principalName} reinstated — it can hold tokens again`, 'success')
      } else {
        await api.revokeServicePrincipal(principal.principal_id, reason)
        showToast?.(`${principalName} withdrawn — every token naming it is refused`, 'success')
      }
      onChanged?.()
      onClose()
    } catch (err) {
      // THE DIALOG STAYS OPEN. Nothing changed, and closing on a failure would leave an operator
      // believing an identity was withdrawn when it is still live.
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [reinstating, principal, principalName, reason, onChanged, onClose, showToast])

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true"
      aria-label={reinstating ? 'Reinstate service identity' : 'Withdraw service identity'}>
      <div className="modal">
        <div className="modal-header-row">
          <div className="modal-title" style={{ marginBottom: 0 }}>
            {reinstating ? 'Reinstate' : 'Withdraw'} “{principalName}”
          </div>
          <button className="btn btn-ghost btn-icon" onClick={close} title="Close">
            <IconX size={14} />
          </button>
        </div>

        {reinstating ? (
          <div className="form-group" style={{ fontSize: '13px' }}>
            <div style={{ color: 'var(--text-muted)' }}>
              This identity may hold tokens again, and the API will stop refusing them.
              <div style={{ marginTop: '6px' }}>
                <IconShieldAlert size={12} />{' '}
                <strong>Its previous tokens stay withdrawn.</strong> Reinstating restores the
                identity, not the credentials that were live when it was revoked — those cannot be
                un-revoked. Issue a new token afterwards.
              </div>
              {revocation?.reason && (
                <div style={{ marginTop: '8px' }}>
                  Withdrawn because: <em>{revocation.reason}</em>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="form-group" style={{ fontSize: '13px' }}>
              <strong style={{ color: 'var(--warning-text)' }}>
                <IconShieldAlert size={13} /> Withdraw this identity?
              </strong>
              <div style={{ color: 'var(--text-muted)', marginTop: '6px' }}>
                The API will refuse <strong>every token naming it</strong> — including ones this
                stack has no record of, and any issued afterwards. That is what makes this
                different from withdrawing tokens one at a time.
                {activeTokens > 0 && (
                  <div style={{ marginTop: '6px' }}>
                    {activeTokens === 1
                      ? 'Its 1 active token will also be withdrawn individually'
                      : `Its ${activeTokens} active tokens will also be withdrawn individually`}
                    , so reinstating later will not bring them back.
                  </div>
                )}
                <div style={{ marginTop: '6px' }}>
                  Reversible — but storage, realtime and the edge functions verify the signature
                  independently and will keep accepting existing tokens until they expire.
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="principal-revoke-reason">
                Reason (optional)
              </label>
              <input
                id="principal-revoke-reason"
                className="form-control"
                autoFocus
                autoComplete="off"
                placeholder="e.g. decommissioned, key suspected leaked"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              {/* RECORDED ON THE ROW AND IN THE AUDIT TRAIL. "Why" is the question a reader of the
                  denylist will have, and without this it lives only in somebody's memory. */}
              <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
                Shown on the identity and recorded in the Audit Trail.
              </div>
            </div>
          </>
        )}

        {error && (
          <div className="form-group" style={{ color: 'var(--danger-text)', fontSize: '12px' }}>
            <IconShieldAlert size={12} /> {error}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={close}>Cancel</button>
          <ActionButton
            pending={busy}
            pendingLabel={reinstating ? 'Reinstating…' : 'Withdrawing…'}
            className={reinstating ? 'btn btn-primary' : 'btn btn-danger'}
            onClick={submit}
            title={reinstating
              ? 'Lift the flag. Previous tokens stay withdrawn.'
              : 'Refuse every token naming this identity, now and in future.'}
          >
            {reinstating ? 'Reinstate Identity' : 'Withdraw Identity'}
          </ActionButton>
        </div>
      </div>
    </div>
  )
}
