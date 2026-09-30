import React, { useCallback, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconShieldAlert } from '../common/Icons'

/**
 * Withdraw a whole machine identity, or put one back. One dialog for both directions because what a
 * reader needs is the same: what happens to the tokens. Withdrawing the identity makes
 * `auth_pre_request()` refuse on the `sub` claim, which reaches every token naming the principal,
 * including ones this stack has no record of and ones issued afterwards; revoking tokens one by
 * one in the inventory dialog does not. Reinstatement restores the identity, not the credentials:
 * withdrawing also revokes each outstanding token, and `revoke_service_token()` has no inverse.
 */
export function ServicePrincipalRevocationModal({
  principal, principalName, revocation, activeTokens = 0, onClose, onChanged, showToast,
}) {
  const reinstating = !!revocation
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const close = useCallback(() => onClose(), [onClose])

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
    <Modal
      title={`${reinstating ? 'Reinstate' : 'Withdraw'} “${principalName}”`}
      onClose={close}
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={close}>Cancel</button>
          <ActionButton
            pending={busy}
            pendingLabel={reinstating ? 'Reinstating…' : 'Withdrawing…'}
            className={reinstating ? 'btn btn-primary' : 'btn btn-danger'}
            onClick={submit}
            title={reinstating
              ? 'Lift the withdrawal. Previous tokens stay revoked.'
              : 'Refuse every token naming this identity, now and in future.'}
          >
            {reinstating ? 'Reinstate Identity' : 'Withdraw Identity'}
          </ActionButton>
        </>
      }
    >
      {reinstating ? (
        <div className="form-group">
          <p className="cell-meta">
            This identity may hold tokens again, and the API will stop refusing them.
          </p>
          <div className="callout callout-warning">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>
              <strong>Its previous tokens stay revoked.</strong> Reinstating restores the identity,
              not the credentials that were live when it was withdrawn — those cannot be
              un-revoked. Issue a new token afterwards.
            </div>
          </div>
          {revocation?.reason && (
            <p className="cell-meta">
              Withdrawn because: <em>{revocation.reason}</em>
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="callout callout-warning">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>
              <strong>Withdraw this identity?</strong> The API will refuse{' '}
              <strong>every token naming it</strong> — including ones this stack has no record
              of, and any issued afterwards. That is what makes this different from revoking
              tokens one at a time.
              {activeTokens > 0 && (
                <div>
                  {activeTokens === 1
                    ? 'Its 1 active token will also be revoked individually'
                    : `Its ${activeTokens} active tokens will also be revoked individually`}
                  , so reinstating later will not bring them back.
                </div>
              )}
              <div>
                Reversible — but storage, realtime, the edge functions and Studio verify the
                signature independently and will keep accepting existing tokens until they expire.
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
            {/* Recorded on the row and in the Audit Trail: "why" is the question a reader of the
                denylist will have. */}
            <div className="form-hint">Shown on the identity and recorded in the Audit Trail.</div>
          </div>
        </>
      )}
    </Modal>
  )
}
