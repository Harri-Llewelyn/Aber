import React, { useState, useEffect } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { STANDARDS } from '../../utils/standards'
import { VocabularyPanel } from '../common/VocabularyPanel'
import { mtconnectVocabularyTab } from '../common/MTConnectVocabularyPanel'
import { iso22400VocabularyTab } from '../common/ISO22400VocabularyPanel'
import { opcuaVocabularyTab } from '../common/OPCUAVocabularyPanel'
import { ashrae223VocabularyTab } from '../common/ASHRAE223VocabularyPanel'

/**
 * The standard vocabularies, as a page of their own.
 *
 * WHY THIS LEFT THE SCHEMAS PAGE. Schemas carried three stacked concerns -- the schema registry,
 * the metric catalog, and this -- and was the largest tab in the app. The seam is between things
 * you DO and things you LOOK UP: the registry and the catalog are this deployment's state and get
 * edited, while the vocabularies are reference material that is only ever read. The reference half
 * was also the half that grows without anyone here deciding it does: MTConnect alone is ~600
 * entries, the OPC UA tab went from 25 rows to 76 as four companion specifications were added,
 * and ASHRAE 223P -- 563 concepts -- is queued behind them.
 *
 * `onUseEntry` is what keeps the split from costing anything. Clicking Use on an entry still
 * starts a catalog entry from it -- the Schemas page just receives the selection and opens its
 * Add Metric form, rather than the form being on this page. The handover carries IDENTIFIERS, not
 * a prefilled form: the Schemas page holds the vocabularies anyway for its type picker, so it
 * resolves the entry itself and there is exactly one place that knows how a vocabulary row becomes
 * a metric.
 */
export function VocabularyTab({ onUseEntry, hasPermission }) {
  const [vocabulary, setVocabulary] = useState([])
  const [isoVocabulary, setIsoVocabulary] = useState([])
  const [opcuaVocabulary, setOpcuaVocabulary] = useState([])
  const [s223Vocabulary, setS223Vocabulary] = useState([])
  const [catalog, setCatalog] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.get('/api/v1/mtconnect-vocabulary'),
      api.get('/api/v1/iso22400-vocabulary'),
      api.get('/api/v1/opcua-vocabulary'),
      api.get('/api/v1/ashrae223-vocabulary'),
      // The catalog is read only to mark which entries are already in use. A failure there should
      // leave the reference readable rather than blanking the page, so it is defaulted rather
      // than being allowed to reject the whole batch.
      api.get('/api/v1/metric-catalog').catch(() => [])
    ])
      .then(([mt, iso, opcua, s223, cat]) => {
        if (cancelled) return
        setVocabulary(mt || [])
        setIsoVocabulary(iso || [])
        setOpcuaVocabulary(opcua || [])
        setS223Vocabulary(s223 || [])
        setCatalog(cat || [])
        setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // The same permission the Schemas page gates its Add Metric form on -- Use lands on that form,
  // so offering it to someone who cannot submit it would be a dead end.
  const canUse = !!hasPermission?.(PERMISSION_UUIDS.SCHEMA_MANAGE)

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Standard Vocabulary Reference</h2>
      </div>

      <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '0 0 14px 0' }}>
        What the standards define, not what this deployment publishes — a row here is a concept the standard names. The Metric Catalog on the Schemas page is the other half: what devices actually report. Entries already in your catalog are marked, and
        {canUse ? ' Use starts a catalog entry from one.' : ' adding one to the catalog requires Admin permissions.'}
      </p>

      {loading && <div style={{ color: 'var(--text-muted)', padding: '24px 0' }}>Loading vocabularies…</div>}

      {!loading && (
        <VocabularyPanel
          title="Standard Vocabulary Reference"
          canAddMetric={canUse}
          tabs={[
            mtconnectVocabularyTab({
              vocabulary,
              catalog,
              onUseType: canUse
                ? (typeName => onUseEntry?.({ standard: STANDARDS.MTCONNECT, type: typeName }))
                : undefined
            }),
            iso22400VocabularyTab({
              vocabulary: isoVocabulary,
              catalog,
              onUseKpi: canUse
                ? (kpi => onUseEntry?.({ standard: STANDARDS.ISO22400, name: kpi?.name }))
                : undefined
            }),
            opcuaVocabularyTab({
              vocabulary: opcuaVocabulary,
              catalog,
              onUsePoint: canUse
                ? (point => onUseEntry?.({
                    standard: STANDARDS.OPCUA,
                    // Both are needed: opcua_vocabulary is keyed on (companion_spec, name) because
                    // two specifications legitimately define the same browse name.
                    companionSpec: point?.companion_spec,
                    name: point?.name
                  }))
                : undefined
            }),
            ashrae223VocabularyTab({
              vocabulary: s223Vocabulary,
              catalog,
              onUseConcept: canUse
                ? (concept => onUseEntry?.({ standard: STANDARDS.ASHRAE223, name: concept?.name }))
                : undefined
            })
          ]}
        />
      )}
    </>
  )
}
