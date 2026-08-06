import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { ValidatePayloadModal } from '../modals/ValidatePayloadModal'
import { SchemaBuilderModal } from '../modals/SchemaBuilderModal'
import { SchemaDetailModal } from '../modals/SchemaDetailModal'
import { SchemaForkModal } from '../modals/SchemaForkModal'
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
import { dataPointByName, opcuaSections, opcuaPrefill } from '../../utils/opcua'

// Sentinel for the "not in the list yet" option in the group picker. Not a valid group name --
// the CHECK constraint on metric_groups.name rejects anything containing the separator.
const NEW_GROUP = '__new__'

// "Not in the MTConnect vocabulary". The standard itself allows extension, so this escape has to
// exist -- but it is a deliberate choice rather than the default path.
const CUSTOM_TYPE = '__custom__'

// Separator for the OPC UA type picker's option values. The vocabulary is keyed on
// (companion_spec, name) because Machinery and Robotics both define names like `Manufacturer`, so
// the option value has to carry both or the wrong row is resolved.
const OPCUA_KEY_SEP = '::'

// Extracted because three paths need it: the initial state, a successful add, and cancelling out
// of the form. Duplicating the shape was how a field would get missed from one of the resets.
const BLANK_METRIC = {
  // Which vocabulary the type picker draws from, and the provenance recorded on the metric.
  // MTConnect is the default because it is the largest vocabulary and most metrics come from it.
  standard: STANDARDS.MTCONNECT,
  group: '', newGroup: '', instance: '', type: '', customType: '',
  subType: '', units: '', datatype: 10, description: '',
  // AAS semanticId. ISO 22400 and OPC UA take theirs from the vocabulary row; MTConnect derives
  // one from the composed name. `semanticIdManual` records that the operator has taken the field
  // over, so the derivation stops fighting them from that point on.
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
import { VocabularyPanel } from '../common/VocabularyPanel'
import { mtconnectVocabularyTab } from '../common/MTConnectVocabularyPanel'
import { iso22400VocabularyTab } from '../common/ISO22400VocabularyPanel'
import { opcuaVocabularyTab } from '../common/OPCUAVocabularyPanel'
import {
  IconCheck, IconPlus, IconFileCode, IconAlertTriangle, IconArchive,
  IconChevronDown, IconChevronUp, IconX, IconLock, IconGitBranch, IconPencil, IconDownload
} from '../common/Icons'
import { ActionMenu } from '../common/ActionMenu'

export function SchemasTab({ showToast, hasPermission, onSelectSchema }) {
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
  const [showAddMetric, setShowAddMetric] = useState(false)
  // The metric name is composed from its MTConnect parts rather than typed whole: component
  // ("group"), an optional component instance, the data item type, and an optional subType.
  // NEW_GROUP / CUSTOM_TYPE are the sentinels for "not in the standard vocabulary" -- MTConnect
  // permits extension, so those escapes have to exist.
  const [newMetric, setNewMetric] = useState(BLANK_METRIC)
  const [deprecateTarget, setDeprecateTarget] = useState(null)
  // Expansion state for the catalog's group sections, keyed by group label. Absent means
  // COLLAPSED -- inverted from the original, which stored collapse and opened everything.
  //
  // The catalog outgrew the old default. Unrolled it is a wall of rows that pushes the schema
  // registry below the fold, and the group headers carry a count, so a collapsed catalog still
  // says what is in it. Same treatment the vocabulary panel already had.
  const [expandedGroups, setExpandedGroups] = useState({})
  // Filters the catalog by metric name. It exists BECAUSE the groups now start collapsed:
  // without it, finding one metric means opening each group in turn, which is worse than the
  // wall of rows the collapse was meant to fix.
  const [catalogSearch, setCatalogSearch] = useState('')
  const [showDeprecated, setShowDeprecated] = useState(false)
  // Version lifecycle (migration 0037). `detailSchema` is the version being read or edited;
  // `forkTarget` is the one a new version is being cut from. Two states rather than one mode flag,
  // because forking is reachable both from the table and from inside the detail modal.
  const [detailSchema, setDetailSchema] = useState(null)
  const [forkTarget, setForkTarget] = useState(null)
  // Archived versions are hidden by default -- see isCurrentSchema() for why history interleaved
  // with the working set stops being readable.
  const [showArchivedVersions, setShowArchivedVersions] = useState(false)

  /**
   * A group is open when the operator opened it, OR when a search is narrowing the catalog.
   *
   * The search override is not a convenience. With groups collapsed by default, a search that
   * left them shut would render a list of headers and no matches -- the page would look like it
   * had found nothing, when in fact every row it found is one click away inside a closed
   * section. Auto-expanding is what makes the collapsed default survivable.
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
      const [sch, cat, grp, voc, iso, opc, gw, dev] = await Promise.all([
        api.get('/api/v1/schemas'),
        api.get('/api/v1/metric-catalog'),
        api.get('/api/v1/metric-groups'),
        api.get('/api/v1/mtconnect-vocabulary'),
        api.get('/api/v1/iso22400-vocabulary'),
        api.get('/api/v1/opcua-vocabulary'),
        api.get('/api/v1/gateways'),
        api.get('/api/v1/devices'),
      ])
      setSchemas(sch); setCatalog(cat); setGroups(grp); setVocabulary(voc)
      setIsoVocabulary(iso); setOpcuaVocabulary(opc)
      setGateways(gw); setDevices(dev)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  /**
   * Turn a suggested group name into the two fields the picker needs.
   *
   * A vocabulary can suggest a group this deployment has never registered (OPC UA's `MotionDevice`
   * on a fresh stack, say). The select only lists known groups, so an unknown suggestion has to
   * arrive as "+ New group…" with the name pre-typed rather than as a value with no option behind
   * it, which would silently render blank.
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

  // Clicking a data item type in the vocabulary panel starts a catalog entry from it: open the
  // Add Metric form with the type already chosen, leaving the component and instance -- the parts
  // the standard cannot know -- for the operator.
  const handleUseVocabularyType = (typeName) => {
    setNewMetric(m => ({ ...m, standard: STANDARDS.MTCONNECT, type: typeName, customType: '' }))
    setShowAddMetric(true)
  }

  const handleUseKpi = (kpi) => applyPrefill(iso22400Prefill(kpi))
  const handleUseOpcuaPoint = (point) => applyPrefill(opcuaPrefill(point))

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
   * Switching standard clears everything the previous vocabulary decided.
   *
   * Keeping the type across a switch would leave an MTConnect data item type selected while the
   * form claims ISO 22400 provenance -- and `standard` is what an AAS export reads to decide which
   * namespace a metric belongs to, so a stale value there is a wrong interoperability claim rather
   * than cosmetic. The group and description survive because they are the operator's own input.
   */
  const handleStandardChange = (value) => {
    // The group survives a standard switch when the new standard still offers it -- the operator
    // typed it, and re-picking `Axes` after correcting the standard is pointless friction. But
    // the picker now FILTERS by standard, so a group the new standard does not offer would sit
    // in `newMetric.group` while being absent from the options: the select renders blank, the
    // composed name silently keeps the old prefix, and the metric is created under a group the
    // form appears not to have selected.
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
      // Register the group before the metric that will be the first to use it, so the vocabulary
      // stays complete even if the metric insert is then rejected. A group with no metrics is
      // harmless; a metric whose group nobody can find in the picker is not.
      if (effectiveGroup && !knownGroups.includes(effectiveGroup)) {
        // Carries the standard so the group files under it in the picker rather than under
        // Local -- which, now that the picker filters, would hide it from the very standard it
        // was created for.
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
        // Phase 1 of the AAS alignment (migration 0029). Blank is a legitimate value -- MTConnect
        // publishes no per-type identifier, so those metrics stay unmapped rather than carrying an
        // invented one.
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

  // Counts schemas that model the metric at all, not just those that mark it `required`. This
  // number is the impact warning on a destructive confirmation, so it must not understate: a
  // metric listed in `properties` but not `required` is still broken by deprecating it. Uses the
  // same modelledMetrics() the unmodelled-detection and device tags read, so the three cannot
  // disagree about what a schema covers.
  const usageCountFor = (metricName) =>
    schemas.filter(s => modelledMetrics(s)?.has(metricName)).length

  const deviceCountFor = (schemaUuid) =>
    devices.filter(d =>
      (d.submodel_schema_ids?.length ? d.submodel_schema_ids : [d.schema_id]).includes(schemaUuid)
    ).length

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
        // Provisioning is a prerequisite, not a separate action: the spec sheet has to quote the
        // Sparkplug identifiers the device and gateway will actually publish under, and those are
        // derived from database ids -- so the platform must issue them before it can tell an
        // engineer what to configure. The device name is just the label on the record.
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
   * Fork an active schema into the next draft version.
   *
   * The version number is not sent and there is no field for it: `fork_schema()` derives it from
   * the parent, and `enforce_schema_version_provenance()` refuses an insert that names one. The
   * draft is opened immediately afterwards -- forking with nothing to edit is never the goal, so
   * landing back on the table would just mean a second click to get where the operator was going.
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
      // Rethrown so the modal's publish path does not go on to activate a version whose edits
      // were rejected. A publish that silently dropped the changes it was shown saving would be
      // the worst failure this feature has.
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
   * Download a version's definition as a standalone `.schema.json` file.
   *
   * WRITES THE STORED DOCUMENT VERBATIM -- no wrapper object, no injected `title`, no version
   * banner. It is tempting to enrich it, and wrong: a published version is immutable, so the
   * point of having the file is being able to diff it against what the database holds and against
   * the previous version. Anything added here would show up in every one of those diffs as noise
   * that exists nowhere in the schema. The identity rides on the filename instead, which already
   * carries the version because each version has its own `schema_name` (`Foo_v2`).
   *
   * `.schema.json` rather than `.json`: editors and JSON Schema tooling recognise it, which is the
   * whole reason to open the file somewhere else.
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
  // Superseded versions are history and stay out of the working list until asked for. Drafts do
  // not: an unfinished draft has to stay reachable, because opening it is the only way to finish
  // it. See isCurrentSchema().
  const archivedCount = schemas.filter(s => !isCurrentSchema(s)).length
  const visibleSchemas = showArchivedVersions ? schemas : schemas.filter(isCurrentSchema)
  /**
   * Narrows the catalog by metric name, and by nothing else.
   *
   * Name only, deliberately: it is the immutable wire contract and the thing an operator arrives
   * knowing. Matching description or units as well would return rows whose reason for matching is
   * invisible in the table, which reads as a bug.
   */
  const matchesCatalogSearch = (m) =>
    !catalogSearch || (m.name || '').toLowerCase().includes(catalogSearch.trim().toLowerCase())

  const activeCatalog = catalog.filter(m => !m.deprecated).filter(matchesCatalogSearch)
  const deprecatedCatalog = catalog.filter(m => m.deprecated).filter(matchesCatalogSearch)
  // Grouped by the first dotted segment of the name; ungrouped metrics fall into a trailing
  // bucket rather than being hidden. Deprecated metrics stay a flat tail -- they are retired,
  // so filing them by category would just add noise to every group.
  const catalogGroups = groupCatalog(activeCatalog)

  // The vocabulary the picker offers: the curated registry (now MTConnect's component types)
  // plus anything already in use.
  const knownGroups = knownGroupNames(groups, catalog)
  // Narrowed to the selected standard, plus local groups -- 126 MTConnect component types in
  // one flat list is not navigable, and offering ISO 22400's KPI families while the form is set
  // to MTConnect invites a group that contradicts the metric's own provenance.
  const groupOptions = groupOptionsForStandard(groups, catalog, newMetric.standard)
  const effectiveGroup = newMetric.group === NEW_GROUP
    ? canonicaliseGroup(newMetric.newGroup, knownGroups)
    : newMetric.group

  const isMTConnect = newMetric.standard === STANDARDS.MTCONNECT
  const isIso = newMetric.standard === STANDARDS.ISO22400
  const isOpcua = newMetric.standard === STANDARDS.OPCUA
  const isCustomStandard = newMetric.standard === STANDARDS.CUSTOM

  // Only MTConnect offers a "not in the vocabulary" escape inside the type picker. The other two
  // have the Custom *standard* for that, which is the more honest place for it: a data point that
  // is not in OPC UA is not an OPC UA data point, whereas MTConnect explicitly permits extending
  // its type list while staying MTConnect.
  const usingCustomType = isMTConnect && newMetric.type === CUSTOM_TYPE
  const effectiveType = (usingCustomType || isCustomStandard)
    ? newMetric.customType.trim()
    : newMetric.type

  // Provenance actually recorded. A custom MTConnect type is a local extension, so it drops the
  // MTConnect claim even though the form was on the MTConnect tab.
  const effectiveStandard = (isCustomStandard || usingCustomType) ? STANDARDS.CUSTOM : newMetric.standard

  // MTConnect assigns each data item type a category, so it is derived rather than offered. ISO
  // 22400 and OPC UA supply theirs with the vocabulary entry (utils/iso22400, utils/opcua), which
  // is why the prefill carries it. A local extension has none until someone says otherwise.
  const effectiveCategory = isMTConnect
    ? (usingCustomType ? '' : categoryOfType(vocabulary, effectiveType))
    : newMetric.vocabCategory

  // For MTConnect, only SAMPLE is a continuously-varying measurement, so only SAMPLE carries
  // units. The other standards state the unit on the vocabulary entry itself, so the field stays
  // available for them regardless of the category the entry maps onto.
  const unitsApply = isMTConnect ? effectiveCategory === CATEGORY_WITH_UNITS : true
  const typeGroups = typesByCategory(vocabulary)
  const availableSubTypes = subTypes(vocabulary)
  const isoKpis = kpis(isoVocabulary)
  const opcuaGroups = opcuaSections(opcuaVocabulary)
  // The MTConnect UnitEnum, plus whatever the current selection prefilled if that is not in it.
  // ISO 22400 measures MTBF in HOUR and OPC UA carries UNECE codes, neither of which MTConnect
  // guarantees to list -- without this the select would silently show blank for a unit the
  // vocabulary had just supplied.
  const mtconnectUnits = unitNames(vocabulary)
  const availableUnits = newMetric.units && !mtconnectUnits.includes(newMetric.units)
    ? [newMetric.units, ...mtconnectUnits]
    : mtconnectUnits
  // Typing a case variant of an established group resolves to the established spelling. Surfaced
  // before submitting, because the database rejects the fork outright and discovering that as an
  // error is a worse experience than being told up front.
  const groupCaseCollision =
    newMetric.group === NEW_GROUP &&
    newMetric.newGroup.trim() !== '' &&
    effectiveGroup !== newMetric.newGroup.trim()
  // One composer for all three standards, so every name a group derivation has to read is built
  // the same way. The subType segment only exists for MTConnect -- an ISO KPI or an OPC UA browse
  // name is a whole concept with no qualifier to append.
  const composedName = composeMetricName(
    effectiveGroup,
    newMetric.instance,
    effectiveType,
    isMTConnect ? newMetric.subType : ''
  )
  // MTConnect metrics get an id derived from the name they will publish under, in this
  // deployment's own namespace (see utils/standards.js for why local rather than mtconnect.org).
  // It tracks the name as the form is filled in, and stops the moment the operator types their
  // own -- an id that overwrote a hand-entered crosswalk on the next keystroke would be worse
  // than no prefill at all.
  // Gated on the type being chosen, not merely on the name being non-empty: with only a group
  // picked the composed name is `OEE`, and an id derived from that names a group rather than a
  // metric. Nothing is derived until there is a metric to derive it from.
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

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Factory+ Schema Registry <span className="section-count">{schemas.length}</span></h2>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowValidateModal(true)} disabled={schemas.length === 0} title="Test sample telemetry payload against registered schema rules">
            <IconCheck size={14} /> Validate Candidate Payload
          </button>
          {/* The only way to create a schema. "Register New Schema" used to sit beside this,
              taking a raw JSON Schema document as free text -- which meant a schema could name
              metrics that were not in the catalog, had no standard, and carried no semantic id.
              Every derived feature reads schemas: device tags, unmodelled detection, the tag
              filters on three pages. Building from the catalog is what guarantees those inputs
              exist, so it is now the single path rather than the more careful of two. */}
          <button
            className={`btn btn-primary btn-sm ${!canManageSchema ? 'btn-disabled' : ''}`}
            disabled={!canManageSchema}
            onClick={() => canManageSchema && setShowBuilderModal(true)}
            title={!canManageSchema ? 'Requires Admin permissions' : 'Build a schema from the metric catalog, then download a spec sheet or provision a device'}
          >
            <IconFileCode size={14} /> Build Schema from Catalog
          </button>
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Centralized JSON Schema Registry for defining, registering, and interactively validating telemetry payload data structures against industrial standards.
      </p>

      <div className="card" style={{ marginBottom: '24px' }}>
        {/* `.card-header`, not `.section-header`: the card has no padding of its own, so a plain
            section header would sit flush against its borders. */}
        <div className="card-header">
          <h3 className="section-title">Metric Catalog <span className="section-count">{activeCatalog.length}</span></h3>
          {/* Sits beside Add Metric because the groups now start collapsed: search is how you
              reach a known metric without opening every section. Typing auto-expands the groups
              that matched -- see isGroupOpen(). */}
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

        <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '12px 20px 0' }}>
          Metrics are grouped by the first segment of their name — <span className="mono">Axes/C/ANGLE</span> and{' '}
          <span className="mono">Axes/X/POSITION</span> both belong to <strong>Axes</strong>. The <span className="mono">/</span>{' '}
          separator is the one Sparkplug B uses for its own names (<span className="mono">Node Control/Rebirth</span>),
          and the one Factory+ and MTConnect use for component paths. The group is part of the name a device publishes,
          so it is visible in MQTT, TimescaleDB and Grafana, and — like the name itself — cannot be edited afterwards.
          Names without a separator are listed under <strong>Ungrouped</strong>.
        </p>

        {showAddMetric && (
          <div style={{ margin: '16px 20px', padding: '12px', background: 'var(--bg-glass)', borderRadius: 'var(--radius)' }}>
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
                  onChange={e => setNewMetric(m => ({ ...m, group: e.target.value }))}
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

              {/* One slot, three vocabularies. Which one fills it is the Standard selector's only
                  job, so the label changes with it rather than staying generic and leaving the
                  operator to work out what a "type" means for a KPI. */}
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

              {/* AAS Phase 1. Prefilled from the vocabulary for ISO 22400 and OPC UA, and derived
                  from the composed name for MTConnect; editable in every case, because a semantic
                  id is an assertion about the metric and assertions get corrected. */}
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

            {/* The database says the same thing (metric_catalog_name_format, migration 0007), but
                a 400 after pressing Add is a poor way to learn it -- and the name is immutable, so
                there is no correcting it afterwards either. */}
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
          <div className="empty-state" style={{ padding: '24px 20px' }}>
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
                  <tr>
                    <td colSpan={8} style={{ background: 'var(--bg-glass)', padding: 0, borderTop: '1px solid var(--border)' }}>
                      {/* Whole header row is the control, same as the vocabulary panel's sections. */}
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.label)}
                        aria-expanded={open}
                        style={{
                          width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
                          padding: '6px 12px', background: 'none', border: 'none',
                          cursor: 'pointer', color: 'inherit', textAlign: 'left', font: 'inherit'
                        }}
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
                          <span style={{ fontSize: '10px', color: 'var(--text-dim)', marginLeft: '6px', fontStyle: 'italic' }} title="Local extension — not drawn from a standard vocabulary">
                            local
                          </span>
                        )}
                      </td>
                      <td>
                        {m.standard
                          ? <span className="badge badge-neutral" style={{ fontSize: '10px' }} title={`Named from the ${m.standard} vocabulary`}>{m.standard}</span>
                          : <span style={{ color: 'var(--text-dim)', fontSize: '11px' }}>{LOCAL_EXTENSION_LABEL}</span>}
                      </td>
                      <td>
                        {m.category
                          ? <span className="badge badge-neutral" style={{ fontSize: '10px' }} title={`MTConnect ${m.category} observation`}>{m.category}</span>
                          : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{m.units || '—'}</td>
                      <td>{datatypeLabel(m.datatype)}</td>
                      {/* Capped and scrollable: a semantic id is a full IRI, and `.table-wrap`
                          scrolls horizontally, so an unconstrained cell pushes the Deprecate
                          button off-screen. Same lesson as the quarantine payload cell. */}
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

              {/* Deprecated metrics get a section of their own, collapsed by default: they are
                  retired, so they are context rather than the working set. Rendered only when
                  some exist, so the header is never an empty promise. */}
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
                    <td className="mono" style={{ fontSize: '10px', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.semantic_id || ''}>
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

      {/* One reference card for all three standards, below the catalog: the catalog is this
          deployment's state and comes first, the standards behind it follow. Tab order is by size —
          MTConnect is ~600 entries and the one most metrics come from, then the two smaller
          specialised ones. */}
      {!loading && (
        <VocabularyPanel
          title="Standard Vocabulary Reference"
          canAddMetric={canManageSchema}
          tabs={[
            mtconnectVocabularyTab({
              vocabulary, catalog, onUseType: handleUseVocabularyType
            }),
            iso22400VocabularyTab({
              vocabulary: isoVocabulary, catalog, onUseKpi: handleUseKpi
            }),
            opcuaVocabularyTab({
              vocabulary: opcuaVocabulary, catalog, onUsePoint: handleUseOpcuaPoint
            })
          ]}
        />
      )}

      <div className="card">
        <div className="card-header">
          <h3 className="section-title">
            Registered Schemas <span className="section-count">{visibleSchemas.length}</span>
          </h3>
          {archivedCount > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              aria-expanded={showArchivedVersions}
              onClick={() => setShowArchivedVersions(v => !v)}
              title={showArchivedVersions
                ? 'Hide superseded versions'
                : `Show the ${archivedCount} archived version${archivedCount === 1 ? '' : 's'} kept as history`}
            >
              {showArchivedVersions ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
              {' '}Archived Versions <span className="section-count">{archivedCount}</span>
            </button>
          )}
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '12px 20px 0' }}>
          A published schema is <strong>read-only</strong>. Devices are provisioned against the exact metric names it
          models, so changing one in place would silently redefine the contract a fleet is judged against. Changes are
          made by creating the next version — <span className="mono">v1 → v2 → v3</span> — which forks the definition into
          an editable draft. Publishing a draft activates it, archives its predecessor, and moves every device across in
          one transaction. Version numbers are assigned by the database and cannot be chosen.
        </p>
        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading schemas…</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th title="Schema descriptive name">Schema Name</th><th title="Lineage position and lifecycle state. Only a draft is editable.">Version</th><th title="Why this version exists, recorded when it was created">Change Description</th><th title="Schema unique UUID">Schema UUID</th><th title="Devices provisioned with this schema">Devices</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              <tbody>
                {visibleSchemas.map(sch => {
                  const count = deviceCountFor(sch.schema_uuid)
                  const status = schemaStatus(sch)
                  const draft = schemas.find(s =>
                    s.parent_schema_id === sch.schema_uuid && schemaStatus(s) === SCHEMA_STATUS.DRAFT
                  )
                  const forkBlocked = !canManageSchema || !!draft
                  return (
                    <tr key={sch.schema_uuid} style={status === SCHEMA_STATUS.ARCHIVED ? { opacity: 0.6 } : undefined}>
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
                          horizontally, so an unbounded cell pushes the action buttons off-screen.
                          Third time this table shape has taught that lesson. */}
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
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setDetailSchema(sch)}
                          title={isSchemaEditable(sch)
                            ? 'Edit this draft version and publish it'
                            : 'View this version — its definition, change description and lineage'}
                        >
                          {isSchemaEditable(sch) ? <><IconPencil size={12} /> Edit Draft</> : <>View</>}
                        </button>
                        {/* One primary action per published version. Disabled with a reason rather
                            than hidden, so "why can I not change this?" is answerable in place. */}
                        {canForkSchema(sch) && (
                          <button
                            className={`btn btn-primary btn-sm ${forkBlocked ? 'btn-disabled' : ''}`}
                            style={{ marginLeft: '6px' }}
                            disabled={forkBlocked}
                            onClick={() => !forkBlocked && setForkTarget(sch)}
                            title={!canManageSchema
                              ? 'Requires Admin permissions'
                              : draft
                                ? `A draft (${draft.schema_name}) already exists — publish or discard it first`
                                : `Fork this schema into an editable draft at v${nextVersion(sch)}`}
                          >
                            <IconGitBranch size={12} /> Create Version (v{nextVersion(sch)})
                          </button>
                        )}
                        {/* Download lives in the overflow menu, not beside the other two. It is a
                            secondary action, and this is the row shape Devices and Gateways
                            already use -- two primary controls visible, everything else behind
                            "More". That rule exists because the Devices cell reached seven
                            buttons one feature at a time; the menu is where the next schema
                            action goes, so this one starts it rather than adding a third button. */}
                        <span style={{ marginLeft: '6px', display: 'inline-block', verticalAlign: 'middle' }}>
                          <ActionMenu
                            label="More"
                            testId={`schema-actions-${sch.schema_uuid}`}
                            items={[
                              {
                                key: 'download',
                                icon: <IconDownload size={13} />,
                                label: 'Download definition (JSON)',
                                title: sch.schema_definition
                                  ? `Save ${sch.schema_name}.schema.json to open in an editor or JSON Schema tool`
                                  : 'This version has no definition to download',
                                disabled: !sch.schema_definition,
                                onClick: () => handleDownloadSchema(sch)
                              }
                            ]}
                          />
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Keyed on the schema UUID so switching between versions remounts the modal. Without it,
          the editor's seeded state (which metrics are ticked) would survive the switch and the
          operator would be editing v3 while looking at v2's metric set. */}
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
          onClose={() => setDetailSchema(null)}
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

      {showValidateModal && <ValidatePayloadModal schemas={schemas} onClose={() => setShowValidateModal(false)} />}
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
    </>
  )
}
