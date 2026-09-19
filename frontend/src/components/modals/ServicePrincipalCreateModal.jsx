import React, { useCallback, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { IconShieldAlert, IconX } from '../common/Icons'
import { GRANTABLE_PERMISSIONS, permissionReach } from '../../utils/serviceIdentities'

const NAME_MAX = 80
const PURPOSE_MAX = 500

/**
 * Create a database principal from the Access Control page: a name, a purpose and a set of
 * permissions from the fixed menu. One RPC, `create_machine_principal()`, and no token: the
 * identity reaches nothing until one is signed, and the page opens the token dialog next so the
 * first token is shown once the way every other is. A principal left without a token is harmless,
 * and Withdraw covers it.
 *
 * The menu is `GRANTABLE_PERMISSIONS`, the same three the function allows; the build asserts the
 * two agree. Permissions and never a role: a role changes whenever somebody widens it for the
 * people who hold it.
 */
export function ServicePrincipalCreateModal({ onClose, onCreated, showToast }) {
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [permissions, setPermissions] = useState(() => new Set([GRANTABLE_PERMISSIONS[0]]))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const close = useCallback(() => onClose(), [onClose])
  useEscapeKey(close, true)

  const toggle = useCallback((perm) => {
    setPermissions(prev => {
      const next = new Set(prev)
      if (next.has(perm)) next.delete(perm)
      else next.add(perm)
      return next
    })
  }, [])

  const trimmedName = name.trim()
  const canSubmit = trimmedName.length > 0 && trimmedName.length <= NAME_MAX
    && purpose.length <= PURPOSE_MAX && permissions.size > 0 && !busy

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      // In menu order, not click order, so two identities given the same set list it the same way.
      const chosen = GRANTABLE_PERMISSIONS.filter(p => permissions.has(p))
      const created = await api.createServicePrincipal(trimmedName, chosen, purpose.trim())
      showToast?.(`${trimmedName} created — it holds no token yet`, 'success')
      // The name is carried from here: the RPC keeps 0080's return shape, and the caller is the
      // one who typed it.
      onCreated?.({ ...created, name: trimmedName })
      onClose()
    } catch (err) {
      // THE DIALOG STAYS OPEN with what was typed: the database refused the whole transaction, so
      // nothing was created and the operator corrects the field the message names.
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [trimmedName, purpose, permissions, onCreated, onClose, showToast])

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="New database principal">
      <div className="modal modal-lg">
        <div className="modal-header-row">
          <div className="modal-title" style={{ marginBottom: 0 }}>New database principal</div>
          <button className="btn btn-ghost btn-icon" onClick={close} title="Close">
            <IconX size={14} />
          </button>
        </div>

        <div className="form-group" style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          {/* The one fact a reader of this page needs before naming anything: which plane. */}
          An identity for a process that reads this stack's <strong>database</strong> through the
          API: a reporting tool, an MCP client, a script. It cannot sign in, holds the permissions
          chosen here and nothing else, and <strong>does not reach the broker</strong> — an MQTT
          client is issued a broker account, not a principal.
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="principal-name">Name</label>
          <input
            id="principal-name"
            className="form-control"
            autoFocus
            autoComplete="off"
            maxLength={NAME_MAX}
            placeholder="e.g. Line 4 OEE report"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
            What the page lists it as. Unique, ignoring case.
          </div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="principal-purpose">Purpose (optional)</label>
          <textarea
            id="principal-purpose"
            className="form-control"
            rows={3}
            maxLength={PURPOSE_MAX}
            placeholder="What presents this identity, and why it needs what it holds"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            style={{ resize: 'vertical' }}
          />
          <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
            Shown beside the name. It is what makes an unfamiliar identity safe to leave alone or
            safe to remove.
          </div>
        </div>

        <fieldset className="form-group" style={{ border: 'none', margin: 0, padding: 0 }}>
          <legend className="form-label">Holds</legend>
          {GRANTABLE_PERMISSIONS.map(perm => (
            <label
              key={perm}
              style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '4px 0', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={permissions.has(perm)}
                onChange={() => toggle(perm)}
                style={{ marginTop: '3px' }}
              />
              <span>
                <span className="badge badge-neutral" style={{ fontSize: '11px' }}>{perm}</span>
                <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '2px' }}>
                  {permissionReach([perm])}
                </div>
              </span>
            </label>
          ))}
          {/* Why the menu is short, said where the reader is choosing. */}
          <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
            Read-only permissions only, never a role. A token, once signed, is revocable against the
            API alone, so a write permission here would be an unrevocable write credential.
          </div>
        </fieldset>

        {error && (
          <div className="form-group" style={{ color: 'var(--danger-text)', fontSize: '12px' }}>
            <IconShieldAlert size={12} /> {error}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={close}>Cancel</button>
          <ActionButton
            pending={busy}
            pendingLabel="Creating…"
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={submit}
            title="Create the identity. No token is issued until you choose to."
          >
            Create Principal
          </ActionButton>
        </div>
      </div>
    </div>
  )
}
