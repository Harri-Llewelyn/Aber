import React, { useState } from 'react'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconAlertTriangle, IconMail } from '../common/Icons'
import { PERSON_ROLES } from '../../utils/people'

/**
 * Who Aber emails about an alert: the roles whose people are told, each ticked. The setting is a
 * list the database checks against its roles, and a person is told only if they hold a ticked role
 * and have an address on their account. The lowest severity is a row of the Settings table, as the
 * webhook's is. The relay is the site's, set in its chart, so the dialog says whether there is one
 * and how to give it one, and never asks for it. As the webhook's dialog, which this follows.
 */
export function EmailModal({ roles, relay, saveRoles, onSaved, onClose }) {
  const [chosen, setChosen] = useState(() => new Set(roles || []))
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()

  const before = new Set(roles || [])
  const unchanged = chosen.size === before.size && [...chosen].every(r => before.has(r))
  // In the order the dashboard lists roles, so the stored list reads the same however it was ticked.
  const list = PERSON_ROLES.map(r => r.name).filter(name => chosen.has(name))

  const toggle = (name) => setChosen(current => {
    const next = new Set(current)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    return next
  })

  const save = () => run(async () => {
    setError(null)
    try {
      await saveRoles(list)
      await onSaved?.(list)
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <Modal
      title="Email"
      icon={<IconMail size={18} />}
      onClose={pending ? () => {} : onClose}
      lead="Aber emails an alert to the people in the roles ticked here when it starts firing, while it fires unacknowledged, and when it resolves. A person is told only if their account has an email address. Nobody is told until a role is ticked."
      error={error}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={pending}>Cancel</button>
          <ActionButton
            className="btn btn-primary"
            pending={pending}
            pendingLabel="Saving…"
            disabled={unchanged}
            title={unchanged ? 'Nothing has changed' : undefined}
            onClick={save}
          >
            Save
          </ActionButton>
        </>
      )}
    >
      {relay && !relay.available && (
        <div className="callout callout-warning" data-testid="email-relay-unavailable">
          <IconAlertTriangle size={14} className="callout-icon" />
          <div>Email cannot be sent yet. {relay.reason}</div>
        </div>
      )}

      <fieldset className="form-group" disabled={pending} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="form-label">Roles told</legend>
        {PERSON_ROLES.map(role => (
          <label key={role.name} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', margin: '6px 0' }}>
            <input
              type="checkbox"
              checked={chosen.has(role.name)}
              onChange={() => toggle(role.name)}
              style={{ marginTop: '2px' }}
            />
            <span>
              <strong>{role.label}</strong>
              <span className="form-hint" style={{ display: 'block' }}>{role.description}</span>
            </span>
          </label>
        ))}
        <p className="form-hint">
          An alert about a machine identity’s token goes to Administrators only, and only when the
          Administrator role is ticked.
        </p>
      </fieldset>
    </Modal>
  )
}
