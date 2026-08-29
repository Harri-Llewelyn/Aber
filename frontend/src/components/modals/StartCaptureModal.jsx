import React, { useState } from 'react'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { IconShieldAlert } from '../common/Icons'

/**
 * Durations offered, rather than a free number.
 *
 * A capture stops at whichever of three caps is met first — duration, 100,000 messages, or 50 MiB —
 * so this is a ceiling and not a promise. The list is short on purpose: the useful question is
 * "roughly how long", and a spinbox invites 3600 from somebody who wanted a minute.
 *
 * TWO HOURS IS THE SCHEMA'S OWN LIMIT (`capture_jobs_caps_are_bounded`), so the last entry is the
 * largest value the gate will accept rather than a number chosen here.
 */
const DURATIONS = [
  { seconds: 30, label: '30 seconds' },
  { seconds: 120, label: '2 minutes' },
  { seconds: 600, label: '10 minutes' },
  { seconds: 1800, label: '30 minutes' },
  { seconds: 7200, label: '2 hours' }
]

/**
 * Start a capture, and — when one is already stored — confirm destroying it in the same breath.
 *
 * ONE DIALOG, NOT TWO, AND THAT IS THE POINT OF THE NOTE FIELD. The alternative was a generic
 * confirmation followed by a form, and it puts the two halves of the decision on different screens:
 * what you are about to LOSE, and what you are about to record. Together, the sentence an operator
 * reads is "overwrite the capture of Line 1 Gateway from 27 Aug 14:30 — pre-trip bearing vibration
 * baseline?", which is a different question from the same dialog without that last clause.
 *
 * That is the entire reason `captures.note` exists. Mitigating the destroy-a-rare-fault risk is
 * what the field is for, and a note visible only on the list does not do that job.
 *
 * THE CONFIRMATION IS NOT DECORATIVE HERE. `start_capture_job()` refuses when a capture of the
 * subject exists unless `p_replace` is true, so this dialog is a precondition in the database
 * rather than a convention of this client — an API caller that never saw it is refused too.
 */
export function StartCaptureModal({ subject, existing, onConfirm, onCancel }) {
  const [note, setNote] = useState('')
  const [seconds, setSeconds] = useState(120)
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()

  useEscapeKey(pending ? () => {} : onCancel)

  const submit = () => run(async () => {
    setError(null)
    try {
      await onConfirm({ note: note.trim(), seconds, replace: !!existing })
    } catch (err) {
      // SHOWN HERE RATHER THAN AS A TOAST, and left as the database wrote it. The two refusals this
      // call produces both name something specific — the capture about to be destroyed, or the
      // capture already running — and a toast would take that away from the dialog that asked.
      setError(err.message)
    }
  })

  return (
    <div className="modal-overlay">
      <div className="modal modal-sm">
        <div className="modal-title">
          {existing ? 'Replace capture' : 'Record capture'} — {subject.name}
        </div>

        {existing && (
          <div className="callout callout-warning" style={{ marginTop: '12px' }}>
            <IconShieldAlert size={14} className="callout-icon" />
            <div style={{ fontSize: '12px' }}>
              This replaces the capture recorded{' '}
              <strong>{formatWhen(existing.recorded_at)}</strong>
              {existing.note ? <> — <strong>{existing.note}</strong></> : null}.
              {' '}That recording is destroyed once the new one succeeds, and cannot be recovered.
              {/* Stated because it changes what a cautious operator does next: the old capture is
                  NOT destroyed when this starts, so a recording that fails leaves it intact. */}
              {' '}The existing capture survives until the replacement has been written.
            </div>
          </div>
        )}

        <div className="form-group" style={{ marginTop: '16px' }}>
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
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '6px 0 0' }}>
            Shown on the list, and inside the confirmation the next person sees before replacing
            this capture. Worth a few words if the recording is of something hard to reproduce.
          </p>
        </div>

        <div className="form-group" style={{ marginTop: '12px' }}>
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
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '6px 0 0' }}>
            A ceiling, not a promise — recording also stops at 100,000 messages or 50&nbsp;MiB,
            whichever comes first. You can stop it early at any point.
          </p>
        </div>

        {/* The subject is stated in full, because the two tabs make it easy to press Capture on the
            device row of a gateway you meant, or the reverse. */}
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '14px 0 0' }}>
          Recording{' '}
          {subject.kind === 'gateway'
            ? <>everything published by <strong>{subject.name}</strong> and every device beneath it</>
            : <>only <strong>{subject.name}</strong>, plus its gateway's birth certificate — which is
              where the alias table lives, and without it the capture cannot be replayed</>}
          .
        </p>

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
          <ActionButton
            className={existing ? 'btn btn-danger' : 'btn btn-primary'}
            pending={pending}
            pendingLabel="Starting…"
            onClick={submit}
          >
            {existing ? 'Replace and record' : 'Start recording'}
          </ActionButton>
        </div>
      </div>
    </div>
  )
}

/** Duplicated from CaptureTab rather than imported, to keep the modal free of a page-level import. */
function formatWhen(iso) {
  if (!iso) return 'at an unknown time'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'at an unknown time'
  return date.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}
