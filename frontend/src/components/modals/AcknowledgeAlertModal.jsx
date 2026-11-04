import React, { useRef, useState } from 'react'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconCheck, IconX } from '../common/Icons'
import {
  ALERT_ACKNOWLEDGEMENT_REASONS, ALERT_ACKNOWLEDGEMENT_NOTE_MAX,
} from '../../utils/alertAcknowledgement'

/**
 * Acknowledge a firing alert: a reason from the closed set, and a note. The reason starts unchosen,
 * so nobody files Investigating by default; Other needs the note, as the database does. A refusal
 * (someone else acknowledged it first, or it resolved meanwhile) is shown in the dialog as the
 * database worded it.
 */
export function AcknowledgeAlertModal({ alert, onConfirm, onCancel }) {
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()
  const reasonRef = useRef(null)

  const needsNote = reason === 'other'
  const ready = reason !== '' && (!needsNote || note.trim() !== '')

  const submit = () => run(async () => {
    setError(null)
    try {
      await onConfirm({ reason, note: note.trim() })
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <Modal
      title="Acknowledge alert"
      icon={<IconCheck size={18} />}
      size="sm"
      onClose={pending ? () => {} : onCancel}
      lead={<>
        <strong>{alert.alert_name}</strong> stays in the list, marked with your name and reason. It
        stops counting in the top bar until it resolves.
      </>}
      initialFocus={reasonRef}
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <ActionButton
            className="btn btn-primary"
            pending={pending}
            pendingLabel="Acknowledging…"
            disabled={!ready}
            title={ready ? undefined : needsNote ? 'Other needs a note' : 'Choose a reason first'}
            onClick={submit}
          >
            Acknowledge alert
          </ActionButton>
        </>
      }
    >
      <div className="form-group">
        <label className="form-label" htmlFor="acknowledge-reason">Reason</label>
        <select
          id="acknowledge-reason"
          className="form-control"
          value={reason}
          onChange={e => setReason(e.target.value)}
          disabled={pending}
          ref={reasonRef}
        >
          <option value="" disabled>Choose a reason…</option>
          {ALERT_ACKNOWLEDGEMENT_REASONS.map(r => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="acknowledge-note">
          {needsNote ? 'Note' : 'Note (optional)'}
        </label>
        <textarea
          id="acknowledge-note"
          className="form-control"
          rows={3}
          value={note}
          onChange={e => setNote(e.target.value)}
          disabled={pending}
          maxLength={ALERT_ACKNOWLEDGEMENT_NOTE_MAX}
          placeholder="Feeder belt change until 14:00"
        />
        <p className="form-hint">
          Everyone who can see the alert reads it. Say what you know, so nobody else goes to look.
        </p>
      </div>
    </Modal>
  )
}

/**
 * Withdraw an alert's acknowledgement, so it counts again. A refusal (it resolved meanwhile, or
 * somebody withdrew it first) is shown in the dialog as the database worded it.
 */
export function WithdrawAcknowledgementModal({ alert, onConfirm, onCancel }) {
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()

  const submit = () => run(async () => {
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <Modal
      title="Withdraw acknowledgement"
      icon={<IconX size={18} />}
      size="sm"
      onClose={pending ? () => {} : onCancel}
      lead={<>
        <strong>{alert.alert_name}</strong> counts in the top bar again. Anyone who may acknowledge
        it can then acknowledge it afresh.
      </>}
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <ActionButton className="btn btn-primary" pending={pending} pendingLabel="Withdrawing…" onClick={submit}>
            Withdraw acknowledgement
          </ActionButton>
        </>
      }
    />
  )
}
