import React from 'react'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'

/**
 * @param {string}   confirmLabel  Verb for the confirming button. The default suits a generic
 *                                 question; name the act where the caller knows it.
 * @param {string}   pendingLabel  What that button says while the action runs.
 */
export function ConfirmModal({ message, onConfirm, onCancel, confirmLabel = 'Confirm', pendingLabel = 'Working…' }) {
  const [pending, runConfirm] = usePendingAction()

  // Escape closes. Via the shared stack rather than a listener of this component's own,
  // because a ConfirmModal can open on top of this one and a bare document listener on each
  // would let one keypress dismiss both.
  //
  // While the action runs Escape becomes a no-op rather than sitting the layer out: passing
  // `active: false` would pop this off the stack and hand the keypress to the dialog UNDERNEATH,
  // so an impatient Escape would dismiss the form that asked the question while its mutation was
  // still in flight.
  useEscapeKey(pending ? () => {} : onCancel)

  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }}>
      <div className="modal modal-sm">
        <div className="modal-title">Confirm Action</div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13px', margin: '12px 0 20px' }}>{message}</p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <ActionButton
            className="btn btn-danger"
            pending={pending}
            pendingLabel={pendingLabel}
            onClick={() => runConfirm(() => onConfirm())}
          >
            {confirmLabel}
          </ActionButton>
        </div>
      </div>
    </div>
  )
}
