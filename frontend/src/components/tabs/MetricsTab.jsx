import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { DeprecateMetricModal } from '../modals/DeprecateMetricModal'
import { RestoreMetricModal } from '../modals/RestoreMetricModal'
import { datatypeLabel, SPARKPLUG_DATATYPES } from '../../utils/sparkplugDatatype'
import {
  groupCatalog, knownGroupNames, groupOptionsForStandard, canonicaliseGroup, isValidMetricName,
  metricNameError,
  composeMetricName
} from '../../utils/metricGroup'
import { modelledMetrics } from '../../utils/deviceTags'
import {
  typesByCategory, subTypes, unitNames, categoryOfType, CATEGORY_WITH_UNITS
} from '../../utils/mtconnect'
import {
  STANDARDS, STANDARD_OPTIONS, SEMANTIC_ID_TYPES, inferSemanticIdType, LOCAL_EXTENSION_LABEL,
  mtconnectSemanticId, DEFAULT_SEMANTIC_ID_TYPE
} from '../../utils/standards'
import { kpis, kpiByName, iso22400Prefill } from '../../utils/iso22400'
import { dataPointByName, opcuaSections, opcuaPrefill, suggestedGroup } from '../../utils/opcua'
import {
  conceptByName, ashrae223Prefill, ashrae223Sections, metricConcepts
} from '../../utils/ashrae223'
import CopyableId from '../common/CopyableId'
import {
  IconPlus, IconAlertTriangle, IconArchive, IconChevronDown, IconChevronUp, IconX, IconRefreshCw
} from '../common/Icons'
import { HelpTip } from '../common/HelpTip'

// Sentinel for the "not in the list yet" option in the group picker. Not a valid group name --
// the CHECK constraint on metric_groups.name rejects anything containing the separator.
const NEW_GROUP = '__new__'

// "Not in the MTConnect vocabulary". The standard itself allows extension, so this escape has to
// exist -- but it is a deliberate choice rather than the default path.
const CUSTOM_TYPE = '__custom__'

// Separator for the OPC UA type picker's option values: the vocabulary is keyed on (companion_spec,
// name), because Machinery and Robotics both define names like `Manufacturer`.
const OPCUA_KEY_SEP = '::'

// Extracted because three paths need it: the initial state, a successful add, and cancelling out
// of the form. Duplicating the shape was how a field would get missed from one of the resets.
const BLANK_METRIC = {
  // Which vocabulary the type picker draws from, and the provenance recorded on the metric.
  // MTConnect is the default because it is the largest vocabulary and most metrics come from it.
  standard: STANDARDS.MTCONNECT,
  group: '', newGroup: '', instance: '', type: '', customType: '',
  subType: '', units: '', datatype: 10, description: '',
  // AAS semanticId. ISO 22400 and OPC UA take theirs from the vocabulary row; MTConnect derives one
  // from the data item type. `semanticIdManual` records that the operator has taken the field over.
  semanticId: '', semanticIdType: '', semanticIdManual: false,
  // Only set for standards whose vocabulary states it. MTConnect derives it from the data item
  // type instead, so this stays blank there and effectiveCategory falls back to the derivation.
  vocabCategory: ''
}

/**
 * The metric catalog as a page of its own: the vocabulary of metrics every schema is built from.
 *
 * Split from the Schemas page, which the catalog shared with the schema registry. The two grow on
 * different clocks -- the registry gains a row per publish, the catalog a row per metric anyone
 * models, and it keeps growing for as long as standards are adopted -- so each was capping its own
 * height to leave the other room, and neither had a full viewport. The registry still reads the
 * catalog, for the schema builder; nothing here reads the registry except the usage count on a
 * deprecation.
 *
 * @param {Object} pendingVocabularyEntry Handed over by Use on the Vocabulary page: identifiers
 * for a standard's entry, resolved here because applyPrefill() is the only place that knows how a
 * vocabulary row becomes a metric.
 */
