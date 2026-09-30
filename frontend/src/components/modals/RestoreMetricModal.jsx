import React from 'react'
import { IconRefreshCw } from '../common/Icons'
import { ConfirmModal } from './ConfirmModal'

/**
 * The confirmation for undoing a deprecation, shaped like DeprecateMetricModal. `replacement` is
 * the catalog row `superseded_by` names, or null; restoring clears that pointer.
 */
export function RestoreMetricModal({ metric, replacement, onConfirm, onCancel }) {
  return (
    <ConfirmModal
      title={<>Restore metric <span className="mono">{metric.name}</span></>}
      size="md"
      icon={<IconRefreshCw size={18} />}
      message={<>
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
      </>}
      confirmLabel="Restore metric"
      pendingLabel="Restoring…"
      confirmClassName="btn btn-primary"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
