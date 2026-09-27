import React from 'react'
import { IconRefreshCw } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { usePendingAction } from '../../hooks/usePendingAction'

/**
 * The confirmation for undoing a deprecation (#468), shaped like DeprecateMetricModal. `replacement`
 * is the catalog row `superseded_by` names, or null; restoring clears that pointer.
 */
export function RestoreMetricModal({ metric, replacement, onConfirm, onCancel }) {
  const [restoring, runRestore] = usePendingAction()

  // Escape closes through the shared stack. Inert mid-flight; see ConfirmModal.
  useEscapeKey(restoring ? () => {} : onCancel)

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconRefreshCw size={18} />
          <span>Restore Metric <span className="mono">{metric.name}</span></span>
        </div>

        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
          This returns <strong>{metric.name}</strong> to the schema builder's picker — it will be
          offered to schema authors for new schemas again. Schemas that already model it are
          unchanged; deprecating never removed it from them. {metric.superseded_by ? (
            replacement ? (
              <>It is marked as superseded by <strong className="mono">{replacement.name}</strong>, and
                restoring clears that pointer: a current metric cannot also be replaced.</>
            ) : (
              <>It carries a replacement pointer, and restoring clears it: a current metric cannot
                also be replaced.</>
            )
          ) : (
            <>It names no replacement, so there is no pointer to clear.</>
          )}
        </p>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={restoring} title="Cancel">Cancel</button>
          <ActionButton
            className="btn btn-primary"
            pending={restoring}
            pendingLabel="Restoring…"
            onClick={() => runRestore(onConfirm)}
            title="Confirm restore"
          >
            Restore Metric
          </ActionButton>
        </div>
      </div>
    </div>
  )
}
