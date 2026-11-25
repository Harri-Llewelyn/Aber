import React, { useCallback, useRef, useState } from 'react'
import { ActionButton } from '../common/ActionButton'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { HoldToReveal } from '../common/HoldToReveal'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { IconLock } from '../common/Icons'
import { MIN_PASSWORD_LENGTH, changeOwnPassword, newPasswordProblems } from '../../utils/passwords'
import { useFormCheck } from '../../hooks/useFormCheck'

/**
 * Change Password, from the Profile page: the signed-in person's current password, then the new
 * one twice. GoTrue checks the current one in the same request that sets the new one
 * (utils/passwords.js). No audit row is written here: GoTrue's own audit log records the change.
 */
export function ChangePasswordModal({ email, onClose, showToast }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const currentRef = useRef(null)

  const problems = newPasswordProblems(current, next, again)
  const check = useFormCheck({
    current: { id: 'change-password-current', missing: problems.current },
    next: { id: 'change-password-new', missing: problems.next },
    again: { id: 'change-password-again', missing: problems.again },
  })

  const change = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await changeOwnPassword(email, current, next)
      showToast?.('Your password is changed. Use the new one the next time you sign in.', 'success')
      onClose()
    } catch (err) {
      setError(err.message)
      setCurrent('')
      setBusy(false)
    }
  }, [busy, email, current, next, showToast, onClose])

  return (
    <Modal
      title="Change Your Password"
      icon={<IconLock size={18} />}
      busy={busy}
      onClose={onClose}
      lead="This browser stays signed in. Other browsers signed in as you are signed out within the hour."
      initialFocus={currentRef}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={(
        <ActionButton type="submit" form="change-password-form" pending={busy} pendingLabel="Changing…" className="btn btn-primary">
          Change Password
        </ActionButton>
      )}
    >
      {/* `noValidate`: the browser's own message about a short password would stop the press before
          the form could say what it needs. */}
      <form id="change-password-form" noValidate onSubmit={e => { e.preventDefault(); check.press(change) }}>
        {/* For the browser's password manager, which files the new password under this address. */}
        <input type="email" autoComplete="username" value={email || ''} readOnly hidden />

        <div className="form-group">
          <label className="form-label" htmlFor="change-password-current">Current Password <RequiredMark /></label>
          <input
            id="change-password-current"
            className="form-control"
            type="password"
            value={current}
            onChange={e => { setCurrent(e.target.value); setError(null) }}
            autoComplete="current-password"
            disabled={busy}
            ref={currentRef}
            aria-required="true"
            {...fieldErrorProps(check.errors.current, 'change-password-current-error')}
          />
          <FieldError id="change-password-current-error" error={check.errors.current} />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="change-password-new">New Password <RequiredMark /></label>
          <div className="password-field">
            <input
              id="change-password-new"
              className="form-control"
              type={revealed ? 'text' : 'password'}
              value={next}
              onChange={e => setNext(e.target.value)}
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              disabled={busy}
              aria-required="true"
              {...fieldErrorProps(check.errors.next, 'change-password-new-error', 'change-password-new-hint')}
            />
            <HoldToReveal revealed={revealed} onChange={setRevealed} />
          </div>
          <div id="change-password-new-hint" className="form-hint">
            At least {MIN_PASSWORD_LENGTH} characters, and different from your current password.
          </div>
          <FieldError id="change-password-new-error" error={check.errors.next} />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="change-password-again">New Password Again <RequiredMark /></label>
          <input
            id="change-password-again"
            className="form-control"
            type={revealed ? 'text' : 'password'}
            value={again}
            onChange={e => setAgain(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            aria-required="true"
            {...fieldErrorProps(check.errors.again, 'change-password-again-error')}
          />
          <FieldError id="change-password-again-error" error={check.errors.again} />
        </div>
      </form>
    </Modal>
  )
}
