import React from 'react'
import { HelpTip } from './HelpTip'
import { SEMANTIC_ID_TYPES, followSemanticIdType } from '../../utils/standards'

/** What the id asserts, by what carries it. */
const HELP = {
  schema: 'The published id of the standard Submodel this schema matches, such as an IDTA '
    + "template's IRI. Leave it blank for a schema you composed yourself: a claim it does not meet "
    + 'is worse than none.',
  metric: 'The published id of the concept this metric measures, which the AAS export carries so a '
    + "consumer can match it with other systems' data. Clearing it leaves the metric unmapped, "
    + 'which is legitimate.'
}

const TYPE_HELP = 'How to read the id: IRI for a URL or URN, IRDI for an ECLASS or IEC CDD code. '
  + 'Guessed from what you type; change it if the guess is wrong.'

const PLACEHOLDER = {
  schema: 'e.g. https://admin-shell.io/idta/nameplate/3/0/Nameplate',
  metric: 'e.g. http://opcfoundation.org/UA/Machinery/Manufacturer'
}

const LABEL_ROW = { display: 'flex', alignItems: 'center', marginBottom: '7px' }
const LABEL = { marginBottom: 0 }

/**
 * A semantic id and its AAS reference type as one field, shared by the Schema builder, a draft
 * schema and a catalog metric's Edit so the three cannot drift apart. `readOnly` shows the pair as
 * text. The type is empty and its select disabled while the id is blank: a type with no id exports
 * as a Reference with no key. `onChange` receives the next `{ semanticId, semanticIdType }`.
 */
export function SemanticIdField({
  idPrefix, subject = 'schema', semanticId = '', semanticIdType = '', onChange, readOnly = false
}) {
  const idFor = `${idPrefix}-semantic-id`
  const typeFor = `${idPrefix}-semantic-id-type`
  const hasId = (semanticId || '').trim() !== ''

  // Each tip is a sibling of its label, never a child: a button inside a label answers to the
  // label's name too, and the control stops being the only thing that does.
  return (
    <div className="form-group">
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={LABEL_ROW}>
            {readOnly
              ? <span className="form-label" style={LABEL}>Semantic ID</span>
              : (
                <label className="form-label" style={LABEL} htmlFor={idFor}>
                  Semantic ID <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>(optional)</span>
                </label>
              )}
            <HelpTip text={HELP[subject]} label="What a semantic ID is for" />
          </div>
          {readOnly ? (
            <div className="mono" style={{ fontSize: '12px', wordBreak: 'break-all', color: hasId ? 'var(--text-primary)' : 'var(--text-dim)' }}>
              {hasId ? semanticId : '—'}
            </div>
          ) : (
            <input
              id={idFor}
              className="form-control mono"
              style={{ fontSize: '11px' }}
              value={semanticId}
              onChange={e => onChange?.({
                semanticId: e.target.value,
                semanticIdType: followSemanticIdType(semanticId, semanticIdType, e.target.value)
              })}
              placeholder={PLACEHOLDER[subject]}
            />
          )}
        </div>

        <div style={{ flex: '0 0 140px' }}>
          <div style={LABEL_ROW}>
            {readOnly
              ? <span className="form-label" style={LABEL}>Reference Type</span>
              : <label className="form-label" style={LABEL} htmlFor={typeFor}>Reference Type</label>}
            <HelpTip text={TYPE_HELP} label="What the reference type says" />
          </div>
          {readOnly ? (
            <div style={{ fontSize: '12px', color: hasId && semanticIdType ? 'var(--text-primary)' : 'var(--text-dim)' }}>
              {hasId && semanticIdType ? semanticIdType : '—'}
            </div>
          ) : (
            <select
              id={typeFor}
              className="form-control"
              value={hasId ? semanticIdType : ''}
              disabled={!hasId}
              onChange={e => onChange?.({ semanticId, semanticIdType: e.target.value })}
              title={hasId ? undefined : 'Enter a semantic id first: a type with no id says nothing'}
            >
              <option value="">— None —</option>
              {SEMANTIC_ID_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
        </div>
      </div>
    </div>
  )
}
