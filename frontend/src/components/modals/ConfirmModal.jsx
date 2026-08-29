import React, { useState } from 'react'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'

/**
 * @param {string}   confirmLabel  Verb for the confirming button. The default suits a generic
 *                                 question; name the act where the caller knows it.
 * @param {string}   pendingLabel  What that button says while the action runs.
 * @param {string}   [requireTyped]  When set, the operator must type this exact text before the
 *                                 confirming button becomes usable. See below.
 * @param {string}   [requireTypedLabel]  What the typed value IS, for the field's label.
 * @param {string}   [confirmClassName]  Button class for the confirming action. Defaults to
 *                                 `btn btn-danger`, which is right for the destructive callers
 *                                 that make up most of them -- but NOT for all of them: a dialog
 *                                 guarding a constructive act (restoring an archived entity) that
 *                                 painted its confirm button red would tell the operator they were
 *                                 about to destroy something, which is the opposite of true. A
 *                                 confirmation exists to make somebody read; a mislabelled colour
 *                                 makes them read the wrong thing.
 */
export function ConfirmModal({
  message,
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
   * OPT-IN, NOT THE DEFAULT, and that is the whole design of this prop (issue #38).
   *
   * This dialog has ten callers and most of them guard something reversible -- archiving an asset,
   * discarding a draft, deprecating a metric. Making everyone type a name would train people to
   * copy-paste through the one dialog where reading it matters, which is the opposite of what the
   * issue asks for. Friction only buys attention while it is rare.
   *
   * TRIMMED BEFORE COMPARING, but otherwise exact -- case included. Trailing whitespace is what a
   * copy-paste out of the table beside it brings along, and rejecting that teaches nothing; a
   * different case means they typed a different name.
   */
  const gated = typeof requireTyped === 'string' && requireTyped.length > 0
  const satisfied = !gated || typed.trim() === requireTyped

  // Escape closes. Via the shared stack rather than a listener of this component's own,
  // because a ConfirmModal can open on top of this one and a bare document listener on each
  // would let one keypress dismiss both.
  //
  // While the action runs Escape becomes a no-op rather than sitting the layer out: passing
  // `active: false` would pop this off the stack and hand the keypress to the dialog UNDERNEATH,
  // so an impatient Escape would dismiss the form that asked the question while its mutation was
  // still in flight.
  useEscapeKey(pending ? () => {} : onCancel)

  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }}>
      <div className="modal modal-sm">
        <div className="modal-title">Confirm Action</div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13px', margin: '12px 0 20px' }}>{message}</p>

        {gated && (
          <div className="form-group" style={{ marginBottom: '20px' }}>
            <label className="form-label" htmlFor="confirm-typed">
              Type the {requireTypedLabel} to confirm
            </label>
            {/* THE VALUE IS SHOWN, not hidden behind a memory test. The point is to make the
                operator look at WHICH asset they are about to destroy -- a dialog that made them
                recall the name would just send them back to the table with the dialog still open.
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
              // Not autoFocus: this dialog is opened by a click on a row, and focusing a text field
              // moves the screen reader's cursor off the message that explains what is about to
              // happen -- which is the sentence the field exists to make them read.
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

        <div className="modal-actions">
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
        </div>
      </div>
    </div>
  )
}
