import React from 'react'
import { Tooltip } from './Tooltip'
import { datatypeToJsonSchemaType } from '../../utils/sparkplugDatatype'

const PLACEHOLDER = {
  string: 'e.g. READY, ACTIVE, STOPPED',
  boolean: 'true or false',
  number: 'e.g. 0, 1, 2'
}

const HELP = 'The only values this metric may report, separated by commas; blank allows any. A schema '
  + 'built from it copies them, and a device set to Enforce drops any other value.'

const NUMBER_HELP = 'The only values this metric may report, as whole numbers separated by commas; blank '
  + 'allows any. A schema built from it copies them. Give a measurement a range in the schema builder.'

/**
 * A catalog metric's permitted values as one line of text, shared by Add Metric and Edit so the two
 * cannot drift. The caller holds the text and parses it (utils/schemaProperty.js), and passes the
 * parse's `error`, shown under the field. Render it only where permittedValuesApply() allows.
 */
export function PermittedValuesField({ idPrefix, datatype, value, onChange, error, style }) {
  const id = `${idPrefix}-permitted-values`
  const type = datatypeToJsonSchemaType(datatype)
  return (
    <div className="form-group" style={style}>
      <label className="form-label" htmlFor={id}>Permitted Values</label>
      <Tooltip text={type === 'number' ? NUMBER_HELP : HELP}>
        <input
          id={id}
          className="form-control"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={PLACEHOLDER[type]}
          aria-invalid={error ? true : undefined}
          style={error ? { borderColor: 'var(--danger)' } : undefined}
        />
      </Tooltip>
      {error && (
        <div role="alert" style={{ fontSize: '11px', color: 'var(--danger)', marginTop: '4px' }}>{error}</div>
      )}
    </div>
  )
}
