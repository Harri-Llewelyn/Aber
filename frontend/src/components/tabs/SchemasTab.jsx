import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { ValidatePayloadModal } from '../modals/ValidatePayloadModal'
import { SchemaBuilderModal } from '../modals/SchemaBuilderModal'
import { SchemaDetailModal } from '../modals/SchemaDetailModal'
import { SchemaForkModal } from '../modals/SchemaForkModal'
import { ConfirmModal } from '../modals/ConfirmModal'
import { DeprecateMetricModal } from '../modals/DeprecateMetricModal'
import { downloadJSON } from '../../utils/downloadJSON'
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
import { conceptByName, ashrae223Prefill } from '../../utils/ashrae223'

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
  // from the composed name. `semanticIdManual` records that the operator has taken the field over.
  semanticId: '', semanticIdType: '', semanticIdManual: false,
  // Only set for standards whose vocabulary states it. MTConnect derives it from the data item
  // type instead, so this stays blank there and effectiveCategory falls back to the derivation.
  vocabCategory: ''
}
import { deviceSparkplugId, gatewaySparkplugId } from '../../utils/sparkplugId'
import {
  schemaVersionLabel, schemaStatus, statusBadgeClass, statusLabel, isSchemaEditable,
  canForkSchema, nextVersion, isCurrentSchema, SCHEMA_STATUS
} from '../../utils/schemaVersion'
import CopyableId from '../common/CopyableId'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import {
  IconCheck, IconPlus, IconFileCode, IconAlertTriangle, IconArchive, IconCpu,
  IconChevronDown, IconChevronUp, IconX, IconLock, IconGitBranch, IconPencil, IconDownload
} from '../common/Icons'
import { HelpTip } from '../common/HelpTip'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'

/**
 * @param {Function} onSelectSchema Opens the Devices page filtered to a schema.
 *
 * @param {Function} onSelectDevice Opens one device on the Devices page.
 *
 * @param {string} initialSchemaId A schema to open on arrival, handed over by a device drawer's
 * Schema chip.
 */
