import React, { useState, useEffect } from 'react'
import { api } from '../../api'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { PERMISSION_UUIDS } from '../../constants'
import { LoadingState } from '../common/LoadingState'
import { STANDARDS } from '../../utils/standards'
import { VocabularyPanel } from '../common/VocabularyPanel'
import { mtconnectVocabularyTab } from '../common/MTConnectVocabularyPanel'
import { iso22400VocabularyTab } from '../common/ISO22400VocabularyPanel'
import { opcuaVocabularyTab } from '../common/OPCUAVocabularyPanel'
import { ashrae223VocabularyTab } from '../common/ASHRAE223VocabularyPanel'
import { qudtVocabularyTab } from '../common/QUDTVocabularyPanel'
import { qudtHandover } from '../../utils/qudt'
import { vda5050VocabularyTab } from '../common/VDA5050VocabularyPanel'
import { idtaTemplateTab } from '../common/IDTATemplatePanel'
import { siteVocabularyTab } from '../common/SiteVocabularyPanel'

/**
 * The standard vocabularies as a page of their own: reference material that is only read, separate
 * from the Metrics page's catalog, which is edited. Clicking an entry opens the Add Metric dialog
 * on the Metrics page: `onUseEntry` hands identifiers over, and MetricsTab, which holds the
 * vocabularies for its type picker, resolves the entry itself, so one place knows how a vocabulary
 * row becomes a metric. The Templates tab starts no metric: a submodel template is looked up, not used to
 * name one, and its Build Schema opens Build Schema from Template on the Schemas page (common/IDTATemplatePanel.jsx). The Imported tab is the exception to "only read": it loads its
 * own rows, and an Administrator imports, removes and shares them (common/SiteVocabularyPanel.jsx), so
 * this page passes it `showToast`.
 */
export function VocabularyTab({ onUseEntry, hasPermission, showToast }) {
  const [vocabulary, setVocabulary] = useState([])
  const [isoVocabulary, setIsoVocabulary] = useState([])
  const [opcuaVocabulary, setOpcuaVocabulary] = useState([])
  const [s223Vocabulary, setS223Vocabulary] = useState([])
  const [qudtKinds, setQudtKinds] = useState([])
  const [vdaVocabulary, setVdaVocabulary] = useState([])
  const [templateElements, setTemplateElements] = useState([])
  const [catalog, setCatalog] = useState([])
  const [loading, setLoading] = useState(true)
  // Where the Imported tab draws a file's drawer: beside the card, as every page's drawer is.
  const [drawerHost, setDrawerHost] = useState(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.get('/api/v1/mtconnect-vocabulary'),
      api.get('/api/v1/iso22400-vocabulary'),
      api.get('/api/v1/opcua-vocabulary'),
      api.get('/api/v1/ashrae223-vocabulary'),
      api.get('/api/v1/qudt-quantity-kinds'),
      api.get('/api/v1/vda5050-vocabulary'),
      api.get('/api/v1/idta-template-elements'),
      // The catalog is read only to mark which entries are in use, so a failure there is defaulted
      // rather than blanking the reference.
      api.get('/api/v1/metric-catalog').catch(() => [])
    ])
      .then(([mt, iso, opcua, s223, qudt, vda, templates, cat]) => {
        if (cancelled) return
        setVocabulary(mt || [])
        setIsoVocabulary(iso || [])
        setOpcuaVocabulary(opcua || [])
        setS223Vocabulary(s223 || [])
        setQudtKinds(qudt || [])
        setVdaVocabulary(vda || [])
        setTemplateElements(templates || [])
        setCatalog(cat || [])
        setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // The permission Add Metric is gated on: a click lands on that dialog, so offering it to someone
  // who cannot submit it would be a dead end.
  const canUse = !!hasPermission?.(PERMISSION_UUIDS.SCHEMA_MANAGE)

  // `page-fill`: the panel is the page's one card, and its sections scroll inside it.
  return (
    <div className="page-layout page-fill">
      <div className="page-main">
      {loading && <LoadingState label="vocabularies" />}

      {!loading && (
        <VocabularyPanel
          subtitle={<>
            What the standards define, not what devices publish{canUse
              ? '; click an entry to start a catalog metric from it.'
              : `; ${requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)} to start a catalog metric from an entry.`}
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
            }),
            qudtVocabularyTab({
              vocabulary: qudtKinds,
              catalog,
              onUseKind: canUse
                ? (kind => onUseEntry?.(qudtHandover(kind)))
                : undefined
            }),
            vda5050VocabularyTab({
              vocabulary: vdaVocabulary,
              catalog,
              onUseField: canUse
                ? (field => onUseEntry?.({ standard: STANDARDS.VDA5050, name: field?.name }))
                : undefined
            }),
            idtaTemplateTab({
              elements: templateElements,
              onNotify: showToast,
              deniedTitle: canUse ? null : requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
            }),
            siteVocabularyTab({ canManage: canUse, onUseEntry, showToast, drawerHost })
          ]}
        />
      )}
      </div>
      {/* A box of its own would be a third column; `contents` makes the drawer a flex item of the row. */}
      <div ref={setDrawerHost} style={{ display: 'contents' }} />
    </div>
  )
}
