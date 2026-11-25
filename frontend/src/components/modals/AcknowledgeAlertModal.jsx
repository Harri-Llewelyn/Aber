import React, { useRef, useState } from 'react'
import { useFormCheck } from '../../hooks/useFormCheck'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { IconCheck, IconX } from '../common/Icons'
import { ConfirmModal } from './ConfirmModal'
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
  const check = useFormCheck({
    reason: { id: 'acknowledge-reason', missing: reason === '' && 'Choose a reason' },
    note: { id: 'acknowledge-note', missing: needsNote && note.trim() === '' && 'Other needs a note' },
  })

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
      title="Acknowledge Alert"
      icon={<IconCheck size={18} />}
      busy={pending}
      onClose={onCancel}
      lead={<>
        <strong>{alert.alert_name}</strong> stays in the list, marked with your name and reason. It
        stops counting in the top bar until it resolves.
      </>}
      initialFocus={reasonRef}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={
        <ActionButton
          className="btn btn-primary"
          pending={pending}
          pendingLabel="Acknowledging…"
          onClick={() => check.press(submit)}
        >
          Acknowledge Alert
        </ActionButton>
      }
    >
      <div className="form-group">
        <label className="form-label" htmlFor="acknowledge-reason">Reason <RequiredMark /></label>
        <select
          id="acknowledge-reason"
          className="form-control"
          value={reason}
          onChange={e => setReason(e.target.value)}
          disabled={pending}
          ref={reasonRef}
          aria-required="true"
          {...fieldErrorProps(check.errors.reason, 'acknowledge-reason-error')}
        >
          <option value="" disabled>Choose a reason…</option>
          {ALERT_ACKNOWLEDGEMENT_REASONS.map(r => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
        <FieldError id="acknowledge-reason-error" error={check.errors.reason} />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="acknowledge-note">
          {needsNote ? <>Note <RequiredMark /></> : 'Note (optional)'}
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
          aria-required={needsNote || undefined}
          {...fieldErrorProps(check.errors.note, 'acknowledge-note-error', 'acknowledge-note-hint')}
        />
        <p id="acknowledge-note-hint" className="form-hint">
          Everyone who can see the alert reads it. Say what you know, so nobody else goes to look.
        </p>
        <FieldError id="acknowledge-note-error" error={check.errors.note} />
      </div>
    </Modal>
  )
}

/**
 * Withdraw an alert's acknowledgement, so it counts again. A refusal (it resolved meanwhile, or
 * somebody withdrew it first) is shown in the dialog as the database worded it.
 */
export function WithdrawAcknowledgementModal({ alert, onConfirm, onCancel }) {
  return (
    <ConfirmModal
      title="Withdraw Acknowledgement"
      icon={<IconX size={18} />}
      message={<>
        <strong>{alert.alert_name}</strong> counts in the top bar again. Anyone who may acknowledge
        it can then acknowledge it afresh.
      </>}
      confirmLabel="Withdraw Acknowledgement"
      pendingLabel="Withdrawing…"
      confirmClassName="btn btn-primary"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
