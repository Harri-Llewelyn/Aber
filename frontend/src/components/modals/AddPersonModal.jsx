import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { copyText } from '../common/CopyableId'
import { Modal } from '../common/Modal'
import { IconCheck, IconCopy, IconPlus, IconShieldAlert, IconUser } from '../common/Icons'
import { PERSON_ROLES, personRoleLabel } from '../../utils/people'

const COPY_FEEDBACK_MS = 1600

/** ensure_first_administrator()'s and manage-people's test of an address. */
const EMAIL = /^[^@\s]+@[^@\s]+$/

/**
 * Add a person with a role. manage-people decides how they get in: an invitation when the site has
 * a mail relay, otherwise a password it mints, which this dialog shows once. The password lives in
 * this component's state until the dialog closes: not in a toast, the URL or the Audit Trail.
 *
 * `onAdded` runs once the person exists, so the list behind the dialog can reload.
 */
export function AddPersonModal({ onClose, onAdded, showToast }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('Operator')
  const [added, setAdded] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(null)

  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const valid = EMAIL.test(email.trim())

  const add = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.addPerson(email.trim(), role)
      setAdded(result)
      onAdded?.(result)
      showToast?.(result.invited ? `Invitation sent to ${result.email}` : `${result.email} added`, 'success')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [email, role, onAdded, showToast])

  const copy = useCallback(async (label, value) => {
    const ok = await copyText(value)
    setCopied(ok ? label : null)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
    if (!ok) showToast?.('Could not reach the clipboard — select the value and copy it.', 'error')
  }, [showToast])

  const close = useCallback(() => onClose(), [onClose])

  if (added) {
    return (
      <Modal
        title={`${added.email} added`}
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
          <>
            <div className="callout callout-warning">
              <IconShieldAlert size={14} className="callout-icon" />
              <div>
                <strong>Copy this password now — it is not shown again.</strong>
                <div>
                  Closing this dialog discards it, and nothing in Aber keeps a copy. Give it to{' '}
                  {added.email} in person, or by a channel you trust. They sign in with it as{' '}
                  {personRoleLabel(added.role)}.
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="person-email">Email</label>
              <input id="person-email" className="form-control mono" readOnly value={added.email} />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="person-password">Password</label>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input id="person-password" className="form-control mono" readOnly value={added.password || ''} />
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => copy('password', added.password)}
                  title="Copy password"
                  aria-label="Copy password"
                >
                  {copied === 'password' ? <IconCheck size={13} /> : <IconCopy size={13} />}
                </button>
              </div>
              <div className="form-hint">
                It cannot be shown again. Without a mail relay, a lost password is set again outside
                the dashboard: see Accounts in docs/install.md.
              </div>
            </div>
          </>
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
            title={valid ? 'Add this person' : 'Enter an email address first'}
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
          autoFocus
        />
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
