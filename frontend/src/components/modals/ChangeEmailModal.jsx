import React, { useCallback, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { IconUser } from '../common/Icons'
import { EMAIL, normaliseEmail } from '../../utils/people'
import { personUrl } from '../../routes'
import { useFormCheck } from '../../hooks/useFormCheck'

/**
 * Change Email, from a person's drawer: an Administrator gives someone else a new address, in use
 * at once (manage-people's `change-email`). It is trimmed and lower-cased as Add Person sends one.
 * The change ends every session they hold, so they sign in again with the new address; nothing is
 * mailed to either. `onChanged` gets manage-people's answer once the address has changed.
 */
export function ChangeEmailModal({ person, onClose, onChanged, showToast }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  const next = normaliseEmail(email)
  const problem = !next ? null
    : !EMAIL.test(next) || next.length > 254 ? 'That is not an email address.'
      : next === normaliseEmail(person.email) ? 'That is already their email address.'
        : null

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.changePersonEmail(person.user_id, next)
      onChanged?.(result)
      showToast?.(`${person.email} is now ${result.email}. They sign in again with it.`, 'success',
        { to: personUrl(person.user_id) })
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }, [next, person, onChanged, onClose, showToast])

  const check = useFormCheck({
    email: { id: 'change-email-input', missing: !next && 'Type their new email address', wrong: problem },
  })

  return (
    <Modal
      title={`Change the Email Address for ${person.email}`}
      icon={<IconUser size={18} />}
      busy={busy}
      onClose={onClose}
      lead="They sign in with the new address from now on. Every session they have ends, so they will have to sign in again. Nothing is sent to either address, so tell them yourself."
      initialFocus={inputRef}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={(
        <ActionButton pending={busy} pendingLabel="Changing…" className="btn btn-primary" onClick={() => check.press(save)}>
          Change Email
        </ActionButton>
      )}
    >
      <div className="form-group">
        <label className="form-label" htmlFor="change-email-input">New Email Address <RequiredMark /></label>
        <input
          id="change-email-input"
          className="form-control"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !busy) check.press(save) }}
          placeholder="name@example.com"
          autoComplete="off"
          disabled={busy}
          ref={inputRef}
          aria-required="true"
          {...fieldErrorProps(check.errors.email, 'change-email-error', 'change-email-hint')}
        />
        <div id="change-email-hint" className="form-hint">
          Their role, name and history stay. Approvals and Entities keep the address they had when they acted.
        </div>
        <FieldError id="change-email-error" error={check.errors.email} />
      </div>
    </Modal>
  )
}
