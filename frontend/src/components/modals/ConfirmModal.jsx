import React, { useState } from 'react'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'

/**
 * A question with two answers, in a `<Modal>` on the confirm layer (above the dialog that asked).
 * A dialog that needs more than a question, such as a field for one option, passes it as
 * `children`; one that needs a different frame uses `<Modal>` directly.
 *
 * @param {React.ReactNode} [title] Names the act ("Delete backup"), not "Confirm".
 *
 * @param {React.ReactNode} [icon] A sized icon element shown before the title.
 *
 * @param {'sm'|'md'} [size] Width step; `sm` for a plain question, `md` when `children` hold a form.
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
 * @param {string} [requireTyped] When set, the operator must type this exact text before the
 * confirming button becomes usable.
 *
 * @param {string} [requireTypedLabel] What the typed value is, for the field's label.
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
  const [typed, setTyped] = useState('')

  /**
   * Opt-in, not the default: most callers guard something reversible, and friction only buys
   * attention while it is rare. Trimmed before comparing (a copy-paste brings trailing whitespace)
   * but otherwise exact, case included.
   */
  const gated = typeof requireTyped === 'string' && requireTyped.length > 0
  const satisfied = !gated || typed.trim() === requireTyped

  // While the action runs, Escape, the × and Cancel are no-ops rather than the layer sitting out:
  // leaving the Escape stack would hand the keypress to the dialog underneath while its mutation
  // is in flight.
  const dismiss = pending ? () => {} : onCancel

  return (
    <Modal
      title={title}
      icon={icon}
      size={size}
      layer="confirm"
      lead={message}
      onClose={dismiss}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <ActionButton
            className={confirmClassName}
            pending={pending}
            pendingLabel={pendingLabel}
            disabled={!satisfied}
            // Stated rather than left to be inferred from a greyed-out button, which explains
            // nothing about WHY it is greyed out.
            title={satisfied ? undefined : `Type the ${requireTypedLabel} above to enable this`}
            onClick={() => runConfirm(() => onConfirm())}
          >
            {confirmLabel}
          </ActionButton>
        </>
      }
    >
      {children}

      {gated && (
        <div className="form-group" style={{ marginBottom: '20px' }}>
          <label className="form-label" htmlFor="confirm-typed">
            Type the {requireTypedLabel} to confirm
          </label>
          {/* The value is shown, so the operator looks at which asset they are about to destroy.
              `mono` because these are ids and underscored names, where l/1 and O/0 matter. */}
          <p className="mono" style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 6px' }}>
            {requireTyped}
          </p>
          <input
            id="confirm-typed"
            className="form-control mono"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            disabled={pending}
            autoComplete="off"
            spellCheck={false}
            // Not autoFocus: focusing the field would move a screen reader's cursor off the
            // message that explains what is about to happen.
            placeholder={requireTyped}
            aria-describedby="confirm-typed-hint"
          />
          <p
            id="confirm-typed-hint"
            style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '6px 0 0' }}
          >
            {satisfied
              ? 'Matches — the action below is now enabled.'
              : 'The action below stays disabled until this matches exactly.'}
          </p>
        </div>
      )}
    </Modal>
  )
}
