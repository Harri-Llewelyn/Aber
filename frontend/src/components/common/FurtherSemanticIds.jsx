import React, { useEffect, useState } from 'react'
import { ActionButton } from './ActionButton'
import { Badge } from './Badge'
import { FormProblem } from './FormProblem'
import { HelpTip } from './HelpTip'
import { SemanticIdField } from './SemanticIdField'
import {
  FURTHER_SOURCE_MAX_LENGTH, MAX_FURTHER_SEMANTIC_IDS, furtherIdProblem
} from '../../utils/furtherSemanticIds'

const HELP = 'Other published ids of the concept this metric measures, such as the id a submodel '
  + 'template gives it. The AAS export carries them beside the metric’s own id, so a consumer that '
  + 'matches on any of them finds the metric. '
  + `At most ${MAX_FURTHER_SEMANTIC_IDS} a metric.`

const NO_DRAFT = { semanticId: '', semanticIdType: '' }

/**
 * A metric's further semantic ids as text: each id in `mono` with its reference type and, when it
 * has one, where the equivalence comes from. With `onRemove` each row has a Remove button, and
 * `added` names the ids not saved yet. Without it the list is static, which is all a person who
 * cannot write the catalogue sees, and what the metric's drawer draws.
 *
 * @param {{ semanticId: string, semanticIdType: string, source: string }[]} ids
 */
export function FurtherSemanticIdList({ ids, added = [], onRemove }) {
  if (ids.length === 0) return <div className="further-ids-none">None</div>
  return (
    <ul className="further-ids" aria-label="Further semantic IDs">
      {ids.map(row => (
        <li key={row.semanticId} className="further-id">
          <span className="further-id-value mono">{row.semanticId}</span>
          <span className="further-id-meta">
            <span className="further-id-type">{row.semanticIdType}</span>
            {row.source && <span className="further-id-source">{row.source}</span>}
            {added.includes(row.semanticId) && <Badge tone="info" size="sm">New</Badge>}
          </span>
          {onRemove && (
            <button
              type="button"
              className="btn btn-ghost btn-sm further-id-remove"
              aria-label={`Remove further semantic id ${row.semanticId}`}
              onClick={() => onRemove(row.semanticId)}
            >
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * The list a metric's Edit dialog edits: the further ids it holds, Remove on each, and Add Further ID,
 * which opens a field to add one with its reference type, the vocabulary search and an optional
 * source. An id is added to the list with Add and written when the dialog saves, so the draft and the
 * list are the dialog's state: `draft` is the `{ semanticId, semanticIdType }` typed, `source` its
 * source. `ownId` is the metric's own id as the dialog now holds it, which a further id may not
 * equal. At the limit the button is replaced by a sentence saying why.
 */
export function FurtherSemanticIdsEditor({
  idPrefix, ids, added, ownId, candidates, draft, source, onDraft, onSource, onAdd, onRemove
}) {
  const [adding, setAdding] = useState(false)
  const listed = ids.map(row => row.semanticId)
  const typed = draft.semanticId.trim() !== ''
  const problem = furtherIdProblem({ draft, source, ownId, listed })
  const full = ids.length >= MAX_FURTHER_SEMANTIC_IDS
  const headingId = `${idPrefix}-heading`
  const fieldId = `${idPrefix}-new-semantic-id`

  useEffect(() => { if (adding) document.getElementById(fieldId)?.focus() }, [adding, fieldId])

  const close = () => { setAdding(false); onDraft(NO_DRAFT); onSource('') }
  const add = () => { onAdd(); setAdding(false) }

  return (
    <div className="form-group further-ids-group" role="group" aria-labelledby={headingId}>
      <div className="further-ids-head">
        <span className="form-label" id={headingId}>
          Further Semantic IDs <span className="further-ids-count">({ids.length} of {MAX_FURTHER_SEMANTIC_IDS})</span>
        </span>
        <HelpTip text={HELP} label="What further semantic IDs are for" />
      </div>

      <FurtherSemanticIdList ids={ids} added={added} onRemove={onRemove} />

      {full && !adding && (
        <p className="form-hint">
          A metric carries at most {MAX_FURTHER_SEMANTIC_IDS} further semantic ids. Remove one to add another.
        </p>
      )}
      {!full && !adding && (
        <button type="button" className="btn btn-ghost btn-sm further-ids-add" onClick={() => setAdding(true)}>
          Add Further ID
        </button>
      )}
      {adding && (
        <div className="further-ids-form">
          <SemanticIdField
            idPrefix={`${idPrefix}-new`}
            subject="further"
            semanticId={draft.semanticId}
            semanticIdType={draft.semanticIdType}
            candidates={candidates}
            onChange={onDraft}
          />
          <div className="form-group">
            <label className="form-label" htmlFor={`${idPrefix}-source`}>
              Source <span className="further-ids-count">(optional)</span>
            </label>
            <input
              id={`${idPrefix}-source`}
              className="form-control"
              value={source}
              onChange={e => onSource(e.target.value)}
              placeholder="e.g. ECLASS 14.0, or the template that names the concept this way"
              aria-describedby={`${idPrefix}-source-hint`}
            />
            <div className="form-hint" id={`${idPrefix}-source-hint`}>
              Where the equivalence comes from. Up to {FURTHER_SOURCE_MAX_LENGTH} characters.
            </div>
          </div>
          <FormProblem problem={problem} />
          <div className="further-ids-form-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={close}>Cancel</button>
            <ActionButton
              className="btn btn-primary btn-sm"
              disabled={!typed || Boolean(problem)}
              onClick={add}
              title={typed ? undefined : 'Type or search for an id first'}
            >
              Add
            </ActionButton>
          </div>
        </div>
      )}
    </div>
  )
}
