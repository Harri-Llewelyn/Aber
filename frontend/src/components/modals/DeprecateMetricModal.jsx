import React, { useState } from 'react'
import { IconAlertTriangle } from '../common/Icons'
import { ConfirmModal } from './ConfirmModal'
import { MetricPicker } from '../common/MetricPicker'

export function DeprecateMetricModal({ metric, usageCount, catalog, onConfirm, onCancel }) {
  const [supersededBy, setSupersededBy] = useState('')

  // A derived metric is replaced by another derived one: a changed definition is a new metric.
  const replacementCandidates = (catalog || []).filter(m =>
    !m.deprecated && m.metric_uuid !== metric.metric_uuid && (!metric.derivation || m.derivation))
  const replacement = replacementCandidates.find(m => m.metric_uuid === supersededBy)

  return (
    <ConfirmModal
      title={<>Deprecate Metric <span className="mono">{metric.name}</span></>}
      size="md"
      icon={<IconAlertTriangle size={18} />}
      message={metric.derivation ? <>
        This moves <strong>{metric.name}</strong> from the Derived tab to the Deprecated Metrics tab. {usageCount > 0 ? (
          <><strong>{usageCount}</strong> schema{usageCount === 1 ? ' names' : 's name'} it and {usageCount === 1 ? 'keeps' : 'keep'} it, so their
          devices still have it. No other schema can name it.</>
        ) : (
          <>No schema names it, and none can once it is deprecated.</>
        )} Its definition can never be changed, so a different one
        is a new derived metric: add it first, then name it below as this one's replacement.
      </> : <>
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
      {/* The schema builder's metric list, radio buttons: one replacement, or none. A radio cannot be
          unpicked, so the choice is stated beneath the list with a way to clear it. */}
      <div className="form-group" role="group" aria-labelledby="deprecate-superseded-label">
        <span className="form-label" id="deprecate-superseded-label">Superseded By (optional)</span>
        <p className="form-hint" style={{ marginTop: 0 }}>
          {metric.derivation ? 'The derived metric that takes its place.' : 'Point future schema authors at a replacement metric.'}
        </p>
        <MetricPicker
          metrics={replacementCandidates}
          single
          isPicked={m => m.metric_uuid === supersededBy}
          onPick={m => setSupersededBy(m.metric_uuid)}
          listStyle={{ flex: 'none', height: '220px' }}
          emptyText={metric.derivation ? 'No other derived metric can take its place.' : 'No other metric can take its place.'}
        />
        <div className="form-hint" style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '28px' }}>
          {replacement ? (
            <>
              <span>Replaced by <span className="mono">{replacement.name}</span></span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSupersededBy('')}>
                No Replacement
              </button>
            </>
          ) : 'No replacement chosen.'}
        </div>
      </div>
    </ConfirmModal>
  )
}
