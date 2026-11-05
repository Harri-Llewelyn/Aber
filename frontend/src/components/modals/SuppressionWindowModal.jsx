import React, { useRef, useState } from 'react'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconAlertTriangle, IconBellOff } from '../common/Icons'
import { localMinute, parseLocal } from '../../utils/timeWindow'
import { formatDateTime } from '../../utils/format'
import { SUPPRESSION_REASON_MAX, windowState } from '../../utils/alertSuppression'

/** What a window on each kind of subject keeps quiet, for the dialogs' leads. */
function covers(kind, name) {
  const named = <strong>{name}</strong>
  if (kind === 'gateway') return <>Alerts on {named} itself, not on its devices,</>
  if (kind === 'cell') return <>Alerts on every device in {named}</>
  return <>Alerts on {named}</>
}

/**
 * Schedule a suppression window, or change one: a start, an end and a reason. Times are in local
 * time, as the History page's custom range takes them. A start already past is now, as the
 * database takes it; a window that has started keeps its start. A refusal is shown in the dialog
 * as the database worded it.
 *
 * `window` is the window to change, or null to schedule one. `onConfirm` receives
 * `{ startsAt, endsAt, reason }` as ISO strings and text, with null for what a change keeps.
 */
export function SuppressionWindowModal({ kind, subjectName, window = null, onConfirm, onCancel }) {
  const changing = Boolean(window)
  const started = changing && windowState(window) !== 'upcoming'
  const [start, setStart] = useState(() => localMinute(window ? new Date(window.starts_at) : new Date()))
  const [end, setEnd] = useState(() => (window ? localMinute(new Date(window.ends_at)) : ''))
  const [reason, setReason] = useState(window?.reason ?? '')
  const [error, setError] = useState(null)
  // Set by the first edit, so a dialog that has just opened is not already scolding.
  const [touched, setTouched] = useState(false)
  const [pending, run] = usePendingAction()
  const reasonRef = useRef(null)

  const startAt = parseLocal(start)
  const endAt = parseLocal(end)
  const trimmed = reason.trim()
  // The minute the field shows, against the minute the window holds, so an untouched start is no change.
  const startChanged = changing && !started && start !== localMinute(new Date(window.starts_at))
  const endChanged = !changing || end !== localMinute(new Date(window.ends_at))
  const reasonChanged = !changing || trimmed !== window.reason

  const problem = !startAt && !started ? 'Choose a start'
    : !endAt ? 'Choose an end'
      : endAt.getTime() <= Date.now() ? 'The end must be in the future'
        : endAt <= (started ? new Date(window.starts_at) : startAt) ? 'The end must come after the start'
          : trimmed === '' ? 'Give a reason'
            : changing && !startChanged && !endChanged && !reasonChanged ? 'Nothing has changed'
              : null

  const submit = () => run(async () => {
    setError(null)
    try {
      await onConfirm({
        startsAt: changing
          ? (startChanged ? startAt.toISOString() : null)
          : (startAt > new Date() ? startAt.toISOString() : null),
        endsAt: endChanged ? endAt.toISOString() : null,
        reason: reasonChanged ? trimmed : null,
      })
    } catch (err) {
      setError(err.message)
    }
  })

  const action = changing ? 'Change window' : 'Schedule window'
  return (
    <Modal
      title={action}
      icon={<IconBellOff size={18} />}
      size="sm"
      onClose={pending ? () => {} : onCancel}
      lead={<>
        {covers(kind, subjectName)} are recorded, but not counted, coloured or sent, from the start to
        the end. One still firing at the end counts again then.
      </>}
      initialFocus={reasonRef}
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <ActionButton
            className={`btn btn-primary${problem ? ' btn-disabled' : ''}`}
            pending={pending}
            pendingLabel={changing ? 'Changing…' : 'Scheduling…'}
            disabled={problem !== null}
            title={problem ?? undefined}
            onClick={submit}
          >
            {action}
          </ActionButton>
        </>
      }
    >
      <div className="form-group">
        <label className="form-label" htmlFor="suppression-reason">Reason</label>
        <textarea
          id="suppression-reason"
          className="form-control"
          rows={2}
          value={reason}
          onChange={e => { setReason(e.target.value); setTouched(true) }}
          disabled={pending}
          maxLength={SUPPRESSION_REASON_MAX}
          placeholder="Belt change on the feeder"
          ref={reasonRef}
        />
        <p className="form-hint">Everyone who can see the alerts reads it beside them.</p>
      </div>
      <div className="suppression-window-times">
        <div className="form-group">
          <label className="form-label" htmlFor="suppression-start">Start</label>
          <input
            id="suppression-start"
            type="datetime-local"
            className="form-control"
            value={start}
            onChange={e => { setStart(e.target.value); setTouched(true) }}
            disabled={pending || started}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="suppression-end">End</label>
          <input
            id="suppression-end"
            type="datetime-local"
            className="form-control"
            value={end}
            onChange={e => { setEnd(e.target.value); setTouched(true) }}
            disabled={pending}
          />
        </div>
      </div>
      <p className="form-hint">
        {started
          ? `In local time. It started at ${formatDateTime(window.starts_at)}, so its start stays.`
          : 'In local time. A start already past is now.'}
      </p>
      {/* Why the confirm is off, said where the person is looking, not only in its hover tip. */}
      <p className="form-hint hint-danger" aria-live="polite">
        {touched && problem && problem !== 'Nothing has changed' && (
          <><IconAlertTriangle size={12} /> {problem}</>
        )}
      </p>
    </Modal>
  )
}

/**
 * End a window now, or cancel one that has not started. Ending puts its alerts back in the count;
 * cancelling deletes a window that never covered anything. A refusal (it ended meanwhile) is shown
 * in the dialog as the database worded it.
 */
export function EndSuppressionWindowModal({ kind, subjectName, window, onConfirm, onCancel }) {
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()
  const upcoming = windowState(window) === 'upcoming'

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
      title={upcoming ? 'Cancel window' : 'End window'}
      icon={<IconBellOff size={18} />}
      size="sm"
      onClose={pending ? () => {} : onCancel}
      lead={upcoming
        ? <>The window from {formatDateTime(window.starts_at)} has not started, so it is cancelled. {covers(kind, subjectName)} are not kept quiet by it.</>
        : <>{covers(kind, subjectName)} count again now. One still firing is sent, as if it had just fired.</>}
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Keep window</button>
          <ActionButton
            className={upcoming ? 'btn btn-danger' : 'btn btn-primary'}
            pending={pending}
            pendingLabel={upcoming ? 'Cancelling…' : 'Ending…'}
            onClick={submit}
          >
            {upcoming ? 'Cancel window' : 'End now'}
          </ActionButton>
        </>
      }
    />
  )
}
