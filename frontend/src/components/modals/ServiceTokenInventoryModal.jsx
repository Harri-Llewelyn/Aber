import React, { useCallback, useMemo, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { IconShieldAlert, IconX } from '../common/Icons'

/**
 * One principal's tokens, and the only place a token can be withdrawn.
 *
 * =================================================================================================
 * WHY A DIALOG AND NOT A BUTTON IN THE ROW
 *
 * A principal has N tokens, not one. `tokenStatus()` exists because a re-mint ADDS a credential
 * rather than replacing one, so "revoke this principal's token" is not a well-formed instruction --
 * there is no single token to name. A row-level Revoke button would have to pick one, and whichever
 * rule it used (newest? earliest-expiring?) would be a guess the operator could not see being made.
 *
 * So the row shows the COUNT and this dialog shows the LIST. Revocation is per-jti, which is what
 * `revoke_service_token()` takes and what the denylist is keyed on.
 *
 * =================================================================================================
 * WHAT THIS DIALOG HAS TO SAY THAT THE BADGE CANNOT
 *
 * A revoked token is not a deleted one. `auth_pre_request()` is a PostgREST hook, so withdrawing a
 * jti stops it reaching the API and leaves it working at storage, realtime, the edge runtime and
 * Studio until its own expiry. An operator who reads "Revoked" as "gone" will stop looking for it,
 * which is the wrong conclusion to draw from a control this dialog is offering -- so the scope is
 * stated once at the top and the expiry stays visible on every withdrawn row.
 *
 * =================================================================================================
 * NO TYPE-TO-CONFIRM, AND NO UNDO
 *
 * Revocation is not destructive in the way GatewayCredentialModal's mint is -- it takes a credential
 * OUT of service rather than replacing one something is holding -- so a name-typing barrier would be
 * ceremony. But it is one-way: `revoke_service_token()` has no inverse, and a withdrawn token cannot
 * be reinstated. The button says so rather than asking twice.
 */
export function ServiceTokenInventoryModal({ principalName, status, onClose, onChanged, showToast }) {
  // The jtis this dialog has withdrawn during its own lifetime, so a row updates the moment it is
  // acted on. THE SERVER IS STILL THE AUTHORITY -- `onChanged` reloads the page's three reads on
  // close -- and this is only what keeps the list from lying between the click and that reload.
  const [justRevoked, setJustRevoked] = useState(() => new Set())
  const [busyJti, setBusyJti] = useState(null)
  const [errors, setErrors] = useState(() => new Map())

  const close = useCallback(() => {
    // RELOAD ONLY IF SOMETHING CHANGED. Closing a dialog that was opened to look rather than to act
    // should not make the table flicker through a refetch.
    if (justRevoked.size > 0) onChanged?.()
    onClose()
  }, [justRevoked, onChanged, onClose])

  useEscapeKey(close, true)

  const revoke = useCallback(async (jti) => {
    setBusyJti(jti)
    setErrors(prev => { const next = new Map(prev); next.delete(jti); return next })
    try {
      await api.revokeServiceToken(jti)
      setJustRevoked(prev => new Set(prev).add(jti))
      showToast?.('Token withdrawn — the API will refuse it from now on', 'success')
    } catch (err) {
      // PER-ROW, NOT A DIALOG-LEVEL BANNER. Several tokens can be withdrawn in one visit, and a
      // single error slot would attribute the third failure to whichever row the reader was
      // looking at.
      setErrors(prev => new Map(prev).set(jti, err.message))
      showToast?.(err.message, 'error')
    } finally {
      setBusyJti(null)
    }
  }, [showToast])

  // NEWEST FIRST, which is the reverse of tokenStatus()'s ordering and deliberate. That function
  // sorts by earliest expiry because it needs the next date something breaks; a person looking for
  // the token they just issued wants it at the top.
  const rows = useMemo(
    () => [...(status?.rows || [])].sort((a, b) => b.expiresAtMs - a.expiresAtMs),
    [status]
  )

  const now = Date.now()

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Service principal tokens">
      <div className="modal modal-lg">
        <div className="modal-header-row">
          <div className="modal-title" style={{ marginBottom: 0 }}>
            Tokens for “{principalName}”
          </div>
          <button className="btn btn-ghost btn-icon" onClick={close} title="Close">
            <IconX size={14} />
          </button>
        </div>

        <div className="form-group" style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          Every unexpired mint is a live credential — issuing another <strong>adds</strong> one
          rather than replacing it, so each is withdrawn separately.
          <div style={{ marginTop: '6px' }}>
            <IconShieldAlert size={12} /> Withdrawing stops a token reaching{' '}
            <strong>the API</strong>. Storage, realtime, the edge functions and Studio verify the
            signature independently and keep accepting it until it expires. Revocation{' '}
            <strong>cannot be undone</strong>.
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="form-group" style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
            No mint is recorded for this identity. That is not the same as no token existing — see
            the note on the row.
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Token ID (jti)</th>
                  <th>Issued</th>
                  <th>Expires</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(t => {
                  const revoked = t.revoked || justRevoked.has(t.jti)
                  const expired = t.expiresAtMs <= now
                  const error = errors.get(t.jti)
                  return (
                    <tr key={t.jti || `${t.issued_at}-${t.expiresAtMs}`}>
                      <td className="mono" style={{ fontSize: '11px' }}>{t.jti || '—'}</td>
                      <td style={{ fontSize: '12px' }}>
                        {t.issued_at ? new Date(t.issued_at).toLocaleDateString() : '—'}
                      </td>
                      <td style={{ fontSize: '12px' }}>
                        {new Date(t.expiresAtMs).toLocaleDateString()}
                      </td>
                      <td>
                        {/* EXPIRED IS CHECKED BEFORE REVOKED, because the signature check refuses
                            an expired token everywhere -- including the four services a revocation
                            never reaches -- so it is the stronger statement of the two. */}
                        <span className={`badge badge-${expired ? 'neutral' : revoked ? 'warning' : 'ok'}`}
                          style={{ fontSize: '11px' }}>
                          {expired ? 'EXPIRED' : revoked ? 'WITHDRAWN' : 'ACTIVE'}
                        </span>
                        {error && (
                          <div style={{ color: 'var(--danger-text)', fontSize: '11px', marginTop: '4px' }}>
                            {error}
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {/* OFFERED ONLY WHERE IT WOULD DO SOMETHING. An expired token is already
                            refused by the signature check, and revoke_service_token() refuses it
                            outright rather than recording a withdrawal that changed nothing -- so
                            a button here would exist only to produce an error. A jti-less row (a
                            mint recorded before 0043 stamped one) cannot be addressed at all. */}
                        {!expired && !revoked && t.jti && (
                          <ActionButton
                            pending={busyJti === t.jti}
                            pendingLabel="Withdrawing…"
                            className="btn btn-ghost"
                            onClick={() => revoke(t.jti)}
                            title="Withdraw this token. The API refuses it from the next request onward; this cannot be undone."
                          >
                            Revoke
                          </ActionButton>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  )
}
