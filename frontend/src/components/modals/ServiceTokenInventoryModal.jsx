import React, { useCallback, useMemo, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { IconShieldAlert, IconX } from '../common/Icons'

/**
 * One principal's tokens, and the only place a token can be withdrawn. A principal has N tokens
 * because a re-mint adds a credential, so the row shows the count and this dialog the list;
 * revocation is per jti, which is what `revoke_service_token()` takes. A revoked token is not a
 * deleted one: `auth_pre_request()` is a PostgREST hook, so a withdrawn jti still works at storage,
 * realtime, the edge runtime and Studio until its own expiry, which is why the scope is stated at
 * the top and the expiry stays visible on every withdrawn row. No type-to-confirm, and no undo.
 */
export function ServiceTokenInventoryModal({ principalName, status, onClose, onChanged, showToast }) {
  // The jtis this dialog has withdrawn during its own lifetime, so a row updates the moment it is
  // acted on. The server is still the authority: `onChanged` reloads on close.
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
      // Per-row, not a dialog-level banner: several tokens can be withdrawn in one visit.
      setErrors(prev => new Map(prev).set(jti, err.message))
      showToast?.(err.message, 'error')
    } finally {
      setBusyJti(null)
    }
  }, [showToast])

  // Newest first, the reverse of tokenStatus(), which sorts by earliest expiry. A person looking
  // for the token they just issued wants it at the top.
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
                        {/* Expired is checked before revoked: the signature check refuses an
                            expired token everywhere, including the services a revocation never
                            reaches. */}
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
                        {/* Offered only where it would do something: revoke_service_token() refuses
                            an expired token outright, and a jti-less row cannot be addressed. */}
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
