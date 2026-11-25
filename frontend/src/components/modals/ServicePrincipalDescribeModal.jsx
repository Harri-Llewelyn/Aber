import React, { useCallback, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { identityUrl } from '../../routes'
import { useFormCheck } from '../../hooks/useFormCheck'

const NAME_MAX = 80
const PURPOSE_MAX = 500

/**
 * Rename a machine identity created from the Access Control page, or change its purpose. Offered
 * only for a row that has a `machine_principals` entry: an identity a migration pinned is
 * named in the dashboard's registry, and the RPC refuses it.
 *
 * No permissions here, deliberately. Widening what a principal holds is a change of authority that
 * every token already signed for it would carry at once; that is a new principal, not an edit.
 */
export function ServicePrincipalDescribeModal({ principal, onClose, onChanged, showToast }) {
  const [name, setName] = useState(principal.name || '')
  const [purpose, setPurpose] = useState(principal.purpose || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const nameRef = useRef(null)

  const trimmedName = name.trim()
  const check = useFormCheck(
    { name: { id: 'principal-describe-name', missing: !trimmedName && 'Give the identity a name' } },
    { unchanged: trimmedName === (principal.name || '') && purpose.trim() === (principal.purpose || '') },
  )

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await api.describeServicePrincipal(principal.principal_id, trimmedName, purpose.trim())
      showToast?.(`${trimmedName} updated`, 'success', { to: identityUrl(trimmedName) })
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
      busy={busy}
      onClose={onClose}
      lead="The name and purpose only. What the identity holds is fixed at creation: a wider grant would reach every token already issued for it, so that is a new machine identity."
      initialFocus={nameRef}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={
        <ActionButton pending={busy} pendingLabel="Saving…" className="btn btn-primary" onClick={() => check.press(submit)}>
          Save Identity
        </ActionButton>
      }
    >
      <div className="form-group">
        <label className="form-label" htmlFor="principal-describe-name">Name <RequiredMark /></label>
        <input
          id="principal-describe-name"
          className="form-control"
          ref={nameRef}
          autoComplete="off"
          maxLength={NAME_MAX}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-required="true"
          {...fieldErrorProps(check.errors.name, 'principal-describe-name-error')}
        />
        <FieldError id="principal-describe-name-error" error={check.errors.name} />
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
