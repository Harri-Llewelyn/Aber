import React, { useMemo, useState } from 'react'
import { IconPencil } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { SemanticIdField } from '../common/SemanticIdField'
import { FurtherSemanticIdsEditor } from '../common/FurtherSemanticIds'
import { PermittedValuesField } from '../common/PermittedValuesField'
import { datatypeLabel } from '../../utils/sparkplugDatatype'
import { storedSemanticIdPair } from '../../utils/standards'
import { furtherIdProblem, furtherIdsChange, furtherIdsOf } from '../../utils/furtherSemanticIds'
import {
  parsePermittedValues, permittedValuesApply, permittedValuesText, samePermittedValues
} from '../../utils/schemaProperty'
import { Modal } from '../common/Modal'
import { useFormCheck } from '../../hooks/useFormCheck'
import { usePendingAction } from '../../hooks/usePendingAction'

/**
 * Correct a catalog metric's semantic id and reference type, its further semantic ids, and the values
 * it may report: the only things it changes. The name and datatype are shown and not offered: devices
 * publish them. It is also the confirmation, so it says how many schemas model the metric, as
 * DeprecateMetricModal does. `onConfirm` receives only what changed: the pair, `permitted_values`
 * (a list, or null to clear it), `further_semantic_ids` (`{ add, remove }`), or any of them.
 * `suggestion` is the pair Add Metric would suggest for the metric's standard and type, which Use
 * suggested restores; `candidates` feed the fields' vocabulary search (both from
 * utils/semanticIdSources.js). A refusal of the save is shown in the dialog as the database worded it.
 */
export function EditMetricSemanticIdModal({
  metric, usageCount, suggestion = null, candidates = null, onConfirm, onCancel
}) {
  const [saving, runSave] = usePendingAction()
  const [error, setError] = useState(null)

  const stored = storedSemanticIdPair(metric.semantic_id, metric.semantic_id_type)
  const [pair, setPair] = useState(stored)
  const next = storedSemanticIdPair(pair.semanticId, pair.semanticIdType)
  const pairChanged = next.semanticId !== stored.semanticId || next.semanticIdType !== stored.semanticIdType

  // Compared as parsed lists once typed into: a stored value holding a comma reads back as two,
  // so an untouched field must never count as an edit.
  const takesValues = permittedValuesApply(metric.datatype)
  const storedText = permittedValuesText(metric.permitted_values)
  const [valuesText, setValuesText] = useState(storedText)
  const parsed = parsePermittedValues(valuesText, metric.datatype)
  const valuesChanged = takesValues && valuesText !== storedText &&
    !parsed.error && !samePermittedValues(parsed.values, metric.permitted_values)

  // The further ids as the dialog holds them: the metric's own list, edited here and written on Save.
  const savedFurther = useMemo(() => furtherIdsOf(metric), [metric])
  const [further, setFurther] = useState(savedFurther)
  const [draft, setDraft] = useState({ semanticId: '', semanticIdType: '' })
  const [draftSource, setDraftSource] = useState('')
  const furtherChange = furtherIdsChange(savedFurther, further)
  const addedFurther = further.filter(r => !savedFurther.some(s => s.semanticId === r.semanticId)).map(r => r.semanticId)
  const typedDraft = draft.semanticId.trim() !== ''
  const draftProblem = furtherIdProblem({
    draft, source: draftSource, ownId: next.semanticId, listed: further.map(r => r.semanticId)
  })
  const addFurther = () => {
    const pair = storedSemanticIdPair(draft.semanticId, draft.semanticIdType)
    setFurther(list => [...list, { semanticId: pair.semanticId, semanticIdType: pair.semanticIdType, source: draftSource.trim() }]
      .sort((a, b) => a.semanticId.localeCompare(b.semanticId)))
    setDraft({ semanticId: '', semanticIdType: '' })
    setDraftSource('')
  }
  const removeFurther = (id) => setFurther(list => list.filter(r => r.semanticId !== id))

  // What is wrong with the id typed under Further Semantic ID is said under it, as it is typed.
  const ownIdIsFurther = next.semanticId !== '' && further.some(r => r.semanticId === next.semanticId)
  const ownProblem = further.length > 0 && next.semanticId === ''
    ? 'The further ids need an id of the metric’s own beside them. Keep its semantic id, or remove them first.'
    : ownIdIsFurther ? 'The metric’s own id is also one of its further ids. Remove it from that list first.'
      : null
  const check = useFormCheck({
    ownId: { id: 'metric-edit-semantic-id', wrong: ownProblem },
    further: {
      id: 'metric-edit-further-new-semantic-id',
      missing: typedDraft && !draftProblem && 'Press Add to keep the further id you typed, or clear it.',
      wrong: typedDraft && draftProblem,
    },
    values: { id: 'metric-edit-permitted-values', wrong: takesValues && parsed.error },
  }, { unchanged: !pairChanged && !valuesChanged && furtherChange === null })

  const save = () => runSave(async () => {
    setError(null)
    try {
      await onConfirm({
        ...(pairChanged && { semantic_id: next.semanticId, semantic_id_type: next.semanticIdType }),
        ...(valuesChanged && { permitted_values: parsed.values }),
        ...(furtherChange && { further_semantic_ids: furtherChange })
      })
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <Modal
      title="Edit Metric"
      subject={metric.name}
      icon={<IconPencil size={18} />}
      size="md"
      busy={saving}
      onClose={onCancel}
      lead={`Changes the metric's semantic id and further IDs${takesValues ? ', and the values it permits' : ''}.`}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={
        <ActionButton className="btn btn-primary" pending={saving} pendingLabel="Saving…" onClick={() => check.press(save)}>
          Save Metric
        </ActionButton>
      }
    >
      <div className="form-group metric-edit-facts">
        <div>
          <div className="form-label">Name</div>
          <div className="mono">{metric.name}</div>
        </div>
        <div>
          <div className="form-label">Sparkplug Datatype</div>
          <div>{datatypeLabel(metric.datatype)}</div>
        </div>
      </div>

      <SemanticIdField
        idPrefix="metric-edit"
        subject="metric"
        semanticId={pair.semanticId}
        semanticIdType={pair.semanticIdType}
        suggestion={suggestion}
        candidates={candidates}
        ownStandard={metric.standard || ''}
        onChange={setPair}
        error={check.errors.ownId}
      />

      <FurtherSemanticIdsEditor
        idPrefix="metric-edit-further"
        ids={further}
        added={addedFurther}
        ownId={next.semanticId}
        candidates={candidates}
        draft={draft}
        source={draftSource}
        onDraft={setDraft}
        onSource={setDraftSource}
        onAdd={addFurther}
        onRemove={removeFurther}
      />

      {takesValues && (
        <PermittedValuesField
          idPrefix="metric-edit"
          datatype={metric.datatype}
          value={valuesText}
          onChange={setValuesText}
          error={check.errors.values}
        />
      )}

      <p className="form-hint">
        {usageCount > 0 ? (
          <>
            <strong>{usageCount}</strong> schema{usageCount === 1 ? ' models' : 's model'} this
            metric. Every AAS shell exported from {usageCount === 1 ? 'it' : 'them'} will carry the
            new id, so a consumer matching on the old one stops finding it. To keep it found, add
            the old id as a further ID.
          </>
        ) : (
          <>No schema models this metric yet, so no exported shell carries its id.</>
        )} The name and datatype stay as they are: devices publish them.
        {takesValues && (
          <> A published schema keeps the permitted values it was built with. The next version saved
            takes these.</>
        )}
      </p>
    </Modal>
  )
}
