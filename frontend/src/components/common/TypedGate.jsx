import React, { useId, useState } from 'react'

/**
 * A typed gate's state, held by the dialog whose act it guards. `open` is whether the act may run;
 * `reason` is the held button's tooltip, undefined once it may. With no `required` text there is no
 * gate, and `open` is true. What was typed is compared less the spaces at its ends, which a
 * copy-paste brings, and is otherwise exact, case included.
 *
 * @param {string} [required] The text to type.
 * @param {string} [label] What that text is ("schema name"), for the field's label.
 */
export function useTypedGate(required, label = 'name') {
  const [typed, setTyped] = useState('')
  const gated = typeof required === 'string' && required.trim() !== ''
  const open = !gated || typed.trim() === required.trim()
  return { gated, open, required, label, typed, setTyped, reason: open ? undefined : `Type the ${label} above to enable this` }
}

/**
 * The field of a typed gate, straight after the words that say what is lost. Draws nothing when the
 * gate has no text. Which acts take one is in ConfirmModal's `requireTyped`.
 *
 * @param {Object} gate What `useTypedGate()` returned.
 * @param {boolean} [disabled] While the act runs.
 */
export function TypedGate({ gate, disabled = false }) {
  const id = useId()
  if (!gate.gated) return null

  return (
    <div className="form-group typed-gate">
      <label className="form-label" htmlFor={id}>Type the {gate.label} to confirm</label>
      {/* The value is shown, so the operator looks at which record they are about to act on.
          `mono` because these are ids and underscored names, where l/1 and O/0 matter. */}
      <p className="mono typed-gate-text">{gate.required}</p>
      <input
        id={id}
        className="form-control mono"
        value={gate.typed}
        onChange={e => gate.setTyped(e.target.value)}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        // Not the dialog's initialFocus: focusing the field would move a screen reader's cursor
        // off the message that explains what is about to happen.
        placeholder={gate.required}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="form-hint typed-gate-hint" aria-live="polite">
        {gate.open
          ? 'Matches — the action below is now enabled.'
          : 'The action below stays disabled until this matches exactly.'}
      </p>
    </div>
  )
}
