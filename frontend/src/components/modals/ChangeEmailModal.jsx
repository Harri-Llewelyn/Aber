import React, { useCallback, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconUser } from '../common/Icons'
import { EMAIL, normaliseEmail } from '../../utils/people'
import { personUrl } from '../../routes'

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
        { to: personUrl(result.email) })
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }, [next, person, onChanged, onClose, showToast])

  const ready = !!next && !problem

  return (
    <Modal
      title={`Change the email address for ${person.email}`}
      icon={<IconUser size={18} />}
      size="md"
      onClose={busy ? () => {} : onClose}
      lead="They sign in with the new address from now on. Every session they have ends, so they will have to sign in again. Nothing is sent to either address, so tell them yourself."
      initialFocus={inputRef}
      error={error}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <ActionButton
            pending={busy}
            pendingLabel="Changing…"
            className="btn btn-primary"
            onClick={save}
            disabled={!ready}
            title={ready ? undefined : problem || 'Type their new email address first'}
          >
            Change Email
          </ActionButton>
        </>
      )}
    >
      <div className="form-group">
        <label className="form-label" htmlFor="change-email-input">New email address</label>
        <input
          id="change-email-input"
          className="form-control"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && ready && !busy) save() }}
          placeholder="name@example.com"
          autoComplete="off"
          disabled={busy}
          ref={inputRef}
          aria-invalid={problem ? 'true' : undefined}
          aria-describedby="change-email-hint"
        />
        <div id="change-email-hint" className={problem ? 'form-hint hint-danger' : 'form-hint'}>
          {problem || 'Their role, name and history stay. Approvals and Archived Entities keep the address they had when they acted.'}
        </div>
      </div>
    </Modal>
  )
}
