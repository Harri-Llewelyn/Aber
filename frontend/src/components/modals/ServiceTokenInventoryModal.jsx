import React, { useCallback, useMemo, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Badge } from '../common/Badge'
import { Modal } from '../common/Modal'
import { IconShieldAlert } from '../common/Icons'
import { NO_VALUE, formatDate } from '../../utils/format'

/**
 * One machine identity's tokens, and the only place a token can be revoked. An identity has N
 * tokens because a re-mint adds a credential, so the row shows the count and this dialog the list;
 * revocation is per jti, which is what `revoke_service_token()` takes. A revoked token is not a
 * deleted one: `auth_pre_request()` is a PostgREST hook, so a revoked jti still works at storage,
 * realtime, the edge runtime and Studio until its own expiry, which is why the scope is stated at
 * the top and the expiry stays visible on every revoked row. No type-to-confirm, and no undo.
 *
 * `now` is a prop, as it is on `tokenStatus()` and `tokenStatusDetail()`: the status handed in
 * was computed at a clock the caller chose, and a dialog that re-read the real one could
 * disagree with the badge that opened it about which rows are expired.
 */
export function ServiceTokenInventoryModal({ principalName, status, onClose, onChanged, showToast,
  now = Date.now() }) {
  // The jtis this dialog has revoked during its own lifetime, so a row updates the moment it is
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

  const revoke = useCallback(async (jti) => {
    setBusyJti(jti)
    setErrors(prev => { const next = new Map(prev); next.delete(jti); return next })
    try {
      await api.revokeServiceToken(jti)
      setJustRevoked(prev => new Set(prev).add(jti))
      showToast?.('Token revoked — the API will refuse it from now on', 'success')
    } catch (err) {
      // Per-row, not a dialog-level banner: several tokens can be revoked in one visit.
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

  return (
    <Modal
      title={`Tokens for “${principalName}”`}
      size="lg"
      onClose={close}
      lead={<>
        Every unexpired mint is a live credential — issuing another <strong>adds</strong> one
        rather than replacing it, so each is revoked separately.
      </>}
      footer={<button className="btn btn-primary" onClick={close}>Done</button>}
    >
      <div className="callout callout-warning">
        <IconShieldAlert size={14} className="callout-icon" />
        <div>
          Revoking stops a token reaching <strong>the API</strong>. Storage, realtime, the edge
          functions and Studio verify the signature independently and keep accepting it until it
          expires. Revocation <strong>cannot be undone</strong>.
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="cell-meta">
          No mint is recorded for this identity. That is not the same as no token existing — see
          the note on the row.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Token ID (jti)</th>
                <th>Issued</th>
                <th>Expires</th>
                <th>State</th>
                <th className="row-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(t => {
                const revoked = t.revoked || justRevoked.has(t.jti)
                const expired = t.expiresAtMs <= now
                const error = errors.get(t.jti)
                return (
                  <tr key={t.jti || `${t.issued_at}-${t.expiresAtMs}`}>
                    <td className="mono">{t.jti || NO_VALUE}</td>
                    <td className="cell-meta">{t.issued_at ? formatDate(t.issued_at) : NO_VALUE}</td>
                    <td className="cell-meta">{formatDate(t.expiresAtMs)}</td>
                    <td>
                      {/* Expired is checked before revoked: the signature check refuses an
                          expired token everywhere, including the services a revocation never
                          reaches. */}
                      <Badge size="sm" tone={expired ? 'neutral' : revoked ? 'danger' : 'success'}>
                        {expired ? 'EXPIRED' : revoked ? 'REVOKED' : 'ACTIVE'}
                      </Badge>
                      {error && <div className="form-hint hint-danger">{error}</div>}
                    </td>
                    <td className="row-actions">
                      {/* Offered only where it would do something: revoke_service_token() refuses
                          an expired token outright, and a jti-less row cannot be addressed. */}
                      {!expired && !revoked && t.jti && (
                        <ActionButton
                          pending={busyJti === t.jti}
                          pendingLabel="Revoking…"
                          className="btn btn-sm btn-danger btn-danger-reveal"
                          onClick={() => revoke(t.jti)}
                          title="Revoke this token. The API refuses it from the next request onward; this cannot be undone."
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
    </Modal>
  )
}
