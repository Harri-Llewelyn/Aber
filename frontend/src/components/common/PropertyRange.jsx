import React from 'react'
import { fieldErrorProps } from './FieldError'
import { Tooltip } from './Tooltip'
import { rangeError } from '../../utils/schemaProperty'

const RANGE_HELP = 'The valid range of this reading in this schema. A device set to Enforce drops a '
  + 'reading outside it. Leave a side blank for no bound.'

/** A range as nobody has typed it. */
export const NO_RANGE = { minimum: '', maximum: '' }

/**
 * A numeric property's valid range, beside its row while it is ticked: what the schema writes as
 * `minimum` and `maximum`. `range` is the typed `{ minimum, maximum }`; `onChange` receives the next
 * one. `id` is the minimum's, and `errorId` that of the FieldError that names this range while it
 * cannot be saved.
 */
export function PropertyRange({ id, name, range, onChange, errorId }) {
  const error = rangeError(range)
  const field = (key, label, placeholder) => (
    <input
      id={key === 'minimum' ? id : undefined}
      type="number"
      step="any"
      className="form-control property-range-bound"
      aria-label={`${label} of ${name}`}
      placeholder={placeholder}
      value={range[key]}
      onChange={e => onChange({ ...range, [key]: e.target.value })}
      {...fieldErrorProps(error, errorId)}
    />
  )
  return (
    <Tooltip text={error || RANGE_HELP}>
      <span className="property-range">
        {field('minimum', 'Minimum', 'min')}
        <span className="property-range-dash" aria-hidden="true">–</span>
        {field('maximum', 'Maximum', 'max')}
      </span>
    </Tooltip>
  )
}
