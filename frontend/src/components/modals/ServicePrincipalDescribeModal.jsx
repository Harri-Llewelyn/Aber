import React, { useCallback, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'

const NAME_MAX = 80
const PURPOSE_MAX = 500

/**
 * Rename a machine identity created from the Access Control page, or change its purpose. Offered
 * only for a row that has a `machine_principals` entry: the three identities a migration pinned
 * are named in the dashboard's registry, and the RPC refuses them.
 *
 * No permissions here, deliberately. Widening what a principal holds is a change of authority that
 * every token already signed for it would carry at once; that is a new principal, not an edit.
 */
export function ServicePrincipalDescribeModal({ principal, onClose, onChanged, showToast }) {
  const [name, setName] = useState(principal.name || '')
  const [purpose, setPurpose] = useState(principal.purpose || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const close = useCallback(() => onClose(), [onClose])

  const trimmedName = name.trim()
  const unchanged = trimmedName === (principal.name || '') && purpose.trim() === (principal.purpose || '')
  const canSubmit = trimmedName.length > 0 && trimmedName.length <= NAME_MAX
    && purpose.length <= PURPOSE_MAX && !unchanged && !busy

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await api.describeServicePrincipal(principal.principal_id, trimmedName, purpose.trim())
      showToast?.(`${trimmedName} updated`, 'success')
      onChanged?.()
      onClose()
    } catch (err) {
      // THE DIALOG STAYS OPEN with what was typed: nothing changed, and the message names the
      // field to correct.
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [principal, trimmedName, purpose, onChanged, onClose, showToast])

  return (
    <Modal
      title={`Describe “${principal.name}”`}
      size="lg"
      onClose={close}
      lead="The name and purpose only. What the identity holds is fixed at creation: a wider grant would reach every token already issued for it, so that is a new machine identity."
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={close}>Cancel</button>
          <ActionButton
            pending={busy}
            pendingLabel="Saving…"
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={submit}
            title={unchanged ? 'Nothing has changed' : 'Save the name and purpose'}
          >
            Save
          </ActionButton>
        </>
      }
    >
      <div className="form-group">
        <label className="form-label" htmlFor="principal-describe-name">Name</label>
        <input
          id="principal-describe-name"
          className="form-control"
          autoFocus
          autoComplete="off"
          maxLength={NAME_MAX}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="principal-describe-purpose">Purpose (optional)</label>
        <textarea
          id="principal-describe-purpose"
          className="form-control"
          rows={3}
          maxLength={PURPOSE_MAX}
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          style={{ resize: 'vertical' }}
        />
        <div className="form-hint">The change is recorded in the Audit Trail with what it replaced.</div>
      </div>
    </Modal>
  )
}
