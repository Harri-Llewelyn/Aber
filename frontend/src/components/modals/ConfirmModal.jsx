import React from 'react'
import { useEscapeKey } from '../../hooks/useEscapeKey'

export function ConfirmModal({ message, onConfirm, onCancel }) {
  // Escape closes. Via the shared stack rather than a listener of this component's own,
  // because a ConfirmModal can open on top of this one and a bare document listener on each
  // would let one keypress dismiss both.
  useEscapeKey(onCancel)

  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }}>
      <div className="modal modal-sm">
        <div className="modal-title">Confirm Action</div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13px', margin: '12px 0 20px' }}>{message}</p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-danger" onClick={onConfirm}>Confirm</button>
        </div>
      </div>
    </div>
  )
}
