import React, { useState } from 'react'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { TypedGate, useTypedGate } from '../common/TypedGate'

/**
 * A question with two answers, in a `<Modal>`. Opened over another dialog, it is drawn above it.
 * A dialog that needs more than a question, such as a field for one option, passes it as
 * `children`; one that needs a different frame uses `<Modal>` directly.
 *
 * A refusal stays in the dialog: when `onConfirm` rejects, its message is shown in the error slot
 * as it was worded, and the dialog stays open for Cancel or another try. So `onConfirm` closes the
 * dialog only once the act has succeeded, and lets a failure throw rather than toasting it.
 *
 * @param {React.ReactNode} [title] Names the act ("Delete backup"), not "Confirm".
 *
 * @param {React.ReactNode} [icon] A sized icon element shown before the title.
 *
 * @param {'sm'|'default'|'md'} [size] A step of Modal's width scale, for what `children` hold: sm
 * 400px for a question with no field (the default here), default 480px for stacked form fields, md
 * 560px for a form with a list in it. A typed gate is not a field: a confirm with only `requireTyped`
 * stays sm.
 *
 * @param {React.ReactNode} message What will happen, in the lead paragraph.
 *
 * @param {React.ReactNode} [children] Extra content between the message and the typed gate.
 *
 * @param {string} confirmLabel Verb for the confirming button; name the act where the caller knows
 * it.
 *
 * @param {string} pendingLabel What that button says while the action runs.
 *
 * @param {string} [requireTyped] When set, the operator must type this exact text, the record's own
 * name as the dialog shows it, before the confirming button becomes usable.
 *
 * Typed text guards removing a person's access, whoever they are, and every act that cannot be
 * undone. An act cannot be undone when it destroys something the site holds that nobody can make
 * again from the dashboard: a record with its history or readings, a draft's work, a stored file or a
 * backup. It does not guard:
 * - a security response that must stay quick and can be repeated or replaced: ending a token, a
 *   credential, an app's approval, a session or a second factor;
 * - what a person can simply make again, such as a link, a suppression window, a picture, or an area
 *   plan, 3D model or vocabulary uploaded from a file;
 * - an archive, which Restore undoes;
 * - a deletion that is not a person's click, such as a timer's.
 *
 * @param {string} [requireTypedLabel] What the typed value is ("schema name"), for the field's label.
 *
 * @param {string} [confirmClassName] Button class for the confirming action. Defaults to `btn
 * btn-danger`; a dialog guarding a constructive act (restoring an archived entity) must override
 * it.
 */
export function ConfirmModal({
  title = 'Confirm action',
  icon = null,
  size = 'sm',
  message,
  children,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  pendingLabel = 'Working…',
  requireTyped = null,
  requireTypedLabel = 'name',
  confirmClassName = 'btn btn-danger'
}) {
  const [pending, runConfirm] = usePendingAction()
  const gate = useTypedGate(requireTyped, requireTypedLabel)
  const [error, setError] = useState(null)

  const confirm = () => runConfirm(async () => {
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(err.message)
    }
  })

  // While the action runs, Escape, the × and Cancel are no-ops rather than the layer sitting out:
  // leaving the Escape stack would hand the keypress to the dialog underneath while its mutation
  // is in flight.
  const dismiss = pending ? () => {} : onCancel

  return (
    <Modal
      title={title}
      icon={icon}
      size={size}
      lead={message}
      onClose={dismiss}
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <ActionButton
            className={confirmClassName}
            pending={pending}
            pendingLabel={pendingLabel}
            disabled={!gate.open}
            // Stated rather than left to be inferred from a greyed-out button, which explains
            // nothing about WHY it is greyed out.
            title={gate.reason}
            onClick={confirm}
          >
            {confirmLabel}
          </ActionButton>
        </>
      }
    >
      {children}

      <TypedGate gate={gate} disabled={pending} />
    </Modal>
  )
}
