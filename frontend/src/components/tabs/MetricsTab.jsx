import React, { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { usePendingAction } from '../../hooks/usePendingAction'
import { DeprecateMetricModal } from '../modals/DeprecateMetricModal'
import { RestoreMetricModal } from '../modals/RestoreMetricModal'
import { EditMetricSemanticIdModal } from '../modals/EditMetricSemanticIdModal'
import { AddDerivedMetricModal } from '../modals/AddDerivedMetricModal'
import { useDerivedMetricsYaml } from '../../hooks/useDerivedMetricsYaml'
import { useQuantityKinds } from '../../hooks/useQuantityKinds'
import { datatypeLabel, SPARKPLUG_DATATYPES } from '../../utils/sparkplugDatatype'
import {
  groupCatalog, knownGroupNames, groupOptionsForStandard, canonicaliseGroup,
  metricNameError,
  composeMetricName, METRIC_GROUP_SEPARATOR
} from '../../utils/metricGroup'
import { breakAfterSeparators, formatDateTime, plural } from '../../utils/format'
import { DERIVED_METRICS_FILE_NAME } from '../../utils/derivedMetricsFile'
import { modelledMetrics } from '../../utils/deviceTags'
import { SCHEMA_STATUS, lineageVersionLabel, schemaStatus, schemaVersion, statusLabel } from '../../utils/schemaVersion'
import {
  typesByCategory, subTypes, unitNames, categoryOfType, CATEGORY_WITH_UNITS, MTCONNECT_CATEGORIES
} from '../../utils/mtconnect'
import {
  STANDARDS, STANDARD_OPTIONS, LOCAL_EXTENSION_LABEL, sameSemanticIdPair, storedSemanticIdPair
} from '../../utils/standards'
import {
  mtconnectSuggestion, vocabularySuggestion, suggestionForMetric, semanticIdCandidates
} from '../../utils/semanticIdSources'
import { kpis, kpiByName, iso22400Prefill } from '../../utils/iso22400'
import {
  APPLIES_TO_RULE, DERIVED_DATATYPE, SHARE_UNIT_WORDS, appliesToDevices, appliesToNone, isShare, describeDerivation, isDerived, kindLabel,
  matchesDerivedSearch, derivationText, schemasNaming, unitOf,
} from '../../utils/derivedMetric'
import { metricDevices } from '../../utils/history'
import { unitAndCode } from '../../utils/units'
import { dataPointByName, opcuaSections, opcuaPrefill, suggestedGroup } from '../../utils/opcua'
import {
  conceptByName, ashrae223Prefill, ashrae223Sections, metricConcepts
} from '../../utils/ashrae223'
import { fieldByName, fieldByType, fieldType, vda5050Prefill, vda5050Sections } from '../../utils/vda5050'
import { importedStandardOptions, sitePrefill, withSiteStandards, siteVocabularyLabel } from '../../utils/siteVocabulary'
import { Callout } from '../common/Callout'
import CopyableId from '../common/CopyableId'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { ActionButton } from '../common/ActionButton'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { useFormCheck } from '../../hooks/useFormCheck'
import { Badge } from '../common/Badge'
import { DerivedTag } from '../common/DerivedTag'
import { SearchInput } from '../common/SearchInput'
import { ColumnHeader, SortHeader } from '../common/SortHeader'
import { Tooltip } from '../common/Tooltip'
import { RouteLink } from '../common/RouteLink'
import { RecordChip } from '../common/RecordChip'
import { allSchemaVersionsUrl, deviceUrl, metricHistoryUrl, metricUrl, schemaUrl, tabUrl, trailUrl } from '../../routes'
import { ClearFilters } from '../common/ClearFilters'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { SemanticIdField } from '../common/SemanticIdField'
import { StaticField } from '../common/StaticField'
import { FurtherSemanticIdList } from '../common/FurtherSemanticIds'
import { PermittedValuesField } from '../common/PermittedValuesField'
import { furtherIdsOf } from '../../utils/furtherSemanticIds'
import {
  parsePermittedValues, permittedValuesApply, permittedValuesText
} from '../../utils/schemaProperty'
import {
  IconPlus, IconArchive, IconRefreshCw,
  IconPencil, IconBookOpen, IconTag, IconCheck, IconHistory, IconChartLine, IconDownload, IconUpload
} from '../common/Icons'
import { CardHeading } from '../common/CardHeading'
import { TabStrip } from '../common/TabStrip'
import { ExpandAllToggle } from '../common/ExpandAllToggle'
import { GroupHeading } from '../common/GroupHeading'
import { useOpenGroups } from '../../hooks/useOpenGroups'
import { useUrlList, useUrlState, useUrlTab } from '../../hooks/useUrlState'
import { FilterDropdown } from '../common/FilterChecklist'
import { applyFacets } from '../../utils/listFilters'
import { METRICS_TABS } from '../../navigation'
import { useSortableRows, useTableSort } from '../../hooks/useTableSort'

// The YAML editor is CodeMirror, which only an Upload or New in YAML needs: it loads when one is first opened.
const DerivedMetricsEditorModal = lazy(() => import('../modals/DerivedMetricsEditorModal').then(m => ({ default: m.DerivedMetricsEditorModal })))

// Sentinel for the "not in the list yet" option in the group picker. Not a valid group name --
// the CHECK constraint on metric_groups.name rejects anything containing the separator.
const NEW_GROUP = '__new__'

// "Not in the MTConnect vocabulary". The standard itself allows extension, so this escape has to
// exist -- but it is a deliberate choice rather than the default path.
const CUSTOM_TYPE = '__custom__'

// Separator for the OPC UA type picker's option values: the vocabulary is keyed on (companion_spec,
// name), because Machinery and Robotics both define names like `Manufacturer`.
const OPCUA_KEY_SEP = '::'

// The catalog's Standard filter: nothing chosen is any standard, and this sentinel is Local
// extension, because a local extension's own value, STANDARDS.CUSTOM, is '' too.
const LOCAL_STANDARD_FILTER = '__local__'

// The standards the Standard filter offers, in the Add Metric form's order. Local extension follows.
const FILTER_STANDARDS = STANDARD_OPTIONS.filter(o => o.value !== STANDARDS.CUSTOM)

/**
 * The Standard filter option a metric falls under: a standard it was named from, else the published
 * standard a site imported that it was started from (withSiteStandards), else Local extension.
 */
const standardFilterValue = (m) => m.standard || m.site_standard_filter || LOCAL_STANDARD_FILTER

/** No standard chosen. */
const NO_STANDARDS = Object.freeze([])

/**
 * The Standard filter's values: the standards in the Add Metric form's order, one for each published
 * standard a site imported, then Local extension.
 */
const standardFilterOptions = (siteVocabularies) => [
  ...FILTER_STANDARDS.map(o => ({ value: o.value, label: o.label })),
  ...importedStandardOptions(siteVocabularies),
  { value: LOCAL_STANDARD_FILTER, label: LOCAL_EXTENSION_LABEL },
]

/**
 * No semantic id, as the AAS export counts it: NULL and '' alike. The dashboard stores a blank id
 * as NULL, but a row written in SQL can hold ''.
 */
const isUnmapped = (m) => !m.semantic_id

// Extracted because three paths need it: the initial state, a successful add, and closing
// the dialog. Duplicating the shape was how a field would get missed from one of the resets.
const BLANK_METRIC = {
  // Which vocabulary the type picker draws from, and the provenance recorded on the metric.
  // MTConnect is the default because it is the largest vocabulary and most metrics come from it.
  standard: STANDARDS.MTCONNECT,
  group: '', newGroup: '', instance: '', type: '', customType: '',
  // A custom MTConnect type's category, which no vocabulary supplies. SAMPLE is the common one.
  customCategory: MTCONNECT_CATEGORIES[0],
  subType: '', units: '', datatype: 10, description: '',
  // The Permitted Values field as typed: the operator's own, like the description, so a change of
  // standard or type keeps it.
  permittedValues: '',
  // The chosen OPC UA point's companion specification. Two specifications can define one browse
  // name, so `type` alone does not find the row.
  companionSpec: '',
  // AAS semanticId. The field shows the suggestion (derived from the MTConnect data item type, or
  // `vocabSemanticId`, the id the chosen ISO 22400 or OPC UA row carries) until the operator
  // types or picks their own pair, which `semanticIdOwn` holds; null means follow the suggestion.
  vocabSemanticId: '', semanticIdOwn: null,
  // Only set for standards whose vocabulary states it. MTConnect derives it from the data item
  // type instead, so this stays blank there and effectiveCategory falls back to the derivation.
  vocabCategory: '',
  // The imported vocabulary a Custom metric is started from, and whether its definition was left out of
  // the description because the file's definitions are not shared.
  siteVocabularyId: '', definitionWithheld: false
}

/**
 * The operator's own semantic id across a change of type. A typed or picked id is kept, with Use
 * suggested one click away; a blank one gives way to the new type's suggestion, so touching the
 * field before choosing a type cannot leave the form suggesting nothing.
 */
const keepTypedSemanticId = (own) => (own && own.semanticId.trim() !== '' ? own : null)

/**
 * The four tabs, in order (navigation.jsx). The description is the tab's tooltip; the help page has
 * the rest. Uncatalogued's label gains its count once the list loads.
 */
export const VIEWS = METRICS_TABS

// Device chips an Uncatalogued row shows before "more": a name a whole fleet declares would
// otherwise fill the row with one chip per device.
const UNCATALOGUED_DEVICES_SHOWN = 3

/** The catalog's sortable columns, each on what its cell shows. A "—" cell goes last. */
const CATALOG_SORT = {
  name: { type: 'text', value: m => m.name },
  standard: { type: 'text', value: m => m.standard_label || m.standard || LOCAL_EXTENSION_LABEL },
  category: { type: 'text', value: m => m.category },
  // Units sorts on the code, so one unit's rows stay together whatever its symbol.
  units: { type: 'text', value: m => unitOf(m) },
  datatype: { type: 'text', value: m => (m.datatype === null || m.datatype === undefined ? null : datatypeLabel(m.datatype)) },
  semantic_id: { type: 'text', value: m => m.semantic_id },
  description: { type: 'text', value: m => m.description }
}

/** The Derived tab's sortable columns, each on what its cell shows. */
const DERIVED_SORT = {
  name: { type: 'text', value: m => m.name },
  kind: { type: 'text', value: m => kindLabel(m.derivation?.kind) },
  definition: { type: 'text', value: m => derivationText(m.derivation) },
  units: { type: 'text', value: m => unitOf(m) },
  description: { type: 'text', value: m => m.description }
}

/** A definition in words, its metric names and states in mono. */
const Definition = ({ derivation }) => (
  <>
    {describeDerivation(derivation).map((part, i) => (
      part.text !== undefined
        ? <React.Fragment key={i}>{part.text}</React.Fragment>
        : <span key={i} className="mono">{part.name ?? part.state}</span>
    ))}
  </>
)

/**
 * A derived metric's Applies To: a chip for each device, in name order, that opens it on the Devices
 * page. It wraps with no cap, as the Schemas drawer's Devices field does, and a name too long for the
 * drawer is cut and slides on hover or focus. With none, why: `naming` is how many schemas name the metric.
 */
const AppliesTo = ({ devices, naming }) => (devices.length === 0 ? appliesToNone(naming) : (
  <div className="context-device-list">
    {appliesToDevices(devices).map(d => (
      <RecordChip key={d.asset_id} kind="devices" to={deviceUrl(d.asset_id)} name={d.asset_name} />
    ))}
  </div>
))

/**
 * A metric this page names, as a chip that opens it on its tab. The icon and the page are given, not
 * the kind: the kind's key is the catalogue's table name, which drift check 450 reads as a query of it.
 */
const MetricChip = ({ metric }) => (
  <RecordChip icon={<IconTag size={11} />} page="Metrics" to={metricUrl(metric.metric_uuid, metric.deprecated, isDerived(metric))} name={metric.name} />
)

// Schema versions the drawer's Schemas field draws as chips before one link to the rest.
const SCHEMAS_SHOWN = 6

/** Newest first: the later made, and of two made together the higher version. */
const newestFirst = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || schemaVersion(b) - schemaVersion(a)

/**
 * The drawer's Schemas field: the schema versions that model a metric, or name a derived one, newest
 * first, each a chip with its version that opens it on the Schemas page, and a flag for a draft or a
 * superseded one. Past SCHEMAS_SHOWN the rest is one link to the Schemas page with every version listed.
 */
const SchemasUsing = ({ versions }) => {
  const newest = [...versions].sort(newestFirst)
  const rest = newest.length - SCHEMAS_SHOWN
  return (
    <div className="context-device-list">
      {newest.slice(0, SCHEMAS_SHOWN).map(s => (
        <RecordChip
          key={s.schema_uuid}
          kind="schemas"
          to={schemaUrl(s.schema_uuid)}
          name={lineageVersionLabel(s)}
          flag={schemaStatus(s) !== SCHEMA_STATUS.ACTIVE && statusLabel(schemaStatus(s)).toUpperCase()}
        />
      ))}
      {rest > 0 && (
        <RouteLink className="count-link" to={allSchemaVersionsUrl()} title={`Open the Schemas page with every version listed, to find the other ${plural(rest, 'version')}`}>
          and {rest} more
        </RouteLink>
      )}
    </div>
  )
}

/** The Uncatalogued table's sortable columns. Declared By is a list of devices; Devices counts it. */
const UNCATALOGUED_SORT = {
  name: { type: 'text', value: u => u.metric_name },
  devices: { type: 'number', value: u => u.device_count },
  datatype: { type: 'text', value: u => (u.datatypes || []).map(datatypeLabel).join(', ') },
  last_declared: { type: 'time', value: u => u.last_declared_at }
}

/** Why Catalogue cannot prefill a datatype from what the births carried, or null when it can. */
const catalogueDatatypeNote = (row) => {
  const codes = row?.datatypes || []
  if (codes.length === 0) return 'No device gave it a value in its birth certificate, so how it is encoded is not recorded.'
  if (codes.length > 1) return `Its devices declare it as ${codes.map(datatypeLabel).join(' and ')}.`
  if (!SPARKPLUG_DATATYPES.some(d => d.code === codes[0])) {
    return `Its devices declare it as ${datatypeLabel(codes[0])}, which this form does not offer.`
  }
  return null
}

/**
 * An Uncatalogued row's drawer: every field the row has, each device it names, and Catalogue, the act
 * the page offers for it. A name, not a record, so it has no id of its own. `row` is null while closed.
 */
function UncataloguedDrawer({ row, canCatalogue, onCatalogue, onClose, onCopy }) {
  const devices = row?.devices || []
  const datatypes = row?.datatypes || []
  const nameProblem = row ? metricNameError(row.metric_name) : null
  const cannotHold = nameProblem && `The catalog cannot hold this name as the devices declare it. ${nameProblem} Rename it on the devices.`
  return (
    <ContextPanel
      open={!!row}
      onClose={onClose}
      type="METRIC"
      subject="metric"
      onCopy={onCopy}
      title={row?.metric_name || ''}
      icon={<IconTag size={16} />}
      subtitle={row && <Badge tone="warning" size="sm" title="No catalog row describes it">Uncatalogued</Badge>}
      warnings={cannotHold ? [{ id: 'name', tone: 'warning', text: cannotHold }] : []}
      fields={row ? [
        { label: 'Name', value: row.metric_name, mono: true, copyable: true },
        { label: 'Devices', value: String(row.device_count), help: 'How many devices declare this name' },
        {
          label: 'Declared By',
          value: devices.length === 0 ? null : (
            <div className="context-device-list">
              {devices.map(d => (
                <RouteLink
                  key={d.id}
                  className="chip chip-link"
                  to={deviceUrl(d.id)}
                  title={`Open ${d.name} on the Devices page${d.quarantined ? '. It is in quarantine, awaiting approval.' : ''}`}
                >
                  <IconCpu size={11} />
                  <OverflowText className="chip-name">{d.name}</OverflowText>
                  {d.quarantined && <span className="cell-meta">quarantined</span>}
                </RouteLink>
              ))}
            </div>
          ),
          full: true,
          help: 'The devices that declare it. Each opens on the Devices page.'
        },
        {
          label: 'Datatype',
          value: datatypes.length ? datatypes.map(datatypeLabel).join(', ') : null,
          help: "The datatype the devices' births gave it. Not set means none gave it a value; several mean they disagree."
        },
        {
          label: 'Last Declared',
          value: formatDateTime(row.last_declared_at),
          help: 'The latest birth that changed what one of these devices declares. A rebirth declaring the same names does not count.'
        }
      ] : []}
      actions={row ? [{
        label: 'Catalogue', icon: <IconPlus size={13} />,
        onClick: () => onCatalogue(row),
        primary: true,
        disabled: !canCatalogue || !!nameProblem,
        title: !canCatalogue ? requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
          : cannotHold || 'Add this name to the catalog as a Custom metric'
      }] : []}
    />
  )
}

/**
 * The metric catalog: the vocabulary of metrics every schema is built from. Add Metric opens a
 * dialog; selecting a row opens a drawer with the metric's fields and its Edit, Deprecate and
 * Restore actions. The schema registry reads the catalog for the builder; this page reads the
 * schemas only for the usage count on a deprecation or a semantic id edit.
 *
 * @param {Object} pendingVocabularyEntry Handed over by clicking an entry on the Vocabulary page:
 * identifiers for a standard's entry, resolved here because applyPrefill() is the only place that
 * knows how a vocabulary row becomes a metric.
 *
 * The tab is the path (`/metrics/deprecated`), and the catalog's filters and the open drawer are
 * query parameters: `/metrics?unmapped=1` is the catalog with only the metrics that have no
 * semantic id, which the export warning links to.
 */
export function MetricsTab({ showToast, hasPermission, pendingVocabularyEntry, onConsumeVocabularyEntry }) {
  const [catalog, setCatalog]         = useState([])
  const [groups, setGroups]           = useState([])
  // Read for the usage count on a deprecation or a semantic id edit and nothing else -- how many
  // schemas model the metric is the impact warning on either act.
  const [schemas, setSchemas]         = useState([])
  // The devices, for a derived metric's Applies To line; null until read, and when the read fails.
  const [devices, setDevices]         = useState(null)
  const [vocabulary, setVocabulary]   = useState([])
  const [isoVocabulary, setIsoVocabulary]     = useState([])
  const [opcuaVocabulary, setOpcuaVocabulary] = useState([])
  const [s223Vocabulary, setS223Vocabulary] = useState([])
  const [vdaVocabulary, setVdaVocabulary] = useState([])
  // IDTA template elements, which the semantic id picker offers beside the vocabularies.
  const [templateElements, setTemplateElements] = useState([])
  // The files a site imported (site_vocabularies): the Standard column labels a metric started from one,
  // and the Standard filter offers each published standard among them.
  const [siteVocabularies, setSiteVocabularies] = useState([])
  const [referenceLoaded, setReferenceLoaded] = useState(false)
  // True after the first read, so a reload keeps the rows on screen.
  const [loaded, setLoaded]           = useState(false)
  const [showAddMetric, setShowAddMetric] = useState(false)
  const [showAddDerived, setShowAddDerived] = useState(false)
  const [addError, setAddError]       = useState(null)
  const [adding, runAdd]              = usePendingAction()
  const [selectedId, setSelectedId]   = useUrlState('metric', '', { allowed: loaded ? catalog.map(m => m.metric_uuid) : null })
  // The metric name is composed from its parts: component (group), optional instance, type,
  // optional subType. NEW_GROUP and CUSTOM_TYPE are the escapes for a local extension.
  const [newMetric, setNewMetric] = useState(BLANK_METRIC)
  const [deprecateTarget, setDeprecateTarget] = useState(null)
  const [restoreTarget, setRestoreTarget] = useState(null)
  // The uncatalogued_metrics rows: null until the first read, and while a read has failed.
  const [uncatalogued, setUncatalogued] = useState(null)
  const [uncataloguedError, setUncataloguedError] = useState(null)
  const [uncataloguedSearch, setUncataloguedSearch] = useUrlState('name')
  // The Uncatalogued row whose drawer is open, by its name, which is all it has: `?declared=`. A name
  // catalogued since leaves the list, and the address with it.
  const [declaredName, setDeclaredName] = useUrlState('declared', '', { allowed: uncatalogued ? uncatalogued.map(u => u.metric_name) : null })
  // Rows showing every device chip, keyed by metric name.
  const [allDevicesShown, setAllDevicesShown] = useState({})
  // The Uncatalogued row Add Metric was opened from by Catalogue; null for any other opening.
  const [cataloguing, setCataloguing] = useState(null)
  const [editTarget, setEditTarget] = useState(null)
  // Which tab of the card is shown, one per VIEWS entry; the default is the catalog.
  const [view, setView, viewHref] = useUrlTab('metrics', VIEWS.map(v => v.id), 'catalog')
  // Filters the catalog by metric name. With groups collapsed by default it is how one metric is
  // found without opening each group.
  const [catalogSearch, setCatalogSearch] = useUrlState('search')
  // The catalog's other filters: standards (LOCAL_STANDARD_FILTER among them), any of which a metric
  // may be under, and metrics with no id.
  const [standardFilter, setStandardFilter] = useUrlList('standard', NO_STANDARDS, {
    // An imported standard's value is offered once the files are read; until then a link naming one stands.
    allowed: v => FILTER_STANDARDS.some(o => o.value === v) || v === LOCAL_STANDARD_FILTER ||
      (v.startsWith('site:') && (!loaded || importedStandardOptions(siteVocabularies).some(o => o.value === v)))
  })
  const [unmappedOnly, setUnmappedOnly] = useUrlState('unmapped', false)
  // The Derived tab's own search, by name or definition; the catalog's belongs to the catalog tab.
  const [derivedSearch, setDerivedSearch] = useUrlState('derived-search')
  const catalogFilterCount = (catalogSearch ? 1 : 0) + (standardFilter.length ? 1 : 0) + (unmappedOnly ? 1 : 0)
  const clearCatalogFilters = () => {
    setCatalogSearch(''); setStandardFilter([]); setUnmappedOnly(false)
  }

  // The catalog's groups start collapsed, and the search and the filters open what they match.
  const openGroups = useOpenGroups(catalogFilterCount > 0)

  // Closing discards: half-finished input must not leak into the next open, including one started
  // from the Vocabulary page.
  const closeAddMetric = () => {
    setNewMetric(BLANK_METRIC)
    setAddError(null)
    setCataloguing(null)
    addCheck.reset()
    setShowAddMetric(false)
  }

  // A read of its own, not awaited by load(): a failure leaves the catalog's tabs working and is
  // said on the Uncatalogued tab.
  const loadUncatalogued = useCallback(async () => {
    try {
      const rows = await api.get('/api/v1/uncatalogued-metrics')
      setUncatalogued(rows || []); setUncataloguedError(null)
    } catch (e) {
      setUncatalogued(null); setUncataloguedError(e.message)
    }
  }, [])

  // Re-read after every change this page makes: adding a metric can take a name off Uncatalogued.
  const load = useCallback(async () => {
    loadUncatalogued()
    try {
      const [cat, grp, sch, dev, files] = await Promise.all([
        api.get('/api/v1/metric-catalog'),
        api.get('/api/v1/metric-groups'),
        api.get('/api/v1/schemas'),
        api.get('/api/v1/devices').catch(() => null),
        // A read of its own that may fail: the labels fall back to Local extension, the page stands.
        api.get('/api/v1/site-vocabularies').catch(() => []),
      ])
      setSiteVocabularies(files || [])
      setCatalog(withSiteStandards(cat, files)); setGroups(grp); setSchemas(sch); setDevices(dev)
    } finally { setLoaded(true) }
  }, [loadUncatalogued])

  useEffect(() => { load() }, [load])

  // Reference data nothing here writes, so one read per table per visit: the type pickers and the
  // semantic id picker both search what these return, in the browser.
  useEffect(() => {
    let current = true
    Promise.all([
      api.get('/api/v1/mtconnect-vocabulary'),
      api.get('/api/v1/iso22400-vocabulary'),
      api.get('/api/v1/opcua-vocabulary'),
      api.get('/api/v1/ashrae223-vocabulary'),
      api.get('/api/v1/vda5050-vocabulary'),
      api.get('/api/v1/idta-submodel-templates'),
    ]).then(([voc, iso, opc, s223, vda, templates]) => {
      if (!current) return
      setVocabulary(voc); setIsoVocabulary(iso); setOpcuaVocabulary(opc); setS223Vocabulary(s223)
      setVdaVocabulary(vda || [])
      setTemplateElements(templates); setReferenceLoaded(true)
    })
    return () => { current = false }
  }, [])

  // The QUDT quantity kinds, read when the first dialog with a picker opens.
  const quantityKinds = useQuantityKinds(showAddMetric || !!editTarget)

  // Everything the semantic id picker offers, built once per read rather than on each keystroke.
  const semanticIdChoices = useMemo(() => semanticIdCandidates({
    mtconnect: vocabulary, iso22400: isoVocabulary, opcua: opcuaVocabulary, vda5050: vdaVocabulary,
    quantityKinds, templates: templateElements
  }), [vocabulary, isoVocabulary, opcuaVocabulary, vdaVocabulary, quantityKinds, templateElements])

  /**
   * Turn a suggested group name into the two fields the picker needs. A vocabulary can suggest a
   * group this deployment has never registered, which arrives as + New group with the name
   * pre-typed rather than as a value with no option behind it.
   */
  const groupFields = (suggested) => {
    if (!suggested) return { group: '', newGroup: '' }
    const known = knownGroups.find(g => g.toLowerCase() === suggested.toLowerCase())
    return known ? { group: known, newGroup: '' } : { group: NEW_GROUP, newGroup: suggested }
  }

  /**
   * Apply a vocabulary prefill (utils/iso22400, utils/opcua or utils/ashrae223) to the form and
   * open the dialog. A prefill that leaves `datatype` undefined means the vocabulary does not say how the
   * value is encoded -- a 223P concept names a thing, not a reading -- and the form then holds no
   * datatype until the operator picks one. It is the one field that cannot be corrected afterwards,
   * so it is left empty rather than defaulted to Double.
   */
  const applyPrefill = (prefill) => {
    if (!prefill) return
    setNewMetric(m => ({
      ...m,
      ...groupFields(prefill.group),
      standard: prefill.standard,
      type: prefill.type,
      companionSpec: prefill.companionSpec || '',
      customType: '',
      // A KPI, an OPC UA data point and a 223P concept are all whole concepts; none has an
      // MTConnect subType.
      subType: '',
      units: prefill.units || '',
      datatype: prefill.datatype,
      vocabCategory: prefill.category || '',
      vocabSemanticId: prefill.semanticId || '',
      semanticIdOwn: keepTypedSemanticId(m.semanticIdOwn),
      // A VDA 5050 field carries its enum's values (or none); the other prefills leave the field to the operator.
      permittedValues: prefill.permittedValues ?? m.permittedValues,
      // Only fill a description that is still empty, so the vocabulary's blurb never overwrites
      // something the operator has already written.
      description: m.description || prefill.description || ''
    }))
    setShowAddMetric(true)
  }

  /**
   * Apply an imported concept (utils/siteVocabulary) to the form and open the dialog: a Custom metric,
   * named from the preferred name, carrying the concept's id and linked to its file, with its
   * definition as the description only where the file's definitions are shared.
   */
  const applySitePrefill = (prefill) => {
    if (!prefill) return
    setNewMetric({
      ...BLANK_METRIC,
      standard: STANDARDS.CUSTOM,
      customType: prefill.customType,
      datatype: prefill.datatype,
      description: prefill.description,
      semanticIdOwn: { semanticId: prefill.semanticId, semanticIdType: prefill.semanticIdType },
      siteVocabularyId: prefill.siteVocabularyId,
      definitionWithheld: prefill.definitionWithheld
    })
    setShowAddMetric(true)
  }

  // Opens the Add Metric dialog with the type chosen, leaving the component and instance to the
  // operator.
  const handleUseVocabularyType = (typeName) => {
    setNewMetric(m => ({
      ...m, standard: STANDARDS.MTCONNECT, type: typeName, companionSpec: '', customType: '',
      vocabSemanticId: '', semanticIdOwn: keepTypedSemanticId(m.semanticIdOwn)
    }))
    setShowAddMetric(true)
  }

  // Opens the Add Metric dialog as a Custom metric whose own semantic id is the one chosen, a QUDT
  // quantity kind on the Vocabulary page. The name, datatype and unit are the operator's.
  const handleUseSemanticId = ({ semanticId, semanticIdType }) => {
    setNewMetric(m => ({
      ...m, standard: STANDARDS.CUSTOM, type: '', companionSpec: '', vocabSemanticId: '',
      semanticIdOwn: { semanticId, semanticIdType: semanticIdType || '' }
    }))
    setShowAddMetric(true)
  }

  /**
   * Catalogue, on the Uncatalogued tab: Add Metric as a Custom metric under the declared name, its
   * first segment the group, its last the name and any between the instance. A group the Custom
   * picker does not list goes through + New group, which takes an existing group's spelling and
   * warns when the case differs. The datatype is filled only when the births agree on one the form
   * offers: like the name, it cannot be changed afterwards.
   */
  const handleCatalogue = (row) => {
    const segments = row.metric_name.split(METRIC_GROUP_SEPARATOR)
    const leaf = segments.pop()
    const [group = '', ...instance] = segments
    const offered = groupOptionsForStandard(groups, catalog, STANDARDS.CUSTOM)
      .some(bucket => bucket.names.includes(group))
    setNewMetric({
      ...BLANK_METRIC,
      standard: STANDARDS.CUSTOM,
      group: offered || !group ? group : NEW_GROUP,
      newGroup: offered ? '' : group,
      instance: instance.join(METRIC_GROUP_SEPARATOR),
      customType: leaf,
      datatype: catalogueDatatypeNote(row) ? undefined : row.datatypes[0]
    })
    setCataloguing(row)
    setShowAddMetric(true)
  }

  /**
   * Arrival from an entry clicked on the Vocabulary page. The handover carries identifiers, resolved
   * here, because the rules that turn a vocabulary row into a metric live in applyPrefill and
   * nowhere else. Waits for the vocabularies and the groups to load, and clears the handover once
   * applied.
   */
  useEffect(() => {
    if (!pendingVocabularyEntry || !loaded || !referenceLoaded) return
    const entry = pendingVocabularyEntry

    if (entry.standard === STANDARDS.CUSTOM && entry.semanticId) {
      handleUseSemanticId(entry)
    } else if (entry.standard === STANDARDS.MTCONNECT && entry.type) {
      handleUseVocabularyType(entry.type)
    } else if (entry.standard === STANDARDS.ISO22400) {
      const kpi = kpiByName(isoVocabulary, entry.name)
      if (kpi) applyPrefill(iso22400Prefill(kpi))
    } else if (entry.standard === STANDARDS.OPCUA) {
      const point = dataPointByName(opcuaVocabulary, entry.companionSpec, entry.name)
      if (point) applyPrefill(opcuaPrefill(point))
    } else if (entry.standard === STANDARDS.ASHRAE223) {
      const concept = conceptByName(s223Vocabulary, entry.name)
      if (concept) applyPrefill(ashrae223Prefill(concept))
    } else if (entry.standard === STANDARDS.VDA5050) {
      const field = fieldByName(vdaVocabulary, entry.name)
      if (field) applyPrefill(vda5050Prefill(field))
    } else if (entry.siteConcept) {
      applySitePrefill(sitePrefill(entry.siteConcept, entry.siteVocabulary))
    }

    onConsumeVocabularyEntry?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingVocabularyEntry, loaded, referenceLoaded, isoVocabulary, opcuaVocabulary, s223Vocabulary, vdaVocabulary])

  /** Selecting an entry in the type picker prefills everything that entry determines. */
  const handleTypeChange = (value) => {
    if (newMetric.standard === STANDARDS.ISO22400) {
      const kpi = kpiByName(isoVocabulary, value)
      if (kpi) return applyPrefill(iso22400Prefill(kpi))
    }
    if (newMetric.standard === STANDARDS.OPCUA) {
      const [spec, name] = String(value).split(OPCUA_KEY_SEP)
      const point = dataPointByName(opcuaVocabulary, spec, name)
      if (point) return applyPrefill(opcuaPrefill(point))
    }
    if (newMetric.standard === STANDARDS.ASHRAE223) {
      const concept = conceptByName(s223Vocabulary, value)
      if (concept) return applyPrefill(ashrae223Prefill(concept))
    }
    if (newMetric.standard === STANDARDS.VDA5050) {
      const field = fieldByType(vdaVocabulary, value)
      if (field) return applyPrefill(vda5050Prefill(field))
    }
    // An MTConnect type, or a vocabulary picker set back to empty: no row's id applies any more.
    setNewMetric(m => ({
      ...m, type: value, companionSpec: '', vocabSemanticId: '',
      semanticIdOwn: keepTypedSemanticId(m.semanticIdOwn)
    }))
  }

  /**
   * The chosen OPC UA data point, found by specification and name together: by name alone, a name
   * two specifications define finds whichever the API ordered first.
   */
  const chosenDataPoint = newMetric.standard === STANDARDS.OPCUA && newMetric.type
    ? dataPointByName(opcuaVocabulary, newMetric.companionSpec, newMetric.type)
    : null

  /**
   * Changing the group can hide the selected OPC UA data point, since that picker filters by group.
   * Clearing takes the whole prefill with it: units, datatype, category and semantic id all came
   * from that point. MTConnect and ISO 22400 are untouched, because neither picker filters by
   * group.
   */
  const handleGroupChange = (value) => {
    const orphaned =
      newMetric.standard === STANDARDS.OPCUA &&
      newMetric.type &&
      value && value !== NEW_GROUP &&
      suggestedGroup(chosenDataPoint) !== value

    setNewMetric(m => ({
      ...m,
      group: value,
      ...(orphaned
        ? {
            type: '',
            companionSpec: '',
            units: '',
            datatype: '',
            vocabCategory: '',
            vocabSemanticId: '',
            semanticIdOwn: keepTypedSemanticId(m.semanticIdOwn)
          }
        : {})
    }))
  }

  /**
   * Switching standard clears everything the previous vocabulary decided: `standard` is what an AAS
   * export reads to choose a namespace, so a stale type is a wrong interoperability claim. The
   * group and description are the operator's own input and survive.
   */
  const handleStandardChange = (value) => {
    // The group survives a standard switch when the new standard still offers it. The picker
    // filters by standard, so a group the new standard does not offer would sit in state while
    // absent from the options.
    const stillOffered = groupOptionsForStandard(groups, catalog, value)
      .some(bucket => bucket.names.includes(newMetric.group))
    // The "+ New group…" sentinel is not a group name and is always available.
    const keepGroup = newMetric.group === NEW_GROUP || stillOffered

    setNewMetric(m => ({
      ...m,
      standard: value,
      group: keepGroup ? m.group : '',
      newGroup: keepGroup ? m.newGroup : '',
      type: '', companionSpec: '', customType: '', customCategory: BLANK_METRIC.customCategory,
      subType: '', units: '', vocabCategory: '', vocabSemanticId: '', semanticIdOwn: null,
      siteVocabularyId: '', definitionWithheld: false,
      // The values a VDA 5050 enum filled in were that field's; any other standard's are the operator's own.
      permittedValues: m.standard === STANDARDS.VDA5050 ? '' : m.permittedValues
    }))
  }

  const handleAddMetric = async () => {
    const composed = composedName
    setAddError(null)
    try {
      // Register the group before the metric that first uses it, so the vocabulary stays complete
      // if the metric insert is rejected.
      if (effectiveGroup && !knownGroups.includes(effectiveGroup)) {
        // Carries the standard so the group files under it in the picker rather than under Local.
        await api.post('/api/v1/metric-groups', { name: effectiveGroup, standard: effectiveStandard })
      }

      const added = await api.post('/api/v1/metric-catalog', {
        name: composed,
        datatype: newMetric.datatype,
        category: effectiveCategory,
        // Stored alongside the name as well as inside it: the name is what the device publishes,
        // the column is what can be queried without parsing.
        sub_type: newMetric.subType,
        units: unitsApply ? newMetric.units : '',
        standard: effectiveStandard,
        // AAS alignment. Blank is legitimate for a local extension, which no vocabulary names, and
        // nothing is minted for one.
        semantic_id: semanticIdValue,
        semantic_id_type: semanticIdTypeValue,
        // The imported file a Custom metric was started from: a standard is never typed beside it.
        site_vocabulary_id: effectiveStandard ? '' : newMetric.siteVocabularyId,
        permitted_values: permitted.values,
        description: newMetric.description
      })
      closeAddMetric()
      load()
      showToast(`Metric '${composed}' added to the catalog`, 'success', { to: metricUrl(added?.metric_uuid) })
    } catch (e) {
      setAddError(e.message)
    }
  }

  /**
   * Add Derived Metric's confirm, run from its dialog: the group is registered first when it is new,
   * and a refusal of the save (an input that is derived, a name a device declares) is thrown for the
   * dialog to show as the database worded it.
   */
  const handleAddDerived = async ({ name, group, isNewGroup, description, derivation }) => {
    if (isNewGroup) await api.post('/api/v1/metric-groups', { name: group, standard: '' })
    const added = await api.post('/api/v1/metric-catalog', {
      name, datatype: DERIVED_DATATYPE, description, derivation
    })
    setShowAddDerived(false)
    load()
    showToast(`Derived metric '${name}' added to the catalog`, 'success', { to: metricUrl(added?.metric_uuid, false, true) })
  }

  // The schemas that model the metric at all, not only those marking it `required`: the drawer lists
  // them, and their count is the impact warning on a destructive confirmation. Uses the same
  // modelledMetrics() the device tags read. A derived metric is modelled by none: it is named.
  const schemasUsing = (m) => (isDerived(m)
    ? schemasNaming(m.name, schemas)
    : schemas.filter(s => modelledMetrics(s)?.has(m.name)))
  const usageCountFor = (m) => schemasUsing(m).length

  // Deprecate, Restore and Edit run from their dialogs, which show a refusal as it was worded and
  // stay open; each closes its dialog once the write has succeeded.
  const handleDeprecate = async (supersededBy) => {
    await api.post(`/api/v1/metric-catalog/${deprecateTarget.metric_uuid}/deprecate`, { superseded_by: supersededBy })
    setDeprecateTarget(null)
    load()
    showToast(`Metric '${deprecateTarget.name}' deprecated. The Deprecated Metrics tab can restore it.`, 'success', { to: metricUrl(deprecateTarget.metric_uuid, true) })
  }

  const handleRestore = async () => {
    await api.post(`/api/v1/metric-catalog/${restoreTarget.metric_uuid}/restore`)
    setRestoreTarget(null)
    load()
    showToast(
      isDerived(restoreTarget)
        ? `Derived metric '${restoreTarget.name}' restored to the Derived tab`
        : `Metric '${restoreTarget.name}' restored to the schema builder`,
      'success',
      { to: metricUrl(restoreTarget.metric_uuid, false, isDerived(restoreTarget)) }
    )
  }

  /**
   * Edit's save: `change` holds only what changed, the semantic id pair, the permitted values, the
   * further ids or any of them. A refusal that comes after the first write has changed the metric, so
   * the catalog is read again before the dialog shows it.
   */
  const handleEditMetric = async (change) => {
    const name = editTarget.name
    const pairChanged = Object.hasOwn(change, 'semantic_id')
    const valuesChanged = Object.hasOwn(change, 'permitted_values')
    const furtherChanged = Object.hasOwn(change, 'further_semantic_ids')
    try {
      await api.put(`/api/v1/metric-catalog/${editTarget.metric_uuid}`, change)
    } catch (err) {
      if (furtherChanged) load()
      throw err
    }
    setEditTarget(null)
    load()
    showToast(
      furtherChanged && !pairChanged && !valuesChanged
        ? `Further semantic ids of '${name}' saved`
        : furtherChanged || (pairChanged && valuesChanged)
          ? `Metric '${name}' saved`
          : valuesChanged
            ? (change.permitted_values
              ? `Permitted values of '${name}' saved`
              : `Permitted values of '${name}' cleared; it may report any value`)
            : change.semantic_id
              ? `Semantic id of '${name}' saved`
              : `Semantic id of '${name}' cleared; the metric is now unmapped`,
      'success',
      { to: metricUrl(editTarget.metric_uuid, !!editTarget.deprecated) }
    )
  }

  // The catalog and the schema registry share `schema:manage`. The write is refused by
  // metric_catalog's INSERT and UPDATE policies (has_role('Administrator')), so this disables the
  // control and decides nothing.
  const canManageSchema = hasPermission(PERMISSION_UUIDS.SCHEMA_MANAGE)
  const canReadTrail = hasPermission(PERMISSION_UUIDS.AUDIT_TRAIL_READ)
  // Deprecate, Restore and Edit write metric_catalog too, so they share Add Metric's gate: a
  // permission a Shopfloor_Manager holds, such as archive:manage, would offer a button the database
  // refuses.
  const canDeprecateMetric = canManageSchema
  const canEditMetric = canManageSchema

  /**
   * Narrows the catalog by metric name or UUID, as Areas and Cells search theirs: the UUID is what a
   * link, a log line or the Audit Trail's drawer carries. Not by description or units, which would
   * return rows whose reason for matching is invisible in the table.
   */
  const matchesCatalogSearch = (m) => {
    const q = catalogSearch.trim().toLowerCase()
    return !q || (m.name || '').toLowerCase().includes(q) || String(m.metric_uuid || '').toLowerCase().includes(q)
  }

  // A derived metric has a tab of its own, so the catalog lists the measured ones. Deprecated holds
  // both kinds.
  const currentCatalog = catalog.filter(m => !m.deprecated && !isDerived(m))
  const derivedCatalog = catalog.filter(m => !m.deprecated && isDerived(m))
  const shownDerived = derivedCatalog.filter(m => matchesDerivedSearch(m, derivedSearch))
  // Standard is any of its values. Its counts are over what the search and Unmapped let through, as
  // every list filter's are; Unmapped's own count is over the whole active catalog.
  const { rows: activeCatalog, counts: facetCounts } = applyFacets(currentCatalog, [
    { key: 'standard', chosen: standardFilter, values: m => [standardFilterValue(m)] },
  ], m => matchesCatalogSearch(m) && (!unmappedOnly || isUnmapped(m)))
  const unmappedCount = currentCatalog.filter(isUnmapped).length
  // Its own tab, unfiltered: the search and the filters belong to the catalog tab.
  const deprecatedCatalog = catalog.filter(m => m.deprecated)
  // By name only, as the catalog's search: a match on a device name could be in a chip not shown.
  const shownUncatalogued = (uncatalogued || []).filter(u =>
    !uncataloguedSearch || u.metric_name.toLowerCase().includes(uncataloguedSearch.trim().toLowerCase()))
  // The Uncatalogued row whose drawer is open, on its own tab only.
  const declared = (view === 'uncatalogued' && uncatalogued?.find(u => u.metric_name === declaredName)) || null
  const selectDeclared = (u) => setDeclaredName(name => (name === u.metric_name ? '' : u.metric_name))
  const selected = catalog.find(m => m.metric_uuid === selectedId) || null
  // Grouped by the name's first `/`-separated segment; ungrouped metrics fall into a trailing bucket.
  const catalogGroups = groupCatalog(activeCatalog)
  // Every group there is, not only those shown: Collapse all also closes what a filter opened.
  const setAllGroups = (open) => openGroups.setOpen(groupCatalog(currentCatalog).map(g => g.label), open)
  // `superseded_by` is a uuid; the Deprecated Metrics tab and the restore modal show the name.
  const metricById = new Map(catalog.map(m => [m.metric_uuid, m]))

  // The catalog sorts inside each group, and the groups keep their order. The Deprecated tab sorts
  // by the same columns, plus the replacement's name.
  const catalogSort = useTableSort(CATALOG_SORT, { active: view === 'catalog' })
  const deprecatedSortColumns = useMemo(() => {
    const names = new Map(catalog.map(m => [m.metric_uuid, m.name]))
    return { ...CATALOG_SORT, superseded_by: { type: 'text', value: m => names.get(m.superseded_by) } }
  }, [catalog])
  const [deprecatedRows, deprecatedSort] = useSortableRows(deprecatedCatalog, deprecatedSortColumns, { active: view === 'deprecated' })
  const [uncataloguedRows, uncataloguedSort] = useSortableRows(shownUncatalogued, UNCATALOGUED_SORT, { active: view === 'uncatalogued' })
  const [derivedRows, derivedSort] = useSortableRows(shownDerived, DERIVED_SORT, { active: view === 'derived' })
  // Export holds the derived metrics ticked, or every one listed; Upload and New in YAML open the editor.
  const yaml = useDerivedMetricsYaml({ listed: derivedCatalog, shown: shownDerived, showToast, reload: load })
  // The names devices declare that no row has: a derived metric may not take one.
  const declaredNames = useMemo(() => new Set((uncatalogued || []).map(u => u.metric_name)), [uncatalogued])

  // The vocabulary the picker offers: the curated registry (MTConnect's component types) plus
  // anything already in use.
  const knownGroups = knownGroupNames(groups, catalog)
  // Narrowed to the selected standard plus local groups, so a standard is not offered another's
  // groups.
  const groupOptions = groupOptionsForStandard(groups, catalog, newMetric.standard)
  const effectiveGroup = newMetric.group === NEW_GROUP
    ? canonicaliseGroup(newMetric.newGroup, knownGroups)
    : newMetric.group

  const isMTConnect = newMetric.standard === STANDARDS.MTCONNECT
  const isIso = newMetric.standard === STANDARDS.ISO22400
  const isOpcua = newMetric.standard === STANDARDS.OPCUA
  const isAshrae = newMetric.standard === STANDARDS.ASHRAE223
  const isVda = newMetric.standard === STANDARDS.VDA5050
  const isCustomStandard = newMetric.standard === STANDARDS.CUSTOM

  // Unset after a 223P prefill, or after a group change orphaned an OPC UA data point. The select
  // cannot show "Double" for a value that is not there: `metric_catalog.datatype` is NOT NULL and
  // immutable, so the insert would be refused while the screen said otherwise.
  const datatypeChosen = Number.isInteger(newMetric.datatype)

  // Only MTConnect offers a not-in-the-vocabulary escape in the type picker, because it permits
  // extending its type list. The other standards have Custom for that.
  const usingCustomType = isMTConnect && newMetric.type === CUSTOM_TYPE
  const effectiveType = (usingCustomType || isCustomStandard)
    ? newMetric.customType.trim()
    : newMetric.type

  // Provenance actually recorded. A custom MTConnect type is a local extension, so it drops the
  // MTConnect claim even though the form was on the MTConnect tab.
  const effectiveStandard = (isCustomStandard || usingCustomType) ? STANDARDS.CUSTOM : newMetric.standard

  // MTConnect assigns each data item type a category, so it is derived; a custom type has none to
  // derive, so the operator chooses it. The other standards supply theirs with the vocabulary
  // entry. A Custom metric has none.
  const effectiveCategory = isMTConnect
    ? (usingCustomType ? newMetric.customCategory : categoryOfType(vocabulary, effectiveType))
    : newMetric.vocabCategory

  // For MTConnect only SAMPLE carries units. The other standards state the unit on the vocabulary
  // entry, so the field stays available for them.
  const unitsApply = isMTConnect ? effectiveCategory === CATEGORY_WITH_UNITS : true
  const noUnitsReason = effectiveCategory
    ? `Only a ${CATEGORY_WITH_UNITS} data item has a unit; this type's category is ${effectiveCategory}.`
    : `Only a ${CATEGORY_WITH_UNITS} data item has a unit. Choose a Data Item Type first.`
  const typeGroups = typesByCategory(vocabulary)
  const availableSubTypes = subTypes(vocabulary)
  const isoKpis = kpis(isoVocabulary)
  /**
   * The Data Point picker's sections, narrowed to the selected group. Filtered on suggestedGroup(),
   * the same function opcuaPrefill() uses to set the group, so a visible point can never overwrite
   * the group it was listed under. The sentinel and the empty selection both show everything.
   */
  const opcuaSectionsAll = opcuaSections(opcuaVocabulary)
  const opcuaGroupFilter = newMetric.group && newMetric.group !== NEW_GROUP ? newMetric.group : null
  const opcuaGroups = opcuaGroupFilter
    ? opcuaSectionsAll
        .map(section => ({
          ...section,
          entries: section.entries.filter(e => suggestedGroup(e) === opcuaGroupFilter)
        }))
        .filter(section => section.entries.length > 0)
    : opcuaSectionsAll
  // The Concept picker's sections, by superclass as on the Vocabulary page. Relations are left
  // out: they are predicates, not things a point can be attached to.
  const ashraeSections = ashrae223Sections(metricConcepts(s223Vocabulary))
  // The Field picker's sections, as the Vocabulary page draws them.
  const vdaSections = vda5050Sections(vdaVocabulary)
  // The MTConnect UnitEnum plus whatever the current selection prefilled: ISO 22400 uses HOUR and
  // OPC UA carries UNECE codes, which MTConnect need not list.
  const mtconnectUnits = unitNames(vocabulary)
  const availableUnits = newMetric.units && !mtconnectUnits.includes(newMetric.units)
    ? [newMetric.units, ...mtconnectUnits]
    : mtconnectUnits
  // A case variant of an established group resolves to the established spelling, surfaced before
  // submitting rather than as a database rejection.
  const groupCaseCollision =
    newMetric.group === NEW_GROUP &&
    newMetric.newGroup.trim() !== '' &&
    effectiveGroup !== newMetric.newGroup.trim()
  // One composer for every standard. The subType segment only exists for MTConnect.
  const composedName = composeMetricName(
    effectiveGroup,
    newMetric.instance,
    effectiveType,
    isMTConnect ? newMetric.subType : ''
  )
  // What the metric's own standard gives it: an MTConnect metric its data item type's id, shared by
  // every metric of that type; the others the chosen vocabulary row's id. A custom type or a Custom
  // metric is a local extension and gets none.
  const semanticIdSuggestion = isMTConnect
    ? (usingCustomType ? null : mtconnectSuggestion(effectiveType))
    : vocabularySuggestion(newMetric.standard, effectiveType, newMetric.vocabSemanticId)
  const shownSemanticId = newMetric.semanticIdOwn || {
    semanticId: semanticIdSuggestion?.semanticId || '',
    semanticIdType: semanticIdSuggestion?.semanticIdType || ''
  }
  const { semanticId: semanticIdValue, semanticIdType: semanticIdTypeValue } =
    storedSemanticIdPair(shownSemanticId.semanticId, shownSemanticId.semanticIdType)

  /**
   * The field's pair becomes the operator's own, unless it is the suggestion: Use suggested lands
   * here, and the form then follows the suggestion again. A blank id carries no type.
   */
  const handleSemanticIdChange = (pair) => setNewMetric(m => ({
    ...m,
    semanticIdOwn: semanticIdSuggestion && sameSemanticIdPair(pair, semanticIdSuggestion)
      ? null
      : { semanticId: pair.semanticId, semanticIdType: pair.semanticId.trim() ? pair.semanticIdType : '' }
  }))

  // Shown only once there is a type to compose a name from: before that the name is legitimately
  // half-built, and complaining about it would be scolding the operator mid-keystroke.
  const nameError = effectiveType !== '' ? metricNameError(composedName) : null

  // Offered once the datatype is chosen, since it decides what a value may be. A datatype that takes
  // none sends none, whatever was typed before it changed.
  const takesPermittedValues = datatypeChosen && permittedValuesApply(newMetric.datatype)
  const permitted = takesPermittedValues
    ? parsePermittedValues(newMetric.permittedValues, newMetric.datatype)
    : { values: null, error: null }

  const namesItself = usingCustomType || isCustomStandard
  const addCheck = useFormCheck({
    newGroup: { id: 'metric-new-group', missing: newMetric.group === NEW_GROUP && newMetric.newGroup.trim() === '' && 'Name the new group' },
    type: {
      id: 'metric-type',
      missing: !namesItself && effectiveType === '' && (isIso ? 'Choose a KPI'
        : isOpcua ? 'Choose a data point'
          : isAshrae ? 'Choose a concept'
            : isVda ? 'Choose a field'
              : 'Choose a data item type'),
    },
    custom: { id: 'metric-custom', missing: namesItself && effectiveType === '' && (isCustomStandard ? 'Give the metric a name' : 'Type the custom type') },
    // Said in the callout under the composed name, which is what it is about.
    composed: { id: namesItself ? 'metric-custom' : newMetric.group === NEW_GROUP ? 'metric-new-group' : 'metric-instance', wrong: nameError },
    datatype: { id: 'metric-datatype', missing: !datatypeChosen && 'Choose a Sparkplug datatype' },
    permitted: { id: 'metric-add-permitted-values', wrong: permitted.error },
  })

  /**
   * Edit is on both tabs: a deprecated metric still carries its id into the schemas that model it.
   * The one primary is Restore on a deprecated metric and Edit otherwise; the panel lists it first.
   */
  const metricActions = (m) => [
    // A derived metric has no semantic id or permitted values to correct, and its definition is fixed.
    !isDerived(m) && {
      label: 'Edit', icon: <IconPencil size={13} />,
      onClick: () => setEditTarget(m),
      primary: !m.deprecated,
      disabled: !canEditMetric,
      title: !canEditMetric
        ? requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
        : "Correct this metric's semantic ids, or the values it may report"
    },
    m.deprecated
      ? {
        label: 'Restore', icon: <IconRefreshCw size={13} />,
        onClick: () => setRestoreTarget(m),
        primary: true,
        disabled: !canDeprecateMetric,
        title: !canDeprecateMetric
          ? requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
          : isDerived(m) ? 'List this metric on the Derived tab again' : 'Offer this metric to schema authors again'
      }
      : {
        label: 'Deprecate', icon: <IconArchive size={13} />,
        onClick: () => setDeprecateTarget(m),
        disabled: !canDeprecateMetric,
        danger: true,
        title: !canDeprecateMetric
          ? requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
          : isDerived(m) ? 'Retire this metric from the Derived tab' : 'Retire this metric from the schema builder'
      },
    {
      // Ungated, as the History page is: this metric across every device that reports it, on one scale.
      label: 'View in History', icon: <IconChartLine size={13} />,
      to: metricHistoryUrl(m.name),
      title: 'Compare this metric across the devices that report it on the History page'
    },
    // Withheld from a reader who may not open the Audit Trail, as every drawer's View in Audit Trail is.
    canReadTrail && {
      label: 'View in Audit Trail', icon: <IconHistory size={13} />,
      to: trailUrl(m.metric_uuid, 'METRIC'),
      title: 'Open the Audit Trail filtered to this metric'
    }
  ].filter(Boolean)

  /**
   * The cells both tabs share, so a metric reads the same in each. The deprecated tab's narrowest card
   * has room for Superseded By in place of Units (`superseded`).
   */
  const metricCells = (m, superseded = false) => (
    <>
      {/* The catalog lists measured metrics only; Deprecated lists both, so a derived one says so. */}
      <td>
        <span className="mono">{breakAfterSeparators(m.name)}</span>
        {isDerived(m) && <> <DerivedTag /></>}
      </td>
      {/* Plain text in the row's one meta style: a pill would wrap a long standard name onto two lines. */}
      <td className="cell-meta fit-1280">{m.standard_label || m.standard || LOCAL_EXTENSION_LABEL}</td>
      <td className="cell-meta fit-1400">{m.category || '—'}</td>
      <td className={`cell-meta${superseded ? ' fit-520' : ''}`}>{unitAndCode(unitOf(m)) || '—'}</td>
      <td className="cell-meta fit-700">{datatypeLabel(m.datatype)}</td>
      {/* Cut in the middle: the ids share a long prefix, and the end tells two apart. */}
      <td className="fit-880">
        {m.semantic_id
          ? <CopyableId
              value={m.semantic_id}
              label={`semantic id${m.semantic_id_type ? ` (${m.semantic_id_type})` : ''}`}
              onNotify={showToast}
              truncate="start"
            />
          : <span className="cell-meta">—</span>}
        {/* The ids beside it are in the drawer; the row says only that there are some. */}
        {m.semantic_id && (m.further_semantic_ids || []).length > 0 && (
          <div className="cell-meta">+{m.further_semantic_ids.length} further</div>
        )}
      </td>
      <td className="cell-meta fit-1100">{m.description || '—'}</td>
    </>
  )

  const selectRow = (m) => setSelectedId(id => id === m.metric_uuid ? null : m.metric_uuid)
  const rowClass = (m) => `row-selectable${selectedId === m.metric_uuid ? ' row-selected' : ''}`
  /** A row opens the drawer from anywhere on it, by mouse or by Enter or Space while it has focus. */
  const rowProps = (m) => ({
    className: rowClass(m),
    tabIndex: 0,
    onClick: rowSelectHandler(() => selectRow(m)),
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
      e.preventDefault()
      selectRow(m)
    }
  })

  const selectedReplacement = selected?.superseded_by ? metricById.get(selected.superseded_by) : null
  const selectedSchemas = selected ? schemasUsing(selected) : []
  const selectedUsage = selectedSchemas.length

  /**
   * One column set for both tabs, fixed (`.metric-table`), so opening a group cannot move a column
   * and the two tabs line up. Description takes what is left; the deprecated tab adds Superseded By.
   */
  const metricColumns = (superseded) => (
    <colgroup>
      <col className="metric-col-name" />
      <col className="metric-col-standard fit-1280" />
      <col className="metric-col-category fit-1400" />
      <col className={`metric-col-units${superseded ? ' fit-520' : ''}`} />
      <col className="metric-col-datatype fit-700" />
      <col className="metric-col-semantic-id fit-880" />
      <col className="fit-1100" />
      {superseded && <col className="metric-col-superseded" />}
    </colgroup>
  )

  const catalogHeaders = (sort, superseded = false) => (
    <>
      <SortHeader sort={sort} column="name">Name</SortHeader>
      <SortHeader sort={sort} column="standard" className="fit-1280" title="Which standard vocabulary this metric was named from">Standard</SortHeader>
      <SortHeader sort={sort} column="category" className="fit-1400" title="MTConnect observation category">Category</SortHeader>
      <SortHeader sort={sort} column="units" className={superseded ? 'fit-520' : undefined}>Units</SortHeader>
      <SortHeader sort={sort} column="datatype" className="fit-700" title="How the value is encoded on the wire">Datatype</SortHeader>
      <SortHeader sort={sort} column="semantic_id" className="fit-880" title="The AAS id of the concept the metric measures. A dash is a metric mapped to none, which Edit can map. A line under an id counts the further ids it carries.">Semantic ID</SortHeader>
      <SortHeader sort={sort} column="description" className="fit-1100">Description</SortHeader>
    </>
  )

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        {/* One card: the catalog and the deprecated metrics are two tabs of it, and the table of the
            tab on show scrolls inside it. */}
        <div className="card card-fill">
          <CardHeading
            icon={<IconTag size={15} />}
            title="Metrics"
            description="The catalog of metrics that schemas are built from, the ones Aber computes from them, the ones since deprecated, and the names devices declare that it lacks."
          />

          {/* Every tab is always there, so a deprecation has a known place to be undone. Uncatalogued
              carries its count once read, so an empty list reads as good news from the tab bar. */}
          <TabStrip
            ariaLabel="Metrics"
            value={view}
            hrefFor={viewHref}
            onChange={id => { if (id !== view) { setView(id); setSelectedId(null) } }}
            tabs={VIEWS.map(v => (v.id === 'uncatalogued' && uncatalogued
              ? { ...v, label: `${v.label} (${uncatalogued.length})` }
              : v))}
          />

          {view === 'catalog' && (
            <>
              {/* The groups start collapsed, so the search and the filters are how metrics are
                  reached; they open the groups that matched. */}
              <div className="filter-bar">
                <SearchInput
                  value={catalogSearch}
                  onChange={setCatalogSearch}
                  placeholder="Search name or UUID…"
                  ariaLabel="Search the metric catalog"
                />
                <FilterDropdown
                  label="Standard"
                  noun="standard"
                  plural="standards"
                  options={standardFilterOptions(siteVocabularies)}
                  value={standardFilter}
                  onChange={setStandardFilter}
                  counts={facetCounts.standard}
                  width="md"
                />
                <Tooltip text="Metrics with no semantic id. An AAS export writes them without one, so they cannot fill a Digital Nameplate field.">
                  <button
                    type="button"
                    className={`btn btn-sm ${unmappedOnly ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setUnmappedOnly(v => !v)}
                    aria-pressed={unmappedOnly}
                  >
                    Unmapped ({unmappedCount})
                  </button>
                </Tooltip>
                <div className="filter-bar-actions">
                  <ClearFilters count={catalogFilterCount} onClear={clearCatalogFilters} />
                  <ActionButton
                    className="btn btn-primary btn-sm"
                    permitted={canManageSchema}
                    deniedTitle={requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)}
                    onClick={() => setShowAddMetric(true)}
                  >
                    <IconPlus size={13} /> Add Metric
                  </ActionButton>
                </div>
              </div>

              {/* The control that acts on the groups sits at the start of the row over them, not in
                  the toolbar. Drawn with the table: an empty list has no group to open. */}
              {loaded && catalogGroups.length > 0 && (
                <div className="groups-header">
                  <ExpandAllToggle
                    anyOpen={catalogGroups.some(g => openGroups.isOpen(g.label))}
                    onExpandAll={() => setAllGroups(true)}
                    onCollapseAll={() => setAllGroups(false)}
                    noun="groups"
                  />
                </div>
              )}

              {!loaded ? <LoadingState label="catalog" /> : catalogGroups.length === 0 ? (
                <EmptyState
                  icon={<IconBookOpen size={36} />}
                  filtered={catalogFilterCount > 0}
                  message={deprecatedCatalog.length > 0
                    ? 'Every metric in the catalog is deprecated.'
                    : 'No metrics in the catalog yet.'}
                  filteredMessage={catalogFilterCount === 1 && catalogSearch
                    ? <>No metric matches <strong>{catalogSearch}</strong>.</>
                    : 'No metric matches these filters.'}
                />
              ) : (
                <div className="table-wrap">
                  <table className="table-fit metric-table">
                    {metricColumns(false)}
                    <thead><tr>{catalogHeaders(catalogSort)}</tr></thead>
                    {catalogGroups.map((group, i) => {
                      const open = openGroups.isOpen(group.label)
                      const rowsId = `catalog-group-${i}`
                      return (
                        <React.Fragment key={group.label}>
                          <tbody>
                            <tr className="table-group-row">
                              <td colSpan={7}>
                                <GroupHeading
                                  open={open}
                                  onToggle={() => openGroups.toggle(group.label)}
                                  label={group.label}
                                  muted={group.isUngrouped}
                                  count={group.metrics.length}
                                  countLabel={plural(group.metrics.length, 'metric')}
                                  title={group.isUngrouped
                                    ? 'Metric names with no "Group/Metric" prefix, so in no component'
                                    : `Metrics named "${group.label}/…"`}
                                  controls={rowsId}
                                />
                              </td>
                            </tr>
                          </tbody>
                          <tbody id={rowsId} hidden={!open}>
                            {open && catalogSort.apply(group.metrics).map(m => (
                              <tr key={m.metric_uuid} {...rowProps(m)}>
                                {metricCells(m)}
                              </tr>
                            ))}
                          </tbody>
                        </React.Fragment>
                      )
                    })}
                  </table>
                </div>
              )}
            </>
          )}

          {view === 'derived' && (
            <>
              <div className="filter-bar">
                <SearchInput
                  value={derivedSearch}
                  onChange={setDerivedSearch}
                  placeholder="Search name, definition or UUID…"
                  ariaLabel="Search the derived metrics"
                />
                <div className="filter-bar-actions">
                  <ClearFilters count={derivedSearch ? 1 : 0} onClear={() => setDerivedSearch('')} />
                  <ActionButton
                    className="btn btn-primary btn-sm"
                    permitted={canManageSchema}
                    deniedTitle={requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)}
                    title="Choose a derived-metrics.yaml file. It opens in the editor, and is checked and shown to you before anything is saved"
                    onClick={yaml.uploadFile}
                  >
                    <IconUpload size={13} aria-hidden="true" /> Upload
                  </ActionButton>
                  <ActionButton
                    className="btn btn-primary btn-sm"
                    disabled={derivedCatalog.length === 0}
                    title={yaml.pickedIds.length
                      ? `Download the ${plural(yaml.pickedIds.length, 'derived metric')} you ticked as ${DERIVED_METRICS_FILE_NAME}`
                      : derivedCatalog.length === 0 ? 'There is no derived metric to export' : `Download every derived metric as ${DERIVED_METRICS_FILE_NAME}. Tick some to export only those`}
                    onClick={yaml.exportYaml}
                  >
                    <IconDownload size={13} aria-hidden="true" /> {yaml.pickedIds.length ? `Export (${yaml.pickedIds.length})` : 'Export'}
                  </ActionButton>
                  <ActionButton
                    className="btn btn-primary btn-sm"
                    permitted={canManageSchema}
                    deniedTitle={requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)}
                    title="Write derived metrics as YAML in an editor, as the Automations page does. Nothing is saved until you confirm what it would do"
                    onClick={yaml.newFile}
                  >
                    <IconPlus size={13} aria-hidden="true" /> New in YAML
                  </ActionButton>
                  <ActionButton
                    className="btn btn-primary btn-sm"
                    permitted={canManageSchema}
                    deniedTitle={requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)}
                    onClick={() => setShowAddDerived(true)}
                  >
                    <IconPlus size={13} /> Add Derived Metric
                  </ActionButton>
                </div>
              </div>

              {!loaded ? <LoadingState label="catalog" /> : shownDerived.length === 0 ? (
                <EmptyState
                  icon={<IconTag size={36} />}
                  filtered={derivedCatalog.length > 0}
                  message="No derived metric yet. Add one to compute a rate, a share of time or a total from metrics the catalog already holds."
                  filteredMessage={<>No derived metric matches <strong>{derivedSearch}</strong>.</>}
                />
              ) : (
                <div className="table-wrap">
                  <table className="table-fit metric-table">
                    <colgroup>
                      <col className="automation-select" />
                      <col className="metric-col-name" />
                      <col className="metric-col-kind fit-880" />
                      <col />
                      <col className="metric-col-units fit-700" />
                      <col className="metric-col-description fit-1100" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th className="automation-select">
                          <input
                            ref={yaml.headBox}
                            type="checkbox"
                            aria-label="Select every derived metric shown"
                            checked={yaml.allShown}
                            onChange={yaml.toggleAllShown}
                          />
                        </th>
                        <SortHeader sort={derivedSort} column="name">Name</SortHeader>
                        <SortHeader sort={derivedSort} column="kind" className="fit-880" title="How the value is computed">Kind</SortHeader>
                        <SortHeader sort={derivedSort} column="definition" title="The metrics it is computed from, and how. A definition cannot change once saved.">Definition</SortHeader>
                        <SortHeader sort={derivedSort} column="units" className="fit-700" title="Follows the inputs: a rate is the counter's unit per hour, a share of time has none">Units</SortHeader>
                        <SortHeader sort={derivedSort} column="description" className="fit-1100">Description</SortHeader>
                      </tr>
                    </thead>
                    <tbody>
                      {derivedRows.map(m => (
                        <tr key={m.metric_uuid} {...rowProps(m)}>
                          <td className="automation-select">
                            <input
                              type="checkbox"
                              aria-label={`Select ${m.name}`}
                              checked={yaml.ticked.has(m.metric_uuid)}
                              onChange={() => yaml.toggle(m.metric_uuid)}
                            />
                          </td>
                          <td><span className="mono">{breakAfterSeparators(m.name)}</span></td>
                          <td className="cell-meta fit-880">{kindLabel(m.derivation.kind)}</td>
                          <td><Definition derivation={m.derivation} /></td>
                          <td className="cell-meta fit-700">{unitAndCode(unitOf(m)) || '—'}</td>
                          <td className="cell-meta fit-1100">{m.description || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {view === 'deprecated' && (
            <>
              {/* Kept mounted across a reload (`loaded` stays true), so the rows do not vanish and
                  reappear after a save. */}
              {!loaded ? <LoadingState label="catalog" /> : deprecatedCatalog.length === 0 ? (
                <EmptyState icon={<IconArchive size={36} />} message="No metric is deprecated." />
              ) : (
                <div className="table-wrap">
                  <table className="table-fit metric-table">
                    {metricColumns(true)}
                    <thead>
                      <tr>
                        {catalogHeaders(deprecatedSort, true)}
                        <SortHeader sort={deprecatedSort} column="superseded_by" title="The metric named as its replacement when it was deprecated, or a dash where none was.">Superseded By</SortHeader>
                      </tr>
                    </thead>
                    <tbody>
                      {deprecatedRows.map(m => {
                        const replacement = m.superseded_by ? metricById.get(m.superseded_by) : null
                        return (
                          <tr key={m.metric_uuid} {...rowProps(m)}>
                            {metricCells(m, true)}
                            <td>
                              {replacement
                                ? <MetricChip metric={replacement} />
                                : <span className="cell-meta">—</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {view === 'uncatalogued' && (
            <>
              {/* Drawn once there is a list to narrow: a fleet on an empty catalog lists every name. */}
              {uncatalogued?.length > 0 && (
                <div className="filter-bar">
                  <SearchInput
                    value={uncataloguedSearch}
                    onChange={setUncataloguedSearch}
                    placeholder="Search names…"
                    ariaLabel="Search the uncatalogued metrics"
                  />
                </div>
              )}

              {uncataloguedError ? (
                <Callout tone="danger">The uncatalogued metrics could not be read: {uncataloguedError}</Callout>
              ) : !uncatalogued ? <LoadingState label="uncatalogued metrics" /> : shownUncatalogued.length === 0 ? (
                <EmptyState
                  icon={uncatalogued.length === 0 ? <IconCheck size={36} /> : <IconTag size={36} />}
                  filtered={uncatalogued.length > 0}
                  message="Every metric the devices declare is in the catalog."
                  filteredMessage={<>No uncatalogued metric matches <strong>{uncataloguedSearch}</strong>.</>}
                />
              ) : (
                <div className="table-wrap">
                  <table className="table-fit metric-table metric-table-uncatalogued">
                    <colgroup>
                      <col className="metric-col-name" />
                      <col className="metric-col-count fit-1100" />
                      <col />
                      <col className="metric-col-datatype fit-700" />
                      <col className="metric-col-declared fit-880" />
                    </colgroup>
                    <thead>
                      <tr>
                        <SortHeader sort={uncataloguedSort} column="name">Name</SortHeader>
                        <SortHeader sort={uncataloguedSort} column="devices" className="fit-1100" title="How many devices declare this name">Devices</SortHeader>
                        <ColumnHeader title="The devices that declare it. Each opens on the Devices page.">Declared By</ColumnHeader>
                        <SortHeader sort={uncataloguedSort} column="datatype" className="fit-700" title="The datatype the devices' births gave it. A dash means none gave it a value; several mean they disagree.">Datatype</SortHeader>
                        <SortHeader sort={uncataloguedSort} column="last_declared" className="fit-880" title="The latest birth that changed what one of these devices declares. A rebirth declaring the same names does not count.">Last Declared</SortHeader>
                      </tr>
                    </thead>
                    <tbody>
                      {uncataloguedRows.map(u => {
                        const devices = u.devices || []
                        const showAll = allDevicesShown[u.metric_name] || devices.length <= UNCATALOGUED_DEVICES_SHOWN + 1
                        const hidden = devices.length - UNCATALOGUED_DEVICES_SHOWN
                        const datatypes = u.datatypes || []
                        // A row opens its drawer, which holds Catalogue, from anywhere on it but a chip.
                        return (
                          <tr
                            key={u.metric_name}
                            className={`row-selectable${declaredName === u.metric_name ? ' row-selected' : ''}`}
                            tabIndex={0}
                            onClick={rowSelectHandler(() => selectDeclared(u))}
                            onKeyDown={(e) => {
                              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                              e.preventDefault()
                              selectDeclared(u)
                            }}
                          >
                            <td><span className="mono">{breakAfterSeparators(u.metric_name)}</span></td>
                            <td className="cell-meta fit-1100">{u.device_count}</td>
                            <td>
                              <div className="context-device-list">
                                {(showAll ? devices : devices.slice(0, UNCATALOGUED_DEVICES_SHOWN)).map(d => (
                                  <RecordChip
                                    key={d.id}
                                    kind="devices"
                                    to={deviceUrl(d.id)}
                                    name={d.name}
                                    note={d.quarantined && 'It is in quarantine, awaiting approval.'}
                                  >
                                    {d.quarantined && <span className="cell-meta">quarantined</span>}
                                  </RecordChip>
                                ))}
                                {!showAll && (
                                  <RecordChip
                                    icon={null}
                                    name={`${hidden} more`}
                                    onClick={() => setAllDevicesShown(prev => ({ ...prev, [u.metric_name]: true }))}
                                  />
                                )}
                              </div>
                            </td>
                            <td className="cell-meta fit-700">
                              {datatypes.length ? datatypes.map(datatypeLabel).join(', ') : '—'}
                            </td>
                            <td className="cell-meta fit-880">{formatDateTime(u.last_declared_at)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <ContextPanel
        open={!!selected}
        onClose={() => setSelectedId(null)}
        type="METRIC"
        subject="metric"
        onCopy={showToast}
        title={selected?.name || ''}
        icon={<IconTag size={16} />}
        subtitle={selected?.deprecated && <Badge tone="warning" size="sm">Deprecated</Badge>}
        recordId={selected && { label: 'Metric UUID', value: selected.metric_uuid }}
        description={selected && { value: selected.description }}
        fields={selected ? [
          { label: 'Name', value: selected.name, mono: true, copyable: true },
          // A derived metric is a local extension that no device publishes: what it is, and how its
          // value is made, take the place of the standard, the semantic id and the permitted values.
          isDerived(selected) && { label: 'Kind', value: kindLabel(selected.derivation.kind) },
          isDerived(selected) && {
            label: 'Definition',
            value: <Definition derivation={selected.derivation} />,
            full: true,
            help: 'How Aber computes it from other metrics. It cannot be changed: a different definition is a new derived metric.'
          },
          // The devices in service whose schemas name it: the ones the Metric tab compares it across.
          // View in History compares them on one scale.
          isDerived(selected) && devices && {
            label: 'Applies To',
            value: <AppliesTo devices={metricDevices(devices, schemas, selected.name, { catalog })} naming={selectedUsage} />,
            full: true,
            help: `${APPLIES_TO_RULE} Each opens on the Devices page. Nothing is stored: the value is computed when it is drawn.`
          },
          !isDerived(selected) && { label: 'Standard', value: selected.standard_label || selected.standard || LOCAL_EXTENSION_LABEL },
          !isDerived(selected) && { label: 'Category', value: selected.category || null },
          // A time in state has no unit of its own: it is a fraction, shown as a percentage of the time.
          isShare(selected.derivation)
            ? { label: 'Units', value: SHARE_UNIT_WORDS, full: true }
            : { label: 'Units', value: unitAndCode(selected.units) || null },
          { label: 'Datatype', value: datatypeLabel(selected.datatype) },
          !isDerived(selected) && { label: 'Semantic ID', value: selected.semantic_id || null, mono: true, copyable: true, full: true },
          !isDerived(selected) && { label: 'Reference Type', value: selected.semantic_id ? selected.semantic_id_type || null : null },
          // Static text for every role: a person who may write changes them in Edit.
          !isDerived(selected) && selected.semantic_id && (selected.further_semantic_ids || []).length > 0 && {
            label: 'Further Semantic IDs',
            value: <FurtherSemanticIdList ids={furtherIdsOf(selected)} />,
            full: true,
            help: "Other published ids of the same concept. The AAS export carries them beside the metric's own id."
          },
          !isDerived(selected) && {
            label: 'Permitted Values',
            value: permittedValuesText(selected.permitted_values) || null,
            full: true,
            help: 'The only values it may report. A schema built from it copies them; blank allows any value.'
          },
          selected.deprecated && {
            label: 'Superseded By',
            value: selectedReplacement
              ? <MetricChip metric={selectedReplacement} />
              : null,
            full: Boolean(selectedReplacement),
            help: selectedReplacement ? undefined : 'No replacement was named'
          },
          // A derived metric is named, not modelled: until a schema names it, no device has it.
          isDerived(selected) ? {
            label: 'Schemas',
            value: selectedUsage > 0 ? <SchemasUsing versions={selectedSchemas} /> : (
              <>No schema names it yet. <RouteLink to={tabUrl('schemas')} className="count-link" title="Open the Schemas page, where a schema's editor names it">View in Schemas</RouteLink></>
            ),
            full: selectedUsage > 0,
            help: 'The schema versions that name it, newest first. A device has the derived metrics its schemas name.'
          } : {
            label: 'Schemas',
            value: selectedUsage === 0 ? 'None model it' : <SchemasUsing versions={selectedSchemas} />,
            full: selectedUsage > 0,
            help: selectedUsage > 0 ? 'The schema versions that model it, newest first. Each opens on the Schemas page.' : undefined
          }
        ].filter(Boolean) : []}
        actions={selected ? metricActions(selected) : []}
      />

      <UncataloguedDrawer
        row={declared}
        canCatalogue={canManageSchema}
        onCatalogue={handleCatalogue}
        onClose={() => setDeclaredName('')}
        onCopy={showToast}
      />

      {showAddMetric && (
        <Modal
          title="Add Metric"
          icon={<IconPlus size={18} />}
          size="xl"
          busy={adding}
          onClose={closeAddMetric}
          lead="Adds a metric to this site's catalog, named from the parts below."
          problem={addCheck.problem}
          error={addError}
          dismiss="Cancel"
          footer={
            <ActionButton
              className="btn btn-primary"
              pending={adding}
              pendingLabel="Adding…"
              onClick={() => addCheck.press(() => runAdd(handleAddMetric))}
            >
              Add Metric
            </ActionButton>
          }
        >
          <div className="metric-form">
            {/* Chosen first because it decides what every control to its right offers. */}
            <div className="form-group" style={{ flex: '0 1 150px' }}>
              <label className="form-label" htmlFor="metric-standard">Standard</label>
              {/* The tooltip describes the choice made, which the options cannot do for a keyboard. */}
              <Tooltip text={STANDARD_OPTIONS.find(o => o.value === newMetric.standard)?.hint
                || 'The vocabulary the metric is named from. An AAS export reads it to choose the namespace.'}>
                <select
                  id="metric-standard"
                  className="form-control"
                  value={newMetric.standard}
                  onChange={e => handleStandardChange(e.target.value)}
                >
                  {STANDARD_OPTIONS.map(o => (
                    <option key={o.label} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Tooltip>
            </div>

            <div className="form-group" style={{ flex: '0 1 170px' }}>
              <label className="form-label" htmlFor="metric-group">Group</label>
              <Tooltip text="The component the metric belongs to. It is the first segment of the name the device publishes.">
                <select
                  id="metric-group"
                  className="form-control"
                  value={newMetric.group}
                  onChange={e => handleGroupChange(e.target.value)}
                >
                  <option value="">— No group —</option>
                  {groupOptions.map(bucket => (
                    <optgroup key={bucket.label} label={`${bucket.label} (${bucket.names.length})`}>
                      {bucket.names.map(g => <option key={g} value={g}>{g}</option>)}
                    </optgroup>
                  ))}
                  <option value={NEW_GROUP}>+ New group…</option>
                </select>
              </Tooltip>
            </div>

            {newMetric.group === NEW_GROUP && (
              <div className="form-group" style={{ flex: '0 1 170px' }}>
                <label className="form-label" htmlFor="metric-new-group">New Group Name <RequiredMark /></label>
                <Tooltip text="One segment of the name, so it cannot contain a slash.">
                  <input
                    id="metric-new-group"
                    aria-required="true"
                    className="form-control"
                    value={newMetric.newGroup}
                    onChange={e => setNewMetric(m => ({ ...m, newGroup: e.target.value.replace(/\//g, '') }))}
                    placeholder="e.g. Hydraulic"
                    {...fieldErrorProps(addCheck.errors.newGroup, 'metric-new-group-error')}
                  />
                </Tooltip>
                <FieldError id="metric-new-group-error" error={addCheck.errors.newGroup} />
              </div>
            )}

            <div className="form-group" style={{ flex: '0 1 110px' }}>
              <label className="form-label" htmlFor="metric-instance">Instance</label>
              <Tooltip text="Which one, when the component occurs more than once: the axis name, the spindle number. Blank if only one.">
                <input
                  id="metric-instance"
                  className="form-control"
                  value={newMetric.instance}
                  onChange={e => setNewMetric(m => ({ ...m, instance: e.target.value.replace(/\//g, '') }))}
                  placeholder="e.g. C"
                />
              </Tooltip>
            </div>

            {/* One slot, five vocabularies. The Standard selector decides which fills it, so the
                label changes with it. */}
            {isMTConnect && (
              <div className="form-group" style={{ flex: '1 1 200px' }}>
                <label className="form-label" htmlFor="metric-type">Data Item Type <RequiredMark /></label>
                <Tooltip text="SAMPLE is a continuous measurement, EVENT a discrete change of state, CONDITION a fault or warning.">
                  <select
                    id="metric-type"
                    aria-required="true"
                    className="form-control"
                    value={newMetric.type}
                    onChange={e => handleTypeChange(e.target.value)}
                    {...fieldErrorProps(addCheck.errors.type, 'metric-type-error')}
                  >
                    <option value="">— Select a type —</option>
                    {typeGroups.map(g => (
                      <optgroup key={g.category} label={`${g.category} (${g.types.length})`}>
                        {g.types.map(t => <option key={t} value={t}>{t}</option>)}
                      </optgroup>
                    ))}
                    <option value={CUSTOM_TYPE}>+ Not in MTConnect…</option>
                  </select>
                </Tooltip>
                <FieldError id="metric-type-error" error={addCheck.errors.type} />
              </div>
            )}

            {isIso && (
              <div className="form-group" style={{ flex: '1 1 200px' }}>
                <label className="form-label" htmlFor="metric-type">KPI <RequiredMark /></label>
                <Tooltip text={isoKpis.find(k => k.name === newMetric.type)?.formula
                  || 'Choosing a KPI fills in its unit, semantic id and group, which belong to the standard.'}>
                  <select
                    id="metric-type"
                    aria-required="true"
                    className="form-control"
                    value={newMetric.type}
                    onChange={e => handleTypeChange(e.target.value)}
                    {...fieldErrorProps(addCheck.errors.type, 'metric-type-error')}
                  >
                    <option value="">— Select a KPI —</option>
                    {isoKpis.map(k => (
                      <option key={k.name} value={k.name}>
                        {k.name}{k.kpi_id && k.kpi_id !== k.name ? ` (${k.kpi_id})` : ''}
                      </option>
                    ))}
                  </select>
                </Tooltip>
                <FieldError id="metric-type-error" error={addCheck.errors.type} />
              </div>
            )}

            {isOpcua && (
              <div className="form-group" style={{ flex: '1 1 220px' }}>
                <label className="form-label" htmlFor="metric-type">Data Point <RequiredMark /></label>
                <Tooltip text={chosenDataPoint?.description
                  || 'Choosing a data point fills in its group, its datatype and its semantic id.'}>
                  <select
                    id="metric-type"
                    aria-required="true"
                    className="form-control"
                    value={chosenDataPoint
                      ? `${chosenDataPoint.companion_spec}${OPCUA_KEY_SEP}${chosenDataPoint.name}`
                      : ''}
                    onChange={e => handleTypeChange(e.target.value)}
                    {...fieldErrorProps(addCheck.errors.type, 'metric-type-error')}
                  >
                    <option value="">— Select a data point —</option>
                    {/* Says why it is empty: a group no companion specification covers yields
                        nothing. Disabled because it is a message, not a choice. */}
                    {opcuaGroups.length === 0 && (
                      <option value="" disabled>
                        No OPC UA data points under &quot;{opcuaGroupFilter}&quot; — clear the group to see all
                      </option>
                    )}
                    {opcuaGroups.map(section => (
                      <optgroup key={section.key} label={`${section.title} (${section.entries.length})`}>
                        {section.entries.map(p => (
                          <option
                            key={`${p.companion_spec}${OPCUA_KEY_SEP}${p.name}`}
                            value={`${p.companion_spec}${OPCUA_KEY_SEP}${p.name}`}
                          >
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </Tooltip>
                <FieldError id="metric-type-error" error={addCheck.errors.type} />
              </div>
            )}

            {isAshrae && (
              <div className="form-group" style={{ flex: '1 1 220px' }}>
                <label className="form-label" htmlFor="metric-type">Concept <RequiredMark /></label>
                <Tooltip text={ashraeSections.flatMap(s => s.entries).find(c => c.name === newMetric.type)?.description
                  || 'Choosing a concept fills in the group and the name. A concept names a thing, so the rest stays yours.'}>
                  <select
                    id="metric-type"
                    aria-required="true"
                    className="form-control"
                    value={newMetric.type}
                    onChange={e => handleTypeChange(e.target.value)}
                    {...fieldErrorProps(addCheck.errors.type, 'metric-type-error')}
                  >
                    <option value="">— Select a concept —</option>
                    {ashraeSections.map(section => (
                      <optgroup key={section.key} label={`${section.title} (${section.entries.length})`}>
                        {section.entries.map(c => (
                          <option key={c.name} value={c.name}>{c.label || c.name}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </Tooltip>
                <FieldError id="metric-type-error" error={addCheck.errors.type} />
              </div>
            )}

            {isVda && (
              <div className="form-group" style={{ flex: '1 1 220px' }}>
                <label className="form-label" htmlFor="metric-type">Field <RequiredMark /></label>
                <Tooltip text={fieldByType(vdaVocabulary, newMetric.type)?.description
                  || 'Choosing a field fills in the group, the name, the datatype and the semantic id. VDA 5050 3.0 calls the vehicle a mobile robot.'}>
                  <select
                    id="metric-type"
                    aria-required="true"
                    className="form-control"
                    value={newMetric.type}
                    onChange={e => handleTypeChange(e.target.value)}
                    {...fieldErrorProps(addCheck.errors.type, 'metric-type-error')}
                  >
                    <option value="">— Select a field —</option>
                    {vdaSections.map(section => (
                      <optgroup key={section.key} label={section.title + ' (' + section.entries.length + ')'}>
                        {section.entries.map(f => (
                          <option key={f.name} value={fieldType(f)}>{f.name}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </Tooltip>
                <FieldError id="metric-type-error" error={addCheck.errors.type} />
              </div>
            )}

            {(usingCustomType || isCustomStandard) && (
              <div className="form-group" style={{ flex: '1 1 170px' }}>
                <label className="form-label" htmlFor="metric-custom">{isCustomStandard ? 'Metric Name' : 'Custom Type'} <RequiredMark /></label>
                <Tooltip text={isCustomStandard
                  ? 'A local extension, with no standard behind it. It still groups and tags like every other metric.'
                  : 'A local extension. MTConnect allows these, but prefer a standard type where one fits.'}>
                  <input
                    id="metric-custom"
                    aria-required="true"
                    className="form-control"
                    value={newMetric.customType}
                    onChange={e => setNewMetric(m => ({ ...m, customType: e.target.value.replace(/\//g, '') }))}
                    placeholder="e.g. VIBRATION_RMS"
                    {...fieldErrorProps(addCheck.errors.custom, 'metric-custom-error')}
                  />
                </Tooltip>
                <FieldError id="metric-custom-error" error={addCheck.errors.custom} />
              </div>
            )}

            {/* Every MTConnect data item declares one, an extension included. It decides whether
                Units is offered, so it is asked before Units. */}
            {usingCustomType && (
              <div className="form-group" style={{ flex: '0 1 150px' }}>
                <label className="form-label" htmlFor="metric-custom-category">Category</label>
                <Tooltip text="SAMPLE is a measured quantity and takes a unit. EVENT is a change of state, CONDITION a fault or warning.">
                  <select
                    id="metric-custom-category"
                    className="form-control"
                    value={newMetric.customCategory}
                    onChange={e => setNewMetric(m => ({ ...m, customCategory: e.target.value }))}
                  >
                    {MTCONNECT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Tooltip>
              </div>
            )}

            {/* MTConnect only: a subType qualifies a data item type. An ISO KPI and an OPC UA
                browse name are whole concepts, so there is nothing to qualify. */}
            {isMTConnect && (
              <div className="form-group" style={{ flex: '0 1 150px' }}>
                <label className="form-label" htmlFor="metric-subtype">Sub Type</label>
                <Tooltip text="An optional qualifier, such as ACTUAL or COMMANDED. It ends the name, so the variants do not collide.">
                  <select
                    id="metric-subtype"
                    className="form-control"
                    value={newMetric.subType}
                    onChange={e => setNewMetric(m => ({ ...m, subType: e.target.value }))}
                  >
                    <option value="">— None —</option>
                    {availableSubTypes.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Tooltip>
              </div>
            )}

            {unitsApply ? (
              <div className="form-group" style={{ flex: '0 1 150px' }}>
                <label className="form-label" htmlFor="metric-units">Units</label>
                <Tooltip text="A vocabulary entry fills it where its standard states one; otherwise you choose it.">
                  <select
                    id="metric-units"
                    className="form-control"
                    value={newMetric.units}
                    onChange={e => setNewMetric(m => ({ ...m, units: e.target.value }))}
                  >
                    <option value="">— None —</option>
                    {availableUnits.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </Tooltip>
              </div>
            ) : (
              // A type that takes no unit is a fact, as Edit Metric shows a name it cannot change.
              <StaticField label="Units" value="None" reason={noUnitsReason} style={{ flex: '0 1 220px' }} />
            )}

            <div className="form-group" style={{ flex: '0 1 140px' }}>
              <label className="form-label" htmlFor="metric-datatype">Sparkplug Datatype <RequiredMark /></label>
              <Tooltip text="How the value is encoded on the wire. A vocabulary entry fills it where it can. It cannot change later.">
                <select
                  id="metric-datatype"
                  aria-required="true"
                  className="form-control"
                  value={datatypeChosen ? newMetric.datatype : ''}
                  onChange={e => setNewMetric(m => ({ ...m, datatype: parseInt(e.target.value, 10) }))}
                  {...fieldErrorProps(addCheck.errors.datatype, 'metric-datatype-error')}
                >
                  {/* Shown only while nothing is chosen: a select must not read "Double" while the
                      form holds no datatype. */}
                  {!datatypeChosen && <option value="">— Choose —</option>}
                  {SPARKPLUG_DATATYPES.map(d => <option key={d.code} value={d.code}>{d.label}</option>)}
                </select>
              </Tooltip>
              <FieldError id="metric-datatype-error" error={addCheck.errors.datatype} />
            </div>

            <div className="form-group" style={{ flex: '2 1 200px' }}>
              <label className="form-label" htmlFor="metric-description">Description</label>
              <input id="metric-description" className="form-control" value={newMetric.description} onChange={e => setNewMetric(m => ({ ...m, description: e.target.value }))} placeholder="What this metric represents" aria-describedby={newMetric.definitionWithheld ? 'metric-description-withheld' : undefined} />
              {newMetric.definitionWithheld && (
                <div className="form-hint" id="metric-description-withheld">
                  The imported definition is not copied here: its vocabulary's definitions are not shared, and a description
                  is read by every export. Write your own.
                </div>
              )}
            </div>

            {takesPermittedValues && (
              <PermittedValuesField
                idPrefix="metric-add"
                datatype={newMetric.datatype}
                value={newMetric.permittedValues}
                onChange={text => setNewMetric(m => ({ ...m, permittedValues: text }))}
                error={addCheck.errors.permitted}
                style={{ flex: '2 1 200px' }}
              />
            )}

            {/* The field Edit uses too. It shows the suggestion until the operator types or picks
                their own, and Use suggested brings it back. */}
            <SemanticIdField
              idPrefix="metric-add"
              subject="metric"
              semanticId={shownSemanticId.semanticId}
              semanticIdType={shownSemanticId.semanticIdType}
              suggestion={semanticIdSuggestion}
              candidates={semanticIdChoices}
              ownStandard={effectiveStandard}
              onChange={handleSemanticIdChange}
              style={{ margin: 0, flex: '1 1 100%' }}
            />
          </div>

          {/* The composed name is what goes on the wire and can never be edited afterwards, so it
              is shown rather than left to be inferred from two fields. */}
          <div className="form-hint">
            Devices will publish this metric as{' '}
            <span className="mono">{composedName || '…'}</span>
            {' '}— immutable once created.
            {effectiveCategory && (
              <> Category <strong>{effectiveCategory}</strong>
                {usingCustomType
                  ? ', as you chose it.'
                  : isMTConnect ? ', from the MTConnect standard.' : `, mapped from ${newMetric.standard}.`}</>
            )}
            {effectiveStandard
              ? <> Provenance <strong>{effectiveStandard}</strong>.</>
              : newMetric.siteVocabularyId
                ? <> Recorded as a <strong>local extension</strong>, linked to {siteVocabularyLabel(siteVocabularies, newMetric.siteVocabularyId)}.</>
                : <> Recorded as a <strong>local extension</strong>, with no standard provenance.</>}
            {semanticIdValue && (
              <> Semantic id <span className="mono">{semanticIdValue}</span>
                {semanticIdTypeValue ? ` (${semanticIdTypeValue})` : ''}; unlike the name, an Administrator can correct it later with Edit.</>
            )}
          </div>

          {/* The database enforces the same format (metric_catalog_name_format), but a 400 after
              pressing Add is a poor way to learn it, and the name is immutable. */}
          {nameError && (
            <Callout tone="danger">{nameError}</Callout>
          )}

          {!datatypeChosen && (
            <Callout tone="warning">
              Choose a Sparkplug datatype.{' '}
              {cataloguing
                ? catalogueDatatypeNote(cataloguing)
                : 'The vocabulary entry does not say how this value is encoded.'}
              {' '}The datatype cannot be changed once the metric exists.
            </Callout>
          )}

          {/* Catalogue's point is the name the devices already publish; anything else is a new
              metric they do not send. */}
          {cataloguing && composedName !== cataloguing.metric_name && (
            <Callout tone="warning">
              The devices declare <span className="mono">{cataloguing.metric_name}</span>. This adds{' '}
              <span className="mono">{composedName || '…'}</span>, which they do not publish.
            </Callout>
          )}

          {groupCaseCollision && (
            <Callout tone="warning">
              Group <span className="mono">{newMetric.newGroup.trim()}</span> already exists as{' '}
              <span className="mono">{effectiveGroup}</span> — that spelling will be used, so the two do not fork.
            </Callout>
          )}
        </Modal>
      )}

      {showAddDerived && (
        <AddDerivedMetricModal
          catalog={catalog}
          groups={groups}
          declared={declaredNames}
          onConfirm={handleAddDerived}
          onCancel={() => setShowAddDerived(false)}
        />
      )}

      {yaml.editing && (
        <Suspense fallback={null}>
          <DerivedMetricsEditorModal
            uploads={yaml.editing.uploads}
            catalog={catalog}
            showToast={showToast}
            onApplied={yaml.applied}
            onClose={yaml.closeEditor}
          />
        </Suspense>
      )}

      {deprecateTarget && (
        <DeprecateMetricModal
          metric={deprecateTarget}
          usageCount={usageCountFor(deprecateTarget)}
          catalog={catalog}
          onConfirm={handleDeprecate}
          onCancel={() => setDeprecateTarget(null)}
        />
      )}

      {editTarget && (
        <EditMetricSemanticIdModal
          metric={editTarget}
          usageCount={usageCountFor(editTarget)}
          suggestion={suggestionForMetric(editTarget, {
            mtconnect: vocabulary, iso22400: isoVocabulary, opcua: opcuaVocabulary, vda5050: vdaVocabulary
          })}
          candidates={semanticIdChoices}
          onConfirm={handleEditMetric}
          onCancel={() => setEditTarget(null)}
        />
      )}

      {restoreTarget && (
        <RestoreMetricModal
          metric={restoreTarget}
          replacement={restoreTarget.superseded_by ? metricById.get(restoreTarget.superseded_by) : null}
          onConfirm={handleRestore}
          onCancel={() => setRestoreTarget(null)}
        />
      )}
    </div>
  )
}
