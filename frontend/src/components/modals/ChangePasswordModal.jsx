import React, { useCallback, useState } from 'react'
import { ActionButton } from '../common/ActionButton'
import { HoldToReveal } from '../common/HoldToReveal'
import { Modal } from '../common/Modal'
import { IconLock } from '../common/Icons'
import { MIN_PASSWORD_LENGTH, changeOwnPassword, newPasswordProblem } from '../../utils/passwords'

/**
 * Change Password, from the account menu: the signed-in person's current password, then the new
 * one twice. utils/passwords.js checks the current one before GoTrue changes anything. No audit row
 * is written here: GoTrue's own audit log records the change.
 */
export function ChangePasswordModal({ email, onClose, showToast }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const problem = newPasswordProblem(current, next, again)
  // Said under the form once a new password is being typed, so the disabled button is explained.
  const shownProblem = (next || again) ? problem : null

  const change = useCallback(async (e) => {
    e?.preventDefault()
    if (problem || busy) return
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
  }, [problem, busy, email, current, next, showToast, onClose])

  return (
    <Modal
      title="Change your password"
      icon={<IconLock size={18} />}
      size="md"
      onClose={busy ? () => {} : onClose}
      lead="This browser stays signed in. Other browsers signed in as you are signed out within the hour."
      error={error}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <ActionButton
            type="submit"
            form="change-password-form"
            pending={busy}
            pendingLabel="Changing…"
            className="btn btn-primary"
            disabled={!!problem}
            title={problem || 'Change your password'}
          >
            Change Password
          </ActionButton>
        </>
      )}
    >
      <form id="change-password-form" onSubmit={change}>
        {/* For the browser's password manager, which files the new password under this address. */}
        <input type="email" autoComplete="username" value={email || ''} readOnly hidden />

        <div className="form-group">
          <label className="form-label" htmlFor="change-password-current">Current password</label>
          <input
            id="change-password-current"
            className="form-control"
            type="password"
            value={current}
            onChange={e => { setCurrent(e.target.value); setError(null) }}
            autoComplete="current-password"
            disabled={busy}
            autoFocus
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="change-password-new">New password</label>
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
            />
            <HoldToReveal revealed={revealed} onChange={setRevealed} />
          </div>
          <div className="form-hint">
            At least {MIN_PASSWORD_LENGTH} characters, and different from your current password.
          </div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="change-password-again">New password again</label>
          <input
            id="change-password-again"
            className="form-control"
            type={revealed ? 'text' : 'password'}
            value={again}
            onChange={e => setAgain(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
          />
          {shownProblem && <div className="form-hint" role="status">{shownProblem}</div>}
        </div>
      </form>
    </Modal>
  )
}
