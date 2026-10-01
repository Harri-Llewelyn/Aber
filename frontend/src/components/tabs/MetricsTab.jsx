import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { usePendingAction } from '../../hooks/usePendingAction'
import { DeprecateMetricModal } from '../modals/DeprecateMetricModal'
import { RestoreMetricModal } from '../modals/RestoreMetricModal'
import { EditMetricSemanticIdModal } from '../modals/EditMetricSemanticIdModal'
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
  STANDARDS, STANDARD_OPTIONS, LOCAL_EXTENSION_LABEL, sameSemanticIdPair, storedSemanticIdPair
} from '../../utils/standards'
import {
  mtconnectSuggestion, vocabularySuggestion, suggestionForMetric, semanticIdCandidates
} from '../../utils/semanticIdSources'
import { kpis, kpiByName, iso22400Prefill } from '../../utils/iso22400'
import { dataPointByName, opcuaSections, opcuaPrefill, suggestedGroup } from '../../utils/opcua'
import {
  conceptByName, ashrae223Prefill, ashrae223Sections, metricConcepts
} from '../../utils/ashrae223'
import CopyableId from '../common/CopyableId'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { Modal } from '../common/Modal'
import { ActionButton } from '../common/ActionButton'
import { Badge } from '../common/Badge'
import { SectionCount } from '../common/SectionCount'
import { SearchInput } from '../common/SearchInput'
import { ClearFilters } from '../common/ClearFilters'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { SemanticIdField } from '../common/SemanticIdField'
import {
  IconPlus, IconAlertTriangle, IconArchive, IconChevronDown, IconChevronUp, IconRefreshCw,
  IconPencil, IconBookOpen, IconTag
} from '../common/Icons'
import { PageHeading } from '../common/PageHeading'
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

// Extracted because three paths need it: the initial state, a successful add, and closing
// the dialog. Duplicating the shape was how a field would get missed from one of the resets.
const BLANK_METRIC = {
  // Which vocabulary the type picker draws from, and the provenance recorded on the metric.
  // MTConnect is the default because it is the largest vocabulary and most metrics come from it.
  standard: STANDARDS.MTCONNECT,
  group: '', newGroup: '', instance: '', type: '', customType: '',
  subType: '', units: '', datatype: 10, description: '',
  // The chosen OPC UA point's companion specification. Two specifications can define one browse
  // name, so `type` alone does not find the row.
  companionSpec: '',
  // AAS semanticId. The field shows the suggestion (derived from the MTConnect data item type, or
  // `vocabSemanticId`, the id the chosen ISO 22400, OPC UA or 223P row carries) until the operator
  // types or picks their own pair, which `semanticIdOwn` holds; null means follow the suggestion.
  vocabSemanticId: '', semanticIdOwn: null,
  // Only set for standards whose vocabulary states it. MTConnect derives it from the data item
  // type instead, so this stays blank there and effectiveCategory falls back to the derivation.
  vocabCategory: ''
}

/**
 * The operator's own semantic id across a change of type. A typed or picked id is kept, with Use
 * suggested one click away; a blank one gives way to the new type's suggestion, so touching the
 * field before choosing a type cannot leave the form suggesting nothing.
 */
const keepTypedSemanticId = (own) => (own && own.semanticId.trim() !== '' ? own : null)

/**
 * The metric catalog: the vocabulary of metrics every schema is built from. Add Metric opens a
 * dialog; selecting a row opens a drawer with the metric's fields and its Edit, Deprecate and
 * Restore actions. The schema registry reads the catalog for the builder; this page reads the
 * schemas only for the usage count on a deprecation or a semantic id edit.
 *
 * @param {Object} pendingVocabularyEntry Handed over by clicking an entry on the Vocabulary page:
 * identifiers for a standard's entry, resolved here because applyPrefill() is the only place that
 * knows how a vocabulary row becomes a metric.
 */
