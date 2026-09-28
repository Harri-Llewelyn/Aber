import React, { useEffect, useMemo, useRef, useState } from 'react'
import { HelpTip } from './HelpTip'
import {
  SEMANTIC_ID_TYPES, followSemanticIdType, storedSemanticIdPair, sameSemanticIdPair
} from '../../utils/standards'
import { searchSemanticIdCandidates, foreignConcept } from '../../utils/semanticIdSources'

/** The most matches the picker lists at once; the rest are reached by narrowing the search. */
const PICKER_LIMIT = 50

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
 * schema, Add Metric and a catalog metric's Edit so they cannot drift apart. `readOnly` shows the
 * pair as text. The type is empty and its select disabled while the id is blank: a type with no id
 * exports as a Reference with no key. `onChange` receives the next `{ semanticId, semanticIdType }`.
 *
 * `suggestion` is the pair the subject's own standard gives it, `{ semanticId, semanticIdType,
 * note }`. It is marked while the field shows it; once replaced, Use suggested hands it back
 * through `onChange`. What the field shows stays the caller's decision.
 *
 * `candidates` (utils/semanticIdSources.js) add a search beside the field; choosing one sends its id
 * and reference type through `onChange`, and typing stays open for ids no source holds. The search
 * is over the list given, not the server. `ownStandard` is the subject's provenance: a metric carries
 * one id, so an id only another standard holds is named under the field as a replacement.
 */
export function SemanticIdField({
  idPrefix, subject = 'schema', semanticId = '', semanticIdType = '', onChange, readOnly = false,
  suggestion = null, candidates = null, ownStandard = '', style
}) {
  const idFor = `${idPrefix}-semantic-id`
  const typeFor = `${idPrefix}-semantic-id-type`
  const hasId = (semanticId || '').trim() !== ''
  const suggested = storedSemanticIdPair(suggestion?.semanticId, suggestion?.semanticIdType)
  const showingSuggestion =
    suggested.semanticId !== '' && sameSemanticIdPair({ semanticId, semanticIdType }, suggested)
  const canRestore = !readOnly && suggested.semanticId !== '' && !showingSuggestion

  const canPick = !readOnly && (candidates?.length || 0) > 0
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef(null)
  useEffect(() => { if (picking) searchRef.current?.focus() }, [picking])
  const { matches, total } = useMemo(
    () => (picking
      ? searchSemanticIdCandidates(candidates, query, { standard: ownStandard, limit: PICKER_LIMIT })
      : { matches: [], total: 0 }),
    [picking, candidates, query, ownStandard]
  )
  const foreign = readOnly ? null : foreignConcept(candidates, semanticId, ownStandard)

  const toggleRef = useRef(null)
  const closePicker = () => { setPicking(false); setQuery('') }
  const choose = (candidate) => {
    onChange?.({ semanticId: candidate.semanticId, semanticIdType: candidate.semanticIdType })
    closePicker()
  }

  // Escape closes the search, not the dialog around it: stopped here, before useEscapeKey's
  // document listener, and focus goes back to the button that opened it.
  const onPickerKeyDown = (e) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    closePicker()
    toggleRef.current?.focus()
  }

  // Each tip is a sibling of its label, never a child: a button inside a label answers to the
  // label's name too, and the control stops being the only thing that does.
  return (
    <div className="form-group" style={style}>
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
            {showingSuggestion && (
              <span className="semantic-id-suggested" title={suggestion.note}>· suggested</span>
            )}
            {(canRestore || canPick) && (
              <span className="semantic-id-actions">
                {canRestore && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => onChange?.({ ...suggested })}
                    title={`Put the suggested id back: ${suggested.semanticId}`}
                  >
                    Use suggested
                  </button>
                )}
                {canPick && (
                  <button
                    ref={toggleRef}
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-expanded={picking}
                    aria-controls={`${idPrefix}-semantic-id-picker`}
                    onClick={() => (picking ? closePicker() : setPicking(true))}
                    title="Find a concept's id in the standard vocabularies and the IDTA templates"
                  >
                    {picking ? 'Close search' : 'Search vocabularies'}
                  </button>
                )}
              </span>
            )}
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

      {picking && (
        <div className="semantic-id-picker" id={`${idPrefix}-semantic-id-picker`} onKeyDown={onPickerKeyDown}>
          <input
            ref={searchRef}
            className="form-control"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by name, standard or id…"
            aria-label="Search the vocabularies and templates"
          />
          <div className="semantic-id-picker-note">
            {ownStandard
              ? `A metric carries one semantic id: another standard's concept replaces the ${ownStandard} one, and the metric stays ${ownStandard} by provenance.`
              : 'Choosing a concept sets the id and its reference type. You can still type any id.'}
          </div>
          {query.trim() !== '' && total === 0 && (
            <div className="semantic-id-picker-note">
              Nothing matches “{query.trim()}”. You can still type the id into the field.
            </div>
          )}
          {matches.length > 0 && (
            <ul className="semantic-id-picker-list" aria-label="Matching concepts">
              {matches.map(c => (
                <li key={`${c.standard}|${c.semanticId}|${c.label}`}>
                  <button
                    type="button"
                    className="semantic-id-picker-option"
                    onClick={() => choose(c)}
                    title={c.detail || undefined}
                  >
                    <span className="semantic-id-picker-head">
                      <span>{c.label}</span>
                      <span className="badge badge-neutral" style={{ fontSize: '11px' }}>{c.standard}</span>
                    </span>
                    <span className="mono semantic-id-picker-id">{c.semanticId}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {total > matches.length && (
            <div className="semantic-id-picker-note">
              Showing {matches.length} of {total}. Narrow the search to see the rest.
            </div>
          )}
        </div>
      )}

      {/* Describes the id the field holds, however it got there, so it outlasts the search. */}
      {foreign && (
        <div className="semantic-id-picker-note" role="note">
          <span className="mono">{foreign.label}</span> comes from {foreign.standard}. A metric carries
          one semantic id, so it replaces any {ownStandard} id; the metric stays {ownStandard} by
          provenance.
        </div>
      )}
    </div>
  )
}
