import React, { useState } from 'react'
import { IconPencil } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { SemanticIdField } from '../common/SemanticIdField'
import { datatypeLabel } from '../../utils/sparkplugDatatype'
import { storedSemanticIdPair } from '../../utils/standards'
import { Modal } from '../common/Modal'
import { usePendingAction } from '../../hooks/usePendingAction'

/**
 * Correct a catalog metric's semantic id and reference type, the only columns it changes. The name
 * and datatype are shown and not offered: devices publish them. It is also the confirmation, so it
 * says how many schemas model the metric, as DeprecateMetricModal does, because every shell
 * exported from one of them carries the new id. `suggestion` is the pair Add Metric would suggest
 * for the metric's standard and type, which Use suggested restores; `candidates` feed the field's
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
  const changed = next.semanticId !== stored.semanticId || next.semanticIdType !== stored.semanticIdType

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
            disabled={!changed}
            pending={saving}
            pendingLabel="Saving…"
            onClick={() => runSave(() => onConfirm({
              semantic_id: next.semanticId,
              semantic_id_type: next.semanticIdType
            }))}
            title={changed ? 'Save the semantic id and reference type' : 'No changes to save'}
          >
            Save Semantic ID
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
      </p>
    </Modal>
  )
}
