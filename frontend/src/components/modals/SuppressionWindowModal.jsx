import React, { useRef, useState } from 'react'
import { useFormCheck } from '../../hooks/useFormCheck'
import { usePendingAction } from '../../hooks/usePendingAction'
import { useSetting } from '../../hooks/useSettings'
import { ActionButton } from '../common/ActionButton'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { IconBellOff } from '../common/Icons'
import { ConfirmModal } from './ConfirmModal'
import { localMinute, parseLocal } from '../../utils/timeWindow'
import { formatDateTime } from '../../utils/format'
import {
  SUPPRESSION_MAX_DAYS, SUPPRESSION_MAX_DAYS_KEY, SUPPRESSION_MAX_DAYS_PLACE, SUPPRESSION_REASON_MAX, dayWords,
  suppressionMaxDays, windowState,
} from '../../utils/alertSuppression'

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

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
 * database takes it; a window that has started keeps its start. The end may be at most
 * `alerts.suppression_max_days` after the start, as the writers hold it. A refusal is shown in the
 * dialog as the database worded it.
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
  const [pending, run] = usePendingAction()
  const reasonRef = useRef(null)

  const startAt = parseLocal(start)
  const endAt = parseLocal(end)
  const trimmed = reason.trim()
  // The minute the field shows, against the minute the window holds, so an untouched start is no change.
  const startChanged = changing && !started && start !== localMinute(new Date(window.starts_at))
  const endChanged = !changing || end !== localMinute(new Date(window.ends_at))
  const reasonChanged = !changing || trimmed !== window.reason

  // The limit runs from the start the database will hold: the window's own while it stays, else the
  // field's, or now for one already past. A change of the reason alone is not held to it, as the
  // writer does not hold it, so a window longer than a since-lowered limit keeps its end.
  const maxDays = suppressionMaxDays(useSetting(SUPPRESSION_MAX_DAYS_KEY, SUPPRESSION_MAX_DAYS))
  const measuredFrom = started || (changing && !startChanged) ? new Date(window.starts_at)
    : startAt ? new Date(Math.max(startAt.getTime(), Date.now())) : null
  const latestEnd = measuredFrom ? new Date(measuredFrom.getTime() + maxDays * DAY_MS) : null

  const check = useFormCheck({
    reason: { id: 'suppression-reason', missing: trimmed === '' && 'Give a reason' },
    start: { id: 'suppression-start', missing: !startAt && !started && 'Choose a start' },
    end: {
      id: 'suppression-end',
      missing: !endAt && 'Choose an end',
      wrong: endAt && (endAt.getTime() <= Date.now() ? 'The end must be in the future'
        : (startAt || started) && endAt <= (started ? new Date(window.starts_at) : startAt) ? 'The end must come after the start'
          : (startChanged || endChanged) && latestEnd && endAt > latestEnd && `A window can last at most ${dayWords(maxDays)}`),
    },
  }, { unchanged: changing && !startChanged && !endChanged && !reasonChanged })

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

  const action = changing ? 'Change Window' : 'Schedule Window'
  return (
    <Modal
      title={action}
      icon={<IconBellOff size={18} />}
      busy={pending}
      onClose={onCancel}
      lead={<>
        {covers(kind, subjectName)} are recorded, but not counted, coloured or sent, from the start to
        the end. One still firing at the end counts again then.
      </>}
      initialFocus={reasonRef}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={
        <ActionButton
          className="btn btn-primary"
          pending={pending}
          pendingLabel={changing ? 'Changing…' : 'Scheduling…'}
          onClick={() => check.press(submit)}
        >
          {action}
        </ActionButton>
      }
    >
      <div className="form-group">
        <label className="form-label" htmlFor="suppression-reason">Reason <RequiredMark /></label>
        <textarea
          id="suppression-reason"
          className="form-control"
          rows={2}
          value={reason}
          onChange={e => setReason(e.target.value)}
          disabled={pending}
          maxLength={SUPPRESSION_REASON_MAX}
          placeholder="Belt change on the feeder"
          ref={reasonRef}
          aria-required="true"
          {...fieldErrorProps(check.errors.reason, 'suppression-reason-error', 'suppression-reason-hint')}
        />
        <p id="suppression-reason-hint" className="form-hint">Everyone who can see the alerts reads it beside them.</p>
        <FieldError id="suppression-reason-error" error={check.errors.reason} />
      </div>
      <div className="suppression-window-times">
        <div className="form-group">
          <label className="form-label" htmlFor="suppression-start">Start <RequiredMark /></label>
          <input
            id="suppression-start"
            type="datetime-local"
            className="form-control"
            value={start}
            onChange={e => setStart(e.target.value)}
            disabled={pending || started}
            aria-required="true"
            {...fieldErrorProps(check.errors.start, 'suppression-start-error')}
          />
          <FieldError id="suppression-start-error" error={check.errors.start} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="suppression-end">End <RequiredMark /></label>
          <input
            id="suppression-end"
            type="datetime-local"
            className="form-control"
            value={end}
            onChange={e => setEnd(e.target.value)}
            disabled={pending}
            // Down to the minute, so the picker never offers a minute the database refuses.
            max={latestEnd ? localMinute(new Date(Math.floor(latestEnd.getTime() / MINUTE_MS) * MINUTE_MS)) : undefined}
            aria-required="true"
            {...fieldErrorProps(check.errors.end, 'suppression-end-error', 'suppression-end-limit')}
          />
          <p className="form-hint" id="suppression-end-limit">
            At most {dayWords(maxDays)}, set on {SUPPRESSION_MAX_DAYS_PLACE}.
          </p>
          <FieldError id="suppression-end-error" error={check.errors.end} />
        </div>
      </div>
      <p className="form-hint">
        {started
          ? `In local time. It started at ${formatDateTime(window.starts_at)}, so its start stays.`
          : 'In local time. A start already past is now.'}
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
  const upcoming = windowState(window) === 'upcoming'
  return (
    <ConfirmModal
      title={upcoming ? 'Cancel Window' : 'End Window'}
      icon={<IconBellOff size={18} />}
      message={upcoming
        ? <>The window from {formatDateTime(window.starts_at)} has not started, so it is cancelled. {covers(kind, subjectName)} are not kept quiet by it.</>
        : <>{covers(kind, subjectName)} count again now. One still firing is sent, as if it had just fired.</>}
      confirmLabel={upcoming ? 'Cancel Window' : 'End Now'}
      pendingLabel={upcoming ? 'Cancelling…' : 'Ending…'}
      confirmClassName={upcoming ? 'btn btn-danger' : 'btn btn-primary'}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