export function SchemasTab({ showToast, hasPermission, onSelectSchema, onSelectDevice, initialSchemaId, pendingVocabularyEntry, onConsumeVocabularyEntry }) {
  const [schemas, setSchemas]         = useState([])
  const [catalog, setCatalog]         = useState([])
  const [gateways, setGateways]       = useState([])
  const [devices, setDevices]         = useState([])
  const [loading, setLoading]         = useState(true)
  const [showValidateModal, setShowValidateModal] = useState(false)
  const [showBuilderModal, setShowBuilderModal] = useState(false)
  const [groups, setGroups]           = useState([])
  const [vocabulary, setVocabulary]   = useState([])
  const [isoVocabulary, setIsoVocabulary]     = useState([])
  const [opcuaVocabulary, setOpcuaVocabulary] = useState([])
  const [s223Vocabulary, setS223Vocabulary] = useState([])
  const [showAddMetric, setShowAddMetric] = useState(false)
  // The metric name is composed from its MTConnect parts: component (group), optional instance,
  // data item type, optional subType. NEW_GROUP and CUSTOM_TYPE are the escapes MTConnect permits
  // for extensions.
  const [newMetric, setNewMetric] = useState(BLANK_METRIC)
  const [deprecateTarget, setDeprecateTarget] = useState(null)
  // Expansion state for the catalog's group sections, keyed by label; absent means collapsed. The
  // headers carry a count, so a collapsed catalog still says what is in it.
  const [expandedGroups, setExpandedGroups] = useState({})
  // Filters the catalog by metric name. With groups collapsed by default it is how one metric is
  // found without opening each group.
  const [catalogSearch, setCatalogSearch] = useState('')
  const [showDeprecated, setShowDeprecated] = useState(false)
  // Version lifecycle. `detailSchema` is the version being read or edited; `forkTarget` the one a
  // new version is cut from. Two states, because forking is reachable from the table and from the
  // detail modal. An id rather than the object: the list reloads after every fork, publish and
  // deprecate.
  const [selectedId, setSelectedId] = useState(null)
  const [detailSchema, setDetailSchema] = useState(null)
  const [forkTarget, setForkTarget] = useState(null)
  // The draft awaiting a discard confirmation. Held as the OBJECT so the dialog can name the
  // version it is about -- "discard the draft" is not a sentence somebody should have to trust.
  const [discardTarget, setDiscardTarget] = useState(null)
  /**
   * The registry's two filters. Status replaces the old Archived Versions toggle, which was a
   * status filter wearing a button. `current` is the default, so superseded versions stay out of
   * the working list until asked for.
   */
  const [statusFilter, setStatusFilter] = useState('current')
  const [schemaSearch, setSchemaSearch] = useState('')

  /**
   * A group is open when the operator opened it, or when a search is narrowing the catalog: a
   * search that left the groups shut would show headers and no matches.
   */
  const isGroupOpen = (label) => Boolean(catalogSearch) || expandedGroups[label] === true
  const toggleGroup = (label) =>
    setExpandedGroups(prev => ({ ...prev, [label]: !isGroupOpen(label) }))

  // "Cancel" means discard, so closing the form clears it. That also stops half-finished input
  // leaking into the next open -- including the one the vocabulary panel triggers.
  const toggleAddMetric = () => {
    if (showAddMetric) setNewMetric(BLANK_METRIC)
    setShowAddMetric(v => !v)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [sch, cat, grp, voc, iso, opc, s223, gw, dev] = await Promise.all([
        api.get('/api/v1/schemas'),
        api.get('/api/v1/metric-catalog'),
        api.get('/api/v1/metric-groups'),
        api.get('/api/v1/mtconnect-vocabulary'),
        api.get('/api/v1/iso22400-vocabulary'),
        api.get('/api/v1/opcua-vocabulary'),
        api.get('/api/v1/ashrae223-vocabulary'),
        api.get('/api/v1/gateways'),
        api.get('/api/v1/devices'),
      ])
      setSchemas(sch); setCatalog(cat); setGroups(grp); setVocabulary(voc)
      setIsoVocabulary(iso); setOpcuaVocabulary(opc); setS223Vocabulary(s223)
      setGateways(gw); setDevices(dev)
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

  /** Apply a vocabulary prefill (utils/iso22400 or utils/opcua) to the form and open it. */
  const applyPrefill = (prefill) => {
    if (!prefill) return
    setNewMetric(m => ({
      ...m,
      ...groupFields(prefill.group),
      standard: prefill.standard,
      type: prefill.type,
      customType: '',
      // A KPI and an OPC UA data point are both whole concepts; neither has an MTConnect subType.
      subType: '',
      units: prefill.units,
      datatype: prefill.datatype,
      vocabCategory: prefill.category,
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

  // Clicking a data item type in the vocabulary panel opens the Add Metric form with the type
  // chosen, leaving the component and instance to the operator.
  const handleUseVocabularyType = (typeName) => {
    setNewMetric(m => ({ ...m, standard: STANDARDS.MTCONNECT, type: typeName, customType: '' }))
    setShowAddMetric(true)
  }

  const handleUseKpi = (kpi) => applyPrefill(iso22400Prefill(kpi))
  const handleUseOpcuaPoint = (point) => applyPrefill(opcuaPrefill(point))

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
    setNewMetric(m => ({ ...m, type: value }))
  }

  /**
   * Switching standard clears everything the previous vocabulary decided: `standard` is what an AAS
   * export reads to choose a namespace, so a stale type is a wrong interoperability claim. The
   * group and description are the operator's own input and survive.
   */
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

  /**
   * The devices provisioned against one exact schema version: submodels if any, else the 1:1
   * `schema_id`, the rule `schemasForDevice` applies from the other direction. The list, with the
   * count derived from it.
   */
  const devicesForSchema = (schemaUuid) =>
    devices.filter(d =>
      (d.submodel_schema_ids?.length ? d.submodel_schema_ids : [d.schema_id]).includes(schemaUuid)
    )

  const deviceCountFor = (schemaUuid) => devicesForSchema(schemaUuid).length

  const handleDeprecate = async (supersededBy) => {
    try {
      await api.post(`/api/v1/metric-catalog/${deprecateTarget.metric_uuid}/deprecate`, { superseded_by: supersededBy })
      setDeprecateTarget(null)
      load()
      showToast(`Metric '${deprecateTarget.name}' deprecated`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const handleBuilderSubmit = async (schemaPayload, deviceDetails, action) => {
    try {
      const saved = await api.post('/api/v1/schemas', schemaPayload)

      if (action === 'download') {
        // Provisioning is a prerequisite: the spec sheet quotes the Sparkplug identifiers, which
        // are derived from database ids.
        const device = await api.post('/api/v1/devices', {
          asset_name: deviceDetails.device_name,
          active_gateway_id: deviceDetails.gateway_id,
          schema_id: saved.schema_uuid
        })

        const gateway = gateways.find(g => g.gateway_id === deviceDetails.gateway_id)
        const gatewayId = gateway
          ? (gateway.sparkplug_id || gatewaySparkplugId(gateway.gateway_id))
          : 'YOUR_GATEWAY_SPARKPLUG_ID'
        const deviceId = device.sparkplug_id || deviceSparkplugId(device.id)

        const spec = {
          schema_name: schemaPayload.schema_name,
          schema_uuid: saved.schema_uuid,
          description: schemaPayload.description,
          metrics: schemaPayload.schema_definition.properties,
          required: schemaPayload.schema_definition.required,
          device_name: deviceDetails.device_name,
          device_sparkplug_id: deviceId,
          gateway_name: gateway?.gateway_name || null,
          gateway_sparkplug_id: gatewayId,
          topics: {
            dbirth: `spBv1.0/${deviceDetails.group_id}/DBIRTH/${gatewayId}/${deviceId}`,
            ddata: `spBv1.0/${deviceDetails.group_id}/DDATA/${gatewayId}/${deviceId}`
          }
        }
        downloadJSON(spec, `${deviceDetails.device_name}-spec-sheet.json`)
        showToast(`Schema saved, device '${deviceDetails.device_name}' provisioned, spec sheet downloaded`, 'success')
      } else {
        showToast(`Schema '${schemaPayload.schema_name}' saved`, 'success')
      }

      setShowBuilderModal(false)
      load()
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  /**
   * Fork an active schema into the next draft version. The version number is derived by
   * `fork_schema()`, and `enforce_schema_version_provenance()` refuses an insert that names one.
   * The draft opens immediately.
   */
  const handleFork = async (changeDescription) => {
    const parent = forkTarget
    try {
      const draft = await api.post(`/api/v1/schemas/${parent.schema_uuid}/versions`, {
        change_description: changeDescription
      })
      setForkTarget(null)
      const refreshed = await api.get('/api/v1/schemas')
      setSchemas(refreshed)
      setDetailSchema(refreshed.find(s => s.schema_uuid === draft.schema_uuid) || null)
      showToast(`Draft v${draft.version} created as '${draft.schema_name}'`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const handleSaveDraft = async (patch) => {
    if (!detailSchema) return
    try {
      await api.put(`/api/v1/schemas/${detailSchema.schema_uuid}`, patch)
      const refreshed = await api.get('/api/v1/schemas')
      setSchemas(refreshed)
      setDetailSchema(refreshed.find(s => s.schema_uuid === detailSchema.schema_uuid) || null)
      showToast(`Draft '${detailSchema.schema_name}' saved`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
      // Rethrown so the modal's publish path does not activate a version whose edits were rejected.
      throw e
    }
  }

  const handlePublish = async () => {
    if (!detailSchema) return
    try {
      const result = await api.post(`/api/v1/schemas/${detailSchema.schema_uuid}/publish`, {})
      setDetailSchema(null)
      // Devices carry the schema binding, so both lists are stale after a publish.
      load()
      const moved = result.devices_rebound || 0
      showToast(
        `v${result.version} published${result.archived_schema_name ? `, v${result.version - 1} archived` : ''}` +
        (moved > 0 ? ` — ${moved} device binding${moved === 1 ? '' : 's'} moved across` : ''),
        'success'
      )
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  /**
   * Discard the open draft. One draft may exist per lineage, so without this the only way out of an
   * unwanted draft was to publish it.
   */
  const handleDiscardDraft = async () => {
    if (!discardTarget) return
    try {
      const result = await api.post(`/api/v1/schemas/${discardTarget.schema_uuid}/discard`, {})
      setDiscardTarget(null)
      setDetailSchema(null)
      // The lineage moved and so may device bindings, so both lists are stale.
      load()
      const detached = result.devices_detached || 0
      showToast(
        `Draft v${result.version} discarded` +
        (detached > 0
          // Said out loud rather than left to be discovered: a draft can be attached to a machine
          // to try it out, and those attachments go with it.
          ? ` — ${detached} device attachment${detached === 1 ? '' : 's'} removed with it`
          : ''),
        'success'
      )
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  /**
   * Download a version's definition as a standalone `.schema.json`. The stored document verbatim,
   * so it diffs cleanly against the database and the previous version; the identity rides on the
   * filename, which carries the version. `.schema.json` so editors and tooling recognise it.
   */
  const handleDownloadSchema = (sch) => {
    if (!sch?.schema_definition) {
      // downloadJSON() returns silently on falsy data, so an empty definition would look like a
      // button that does nothing. Say what happened instead.
      showToast(`Schema '${sch?.schema_name || 'unknown'}' has no definition to download`, 'error')
      return
    }
    const filename = `${sch.schema_name}.schema.json`
    downloadJSON(sch.schema_definition, filename)
    showToast(`Downloaded ${filename}`, 'success')
  }

  const canManageSchema = hasPermission(PERMISSION_UUIDS.SCHEMA_MANAGE)
  const canDeprecateMetric = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  // Superseded versions stay out of the working list until asked for. Drafts do not: opening one is
  // the only way to finish it. See isCurrentSchema().
  const archivedCount = schemas.filter(s => !isCurrentSchema(s)).length
  const currentCount = schemas.length - archivedCount
  const draftCount = schemas.filter(s => schemaStatus(s) === SCHEMA_STATUS.DRAFT).length
  const activeCount = schemas.filter(s => schemaStatus(s) === SCHEMA_STATUS.ACTIVE).length

  const matchesStatusFilter = (s) => {
    if (statusFilter === 'all') return true
    if (statusFilter === 'current') return isCurrentSchema(s)
    return schemaStatus(s) === statusFilter
  }

  /**
   * Narrows the registry by name, UUID and change description, all columns of this table, so a hit
   * can always be seen. The catalog below matches name alone for the same reason.
   */
  const schemaSearchTerm = schemaSearch.trim().toLowerCase()
  const matchesSchemaSearch = (s) =>
    !schemaSearchTerm || [s.schema_name, s.schema_uuid, s.change_description]
      .some(field => String(field || '').toLowerCase().includes(schemaSearchTerm))

  const visibleSchemas = schemas.filter(s => matchesStatusFilter(s) && matchesSchemaSearch(s))
  // Drives the Clear button and its count. `current` is the resting state, not a filter.
  const schemaFilterCount = (statusFilter !== 'current' ? 1 : 0) + (schemaSearchTerm ? 1 : 0)
  const clearSchemaFilters = () => { setStatusFilter('current'); setSchemaSearch('') }
  /**
   * Narrows the catalog by metric name only: matching description or units would return rows whose
   * reason for matching is invisible in the table.
   */
  const matchesCatalogSearch = (m) =>
    !catalogSearch || (m.name || '').toLowerCase().includes(catalogSearch.trim().toLowerCase())

  const activeCatalog = catalog.filter(m => !m.deprecated).filter(matchesCatalogSearch)
  const deprecatedCatalog = catalog.filter(m => m.deprecated).filter(matchesCatalogSearch)
  // Grouped by the first dotted segment of the name; ungrouped metrics fall into a trailing bucket.
  // Deprecated metrics stay a flat tail.
  const catalogGroups = groupCatalog(activeCatalog)

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
  const isCustomStandard = newMetric.standard === STANDARDS.CUSTOM

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
  // MTConnect metrics get a semantic id derived from the composed name in this deployment's
  // namespace (utils/standards.js). It tracks the name until the operator types their own, and only
  // once a type is chosen: with only a group picked, the composed name names a group rather than a
  // metric.
  const derivedSemanticId =
    isMTConnect && effectiveType !== '' ? mtconnectSemanticId(composedName) : ''
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
    (newMetric.group !== NEW_GROUP || newMetric.newGroup.trim() !== '') &&
    // A type without a value would export as an AAS Reference with no key. Rejected here rather
    // than nulled on the way out, so the operator sees the field they left half-filled.
    (semanticIdValue !== '' || semanticIdTypeValue === '')

  // Arriving from a device drawer's Schema chip. Read from the prop and the URL: the query string
  // survives a reload and a shared link, the prop covers a navigation that pushed none.
  const arrivingSchemaId =
    new URLSearchParams(window.location.search).get('search') || initialSchemaId || ''
  /**
   * Arriving opens the drawer and reveals the row. The hook matches over every schema, so the
   * drawer could open on a row the filters hide; the arrival widens whatever would hide it. Widen
   * rather than clear: `current` is itself the filter that hides a superseded version.
   */
  useArrivalSelection(
    arrivingSchemaId,
    schemas,
    (s, term) => s.schema_uuid === term,
    (s) => {
      setSelectedId(s.schema_uuid)
      setSchemaSearch('')
      setStatusFilter(prev => {
        const shown = prev === 'all'
          || (prev === 'current' ? isCurrentSchema(s) : schemaStatus(s) === prev)
        return shown ? prev : 'all'
      })
    }
  )

  // Resolved fresh every render -- see the note on selectedId.
  const selectedSchema = schemas.find(s => s.schema_uuid === selectedId) || null
  const selectedStatus = selectedSchema ? schemaStatus(selectedSchema) : null
  // A lineage may hold at most one open draft (a partial unique index), so forking again before it
  // is published or discarded is refused.
  const selectedDraft = selectedSchema
    ? schemas.find(s => s.parent_schema_id === selectedSchema.schema_uuid && schemaStatus(s) === SCHEMA_STATUS.DRAFT)
    : null
  const selectedForkBlocked = !canManageSchema || !!selectedDraft

  return (
    <div className="page-layout">
      <div className="page-main">

      {/* Registered schemas first, catalog second: every visit after the first is to read or
          version a schema that already exists. */}

      <div className="card" style={{ marginBottom: 'var(--stack)' }}>
        <div className="card-header">
          {/* FILTERED OF TOTAL, not a bare count. A narrowed registry would otherwise read as a
              short one, which is the wrong thing to believe about a version history. */}
          <h3 className="section-title">
            Registered Schemas
            <HelpTip
              label="About schemas"
              text="A schema declares what a device is modelled to publish. A published schema is read-only: changes are made by creating the next version, which forks it into an editable draft. Publishing a draft activates it, archives its predecessor and moves every device across in one transaction. Version numbers are assigned by the database."
            />
            {visibleSchemas.length !== schemas.length && (
              <span
                className="section-count"
                title={`${visibleSchemas.length} of ${schemas.length} versions match the current filters`}
              >
                {`${visibleSchemas.length}/${schemas.length}`}
              </span>
            )}
          </h3>
          {/* The page's primary action, in the header of the card it acts on. Validate Candidate
              Payload is a schema's own action in the drawer, where the target is already chosen. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {/* The only way to create a schema. Building from the catalog is what guarantees every
                metric has a standard and a semantic id, which device tags, unmodelled detection and
                the tag filters all read. */}
            <button
              className={`btn btn-primary btn-sm ${!canManageSchema ? 'btn-disabled' : ''}`}
              disabled={!canManageSchema}
              onClick={() => canManageSchema && setShowBuilderModal(true)}
              title={!canManageSchema ? 'Requires Admin permissions' : 'Build a schema from the metric catalog, then download a spec sheet or provision a device'}
            >
              <IconFileCode size={14} /> Build Schema from Catalog
            </button>
          {/* The Archived Versions toggle is an option in the status select above. */}
          </div>
        </div>

        <div className="card-body">
      {/* The registry gains a row per publish rather than per schema, so it outgrows a plain list
          faster than anything else here. */}
      <div className="filter-bar">
        <select
          className="form-control"
          style={{ width: '190px' }}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          aria-label="Filter schemas by lifecycle state"
          title="Filter by lifecycle state. Current hides superseded versions."
        >
          {/* Counts in the labels, as on Cells and Gateways: it is how the archived count survived
              losing its badge, and it answers "is there any history at all?" without selecting. */}
          <option value="current">Current ({currentCount})</option>
          <option value={SCHEMA_STATUS.ACTIVE}>Active ({activeCount})</option>
          <option value={SCHEMA_STATUS.DRAFT}>Draft ({draftCount})</option>
          <option value={SCHEMA_STATUS.ARCHIVED}>Archived ({archivedCount})</option>
          <option value="all">All versions ({schemas.length})</option>
        </select>

        <input
          className="form-control"
          style={{ width: '260px' }}
          value={schemaSearch}
          onChange={e => setSchemaSearch(e.target.value)}
          placeholder="Search name, UUID or description…"
          aria-label="Search the schema registry"
          title="Filter schemas by name, UUID or change description"
        />

        {schemaFilterCount > 0 && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={clearSchemaFilters}
            title="Clear every filter"
          >
            <IconX size={13} /> Clear filters ({schemaFilterCount})
          </button>
        )}
      </div>
        </div>{/* .card-body */}
        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading schemas…</div> : visibleSchemas.length === 0 ? (
          /* Says why it is empty, as the catalog's empty state does: a blank table reads as a
             failed load rather than a filter doing its job. */
          <div className="empty-state" style={{ padding: '20px var(--inset)' }}>
            <div className="empty-icon"><IconFileCode size={36} /></div>
            <div className="empty-text">
              {schemas.length === 0
                ? 'No schemas registered yet — build one from the metric catalog below.'
                : schemaSearchTerm
                  ? <>No schema matches <strong>{schemaSearch.trim()}</strong>.</>
                  : 'No schema versions in this lifecycle state.'}
            </div>
          </div>
        ) : (
          /* `.table-scroll` caps the height and pins the header row, so the registry cannot push
             the catalog off the page. */
          <div className="table-wrap table-scroll">
            <table>
              <thead><tr><th title="Schema descriptive name">Schema Name</th><th title="Lineage position and lifecycle state. Only a draft is editable.">Version</th><th title="Why this version exists, recorded when it was created">Change Description</th><th title="Schema unique UUID">Schema UUID</th><th title="Devices provisioned with this schema">Devices</th></tr></thead>
              <tbody>
                {visibleSchemas.map(sch => {
                  const count = deviceCountFor(sch.schema_uuid)
                  const status = schemaStatus(sch)
                  const draft = schemas.find(s =>
                    s.parent_schema_id === sch.schema_uuid && schemaStatus(s) === SCHEMA_STATUS.DRAFT
                  )
                  const forkBlocked = !canManageSchema || !!draft
                  return (
                    <tr
                      key={sch.schema_uuid}
                      className={`row-selectable${selectedId === sch.schema_uuid ? ' row-selected' : ''}`}
                      style={status === SCHEMA_STATUS.ARCHIVED ? { opacity: 0.6 } : undefined}
                      onClick={rowSelectHandler(() => setSelectedId(id => id === sch.schema_uuid ? null : sch.schema_uuid))}
                      title="Click to inspect this schema in the details panel"
                    >
                      <td>
                        <strong>{sch.schema_name}</strong>
                        {/* A published version is read-only, and the lock says so on the row
                            rather than only once the modal is open. */}
                        {!isSchemaEditable(sch) && (
                          <span
                            style={{ marginLeft: '6px', color: 'var(--text-dim)', verticalAlign: 'middle' }}
                            title={`Read-only — this version is ${statusLabel(status)}`}
                          >
                            <IconLock size={11} />
                          </span>
                        )}
                      </td>
                      <td>
                        <span
                          className={`badge ${statusBadgeClass(status)}`}
                          title={isSchemaEditable(sch)
                            ? 'Draft — editable until published'
                            : `${statusLabel(status)} and immutable`}
                        >
                          {schemaVersionLabel(sch)}
                        </span>
                      </td>
                      {/* Constrained: a change description is free text and `.table-wrap` scrolls
                          horizontally, so an unbounded cell pushes the action buttons off-screen. */}
                      <td style={{ maxWidth: '280px', color: sch.change_description ? 'var(--text-muted)' : 'var(--text-dim)', fontSize: '12px' }}>
                        {sch.change_description || '—'}
                      </td>
                      <td><CopyableId value={sch.schema_uuid} label="schema UUID" onNotify={showToast} /></td>
                      <td>
                        {/* The count is the natural entry point to "which devices are these?",
                            so it navigates to the Devices page filtered to this schema. */}
                        <button
                          type="button"
                          className="count-link"
                          disabled={count === 0}
                          onClick={() => count > 0 && onSelectSchema?.(sch.schema_uuid)}
                          title={count === 0
                            ? 'No devices are provisioned with this schema'
                            : `Show the ${count} device${count === 1 ? '' : 's'} using this schema`}
                        >
                          <span className="section-count">{count}</span>
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 'var(--stack)' }}>
        {/* `.card-header`, not `.section-header`: the card has no padding of its own, so a plain
            section header would sit flush against its borders. */}
        <div className="card-header">
          <h3 className="section-title">
            Metric Catalog
            <HelpTip
              label="About the metric catalog"
              text="The metrics a schema can be built from, grouped by name prefix. Search reaches a known metric without opening every group; Use on the Vocabulary page starts a new one from a standard's entry."
            />
          </h3>
          {/* Beside Add Metric because the groups start collapsed; typing auto-expands the groups
              that matched (isGroupOpen). */}
          <input
            className="form-control"
            style={{ width: '200px', marginLeft: 'auto', marginRight: '10px' }}
            value={catalogSearch}
            onChange={e => setCatalogSearch(e.target.value)}
            placeholder="Search metrics…"
            aria-label="Search the metric catalog"
            title="Filter the catalog by metric name"
          />
          {/* The label follows the form's state rather than naming a fixed action, so the control
              always says what pressing it will do. */}
          <button
            className={`btn btn-ghost btn-sm ${!canManageSchema ? 'btn-disabled' : ''}`}
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
        <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: 0 }}>
          Metrics are grouped by the first segment of their name — <span className="mono">Axes/C/ANGLE</span> and{' '}
          <span className="mono">Axes/X/POSITION</span> both belong to <strong>Axes</strong>. The <span className="mono">/</span>{' '}
          separator is the one Sparkplug B uses for its own names (<span className="mono">Node Control/Rebirth</span>),
          and the one Factory+ and MTConnect use for component paths. The group is part of the name a device publishes,
          so it is visible in MQTT, TimescaleDB and Grafana, and — like the name itself — cannot be edited afterwards.
          Names without a separator are listed under <strong>Ungrouped</strong>.
        </p>
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

              {/* One slot, three vocabularies. The Standard selector decides which fills it, so the
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
                <select className="form-control" value={newMetric.datatype} onChange={e => setNewMetric(m => ({ ...m, datatype: parseInt(e.target.value, 10) }))} title="How the value is encoded on the wire. MTConnect does not specify this, so it stays a local choice.">
                  {SPARKPLUG_DATATYPES.map(d => <option key={d.code} value={d.code}>{d.label}</option>)}
                </select>
              </div>

              <div className="form-group" style={{ margin: 0, flex: '2 1 200px' }}>
                <label className="form-label">Description</label>
                <input className="form-control" value={newMetric.description} onChange={e => setNewMetric(m => ({ ...m, description: e.target.value }))} placeholder="What this metric represents" />
              </div>

              {/* Semantic ids: prefilled from the vocabulary for ISO 22400 and OPC UA, derived from
                  the composed name for MTConnect, and editable in every case. */}
              <div className="form-group" style={{ margin: 0, flex: '2 1 260px' }}>
                <label className="form-label">
                  Semantic ID <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>(optional)</span>
                  {!newMetric.semanticIdManual && derivedSemanticId && (
                    <span style={{ fontWeight: 400, color: 'var(--text-dim)', marginLeft: '5px' }} title="Built from the metric name in this deployment's namespace. Type to override.">
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
                      <td>
                        <span className="mono">{m.name}</span>
                        {/* MTConnect permits local extensions, so this marks provenance rather
                            than flagging a problem. */}
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
                      {/* Capped and scrollable: a semantic id is a full IRI, and an unconstrained
                          cell pushes the Deprecate button off-screen. */}
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

              {/* Deprecated metrics get their own section, collapsed by default and rendered only
                  when some exist. */}
              {deprecatedCatalog.length > 0 && (
              <tbody>
                <tr>
                  <td colSpan={8} style={{ background: 'var(--bg-glass)', padding: 0, borderTop: '1px solid var(--border)' }}>
                    <button
                      type="button"
                      onClick={() => setShowDeprecated(v => !v)}
                      aria-expanded={showDeprecated}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '6px 12px', background: 'none', border: 'none',
                        cursor: 'pointer', color: 'inherit', textAlign: 'left', font: 'inherit'
                      }}
                      title={showDeprecated ? 'Hide deprecated metrics' : 'Show metrics that have been retired and replaced'}
                    >
                      {showDeprecated ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                      <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                        Deprecated
                      </span>
                      <span className="section-count">{deprecatedCatalog.length}</span>
                    </button>
                  </td>
                </tr>
                {showDeprecated && deprecatedCatalog.map(m => (
                  <tr key={m.metric_uuid} style={{ opacity: 0.5 }}>
                    <td><span className="mono" style={{ textDecoration: 'line-through' }}>{m.name}</span></td>
                    <td style={{ fontSize: '11px' }}>{m.standard || LOCAL_EXTENSION_LABEL}</td>
                    <td>{m.category || '—'}</td>
                    <td style={{ fontSize: '11px' }}>{m.units || '—'}</td>
                    <td>{datatypeLabel(m.datatype)}</td>
                    <td className="mono" style={{ fontSize: '11px', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.semantic_id || ''}>
                      {m.semantic_id || '—'}
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>
                      <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)' }}>
                        <IconAlertTriangle size={10} /> DEPRECATED
                      </span>
                    </td>
                    <td></td>
                  </tr>
                ))}
              </tbody>
              )}
            </table>
          </div>
        )}
      </div>

      {/* Keyed on the schema UUID so switching versions remounts the modal; otherwise the editor's
          seeded metric selection would survive the switch. */}
      {detailSchema && (
        <SchemaDetailModal
          key={detailSchema.schema_uuid}
          schema={detailSchema}
          schemas={schemas}
          catalog={catalog}
          deviceCount={deviceCountFor(detailSchema.schema_uuid)}
          canManage={canManageSchema}
          showToast={showToast}
          onFork={() => { setForkTarget(detailSchema); setDetailSchema(null) }}
          onDownload={() => handleDownloadSchema(detailSchema)}
          onSaveDraft={handleSaveDraft}
          onPublish={handlePublish}
          onDiscard={() => setDiscardTarget(detailSchema)}
          onClose={() => setDetailSchema(null)}
        />
      )}

      {/* Typed confirmation, because this destroys work: a draft is somebody's editing session, and
          the delete cascades to device attachments made to try it out. Same guard the archive flows
          use. */}
      {discardTarget && (
        <ConfirmModal
          message={
            <>
              Discard draft <strong>{discardTarget.schema_name}</strong> (v{discardTarget.version})?
              {' '}Its predecessor stays exactly as it is — active, attached, unarchived — so the
              lineage returns to the state it was in before the fork. Any device attachments made
              to try this draft out are removed with it. This cannot be undone.
            </>
          }
          requireTyped={discardTarget.schema_name}
          requireTypedLabel="schema name"
          confirmLabel="Discard Draft"
          pendingLabel="Discarding…"
          onConfirm={handleDiscardDraft}
          onCancel={() => setDiscardTarget(null)}
        />
      )}

      {forkTarget && (
        <SchemaForkModal
          schema={forkTarget}
          deviceCount={deviceCountFor(forkTarget.schema_uuid)}
          onConfirm={handleFork}
          onCancel={() => setForkTarget(null)}
        />
      )}

      {/* The drawer's selection is the starting target; the modal's own select still lets it be
          changed, so one payload can be tested against two versions without retyping it. */}
      {showValidateModal && (
        <ValidatePayloadModal
          schemas={schemas}
          initialSchemaUuid={selectedSchema?.schema_uuid}
          onClose={() => setShowValidateModal(false)}
        />
      )}
      {showBuilderModal && <SchemaBuilderModal catalog={catalog} gateways={gateways} onSubmit={handleBuilderSubmit} onCancel={() => setShowBuilderModal(false)} />}
      {deprecateTarget && (
        <DeprecateMetricModal
          metric={deprecateTarget}
          usageCount={usageCountFor(deprecateTarget.name)}
          catalog={catalog}
          onConfirm={handleDeprecate}
          onCancel={() => setDeprecateTarget(null)}
        />
      )}
      </div>

      <ContextPanel
        open={!!selectedSchema}
        onClose={() => setSelectedId(null)}
        type="SCHEMA"
        onCopy={showToast}
        title={selectedSchema?.schema_name || ''}
        subtitle={selectedSchema && (
          <>
            <span className={`badge ${statusBadgeClass(selectedStatus)}`} style={{ fontSize: '11px' }}>
              {statusLabel(selectedStatus)}
            </span>
            <span className="badge badge-neutral" style={{ fontSize: '11px' }}>{schemaVersionLabel(selectedSchema)}</span>
          </>
        )}
        fields={selectedSchema ? [
          { label: 'Schema UUID', value: selectedSchema.schema_uuid, mono: true, copyable: true },
          { label: 'Version', value: schemaVersionLabel(selectedSchema) },
          {
            label: 'Lifecycle',
            value: statusLabel(selectedStatus),
            title: isSchemaEditable(selectedSchema)
              ? 'A draft. This is the only state in which a schema can be edited.'
              : 'Published or archived, and therefore immutable. Fork it to make changes.'
          },
          { label: 'Change Description', value: selectedSchema.change_description || null, full: true },
          {
            label: 'Parent Schema',
            value: selectedSchema.parent_schema_id
              ? (schemas.find(s => s.schema_uuid === selectedSchema.parent_schema_id)?.schema_name || selectedSchema.parent_schema_id)
              : null,
            full: true,
            title: 'The version this one was forked from. Absent on the first version of a lineage.'
          },
          {
            // The chips answer which devices; the action below opens the Devices page filtered to
            // this schema, for when the answer is forty of them.
            label: 'Provisioned Devices',
            value: (() => {
              const attached = devicesForSchema(selectedSchema.schema_uuid)
              if (attached.length === 0) return null
              return (
                <div className="context-device-list">
                  {attached.map(d => (
                    <button
                      key={d.asset_id}
                      className="chip chip-link"
                      onClick={() => onSelectDevice?.(d.asset_id)}
                      title={`Open ${d.asset_name} on the Devices page`}
                    >
                      <IconCpu size={11} />
                      <span className="chip-name">{d.asset_name}</span>
                    </button>
                  ))}
                </div>
              )
            })(),
            full: true,
            title: 'Devices registered against this exact version. Each opens on the Devices page.'
          },
        ] : []}
        actions={selectedSchema ? [
          {
            label: isSchemaEditable(selectedSchema) ? 'Edit Draft' : 'View Schema Detail',
            icon: isSchemaEditable(selectedSchema) ? <IconPencil size={13} /> : <IconFileCode size={13} />,
            onClick: () => setDetailSchema(selectedSchema),
            primary: true,
            title: isSchemaEditable(selectedSchema)
              ? 'Edit this draft version and publish it'
              : 'View this version — its definition, change description and lineage'
          },
          // Offered only on a version that can be forked: a draft is not a lineage head and an
          // archived version is history. Shown disabled where meaningful but blocked, never where
          // meaningless.
          canForkSchema(selectedSchema) && {
            label: `Create Version (v${nextVersion(selectedSchema)})`,
            icon: <IconGitBranch size={13} />,
            onClick: () => setForkTarget(selectedSchema),
            disabled: selectedForkBlocked,
            title: !canManageSchema
              ? 'Requires Admin permissions'
              : selectedDraft
                ? `A draft (${selectedDraft.schema_name}) already exists — publish or discard it first`
                : `Fork this schema into an editable draft at v${nextVersion(selectedSchema)}`
          },
          {
            label: `View ${deviceCountFor(selectedSchema.schema_uuid)} Provisioned Device(s)`,
            icon: <IconCheck size={13} />,
            onClick: () => onSelectSchema?.(selectedSchema.schema_uuid),
            disabled: deviceCountFor(selectedSchema.schema_uuid) === 0,
            title: deviceCountFor(selectedSchema.schema_uuid) === 0
              ? 'No device is provisioned with this schema version'
              : 'Open the Devices page filtered to this schema'
          },
          {
            label: 'Validate Payload', icon: <IconCheck size={13} />,
            onClick: () => setShowValidateModal(true),
            disabled: !selectedSchema.schema_definition,
            title: selectedSchema.schema_definition
              ? `Test a sample telemetry payload against ${schemaVersionLabel(selectedSchema)} of ${selectedSchema.schema_name}`
              : 'This version has no definition to validate against'
          },
          {
            // Was the sole item behind the row's "More" menu. With the Actions column gone this is
            // its only home, and here it costs a line rather than a click to reveal a click.
            label: 'Download Definition (JSON)', icon: <IconDownload size={13} />,
            onClick: () => handleDownloadSchema(selectedSchema),
            disabled: !selectedSchema.schema_definition,
            title: selectedSchema.schema_definition
              ? `Save ${selectedSchema.schema_name}.schema.json to open in an editor or JSON Schema tool`
              : 'This version has no definition to download'
          },
        ].filter(Boolean) : []}
      />
    </div>
  )
}