export function MetricsTab({ showToast, hasPermission, pendingVocabularyEntry, onConsumeVocabularyEntry }) {
  const [catalog, setCatalog]         = useState([])
  const [groups, setGroups]           = useState([])
  // Read for the usage count on a deprecation or a semantic id edit and nothing else -- how many
  // schemas model the metric is the impact warning on either act.
  const [schemas, setSchemas]         = useState([])
  const [vocabulary, setVocabulary]   = useState([])
  const [isoVocabulary, setIsoVocabulary]     = useState([])
  const [opcuaVocabulary, setOpcuaVocabulary] = useState([])
  const [s223Vocabulary, setS223Vocabulary] = useState([])
  // IDTA template elements, which the semantic id picker offers beside the vocabularies.
  const [templateElements, setTemplateElements] = useState([])
  const [referenceLoaded, setReferenceLoaded] = useState(false)
  // True after the first read, so a reload keeps the rows on screen.
  const [loaded, setLoaded]           = useState(false)
  const [showAddMetric, setShowAddMetric] = useState(false)
  const [addError, setAddError]       = useState(null)
  const [adding, runAdd]              = usePendingAction()
  const [selectedId, setSelectedId]   = useState(null)
  // The metric name is composed from its parts: component (group), optional instance, type,
  // optional subType. NEW_GROUP and CUSTOM_TYPE are the escapes for a local extension.
  const [newMetric, setNewMetric] = useState(BLANK_METRIC)
  const [deprecateTarget, setDeprecateTarget] = useState(null)
  const [restoreTarget, setRestoreTarget] = useState(null)
  const [editTarget, setEditTarget] = useState(null)
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

  // Closing discards: half-finished input must not leak into the next open, including one started
  // from the Vocabulary page.
  const closeAddMetric = () => {
    setNewMetric(BLANK_METRIC)
    setAddError(null)
    setShowAddMetric(false)
  }

  // Re-read after every change this page makes.
  const load = useCallback(async () => {
    try {
      const [cat, grp, sch] = await Promise.all([
        api.get('/api/v1/metric-catalog'),
        api.get('/api/v1/metric-groups'),
        api.get('/api/v1/schemas'),
      ])
      setCatalog(cat); setGroups(grp); setSchemas(sch)
    } finally { setLoaded(true) }
  }, [])

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
      api.get('/api/v1/idta-submodel-templates'),
    ]).then(([voc, iso, opc, s223, templates]) => {
      if (!current) return
      setVocabulary(voc); setIsoVocabulary(iso); setOpcuaVocabulary(opc); setS223Vocabulary(s223)
      setTemplateElements(templates); setReferenceLoaded(true)
    })
    return () => { current = false }
  }, [])

  // Everything the semantic id picker offers, built once per read rather than on each keystroke.
  const semanticIdChoices = useMemo(() => semanticIdCandidates({
    mtconnect: vocabulary, iso22400: isoVocabulary, opcua: opcuaVocabulary, ashrae223: s223Vocabulary,
    templates: templateElements
  }), [vocabulary, isoVocabulary, opcuaVocabulary, s223Vocabulary, templateElements])

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
      // Only fill a description that is still empty, so the vocabulary's blurb never overwrites
      // something the operator has already written.
      description: m.description || prefill.description || ''
    }))
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

  /**
   * Arrival from an entry clicked on the Vocabulary page. The handover carries identifiers, resolved
   * here, because the rules that turn a vocabulary row into a metric live in applyPrefill and
   * nowhere else. Waits for the vocabularies and the groups to load, and clears the handover once
   * applied.
   */
  useEffect(() => {
    if (!pendingVocabularyEntry || !loaded || !referenceLoaded) return
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
  }, [pendingVocabularyEntry, loaded, referenceLoaded, isoVocabulary, opcuaVocabulary, s223Vocabulary])

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
      type: '', companionSpec: '', customType: '', subType: '', units: '',
      vocabCategory: '', vocabSemanticId: '', semanticIdOwn: null
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

      await api.post('/api/v1/metric-catalog', {
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
        description: newMetric.description
      })
      closeAddMetric()
      load()
      showToast(`Metric '${composed}' added to the catalog`, 'success')
    } catch (e) {
      setAddError(e.message)
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

  const handleEditSemanticId = async (pair) => {
    try {
      await api.put(`/api/v1/metric-catalog/${editTarget.metric_uuid}`, pair)
      setEditTarget(null)
      load()
      showToast(
        pair.semantic_id
          ? `Semantic id of '${editTarget.name}' saved`
          : `Semantic id of '${editTarget.name}' cleared; the metric is now unmapped`,
        'success'
      )
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  // The catalog and the schema registry share `schema:manage`. The write is refused by
  // metric_catalog's INSERT and UPDATE policies (has_role('Administrator')), so this disables the
  // control and decides nothing.
  const canManageSchema = hasPermission(PERMISSION_UUIDS.SCHEMA_MANAGE)
  // Deprecate, Restore and Edit write metric_catalog too, so they share Add Metric's gate: a
  // permission a Shopfloor_Manager holds, such as archive:manage, would offer a button the database
  // refuses.
  const canDeprecateMetric = canManageSchema
  const canEditMetric = canManageSchema

  /**
   * Narrows the catalog by metric name only: matching description or units would return rows whose
   * reason for matching is invisible in the table.
   */
  const matchesCatalogSearch = (m) =>
    !catalogSearch || (m.name || '').toLowerCase().includes(catalogSearch.trim().toLowerCase())

  const currentCatalog = catalog.filter(m => !m.deprecated)
  const activeCatalog = currentCatalog.filter(matchesCatalogSearch)
  // Its own card, unfiltered: the search box belongs to the catalog card above it.
  const deprecatedCatalog = catalog.filter(m => m.deprecated)
  const selected = catalog.find(m => m.metric_uuid === selectedId) || null
  // Grouped by the name's first `/`-separated segment; ungrouped metrics fall into a trailing bucket.
  const catalogGroups = groupCatalog(activeCatalog)
  // `superseded_by` is a uuid; the Deprecated Metrics card and the restore modal show the name.
  const metricById = new Map(catalog.map(m => [m.metric_uuid, m]))

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

  // MTConnect assigns each data item type a category, so it is derived. The other standards supply
  // theirs with the vocabulary entry. A local extension has none.
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

  const canAddMetric =
    effectiveType !== '' &&
    isValidMetricName(composedName) &&
    datatypeChosen &&
    (newMetric.group !== NEW_GROUP || newMetric.newGroup.trim() !== '')

  /** Edit is on both cards: a deprecated metric still carries its id into the schemas that model it. */
  const metricActions = (m) => [
    {
      label: 'Edit', icon: <IconPencil size={13} />,
      onClick: () => setEditTarget(m),
      disabled: !canEditMetric,
      title: !canEditMetric
        ? requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
        : "Correct this metric's semantic id and reference type"
    },
    m.deprecated
      ? {
        label: 'Restore', icon: <IconRefreshCw size={13} />,
        onClick: () => setRestoreTarget(m),
        disabled: !canDeprecateMetric,
        title: !canDeprecateMetric
          ? requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
          : 'Offer this metric to schema authors again'
      }
      : {
        label: 'Deprecate', icon: <IconArchive size={13} />,
        onClick: () => setDeprecateTarget(m),
        disabled: !canDeprecateMetric,
        danger: true,
        title: !canDeprecateMetric
          ? requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
          : 'Retire this metric from the schema builder'
      }
  ]

  /** The cells both cards share, so a metric reads the same in each. */
  const metricCells = (m) => (
    <>
      <td>
        <span className="mono">{m.name}</span>
        {/* MTConnect permits local extensions, so this marks provenance, not a problem. */}
        {!m.standard && m.category && (
          <span className="cell-meta badge-follow" title="Local extension — not drawn from a standard vocabulary">local</span>
        )}
      </td>
      <td>
        {m.standard
          ? <Badge size="sm" title={`Named from the ${m.standard} vocabulary`}>{m.standard}</Badge>
          : <span className="cell-meta">{LOCAL_EXTENSION_LABEL}</span>}
      </td>
      <td>
        {m.category
          ? <Badge size="sm" title={`MTConnect ${m.category} observation`}>{m.category}</Badge>
          : <span className="cell-meta">—</span>}
      </td>
      <td className="cell-meta">{m.units || '—'}</td>
      <td>{datatypeLabel(m.datatype)}</td>
      {/* Capped: a semantic id is a full IRI, and an unconstrained cell widens the whole table. */}
      <td className="metric-id-cell">
        {m.semantic_id
          ? <CopyableId
              value={m.semantic_id}
              label={`semantic id${m.semantic_id_type ? ` (${m.semantic_id_type})` : ''}`}
              onNotify={showToast}
            />
          : <span className="cell-meta" title="Not mapped to a standard concept. Legitimate for a local extension, which no vocabulary names. Edit can map any metric, and suggests its standard's id.">—</span>}
      </td>
      <td className="cell-meta">{m.description || '—'}</td>
    </>
  )

  const selectRow = (m) => setSelectedId(id => id === m.metric_uuid ? null : m.metric_uuid)
  const rowClass = (m) => `row-selectable${selectedId === m.metric_uuid ? ' row-selected' : ''}`

  const selectedReplacement = selected?.superseded_by ? metricById.get(selected.superseded_by) : null
  const selectedUsage = selected ? usageCountFor(selected.name) : 0

  const catalogHeaders = (
    <>
      <th>Name</th>
      <th title="Which standard vocabulary this metric was named from">Standard</th>
      <th title="MTConnect observation category">Category</th>
      <th title="Unit of measure, where the metric has one">Units</th>
      <th title="How the value is encoded on the wire">Datatype</th>
      <th title="AAS (IEC 63278) semanticId — the resolvable identity of the concept this metric measures">Semantic ID</th>
      <th>Description</th>
    </>
  )

  return (
    <div className="page-layout">
      <div className="page-main stack">
        <PageHeading icon={<IconTag size={15} />} title="Metrics">
          The catalog of metrics that schemas are built from, and the ones since deprecated.
        </PageHeading>

        <div className="card">
          <div className="card-header">
            <h3 className="section-title">
              Metric Catalog
              <HelpTip
                label="About the metric catalog"
                text="The metrics every schema is built from, grouped by the first segment of their name. A name is what a device publishes and cannot change afterwards, so an unwanted metric is deprecated, not removed."
              />
              <SectionCount total={currentCatalog.length} shown={activeCatalog.length} />
            </h3>
            <ActionButton
              className="btn btn-primary btn-sm"
              permitted={canManageSchema}
              deniedTitle={requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)}
              title="Add a new metric to the catalog"
              onClick={() => setShowAddMetric(true)}
            >
              <IconPlus size={13} /> Add Metric
            </ActionButton>
          </div>

          <div className="card-body">
            {/* The groups start collapsed, so typing is how a known metric is reached; it opens
                the groups that matched (isGroupOpen). */}
            <div className="filter-bar">
              <SearchInput
                value={catalogSearch}
                onChange={setCatalogSearch}
                placeholder="Search metrics…"
                ariaLabel="Search the metric catalog"
              />
              <ClearFilters count={catalogSearch ? 1 : 0} onClear={() => setCatalogSearch('')} />
            </div>
          </div>

          {!loaded ? <LoadingState label="catalog" /> : catalogGroups.length === 0 ? (
            <EmptyState
              icon={<IconBookOpen size={36} />}
              filtered={Boolean(catalogSearch)}
              message={deprecatedCatalog.length > 0
                ? 'Every metric in the catalog is deprecated.'
                : 'No metrics in the catalog yet.'}
              filteredMessage={<>No metric matches <strong>{catalogSearch}</strong>.</>}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr>{catalogHeaders}</tr></thead>
                {catalogGroups.map(group => {
                  const open = isGroupOpen(group.label)
                  return (
                    <tbody key={group.label}>
                      <tr className="table-group-row">
                        <td colSpan={7}>
                          {/* The whole header row is the control, as on the Vocabulary page. */}
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
                              className={`table-group-label${group.isUngrouped ? ' table-group-label-muted' : ''}`}
                              title={group.isUngrouped
                                ? 'These metric names carry no "Group/Metric" prefix, so they belong to no component'
                                : `Metrics named "${group.label}/…"`}
                            >
                              {group.label}
                            </span>
                            <span className="section-count">{group.metrics.length}</span>
                          </button>
                        </td>
                      </tr>
                      {open && group.metrics.map(m => (
                        <tr key={m.metric_uuid} className={rowClass(m)} onClick={rowSelectHandler(() => selectRow(m))} title="Click to inspect this metric">
                          {metricCells(m)}
                        </tr>
                      ))}
                    </tbody>
                  )
                })}
              </table>
            </div>
          )}
        </div>

        {/* Kept mounted across a reload, so the card does not vanish and reappear after a save. */}
        {loaded && deprecatedCatalog.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h3 className="section-title">
                Deprecated Metrics
                <HelpTip
                  label="About deprecated metrics"
                  text="Withheld from the schema builder, not deleted: schemas that model one keep it, and its readings stay. Restore offers it to schema authors again and clears the replacement it names."
                />
                <SectionCount total={deprecatedCatalog.length} />
              </h3>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {catalogHeaders}
                    <th title="The metric named as this one's replacement when it was deprecated">Superseded By</th>
                  </tr>
                </thead>
                <tbody>
                  {deprecatedCatalog.map(m => {
                    const replacement = m.superseded_by ? metricById.get(m.superseded_by) : null
                    return (
                      <tr key={m.metric_uuid} className={rowClass(m)} onClick={rowSelectHandler(() => selectRow(m))} title="Click to inspect this metric">
                        {metricCells(m)}
                        <td>
                          {replacement
                            ? <span className="mono">{replacement.name}</span>
                            : <span className="cell-meta" title="No replacement was named">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <ContextPanel
        open={!!selected}
        onClose={() => setSelectedId(null)}
        type="METRIC"
        subject="metric"
        onCopy={showToast}
        title={selected?.name || ''}
        subtitle={selected?.deprecated && <Badge tone="warning" size="sm">Deprecated</Badge>}
        fields={selected ? [
          { label: 'Name', value: selected.name, mono: true, copyable: true },
          { label: 'Standard', value: selected.standard || LOCAL_EXTENSION_LABEL },
          { label: 'Category', value: selected.category || null },
          { label: 'Units', value: selected.units || null },
          { label: 'Datatype', value: datatypeLabel(selected.datatype) },
          { label: 'Semantic ID', value: selected.semantic_id || null, mono: true, copyable: true, full: true },
          { label: 'Reference Type', value: selected.semantic_id ? selected.semantic_id_type || null : null },
          { label: 'Description', value: selected.description || null, full: true },
          selected.deprecated && {
            label: 'Superseded By',
            value: selectedReplacement ? selectedReplacement.name : null,
            mono: true,
            title: selectedReplacement ? undefined : 'No replacement was named'
          },
          {
            label: 'Schemas',
            value: selectedUsage === 0 ? 'None model it' : `${selectedUsage} model${selectedUsage === 1 ? 's' : ''} it`
          }
        ].filter(Boolean) : []}
        actions={selected ? metricActions(selected) : []}
      />

      {showAddMetric && (
        <Modal
          title="Add Metric"
          icon={<IconPlus size={18} />}
          size="xl"
          onClose={closeAddMetric}
          error={addError}
          footer={
            <>
              <button className="btn btn-ghost" onClick={closeAddMetric} disabled={adding}>Cancel</button>
              <ActionButton
                className="btn btn-primary"
                pending={adding}
                pendingLabel="Adding…"
                disabled={!canAddMetric}
                onClick={() => runAdd(handleAddMetric)}
                title="Add this metric to the catalog"
              >
                Add
              </ActionButton>
            </>
          }
        >
          <div className="metric-form">
            {/* Chosen first because it decides what every control to its right offers. */}
            <div className="form-group" style={{ flex: '0 1 150px' }}>
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

            <div className="form-group" style={{ flex: '0 1 170px' }}>
              <label className="form-label">Group</label>
              <select
                className="form-control"
                value={newMetric.group}
                onChange={e => handleGroupChange(e.target.value)}
                title="The component this metric belongs to. Becomes the first segment of its name, so it is part of what the device publishes."
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
              <div className="form-group" style={{ flex: '0 1 170px' }}>
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

            <div className="form-group" style={{ flex: '0 1 110px' }}>
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
              <div className="form-group" style={{ flex: '1 1 200px' }}>
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
              <div className="form-group" style={{ flex: '1 1 200px' }}>
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
              <div className="form-group" style={{ flex: '1 1 220px' }}>
                <label className="form-label">Data Point</label>
                <select
                  className="form-control"
                  value={chosenDataPoint
                    ? `${chosenDataPoint.companion_spec}${OPCUA_KEY_SEP}${chosenDataPoint.name}`
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
              <div className="form-group" style={{ flex: '1 1 220px' }}>
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
              <div className="form-group" style={{ flex: '1 1 170px' }}>
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
              <div className="form-group" style={{ flex: '0 1 150px' }}>
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

            <div className="form-group" style={{ flex: '0 1 150px' }}>
              <label className="form-label">Units</label>
              <select
                className="form-control"
                value={unitsApply ? newMetric.units : ''}
                disabled={!unitsApply}
                onChange={e => setNewMetric(m => ({ ...m, units: e.target.value }))}
                title={unitsApply
                  ? 'The unit of measure. A vocabulary entry fills it where its standard states one; otherwise you choose it.'
                  : 'Only SAMPLE data items carry units'}
              >
                <option value="">— None —</option>
                {availableUnits.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>

            <div className="form-group" style={{ flex: '0 1 140px' }}>
              <label className="form-label">Sparkplug Datatype</label>
              <select
                className="form-control"
                value={datatypeChosen ? newMetric.datatype : ''}
                onChange={e => setNewMetric(m => ({ ...m, datatype: parseInt(e.target.value, 10) }))}
                title="How the value is encoded on the wire. A vocabulary entry fills it where its standard says; otherwise you choose it, and it cannot be changed later."
              >
                {/* Shown only while nothing is chosen: a select must not read "Double" while the
                    form holds no datatype. */}
                {!datatypeChosen && <option value="">— Choose —</option>}
                {SPARKPLUG_DATATYPES.map(d => <option key={d.code} value={d.code}>{d.label}</option>)}
              </select>
            </div>

            <div className="form-group" style={{ flex: '2 1 200px' }}>
              <label className="form-label">Description</label>
              <input className="form-control" value={newMetric.description} onChange={e => setNewMetric(m => ({ ...m, description: e.target.value }))} placeholder="What this metric represents" />
            </div>

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
                {isMTConnect ? ', from the MTConnect standard.' : `, mapped from ${newMetric.standard}.`}</>
            )}
            {effectiveStandard
              ? <> Provenance <strong>{effectiveStandard}</strong>.</>
              : <> Recorded as a <strong>local extension</strong>, with no standard provenance.</>}
            {semanticIdValue && (
              <> Semantic id <span className="mono">{semanticIdValue}</span>
                {semanticIdTypeValue ? ` (${semanticIdTypeValue})` : ''}; unlike the name, an Administrator can correct it later with Edit.</>
            )}
          </div>

          {/* The database enforces the same format (metric_catalog_name_format), but a 400 after
              pressing Add is a poor way to learn it, and the name is immutable. */}
          {nameError && (
            <div className="callout callout-danger">
              <IconAlertTriangle size={13} className="callout-icon" />
              <span>{nameError}</span>
            </div>
          )}

          {!datatypeChosen && (
            <div className="callout callout-warning">
              <IconAlertTriangle size={13} className="callout-icon" />
              <span>Choose a Sparkplug datatype. The vocabulary entry does not say how this value is encoded, and the datatype cannot be changed once the metric exists.</span>
            </div>
          )}

          {groupCaseCollision && (
            <div className="callout callout-warning">
              <IconAlertTriangle size={13} className="callout-icon" />
              <span>
                Group <span className="mono">{newMetric.newGroup.trim()}</span> already exists as{' '}
                <span className="mono">{effectiveGroup}</span> — that spelling will be used, so the two do not fork.
              </span>
            </div>
          )}
        </Modal>
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

      {editTarget && (
        <EditMetricSemanticIdModal
          metric={editTarget}
          usageCount={usageCountFor(editTarget.name)}
          suggestion={suggestionForMetric(editTarget, {
            mtconnect: vocabulary, iso22400: isoVocabulary, opcua: opcuaVocabulary, ashrae223: s223Vocabulary
          })}
          candidates={semanticIdChoices}
          onConfirm={handleEditSemanticId}
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
