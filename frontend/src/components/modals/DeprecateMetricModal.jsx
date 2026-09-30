import React, { useState } from 'react'
import { IconAlertTriangle } from '../common/Icons'
import { ConfirmModal } from './ConfirmModal'

export function DeprecateMetricModal({ metric, usageCount, catalog, onConfirm, onCancel }) {
  const [supersededBy, setSupersededBy] = useState('')

  const replacementCandidates = (catalog || []).filter(m => !m.deprecated && m.metric_uuid !== metric.metric_uuid)

  return (
    <ConfirmModal
      title={<>Deprecate metric <span className="mono">{metric.name}</span></>}
      size="md"
      icon={<IconAlertTriangle size={18} />}
      message={<>
        This retires <strong>{metric.name}</strong> from the schema builder's picker — it will no
        longer be offered for new schemas. {usageCount > 0 ? (
          <>It is currently referenced by <strong>{usageCount}</strong> existing schema{usageCount === 1 ? '' : 's'}, which will be left unchanged and keep working exactly as before.</>
        ) : (
          <>It is not currently referenced by any schema.</>
        )} The metric's name and datatype can never be edited, because devices publish them —
        deprecating and adding a new catalog entry is the only way to change either. A wrong
        semantic id is corrected with Edit instead.
      </>}
      confirmLabel="Deprecate Metric"
      pendingLabel="Deprecating…"
      onConfirm={() => onConfirm(supersededBy || null)}
      onCancel={onCancel}
    >
      <div className="form-group">
        <label className="form-label" htmlFor="deprecate-superseded-by">Superseded By (optional)</label>
        <select
          id="deprecate-superseded-by"
          className="form-control"
          value={supersededBy}
          onChange={e => setSupersededBy(e.target.value)}
          title="Point future schema authors at a replacement metric"
        >
          <option value="">— No replacement —</option>
          {replacementCandidates.map(m => (
            <option key={m.metric_uuid} value={m.metric_uuid}>{m.name}</option>
          ))}
        </select>
      </div>
    </ConfirmModal>
  )
}