export function MetricsTab({ showToast, hasPermission, pendingVocabularyEntry, onConsumeVocabularyEntry }) {
  const [catalog, setCatalog]         = useState([])
  const [groups, setGroups]           = useState([])
  // Read for the usage count on a deprecation and nothing else -- how many schemas model the
  // metric is the impact warning on a destructive act.
  const [schemas, setSchemas]         = useState([])
  const [vocabulary, setVocabulary]   = useState([])
  const [isoVocabulary, setIsoVocabulary]     = useState([])
  const [opcuaVocabulary, setOpcuaVocabulary] = useState([])
  const [s223Vocabulary, setS223Vocabulary] = useState([])
  const [loading, setLoading]         = useState(true)
  const [showAddMetric, setShowAddMetric] = useState(false)
  // The metric name is composed from its MTConnect parts: component (group), optional instance,
  // data item type, optional subType. NEW_GROUP and CUSTOM_TYPE are the escapes MTConnect permits
  // for extensions.
  const [newMetric, setNewMetric] = useState(BLANK_METRIC)
  const [deprecateTarget, setDeprecateTarget] = useState(null)
  const [restoreTarget, setRestoreTarget] = useState(null)
  // Expansion state for the catalog's group sections, keyed by label; absent means collapsed. The
  // headers carry a count, so a collapsed catalog still says what is in it.
  const [expandedGroups, setExpandedGroups] = useState({})
  // Filters the catalog by metric name. With groups collapsed by default it is how one metric is
  // found without opening each group.
  const [catalogSearch, setCatalogSearch] = useState('')

  /**
   * A group is open when the operator opened it, or when a search is narrowing the catalog: a
   * search that left the groups shut would show headers and no matches.
   */
  const isGroupOpen = (label) => Boolean(catalogSearch) || expandedGroups[label] === true
  const toggleGroup = (label) =>
    setExpandedGroups(prev => ({ ...prev, [label]: !isGroupOpen(label) }))

  // "Cancel" means discard, so closing the form clears it. That also stops half-finished input
  // leaking into the next open -- including the one the Vocabulary page's Use action triggers.
  const toggleAddMetric = () => {
    if (showAddMetric) setNewMetric(BLANK_METRIC)
    setShowAddMetric(v => !v)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cat, grp, sch, voc, iso, opc, s223] = await Promise.all([
        api.get('/api/v1/metric-catalog'),
        api.get('/api/v1/metric-groups'),
        api.get('/api/v1/schemas'),
        api.get('/api/v1/mtconnect-vocabulary'),
        api.get('/api/v1/iso22400-vocabulary'),
        api.get('/api/v1/opcua-vocabulary'),
        api.get('/api/v1/ashrae223-vocabulary'),
      ])
      setCatalog(cat); setGroups(grp); setSchemas(sch); setVocabulary(voc)
      setIsoVocabulary(iso); setOpcuaVocabulary(opc); setS223Vocabulary(s223)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

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
   * open it. A prefill that leaves `datatype` undefined means the vocabulary does not say how the
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
      customType: '',
      // A KPI, an OPC UA data point and a 223P concept are all whole concepts; none has an
      // MTConnect subType.
      subType: '',
      units: prefill.units || '',
      datatype: prefill.datatype,
      vocabCategory: prefill.category || '',
      semanticId: prefill.semanticId,
      semanticIdType: prefill.semanticId ? inferSemanticIdType(prefill.semanticId) : '',
      // The vocabulary's id is authoritative for these two standards, so it is not re-derived.
      semanticIdManual: !!prefill.semanticId,
      // Only fill a description that is still empty, so the vocabulary's blurb never overwrites
      // something the operator has already written.
      description: m.description || prefill.description || ''
    }))
    setShowAddMetric(true)
  }

  // Opens the Add Metric form with the type chosen, leaving the component and instance to the
  // operator.
  const handleUseVocabularyType = (typeName) => {
    setNewMetric(m => ({ ...m, standard: STANDARDS.MTCONNECT, type: typeName, customType: '' }))
    setShowAddMetric(true)
  }

  /**
   * Arrival from the Vocabulary page's Use action. The handover carries identifiers and is resolved
   * here, because the rules that turn a vocabulary row into a metric live in applyPrefill and
   * nowhere else. Waits for the vocabularies to load, and clears the handover once applied.
   */
  useEffect(() => {
    if (!pendingVocabularyEntry || loading) return
    const entry = pendingVocabularyEntry

    if (entry.standard === STANDARDS.MTCONNECT && entry.type) {
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
    }

    onConsumeVocabularyEntry?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingVocabularyEntry, loading, isoVocabulary, opcuaVocabulary, s223Vocabulary])

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
    setNewMetric(m => ({ ...m, type: value }))
  }

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
      suggestedGroup(dataPointByName(opcuaVocabulary, null, newMetric.type)) !== value

    setNewMetric(m => ({
      ...m,
      group: value,
      ...(orphaned
        ? {
            type: '',
            units: '',
            datatype: '',
            vocabCategory: '',
            semanticId: '',
            semanticIdType: '',
            semanticIdManual: false
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
      type: '', customType: '', subType: '', units: '',
      vocabCategory: '', semanticId: '', semanticIdType: '', semanticIdManual: false
    }))
  }

  const handleAddMetric = async () => {
    const composed = composedName
    try {
      // Register the group before the metric that first uses it, so the vocabulary stays complete
      // if the metric insert is rejected.
      if (effectiveGroup && !knownGroups.includes(effectiveGroup)) {
        // Carries the standard so the group files under it in the picker rather than under Local.
        await api.post('/api/v1/metric-groups', { name: effectiveGroup, standard: effectiveStandard })
      }

      await api.post('/api/v1/metric-catalog', {
        name: composed,
        datatype: newMetric.datatype,
        category: effectiveCategory,
        // Stored alongside the name as well as inside it: the name is what the device publishes,
        // the column is what can be queried without parsing.
        sub_type: newMetric.subType,
        units: unitsApply ? newMetric.units : '',
        standard: effectiveStandard,
        // AAS alignment. Blank is legitimate: MTConnect publishes no per-type identifier.
        semantic_id: semanticIdValue,
        semantic_id_type: semanticIdTypeValue,
        description: newMetric.description
      })
      setNewMetric(BLANK_METRIC)
      setShowAddMetric(false)
      load()
      showToast(`Metric '${composed}' added to the catalog`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  // Counts schemas that model the metric at all, not only those marking it `required`: this is the
  // impact warning on a destructive confirmation. Uses the same modelledMetrics() the device tags
  // read.
  const usageCountFor = (metricName) =>
    schemas.filter(s => modelledMetrics(s)?.has(metricName)).length

  const handleDeprecate = async (supersededBy) => {
    try {
      await api.post(`/api/v1/metric-catalog/${deprecateTarget.metric_uuid}/deprecate`, { superseded_by: supersededBy })
      setDeprecateTarget(null)
      load()
      showToast(`Metric '${deprecateTarget.name}' deprecated. Deprecated Metrics, below the catalog, can restore it.`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const handleRestore = async () => {
    try {
      await api.post(`/api/v1/metric-catalog/${restoreTarget.metric_uuid}/restore`)
      setRestoreTarget(null)
      load()
      showToast(`Metric '${restoreTarget.name}' restored to the schema builder`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  // Still `schema:manage`, unchanged by the split: the catalogue and the registry were one page
  // and they are still one permission, so the gate here and the gate on Schemas stay the same one.
  // It is not what refuses the write -- metric_catalog's INSERT and UPDATE policies check
  // has_role('Administrator') -- so this disables the control rather than deciding anything.
  const canManageSchema = hasPermission(PERMISSION_UUIDS.SCHEMA_MANAGE)
  // Deprecate and Restore write metric_catalog too, so they share Add Metric's gate. A permission a
  // Shopfloor_Manager holds, such as archive:manage, would offer a button the database refuses.
  const canDeprecateMetric = canManageSchema

  /**
   * Narrows the catalog by metric name only: matching description or units would return rows whose
   * reason for matching is invisible in the table.
   */
  const matchesCatalogSearch = (m) =>
    !catalogSearch || (m.name || '').toLowerCase().includes(catalogSearch.trim().toLowerCase())

  const activeCatalog = catalog.filter(m => !m.deprecated).filter(matchesCatalogSearch)
  // Its own card, unfiltered: the search box belongs to the catalog card above it.
  const deprecatedCatalog = catalog.filter(m => m.deprecated)
  // Grouped by the first dotted segment of the name; ungrouped metrics fall into a trailing bucket.
  const catalogGroups = groupCatalog(activeCatalog)
  // `superseded_by` is a uuid; the Deprecated Metrics card and the restore modal show the name.
  const metricById = new Map(catalog.map(m => [m.metric_uuid, m]))

  // The vocabulary the picker offers: the curated registry (now MTConnect's component types)
  // plus anything already in use.
  const knownGroups = knownGroupNames(groups, catalog)
  // Narrowed to the selected standard plus local groups: 126 MTConnect component types in one list
  // is not navigable, and offering ISO 22400 families under MTConnect invites a contradictory
  // group.
  const groupOptions = groupOptionsForStandard(groups, catalog, newMetric.standard)
  const effectiveGroup = newMetric.group === NEW_GROUP
    ? canonicaliseGroup(newMetric.newGroup, knownGroups)
    : newMetric.group

  const isMTConnect = newMetric.standard === STANDARDS.MTCONNECT
  const isIso = newMetric.standard === STANDARDS.ISO22400
  const isOpcua = newMetric.standard === STANDARDS.OPCUA
  const isAshrae = newMetric.standard === STANDARDS.ASHRAE223
  const isCustomStandard = newMetric.standard === STANDARDS.CUSTOM

  // Unset after a 223P prefill, or after a group change orphaned an OPC UA data point. The select
  // cannot show "Double" for a value that is not there: `metric_catalog.datatype` is NOT NULL and
  // immutable, so the insert would be refused while the screen said otherwise.
  const datatypeChosen = Number.isInteger(newMetric.datatype)

  // Only MTConnect offers a not-in-the-vocabulary escape in the type picker, because it permits
  // extending its type list. The other two have the Custom standard for that.
  const usingCustomType = isMTConnect && newMetric.type === CUSTOM_TYPE
  const effectiveType = (usingCustomType || isCustomStandard)
    ? newMetric.customType.trim()
    : newMetric.type

  // Provenance actually recorded. A custom MTConnect type is a local extension, so it drops the
  // MTConnect claim even though the form was on the MTConnect tab.
  const effectiveStandard = (isCustomStandard || usingCustomType) ? STANDARDS.CUSTOM : newMetric.standard

  // MTConnect assigns each data item type a category, so it is derived. ISO 22400 and OPC UA supply
  // theirs with the vocabulary entry. A local extension has none until someone says otherwise.
  const effectiveCategory = isMTConnect
    ? (usingCustomType ? '' : categoryOfType(vocabulary, effectiveType))
    : newMetric.vocabCategory

  // For MTConnect only SAMPLE carries units. The other standards state the unit on the vocabulary
  // entry, so the field stays available for them.
  const unitsApply = isMTConnect ? effectiveCategory === CATEGORY_WITH_UNITS : true
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
  // One composer for all three standards. The subType segment only exists for MTConnect.
  const composedName = composeMetricName(
    effectiveGroup,
    newMetric.instance,
    effectiveType,
    isMTConnect ? newMetric.subType : ''
  )
  // MTConnect metrics get their data item type's vocabulary id (utils/standards.js), so every
  // metric of one type shares a concept (#457). It follows the type until the operator types their
  // own. A custom type is a local extension with no vocabulary id, so it derives nothing.
  const derivedSemanticId =
    isMTConnect && !usingCustomType && effectiveType !== '' ? mtconnectSemanticId(effectiveType) : ''
  const semanticIdValue = (newMetric.semanticIdManual ? newMetric.semanticId : derivedSemanticId).trim()
  const semanticIdTypeValue = newMetric.semanticIdManual
    ? newMetric.semanticIdType
    : (semanticIdValue ? DEFAULT_SEMANTIC_ID_TYPE : '')

  // Shown only once there is a type to compose a name from: before that the name is legitimately
  // half-built, and complaining about it would be scolding the operator mid-keystroke.
  const nameError = effectiveType !== '' ? metricNameError(composedName) : null

  const canAddMetric =
    effectiveType !== '' &&
    isValidMetricName(composedName) &&
    datatypeChosen &&
    (newMetric.group !== NEW_GROUP || newMetric.newGroup.trim() !== '') &&
    // A type without a value would export as an AAS Reference with no key. Rejected here rather
    // than nulled on the way out, so the operator sees the field they left half-filled.
    (semanticIdValue !== '' || semanticIdTypeValue === '')

  /** The seven cells the catalog and the Deprecated Metrics card share, so a metric reads the same in both. */
  const metricCells = (m) => (
    <>
      <td>
        <span className="mono">{m.name}</span>
        {/* MTConnect permits local extensions, so this marks provenance rather than flagging a
            problem. */}
        {!m.standard && m.category && (
          <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginLeft: '6px', fontStyle: 'italic' }} title="Local extension — not drawn from a standard vocabulary">
            local
          </span>
        )}
      </td>
      <td>
        {m.standard
          ? <span className="badge badge-neutral" style={{ fontSize: '11px' }} title={`Named from the ${m.standard} vocabulary`}>{m.standard}</span>
          : <span style={{ color: 'var(--text-dim)', fontSize: '11px' }}>{LOCAL_EXTENSION_LABEL}</span>}
      </td>
      <td>
        {m.category
          ? <span className="badge badge-neutral" style={{ fontSize: '11px' }} title={`MTConnect ${m.category} observation`}>{m.category}</span>
          : <span style={{ color: 'var(--text-dim)' }}>—</span>}
      </td>
      <td style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{m.units || '—'}</td>
      <td>{datatypeLabel(m.datatype)}</td>
      {/* Capped and scrollable: a semantic id is a full IRI, and an unconstrained cell pushes the
          row's action off-screen. */}
      <td style={{ maxWidth: '260px' }}>
        {m.semantic_id
          ? <CopyableId
              value={m.semantic_id}
              label={`semantic id${m.semantic_id_type ? ` (${m.semantic_id_type})` : ''}`}
              onNotify={showToast}
            />
          : <span style={{ color: 'var(--text-dim)' }} title="Not mapped to a standard concept. Legitimate for MTConnect metrics, which have no published per-type identifier.">—</span>}
      </td>
      <td style={{ color: 'var(--text-muted)' }}>{m.description || '—'}</td>
    </>
  )

  return (
    <>
      {/* No PageHeading: one card, whose header is already the page's title, as on every other
          single-card page. */}
      <div className="card" style={{ marginBottom: 'var(--stack)' }}>
        {/* `.card-header`, not `.section-header`: the card has no padding of its own, so a plain
            section header would sit flush against its borders. */}
        <div className="card-header">
          <h3 className="section-title">
            Metric Catalog
            <HelpTip
              label="About the metric catalog"
              text="The metrics every schema is built from, grouped by the first segment of their name. A name is what a device publishes and cannot change afterwards, so an unwanted metric is deprecated, not removed."
            />
          </h3>
          {/* The label AND the fill follow the form's state, so the control always says what
              pressing it will do and how much it is being offered. Filled while it opens the form,
              which is what every other page's create action looks like; ghost once the form is
              open, where it means Cancel and the form's own Add Metric is the filled one. */}
          <button
            className={`btn btn-sm ${showAddMetric ? 'btn-ghost' : 'btn-primary'} ${!canManageSchema ? 'btn-disabled' : ''}`}
            style={{ marginLeft: 'auto' }}
            disabled={!canManageSchema}
            aria-expanded={showAddMetric}
            onClick={() => canManageSchema && toggleAddMetric()}
            title={!canManageSchema
              ? 'Requires Admin permissions'
              : showAddMetric ? 'Discard this metric and close the form' : 'Add a new metric to the catalog'}
          >
            {showAddMetric
              ? <><IconX size={13} /> Cancel</>
              : <><IconPlus size={13} /> Add Metric</>}
          </button>
        </div>

        {/* `.card-body`, so the inset matches the header's by rule rather than by coincidence. */}
        <div className="card-body">
        {/* The groups start collapsed, so typing is how a known metric is reached; it auto-expands
            the groups that matched (isGroupOpen). */}
        <div className="filter-bar">
          <input
            className="form-control"
            style={{ width: '260px' }}
            value={catalogSearch}
            onChange={e => setCatalogSearch(e.target.value)}
            placeholder="Search metrics…"
            aria-label="Search the metric catalog"
            title="Filter the catalog by metric name"
          />
        </div>
        </div>{/* .card-body */}

        {showAddMetric && (
          <div style={{ margin: '12px var(--inset)', padding: '10px 12px', background: 'var(--bg-glass)', borderRadius: 'var(--radius)' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              {/* Chosen first because it decides what every control to its right offers. */}
              <div className="form-group" style={{ margin: 0, flex: '0 1 150px' }}>
                <label className="form-label">Standard</label>
                <select
                  className="form-control"
                  value={newMetric.standard}
                  onChange={e => handleStandardChange(e.target.value)}
                  title="Which vocabulary this metric is named from. Recorded as the metric's provenance, and what an AAS export reads to decide which namespace it belongs to."
                >
                  {STANDARD_OPTIONS.map(o => (
                    <option key={o.label} value={o.value} title={o.hint}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div className="form-group" style={{ margin: 0, flex: '0 1 170px' }}>
                <label className="form-label">Group</label>
                <select
                  className="form-control"
                  value={newMetric.group}
                  onChange={e => handleGroupChange(e.target.value)}
                  title="The category this metric belongs to. Becomes the first segment of its name, so it is part of what the device publishes."
                >
                  <option value="">— No group —</option>
                  {groupOptions.map(bucket => (
                    <optgroup key={bucket.label} label={`${bucket.label} (${bucket.names.length})`}>
                      {bucket.names.map(g => <option key={g} value={g}>{g}</option>)}
                    </optgroup>
                  ))}
                  <option value={NEW_GROUP}>+ New group…</option>
                </select>
              </div>

              {newMetric.group === NEW_GROUP && (
                <div className="form-group" style={{ margin: 0, flex: '0 1 170px' }}>
                  <label className="form-label">New Group Name</label>
                  <input
                    className="form-control"
                    value={newMetric.newGroup}
                    onChange={e => setNewMetric(m => ({ ...m, newGroup: e.target.value.replace(/\//g, '') }))}
                    placeholder="e.g. Hydraulic"
                    title="A single name segment — it cannot contain a slash"
                  />
                </div>
              )}

              <div className="form-group" style={{ margin: 0, flex: '0 1 110px' }}>
                <label className="form-label">Instance</label>
                <input
                  className="form-control"
                  value={newMetric.instance}
                  onChange={e => setNewMetric(m => ({ ...m, instance: e.target.value.replace(/\//g, '') }))}
                  placeholder="e.g. C"
                  title="Which one, when the component occurs more than once — the axis name, the spindle number. Leave blank if there is only one."
                />
              </div>

              {/* One slot, four vocabularies. The Standard selector decides which fills it, so the
                  label changes with it. */}
              {isMTConnect && (
                <div className="form-group" style={{ margin: 0, flex: '1 1 200px' }}>
                  <label className="form-label">Data Item Type</label>
                  <select
                    className="form-control"
                    value={newMetric.type}
                    onChange={e => handleTypeChange(e.target.value)}
                    title="The MTConnect data item type. Grouped by category: SAMPLE is a continuous measurement, EVENT a discrete state change, CONDITION a fault or warning."
                  >
                    <option value="">— Select a type —</option>
                    {typeGroups.map(g => (
                      <optgroup key={g.category} label={`${g.category} (${g.types.length})`}>
                        {g.types.map(t => <option key={t} value={t}>{t}</option>)}
                      </optgroup>
                    ))}
                    <option value={CUSTOM_TYPE}>+ Not in MTConnect…</option>
                  </select>
                </div>
              )}

              {isIso && (
                <div className="form-group" style={{ margin: 0, flex: '1 1 200px' }}>
                  <label className="form-label">KPI</label>
                  <select
                    className="form-control"
                    value={newMetric.type}
                    onChange={e => handleTypeChange(e.target.value)}
                    title="The ISO 22400-2 key performance indicator. Selecting one fills in its unit, its semantic id and the group it files under — those are properties of the standard, not choices."
                  >
                    <option value="">— Select a KPI —</option>
                    {isoKpis.map(k => (
                      <option key={k.name} value={k.name} title={k.formula || ''}>
                        {k.name}{k.kpi_id && k.kpi_id !== k.name ? ` (${k.kpi_id})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {isOpcua && (
                <div className="form-group" style={{ margin: 0, flex: '1 1 220px' }}>
                  <label className="form-label">Data Point</label>
                  <select
                    className="form-control"
                    value={newMetric.type
                      ? `${(dataPointByName(opcuaVocabulary, null, newMetric.type)?.companion_spec) || ''}${OPCUA_KEY_SEP}${newMetric.type}`
                      : ''}
                    onChange={e => handleTypeChange(e.target.value)}
                    title="The OPC UA companion specification data point. Selecting one fills in its group from the browse path, its datatype and its semantic id."
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
                            title={p.description || ''}
                          >
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
              )}

              {isAshrae && (
                <div className="form-group" style={{ margin: 0, flex: '1 1 220px' }}>
                  <label className="form-label">Concept</label>
                  <select
                    className="form-control"
                    value={newMetric.type}
                    onChange={e => handleTypeChange(e.target.value)}
                    title="The ASHRAE 223P concept this point is attached to. Selecting one fills in the group and the semantic id; the datatype and units stay yours to choose, because a concept names a thing, not a reading."
                  >
                    <option value="">— Select a concept —</option>
                    {ashraeSections.map(section => (
                      <optgroup key={section.key} label={`${section.title} (${section.entries.length})`}>
                        {section.entries.map(c => (
                          <option key={c.name} value={c.name} title={c.description || ''}>
                            {c.label || c.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
              )}

              {(usingCustomType || isCustomStandard) && (
                <div className="form-group" style={{ margin: 0, flex: '1 1 170px' }}>
                  <label className="form-label">{isCustomStandard ? 'Metric Name' : 'Custom Type'}</label>
                  <input
                    className="form-control"
                    value={newMetric.customType}
                    onChange={e => setNewMetric(m => ({ ...m, customType: e.target.value.replace(/\//g, '') }))}
                    placeholder="e.g. VIBRATION_RMS"
                    title={isCustomStandard
                      ? 'A local extension with no standard behind it. It still composes into Group/Instance/Name, so it groups and tags like everything else.'
                      : 'A local extension. MTConnect permits these, but prefer a standard type where one fits.'}
                  />
                </div>
              )}

              {/* MTConnect only: a subType qualifies a data item type. An ISO KPI and an OPC UA
                  browse name are whole concepts, so there is nothing to qualify. */}
              {isMTConnect && (
                <div className="form-group" style={{ margin: 0, flex: '0 1 150px' }}>
                  <label className="form-label">Sub Type</label>
                  <select
                    className="form-control"
                    value={newMetric.subType}
                    onChange={e => setNewMetric(m => ({ ...m, subType: e.target.value }))}
                    title="Optional MTConnect qualifier — ACTUAL vs COMMANDED vs TARGET. It becomes the last segment of the name, because Sparkplug keys only on the name and the variants would otherwise collide."
                  >
                    <option value="">— None —</option>
                    {availableSubTypes.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              )}

              <div className="form-group" style={{ margin: 0, flex: '0 1 150px' }}>
                <label className="form-label">Units</label>
                <select
                  className="form-control"
                  value={unitsApply ? newMetric.units : ''}
                  disabled={!unitsApply}
                  onChange={e => setNewMetric(m => ({ ...m, units: e.target.value }))}
                  title={unitsApply
                    ? 'MTConnect units. The standard defines no default per type, so this is a choice, not a derivation.'
                    : 'Only SAMPLE data items carry units'}
                >
                  <option value="">— None —</option>
                  {availableUnits.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>

              <div className="form-group" style={{ margin: 0, flex: '0 1 140px' }}>
                <label className="form-label">Sparkplug Datatype</label>
                <select
                  className="form-control"
                  value={datatypeChosen ? newMetric.datatype : ''}
                  onChange={e => setNewMetric(m => ({ ...m, datatype: parseInt(e.target.value, 10) }))}
                  title="How the value is encoded on the wire. No vocabulary here specifies this, so it stays a local choice."
                >
                  {/* Shown only while nothing is chosen: a select must not read "Double" while the
                      form holds no datatype. */}
                  {!datatypeChosen && <option value="">— Choose —</option>}
                  {SPARKPLUG_DATATYPES.map(d => <option key={d.code} value={d.code}>{d.label}</option>)}
                </select>
              </div>

              <div className="form-group" style={{ margin: 0, flex: '2 1 200px' }}>
                <label className="form-label">Description</label>
                <input className="form-control" value={newMetric.description} onChange={e => setNewMetric(m => ({ ...m, description: e.target.value }))} placeholder="What this metric represents" />
              </div>

              {/* Semantic ids: prefilled from the vocabulary for ISO 22400 and OPC UA, derived from
                  the data item type for MTConnect, and editable in every case. */}
              <div className="form-group" style={{ margin: 0, flex: '2 1 260px' }}>
                <label className="form-label">
                  Semantic ID <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>(optional)</span>
                  {!newMetric.semanticIdManual && derivedSemanticId && (
                    <span style={{ fontWeight: 400, color: 'var(--text-dim)', marginLeft: '5px' }} title="The data item type's id in this deployment's MTConnect namespace, shared by every metric of that type. Type to override.">
                      · auto
                    </span>
                  )}
                </label>
                <input
                  className="form-control mono"
                  style={{ fontSize: '11px' }}
                  value={semanticIdValue}
                  onChange={e => {
                    const value = e.target.value
                    setNewMetric(m => ({
                      ...m,
                      semanticId: value,
                      // Taking the field over stops the derivation, so it cannot overwrite a
                      // hand-entered crosswalk on the next keystroke.
                      semanticIdManual: true,
                      // Only ever fills a blank type, so a deliberate choice is never overwritten.
                      semanticIdType: m.semanticIdType || inferSemanticIdType(value)
                    }))
                  }}
                  placeholder="e.g. http://opcfoundation.org/UA/Robotics/ActualPosition"
                  title="AAS (IEC 63278) semanticId — the resolvable identity of the concept this metric measures. Unlike the name, it can be corrected later."
                />
              </div>

              <div className="form-group" style={{ margin: 0, flex: '0 1 140px' }}>
                <label className="form-label">Reference Type</label>
                <select
                  className="form-control"
                  value={semanticIdTypeValue}
                  onChange={e => setNewMetric(m => ({
                    ...m,
                    semanticIdType: e.target.value,
                    // Choosing a type adopts the id currently shown, rather than leaving the type
                    // attached to a value the derivation could still change underneath it.
                    semanticIdManual: true,
                    semanticId: m.semanticIdManual ? m.semanticId : semanticIdValue
                  }))}
                  title="Which kind of AAS Reference the semantic id is. IRI for a URI, IRDI for an ECLASS or IEC CDD identifier, ModelReference to point inside another AAS."
                >
                  <option value="">— None —</option>
                  {SEMANTIC_ID_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              <button className={`btn btn-primary btn-sm ${!canAddMetric ? 'btn-disabled' : ''}`} disabled={!canAddMetric} onClick={handleAddMetric} title="Add this metric to the catalog">
                Add
              </button>
            </div>

            {/* The composed name is what actually goes on the wire and can never be edited
                afterwards, so it is shown rather than left to be inferred from two fields. */}
            <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Devices will publish this metric as{' '}
              <span className="mono" style={{ color: composedName ? 'var(--accent)' : 'var(--text-dim)' }}>
                {composedName || '…'}
              </span>
              {' '}— immutable once created.
              {effectiveCategory && (
                <> Category <strong>{effectiveCategory}</strong>
                  {isMTConnect ? ', from the MTConnect standard.' : `, mapped from ${newMetric.standard}.`}</>
              )}
              {effectiveStandard
                ? <> Provenance <strong>{effectiveStandard}</strong>.</>
                : <> Recorded as a <strong>local extension</strong>, with no standard provenance.</>}
              {semanticIdValue && (
                <> Semantic id <span className="mono" style={{ color: 'var(--accent)' }}>{semanticIdValue}</span>
                  {semanticIdTypeValue ? ` (${semanticIdTypeValue})` : ''} — editable later, unlike the name.</>
              )}
            </div>

            {/* The database enforces the same format (metric_catalog_name_format), but a 400 after
                pressing Add is a poor way to learn it, and the name is immutable. */}
            {nameError && (
              <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--danger-text)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <IconAlertTriangle size={12} />
                <span>{nameError}</span>
              </div>
            )}

            {!datatypeChosen && (
              <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--warning-text)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <IconAlertTriangle size={12} />
                <span>Choose a Sparkplug datatype. The vocabulary entry does not say how this value is encoded, and the datatype cannot be changed once the metric exists.</span>
              </div>
            )}

            {semanticIdValue === '' && semanticIdTypeValue !== '' && (
              <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--warning-text)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <IconAlertTriangle size={12} />
                <span>A reference type needs an id to describe. Enter a semantic id, or set the type back to None.</span>
              </div>
            )}

            {groupCaseCollision && (
              <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--warning-text)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <IconAlertTriangle size={12} />
                <span>
                  Group <span className="mono">{newMetric.newGroup.trim()}</span> already exists as{' '}
                  <span className="mono">{effectiveGroup}</span> — that spelling will be used, so the two do not fork.
                </span>
              </div>
            )}
          </div>
        )}

        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading catalog…</div> : catalogGroups.length === 0 ? (
          <div className="empty-state" style={{ padding: '20px var(--inset)' }}>
            <div className="empty-text">
              {catalogSearch
                ? <>No metric matches <strong>{catalogSearch}</strong>.</>
                : deprecatedCatalog.length > 0
                  ? 'Every metric in the catalog is deprecated.'
                  : 'No metrics in the catalog yet.'}
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th title="Which standard vocabulary this metric was named from">Standard</th><th title="MTConnect observation category">Category</th><th title="MTConnect units — SAMPLE data items only">Units</th><th>Datatype</th><th title="AAS (IEC 63278) semanticId — the resolvable identity of the concept this metric measures">Semantic ID</th><th>Description</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              {catalogGroups.map(group => {
                const open = isGroupOpen(group.label)
                return (
                <tbody key={group.label}>
                  {/* `.table-group-row` mixes toward the text colour rather than using
                      `--bg-glass`, which is the hover colour: a category header must not look
                      permanently hovered. */}
                  <tr className="table-group-row">
                    <td colSpan={8}>
                      {/* Whole header row is the control, same as the vocabulary panel's sections. */}
                      <button
                        type="button"
                        className="table-group-button"
                        onClick={() => toggleGroup(group.label)}
                        aria-expanded={open}
                        title={open
                          ? `Collapse ${group.label}`
                          : `Expand ${group.label} (${group.metrics.length} metric${group.metrics.length === 1 ? '' : 's'})`}
                      >
                        {open ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                        <span
                          style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: group.isUngrouped ? 'var(--text-muted)' : 'var(--accent)' }}
                          title={group.isUngrouped
                            ? 'These metric names carry no "Group/Metric" prefix, so they belong to no category'
                            : `Metrics named "${group.label}/…"`}
                        >
                          {group.label}
                        </span>
                        <span className="section-count">{group.metrics.length}</span>
                      </button>
                    </td>
                  </tr>
                  {open && group.metrics.map(m => (
                    <tr key={m.metric_uuid}>
                      {metricCells(m)}
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className={`btn btn-ghost btn-sm ${!canDeprecateMetric ? 'btn-disabled' : ''}`}
                          disabled={!canDeprecateMetric}
                          onClick={() => canDeprecateMetric && setDeprecateTarget(m)}
                          title={!canDeprecateMetric ? 'Requires Admin permissions' : 'Retire this metric from the schema builder'}
                        >
                          <IconArchive size={12} /> Deprecate
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                )
              })}
            </table>
          </div>
        )}
      </div>

      {/* Rendered only while something is deprecated. Restore is the way back from Deprecate (#468),
          so it lives with the rows it applies to rather than behind a toggle in the catalog. */}
      {!loading && deprecatedCatalog.length > 0 && (
        <div className="card" style={{ marginBottom: 'var(--stack)' }}>
          <div className="card-header">
            <h3 className="section-title">
              Deprecated Metrics
              <span className="section-count">{deprecatedCatalog.length}</span>
              <HelpTip
                label="About deprecated metrics"
                text="Withheld from the schema builder, not deleted: schemas that model one keep it, and its readings stay. Restore offers it to schema authors again and clears the replacement it names."
              />
            </h3>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th title="Which standard vocabulary this metric was named from">Standard</th><th title="MTConnect observation category">Category</th><th title="MTConnect units — SAMPLE data items only">Units</th><th>Datatype</th><th title="AAS (IEC 63278) semanticId — the resolvable identity of the concept this metric measures">Semantic ID</th><th>Description</th><th title="The metric named as this one's replacement when it was deprecated">Superseded By</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              <tbody>
                {deprecatedCatalog.map(m => {
                  const replacement = m.superseded_by ? metricById.get(m.superseded_by) : null
                  return (
                    <tr key={m.metric_uuid}>
                      {metricCells(m)}
                      <td>
                        {replacement
                          ? <span className="mono">{replacement.name}</span>
                          : <span style={{ color: 'var(--text-dim)' }} title="No replacement was named">—</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className={`btn btn-ghost btn-sm ${!canDeprecateMetric ? 'btn-disabled' : ''}`}
                          disabled={!canDeprecateMetric}
                          onClick={() => canDeprecateMetric && setRestoreTarget(m)}
                          title={!canDeprecateMetric ? 'Requires Admin permissions' : 'Offer this metric to schema authors again'}
                        >
                          <IconRefreshCw size={12} /> Restore
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {deprecateTarget && (
        <DeprecateMetricModal
          metric={deprecateTarget}
          usageCount={usageCountFor(deprecateTarget.name)}
          catalog={catalog}
          onConfirm={handleDeprecate}
          onCancel={() => setDeprecateTarget(null)}
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
    </>
  )
}
