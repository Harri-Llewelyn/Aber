import React, { useCallback, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { Modal } from '../common/Modal'
import { IconUser } from '../common/Icons'
import { DISPLAY_NAME_MAX, displayNameProblem, normaliseDisplayName } from '../../utils/displayName'
import { personUrl } from '../../routes'
import { useFormCheck } from '../../hooks/useFormCheck'

/**
 * Change Name, from a People row: an Administrator sets or clears another person's display name
 * (set_display_name(), 0203). An empty name clears it, and the person is shown by email alone.
 * `onSaved` runs once the database has it, so the list behind the dialog can reload.
 */
export function DisplayNameModal({ person, onClose, onSaved, showToast }) {
  const [name, setName] = useState(person.display_name || '')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  const problem = displayNameProblem(name)
  const next = normaliseDisplayName(name)
  const check = useFormCheck({ name: { id: 'display-name-input', wrong: problem } }, { unchanged: next === (person.display_name || null) })

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const held = await api.setDisplayName(person.user_id, next)
      onSaved?.(held)
      showToast?.(
        held ? `${person.email} is now shown as ${held}` : `${person.email} is now shown by email alone`,
        'success',
        { to: personUrl(person.user_id) }
      )
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }, [next, person, onSaved, onClose, showToast])

  return (
    <Modal
      title={`Change the Name for ${person.email}`}
      icon={<IconUser size={18} />}
      busy={busy}
      onClose={onClose}
      lead="Shown first, with their email address beside it. Their email address does not change, and stays how they sign in."
      initialFocus={inputRef}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={(
        <ActionButton pending={busy} pendingLabel="Saving…" className="btn btn-primary" onClick={() => check.press(save)}>
          Save Name
        </ActionButton>
      )}
    >
      <div className="form-group">
        <label className="form-label" htmlFor="display-name-input">Display Name</label>
        <input
          id="display-name-input"
          className="form-control"
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !busy) check.press(save) }}
          placeholder="Their name, as colleagues know it"
          autoComplete="off"
          disabled={busy}
          ref={inputRef}
          {...fieldErrorProps(check.errors.name, 'display-name-error', 'display-name-hint')}
        />
        <div id="display-name-hint" className="form-hint">
          {`Up to ${DISPLAY_NAME_MAX} characters. Leave it empty to show their email address alone.`}
        </div>
        <FieldError id="display-name-error" error={check.errors.name} />
      </div>
    </Modal>
  )
}
