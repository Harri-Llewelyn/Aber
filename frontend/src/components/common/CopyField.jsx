import React, { useId } from 'react'
import { useCopy } from '../../hooks/useCopy'
import { NO_VALUE } from '../../utils/format'
import { FieldError } from './FieldError'
import { IconCheck, IconCopy } from './Icons'
import { Tooltip } from './Tooltip'

/** Selects the whole value, so Ctrl+C takes it when the clipboard refuses. */
const selectValue = (e) => window.getSelection()?.selectAllChildren(e.currentTarget)

/**
 * A value a person copies: a secret shown once, or a setting another program is given. Its name, the
 * value as text in a box, and a copy button whose icon is a tick for a moment. The value is no input,
 * so it does not read as one to type in; a click or Tab selects all of it. A long one wraps, then
 * scrolls inside its box. A copy the browser refuses is said under it, and nowhere else.
 *
 *   <CopyField id="signing-key" label="Signing Key" value={key} hint="Give it to the receiver." />
 *
 * @param {string} id The value's id; the label, the hint and the refusal hang off it.
 * @param {string} label The value's name.
 * @param {string|number} [value] Without one, a dash is shown and there is nothing to copy.
 * @param {string} [copyLabel] What the button copies, in a sentence: "edge node ID". The label in
 *   lower case when left out.
 * @param {React.ReactNode} [hint] What to know about the value, under it.
 * @param {React.ReactNode} [warning] What is wrong with it, under it and before the hint.
 * @param {React.ReactNode} [children] Another control in the row, after the copy button.
 */
export function CopyField({ id, label, value, copyLabel = label.toLowerCase(), hint = null, warning = null, children }) {
  const { copied, refusal, copy } = useCopy()
  const errorId = `${id}-copy-error`
  const hasValue = value !== undefined && value !== null && value !== ''
  const described = [warning && `${id}-warning`, hint && `${id}-hint`].filter(Boolean)
  return (
    <div className="form-group">
      <div className="form-label" id={`${id}-label`}>{label}</div>
      <div className="copy-field">
        <div
          id={id}
          className="copy-field-value mono"
          role="textbox"
          aria-readonly="true"
          aria-multiline="true"
          aria-labelledby={`${id}-label`}
          aria-describedby={[...described, refusal && errorId].filter(Boolean).join(' ') || undefined}
          tabIndex={0}
          onFocus={selectValue}
        >
          {hasValue ? String(value) : NO_VALUE}
        </div>
        <Tooltip text={`Copy ${copyLabel}`}>
          <button
            type="button"
            className={`btn btn-ghost btn-icon${hasValue ? '' : ' btn-disabled'}`}
            onClick={() => copy(String(value))}
            disabled={!hasValue}
            aria-label={`Copy ${copyLabel}`}
            aria-describedby={refusal ? errorId : undefined}
          >
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </button>
        </Tooltip>
        {children}
      </div>
      {warning && <div id={`${id}-warning`} className="form-hint hint-warning">{warning}</div>}
      {hint && <div id={`${id}-hint`} className="form-hint">{hint}</div>}
      <FieldError id={errorId} error={refusal} />
    </div>
  )
}

/**
 * A block of text a person copies whole, such as a client's setup: what it is with the copy button
 * on one line, the text under it, and `children` as the hint. A refused copy is said under it.
 * Give it a `key` of its own when the text changes under it, so the last one's tick does not stay.
 *
 * @param {string} text What is shown and copied.
 * @param {React.ReactNode} head What the block is: its label, or a control that chooses it.
 * @param {string} [copyLabel] The button's words.
 */
export function CopyBlock({ text, head, copyLabel = 'Copy', children }) {
  const { copied, refusal, copy } = useCopy()
  const errorId = useId()
  return (
    <>
      <div className="gateway-block-head">
        {head}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => copy(text)}
          aria-describedby={refusal ? errorId : undefined}
        >
          {copied ? <><IconCheck size={12} /> Copied</> : <><IconCopy size={12} /> {copyLabel}</>}
        </button>
      </div>
      <pre className="mono gateway-code gateway-code-wrap">{text}</pre>
      {children && <div className="form-hint">{children}</div>}
      <FieldError id={errorId} error={refusal} />
    </>
  )
}
