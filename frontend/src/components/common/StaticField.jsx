import React from 'react'
import CopyableId from './CopyableId'
import { HelpTip } from './HelpTip'

/** What a field with no value says: the drawers' words. */
export const NOT_SET = 'Not set'

const isEmpty = (value) => value === null || value === undefined || value === false || value === ''

/**
 * A value nobody here can change, where its field would be: its name over it, as a drawer field draws
 * one, and why it is fixed in words under it. Never a disabled control, which reads as "you could change
 * this if you were allowed". A description list, so a screen reader reads the name with the value.
 *
 *   <StaticField label="Site Key" value={siteKey} mono copyable reason="Fixed at install." />
 *
 * @param {React.ReactNode} label The field's name, in Title Case.
 * @param {React.ReactNode} value What it holds. An empty one reads Not set.
 * @param {React.ReactNode} [reason] Why it is fixed, or what decides it: "A proposal can't change this."
 * @param {boolean} [mono] An identifier, in the monospace face.
 * @param {boolean} [copyable] An identifier copied by a click, a CopyableId. `value` is then the text
 *   copied, and `copyLabel` names it in what the copy says (the label in lower case when left out).
 * @param {Function} [onCopy] The page's toast, told of each copy.
 * @param {string} [help] A HelpTip beside the name, for a field whose name does not say what it is;
 *   `helpLabel` is its button's name where `label` is not text.
 * @param {React.ReactNode} [children] Drawn under the reason, in the field: another hint about the value.
 */
export function StaticField({
  label, value, reason = null, mono = false, copyable = false, copyLabel, onCopy, help = null, helpLabel,
  className = '', style, children = null
}) {
  const name = typeof label === 'string' ? label : ''
  return (
    <dl className={`form-group static-field${className ? ` ${className}` : ''}`} style={style}>
      <dt className="form-label">
        {label}
        {help && <HelpTip text={help} label={helpLabel || `What ${name} means`} />}
      </dt>
      <dd className={`form-static${mono ? ' mono' : ''}`}>
        {isEmpty(value)
          ? <span className="context-field-empty">{NOT_SET}</span>
          : copyable
            ? <CopyableId value={String(value)} label={copyLabel || name.toLowerCase()} onNotify={onCopy} className="copyable-id-wrap" />
            : value}
      </dd>
      {reason && <dd className="form-hint">{reason}</dd>}
      {children && <dd>{children}</dd>}
    </dl>
  )
}

/** Static fields side by side while the dialog has room, such as a metric's name and its datatype. */
export function StaticFields({ children }) {
  return <div className="static-fields">{children}</div>
}

/** What a list in a form says where it has nothing to show or offer, in a static field's look: one sentence. */
export function StaticEmpty({ children }) {
  return <p className="form-static context-field-empty">{children}</p>
}
