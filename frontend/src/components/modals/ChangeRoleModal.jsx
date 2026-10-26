import React, { useCallback, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconInfo, IconShieldCheck } from '../common/Icons'
import { PERSON_ROLES, personRoleLabel, personRoleWithArticle } from '../../utils/people'
import { personUrl } from '../../routes'
import { personLabel } from '../../utils/displayName'

/**
 * Change Role, from a person's drawer: an Administrator gives someone else one of the four roles
 * (set_person_role()). Their role is chosen to start with, and Change Role stays disabled until
 * another is. The dialog then says what the new role lets them do, naming them as the drawer does,
 * before anything is sent. The database refuses what roleChangeBlocked() describes; its sentence
 * stays in the dialog. `onChanged` runs once the role is set, so the list behind it can reload.
 */
export function ChangeRoleModal({ person, onClose, onChanged, showToast }) {
  const [role, setRole] = useState(person.role || '')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const selectRef = useRef(null)

  const chosen = PERSON_ROLES.find(r => r.name === role) || null
  const changed = !!chosen && role !== person.role

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await api.setPersonRole(person.user_id, role)
      onChanged?.(role)
      showToast?.(`${personLabel(person)} is now ${personRoleLabel(role)}`, 'success', { to: personUrl(person.email) })
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }, [person, role, onChanged, onClose, showToast])

  return (
    <Modal
      title={`Change the role for ${personLabel(person)}`}
      icon={<IconShieldCheck size={18} />}
      size="md"
      onClose={busy ? () => {} : onClose}
      lead="Choose the role they should hold. Nothing changes until you select Change Role."
      initialFocus={selectRef}
      error={error}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <ActionButton
            pending={busy}
            pendingLabel="Changing…"
            className="btn btn-primary"
            onClick={save}
            disabled={!changed}
            title={changed ? undefined : 'Choose another role first'}
          >
            Change Role
          </ActionButton>
        </>
      )}
    >
      <div className="form-group">
        <label className="form-label" htmlFor="change-role-select">Role</label>
        <select
          id="change-role-select"
          className="form-control"
          value={role}
          onChange={e => setRole(e.target.value)}
          disabled={busy}
          ref={selectRef}
          aria-describedby="change-role-hint"
        >
          {!person.role && <option value="" disabled>No role</option>}
          {PERSON_ROLES.map(r => (
            <option key={r.name} value={r.name}>{r.label}</option>
          ))}
        </select>
        <div id="change-role-hint" className="form-hint">
          {chosen ? chosen.description : 'They hold no role now.'}
        </div>
      </div>

      {/* Read out as the choice changes, so a keyboard user hears what it means. */}
      <div aria-live="polite">
        {changed && (
          <div className="callout callout-info">
            <IconInfo size={14} className="callout-icon" />
            <div>
              {/* Named as the drawer's title names them; the title above gives the email. */}
              <strong>
                <bdi>{person.display_name || person.email || person.user_id}</bdi> becomes{' '}
                {personRoleWithArticle(role)}.
              </strong>{' '}
              {chosen.consequence} Node-RED follows within a minute, and Grafana when they next sign
              in to it.
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
