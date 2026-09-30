import React, { useState } from 'react'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconRecord, IconShieldAlert } from '../common/Icons'
import { formatDateTime } from '../../utils/format'

/**
 * Durations offered, rather than a free number. A capture stops at whichever of three caps is met
 * first (duration, 100,000 messages, or 50 MiB), so this is a ceiling. Two hours is the schema's
 * own limit (`capture_jobs_caps_are_bounded`).
 */
const DURATIONS = [
  { seconds: 30, label: '30 seconds' },
  { seconds: 120, label: '2 minutes' },
  { seconds: 600, label: '10 minutes' },
  { seconds: 1800, label: '30 minutes' },
  { seconds: 7200, label: '2 hours' }
]

/**
 * Start a capture, and when one is already stored, confirm destroying it in the same dialog, so
 * what is about to be lost and what is about to be recorded are read together. The note field
 * exists so the existing capture can be named ("pre-trip bearing vibration baseline").
 * `start_capture_job()` refuses when a capture of the subject exists unless `p_replace` is true, so
 * the confirmation is a precondition in the database.
 */
export function StartCaptureModal({ subject, existing, onConfirm, onCancel }) {
  const [note, setNote] = useState('')
  const [seconds, setSeconds] = useState(120)
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()

  const submit = () => run(async () => {
    setError(null)
    try {
      await onConfirm({ note: note.trim(), seconds, replace: !!existing })
    } catch (err) {
      // Shown here rather than as a toast, as the database wrote it: both refusals name something
      // specific.
      setError(err.message)
    }
  })

  return (
    <Modal
      title={`${existing ? 'Replace capture' : 'Record capture'} — ${subject.name}`}
      icon={<IconRecord size={18} />}
      size="sm"
      onClose={pending ? () => {} : onCancel}
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <ActionButton
            className={existing ? 'btn btn-danger' : 'btn btn-primary'}
            pending={pending}
            pendingLabel="Starting…"
            onClick={submit}
          >
            {existing ? 'Replace and record' : 'Start recording'}
          </ActionButton>
        </>
      }
    >
      {existing && (
        <div className="callout callout-warning">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>
            This replaces the capture recorded <strong>{formatDateTime(existing.recorded_at)}</strong>
            {existing.note ? <> — <strong>{existing.note}</strong></> : null}.
            {' '}That recording is destroyed once the new one succeeds, and cannot be recovered.
            {/* The old capture is not destroyed when this starts, so a failed recording leaves it
                intact. */}
            {' '}The existing capture survives until the replacement has been written.
          </div>
        </div>
      )}

      <div className="form-group">
        <label className="form-label" htmlFor="capture-note">Note (optional)</label>
        <input
          id="capture-note"
          className="form-control"
          value={note}
          onChange={e => setNote(e.target.value)}
          disabled={pending}
          maxLength={120}
          placeholder="pre-trip bearing vibration baseline"
          autoComplete="off"
        />
        <p className="form-hint">
          Shown on the list, and inside the confirmation the next person sees before replacing
          this capture. Worth a few words if the recording is of something hard to reproduce.
        </p>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="capture-seconds">Record for</label>
        <select
          id="capture-seconds"
          className="form-control"
          value={seconds}
          onChange={e => setSeconds(Number(e.target.value))}
          disabled={pending}
        >
          {DURATIONS.map(d => (
            <option key={d.seconds} value={d.seconds}>{d.label}</option>
          ))}
        </select>
        <p className="form-hint">
          A ceiling, not a promise — recording also stops at 100,000 messages or 50&nbsp;MiB,
          whichever comes first. You can stop it early at any point.
        </p>
      </div>

      {/* The subject is stated in full: a gateway's capture and a device's record different things. */}
      <p className="form-hint">
        Recording{' '}
        {subject.kind === 'gateway'
          ? <>everything published by <strong>{subject.name}</strong> and every device beneath it</>
          : <>only <strong>{subject.name}</strong>, plus its gateway's birth certificate, which
            carries the alias table. Without a birth certificate a playback loses every metric the
            gateway sends by alias</>}
        .
      </p>
    </Modal>
  )
}
