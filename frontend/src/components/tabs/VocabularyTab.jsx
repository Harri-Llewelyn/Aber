import React, { useState, useEffect } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { LoadingState } from '../common/LoadingState'
import { STANDARDS } from '../../utils/standards'
import { VocabularyPanel } from '../common/VocabularyPanel'
import { mtconnectVocabularyTab } from '../common/MTConnectVocabularyPanel'
import { iso22400VocabularyTab } from '../common/ISO22400VocabularyPanel'
import { opcuaVocabularyTab } from '../common/OPCUAVocabularyPanel'
import { ashrae223VocabularyTab } from '../common/ASHRAE223VocabularyPanel'

/**
 * The standard vocabularies as a page of their own: reference material that is only read, separate
 * from the Metrics page's catalog, which is edited. Clicking an entry opens the Add Metric dialog
 * on the Metrics page: `onUseEntry` hands identifiers over, and MetricsTab, which holds the
 * vocabularies for its type picker, resolves the entry itself, so one place knows how a vocabulary
 * row becomes a metric.
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
      // The catalog is read only to mark which entries are in use, so a failure there is defaulted
      // rather than blanking the reference.
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

  // The permission Add Metric is gated on: a click lands on that dialog, so offering it to someone
  // who cannot submit it would be a dead end.
  const canUse = !!hasPermission?.(PERMISSION_UUIDS.SCHEMA_MANAGE)

  return (
    <>
      {loading && <LoadingState label="vocabularies" />}

      {!loading && (
        <VocabularyPanel
          subtitle={<>
            What the standards define, not what this deployment publishes: a row here is a concept the standard names. The Metric Catalog on the Metrics page is the other half, what devices actually report. Entries already in your catalog are marked.
            {canUse
              ? ' Click an entry to start a catalog metric from it.'
              : ` ${requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)} to start a catalog metric from an entry.`}
          </>}
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
