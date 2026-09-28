import React, { useState } from 'react'
import { IconPencil } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { SemanticIdField } from '../common/SemanticIdField'
import { datatypeLabel } from '../../utils/sparkplugDatatype'
import { storedSemanticIdPair } from '../../utils/standards'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { usePendingAction } from '../../hooks/usePendingAction'

/**
 * Correct a catalog metric's semantic id and reference type, the only columns it changes. The name
 * and datatype are shown and not offered: devices publish them. It is also the confirmation, so it
 * says how many schemas model the metric, as DeprecateMetricModal does, because every shell
 * exported from one of them carries the new id. `suggestion` is the pair Add Metric would suggest
 * for the metric's standard and type (utils/semanticIdSources.js), which Use suggested restores.
 */
export function EditMetricSemanticIdModal({ metric, usageCount, suggestion = null, onConfirm, onCancel }) {
  const [saving, runSave] = usePendingAction()

  // Escape closes through the shared stack. Inert mid-flight; see ConfirmModal.
  useEscapeKey(saving ? () => {} : onCancel)

  const stored = storedSemanticIdPair(metric.semantic_id, metric.semantic_id_type)
  const [pair, setPair] = useState(stored)
  const next = storedSemanticIdPair(pair.semanticId, pair.semanticIdType)
  const changed = next.semanticId !== stored.semanticId || next.semanticIdType !== stored.semanticIdType

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconPencil size={18} />
          <span>Edit Metric <span className="mono">{metric.name}</span></span>
        </div>

        <div className="form-group" style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
          <div>
            <div className="form-label">Name</div>
            <div className="mono" style={{ fontSize: '12px' }}>{metric.name}</div>
          </div>
          <div>
            <div className="form-label">Sparkplug Datatype</div>
            <div style={{ fontSize: '12px' }}>{datatypeLabel(metric.datatype)}</div>
          </div>
        </div>

        <SemanticIdField
          idPrefix="metric-edit"
          subject="metric"
          semanticId={pair.semanticId}
          semanticIdType={pair.semanticIdType}
          suggestion={suggestion}
          onChange={setPair}
        />

        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
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

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={saving} title="Cancel">Cancel</button>
          <ActionButton
            className={`btn btn-primary ${!changed ? 'btn-disabled' : ''}`}
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
        </div>
      </div>
    </div>
  )
}
