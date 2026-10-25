import React, { useCallback, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconCheck, IconPlus, IconUser } from '../common/Icons'
import { EMAIL, PERSON_ROLES, personRoleLabel } from '../../utils/people'
import { PasswordShownOnce } from './PasswordShownOnce'
import { personUrl } from '../../routes'
import { DISPLAY_NAME_MAX, displayNameProblem, normaliseDisplayName, personLabel } from '../../utils/displayName'

/**
 * Add a person with a role, and optionally a display name. manage-people decides how they get in:
 * an invitation when the site has a mail relay, otherwise a password it mints, which this dialog
 * shows once (PasswordShownOnce). It refuses a bad name before the account exists; a name the
 * database then does not set leaves the person added, and the toast says so.
 *
 * `onAdded` runs once the person exists, so the list behind the dialog can reload.
 */
export function AddPersonModal({ onClose, onAdded, showToast }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('Operator')
  const [displayName, setDisplayName] = useState('')
  const [added, setAdded] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const emailRef = useRef(null)

  const nameProblem = displayNameProblem(displayName)
  const valid = EMAIL.test(email.trim()) && !nameProblem

  const add = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.addPerson(email.trim(), role, normaliseDisplayName(displayName))
      setAdded(result)
      onAdded?.(result)
      showToast?.(result.invited ? `Invitation sent to ${result.email}` : `${result.email} added`, 'success', { to: personUrl(result.email) })
      if (result.name_error) showToast?.(result.name_error, 'warning', { to: personUrl(result.email) })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [email, role, displayName, onAdded, showToast])

  const close = useCallback(() => onClose(), [onClose])

  if (added) {
    return (
      <Modal
        title={`${personLabel(added)} added`}
        icon={<IconUser size={18} />}
        size="lg"
        onClose={close}
        footer={<button className="btn btn-primary" onClick={close}>Done</button>}
      >
        {added.invited ? (
          <div className="callout callout-info">
            <IconCheck size={14} className="callout-icon" />
            <div>
              <strong>An invitation was sent to {added.email}.</strong>
              <div>
                They choose their own password from the link in it, and then sign in as{' '}
                {personRoleLabel(added.role)}. If the link has expired, they can use{' '}
                <em>Forgot your password?</em> on the sign-in page.
              </div>
            </div>
          </div>
        ) : (
          <PasswordShownOnce
            email={added.email}
            password={added.password}
            showToast={showToast}
            hint="It cannot be shown again. If it is lost, open their row and select Set New Password."
          >
            Closing this dialog discards it, and nothing in Aber keeps a copy. Give it to{' '}
            {added.email} in person, or by a channel you trust. They sign in with it as{' '}
            {personRoleLabel(added.role)}.
          </PasswordShownOnce>
        )}
      </Modal>
    )
  }

  return (
    <Modal
      title="Add a person"
      icon={<IconUser size={18} />}
      size="md"
      onClose={busy ? () => {} : close}
      lead="They sign in to the dashboard with this email address, and can do what the role allows."
      initialFocus={emailRef}
      error={error}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={close} disabled={busy}>Cancel</button>
          <ActionButton
            pending={busy}
            pendingLabel="Adding…"
            className="btn btn-primary"
            onClick={add}
            disabled={!valid}
            title={valid ? undefined : nameProblem || 'Enter an email address first'}
          >
            <IconPlus size={14} /> Add Person
          </ActionButton>
        </>
      )}
    >
      <div className="form-group">
        <label className="form-label" htmlFor="add-person-email">Email</label>
        <input
          id="add-person-email"
          className="form-control"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="name@example.com"
          autoComplete="off"
          disabled={busy}
          ref={emailRef}
        />
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="add-person-name">Display name (optional)</label>
        <input
          id="add-person-name"
          className="form-control"
          type="text"
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          placeholder="Their name, as colleagues know it"
          autoComplete="off"
          disabled={busy}
          aria-invalid={nameProblem ? 'true' : undefined}
          aria-describedby="add-person-name-hint"
        />
        <div id="add-person-name-hint" className={nameProblem ? 'form-hint hint-danger' : 'form-hint'}>
          {nameProblem || `Shown with their email address beside it. Up to ${DISPLAY_NAME_MAX} characters. They can change it on their Profile page.`}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="add-person-role">Role</label>
        <select
          id="add-person-role"
          className="form-control"
          value={role}
          onChange={e => setRole(e.target.value)}
          disabled={busy}
        >
          {PERSON_ROLES.map(r => (
            <option key={r.name} value={r.name}>{r.label}</option>
          ))}
        </select>
        <div className="form-hint">{PERSON_ROLES.find(r => r.name === role)?.description}</div>
      </div>

      <div className="form-hint">
        If this site has a mail relay, they get an invitation by email. Otherwise you get a password
        to give them, shown once.
      </div>
    </Modal>
  )
}
