import React, { useState } from 'react'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { IconShieldAlert } from '../common/Icons'

/**
 * Queue a backup, with the note that will be kept beside it. The note is asked for here rather
 * than on the page because it is the one thing a person adds to a backup, and the thing the next
 * person reads when choosing which one to restore from. The gate's refusal, when one backup is
 * already queued or running, is shown inside the dialog as the database wrote it.
 */
export function TakeBackupModal({ onConfirm, onCancel }) {
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()

  useEscapeKey(pending ? () => {} : onCancel)

  const submit = () => run(async () => {
    setError(null)
    try {
      await onConfirm({ note: note.trim() })
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <div className="modal-overlay">
      <div className="modal modal-sm">
        <div className="modal-title">Take a backup</div>

        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '12px 0 0' }}>
          Both databases, the stored files and the forge, taken by the backup service onto its
          own volume. A backup taken here is <strong>pinned</strong>: the retention window does not
          apply until you release it.
        </p>

        <div className="form-group" style={{ marginTop: '16px' }}>
          <label className="form-label" htmlFor="backup-note">Note (optional)</label>
          <input
            id="backup-note"
            className="form-control"
            value={note}
            onChange={e => setNote(e.target.value)}
            disabled={pending}
            maxLength={200}
            placeholder="before the areas migration"
            autoComplete="off"
            autoFocus
          />
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '6px 0 0' }}>
            Kept with the backup and shown on the list. Say why it was taken: it is what the next
            person reads when choosing which backup to restore from.
          </p>
        </div>

        {error && (
          <div
            className="callout"
            style={{ borderColor: 'var(--danger)', color: 'var(--danger-text)', marginTop: '12px' }}
          >
            <IconShieldAlert size={14} className="callout-icon" />
            <div style={{ fontSize: '12px' }}>{error}</div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <ActionButton pending={pending} pendingLabel="Queuing…" onClick={submit}>
            Take a backup
          </ActionButton>
        </div>
      </div>
    </div>
  )
}
