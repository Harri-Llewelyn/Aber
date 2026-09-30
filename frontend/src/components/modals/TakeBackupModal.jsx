import React, { useState } from 'react'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconHardDrive } from '../common/Icons'

/**
 * Queue a backup, with the note that will be kept beside it. The note is asked for here rather
 * than on the page because it is the one thing a person adds to a backup, and the thing the next
 * person reads when choosing which one to restore from. The gate's refusal, when one backup is
 * already queued or running, is shown inside the dialog as the database wrote it. `holds` names
 * every component the run writes, in the page's words.
 */
export function TakeBackupModal({ holds, onConfirm, onCancel }) {
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()

  const submit = () => run(async () => {
    setError(null)
    try {
      await onConfirm({ note: note.trim() })
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <Modal
      title="Take a backup"
      icon={<IconHardDrive size={18} />}
      size="sm"
      onClose={pending ? () => {} : onCancel}
      lead={<>
        Taken by the backup service onto its own volume: {holds}. A backup taken here
        is <strong>pinned</strong>: the retention window does not apply until you release it.
      </>}
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <ActionButton pending={pending} pendingLabel="Queuing…" onClick={submit}>
            Take a backup
          </ActionButton>
        </>
      }
    >
      <div className="form-group">
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
        <p className="form-hint">
          Kept with the backup and shown on the list. Say why it was taken: it is what the next
          person reads when choosing which backup to restore from.
        </p>
      </div>
    </Modal>
  )
}
