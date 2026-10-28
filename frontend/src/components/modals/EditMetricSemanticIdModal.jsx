import React, { useState } from 'react'
import { IconPencil } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { SemanticIdField } from '../common/SemanticIdField'
import { PermittedValuesField } from '../common/PermittedValuesField'
import { datatypeLabel } from '../../utils/sparkplugDatatype'
import { storedSemanticIdPair } from '../../utils/standards'
import {
  parsePermittedValues, permittedValuesApply, permittedValuesText, samePermittedValues
} from '../../utils/schemaProperty'
import { Modal } from '../common/Modal'
import { usePendingAction } from '../../hooks/usePendingAction'

/**
 * Correct a catalog metric's semantic id and reference type, and the values it may report: the
 * only columns it changes. The name and datatype are shown and not offered: devices publish them.
 * It is also the confirmation, so it says how many schemas model the metric, as
 * DeprecateMetricModal does. `onConfirm` receives only what changed: the pair, `permitted_values`
 * (a list, or null to clear it), or both. `suggestion` is the pair Add Metric would suggest for the
 * metric's standard and type, which Use suggested restores; `candidates` feed the field's
 * vocabulary search (both from utils/semanticIdSources.js).
 */
export function EditMetricSemanticIdModal({
  metric, usageCount, suggestion = null, candidates = null, onConfirm, onCancel
}) {
  const [saving, runSave] = usePendingAction()

  // Escape, the close button and Cancel do nothing while the save runs, as in ConfirmModal.
  const dismiss = saving ? () => {} : onCancel

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

  const changed = pairChanged || valuesChanged
  const blocked = takesValues && !!parsed.error

  return (
    <Modal
      title={<>Edit Metric <span className="mono">{metric.name}</span></>}
      icon={<IconPencil size={18} />}
      size="md"
      onClose={dismiss}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
          <ActionButton
            className="btn btn-primary"
            disabled={!changed || blocked}
            pending={saving}
            pendingLabel="Saving…"
            onClick={() => runSave(() => onConfirm({
              ...(pairChanged && { semantic_id: next.semanticId, semantic_id_type: next.semanticIdType }),
              ...(valuesChanged && { permitted_values: parsed.values })
            }))}
            title={blocked ? parsed.error : changed ? undefined : 'No changes to save'}
          >
            Save Metric
          </ActionButton>
        </>
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
      />

      {takesValues && (
        <PermittedValuesField
          idPrefix="metric-edit"
          datatype={metric.datatype}
          value={valuesText}
          onChange={setValuesText}
          error={parsed.error}
        />
      )}

      <p className="form-hint">
        {usageCount > 0 ? (
          <>
            <strong>{usageCount}</strong> schema{usageCount === 1 ? ' models' : 's model'} this
            metric. Every AAS shell exported from {usageCount === 1 ? 'it' : 'them'} will carry the
            new id, so a consumer matching on the old one stops finding it.
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
