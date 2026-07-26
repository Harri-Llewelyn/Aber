import React from 'react'

export function ConfirmModal({ message, onConfirm, onCancel }) {
  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }}>
      <div className="modal" style={{ maxWidth: 400 }}>
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
