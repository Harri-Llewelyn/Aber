import React, { useCallback, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { Modal } from '../common/Modal'
import { IconInfo, IconShieldCheck } from '../common/Icons'
import { PERSON_ROLES, personRoleLabel, personRoleWithArticle } from '../../utils/people'
import { personUrl } from '../../routes'
import { personLabel } from '../../utils/displayName'
import { useFormCheck } from '../../hooks/useFormCheck'

/**
 * Change Role, from a person's drawer: an Administrator gives someone else one of the four roles
 * (set_person_role()). Their role is chosen to start with. Once another is, the dialog says what the
 * new role lets them do, naming them as the drawer does,
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
  const check = useFormCheck({ role: { id: 'change-role-select', missing: !chosen && 'Choose a role' } }, { unchanged: !changed })

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await api.setPersonRole(person.user_id, role)
      onChanged?.(role)
      showToast?.(`${personLabel(person)} is now ${personRoleLabel(role)}`, 'success', { to: personUrl(person.user_id) })
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }, [person, role, onChanged, onClose, showToast])

  return (
    <Modal
      title={`Change the Role for ${personLabel(person)}`}
      icon={<IconShieldCheck size={18} />}
      busy={busy}
      onClose={onClose}
      lead="Choose the role they should hold. Nothing changes until you select Change Role."
      initialFocus={selectRef}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={(
        <ActionButton pending={busy} pendingLabel="Changing…" className="btn btn-primary" onClick={() => check.press(save)}>
          Change Role
        </ActionButton>
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
          {...fieldErrorProps(check.errors.role, 'change-role-error', 'change-role-hint')}
        >
          {!person.role && <option value="" disabled>No role</option>}
          {PERSON_ROLES.map(r => (
            <option key={r.name} value={r.name}>{r.label}</option>
          ))}
        </select>
        <div id="change-role-hint" className="form-hint">
          {chosen ? chosen.description : 'They hold no role now.'}
        </div>
        <FieldError id="change-role-error" error={check.errors.role} />
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
