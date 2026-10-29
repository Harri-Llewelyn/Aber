import React, { useState, useMemo } from 'react'
import { IconFileCode } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { usePendingAction } from '../../hooks/usePendingAction'
import { datatypeLabel, datatypeToJsonSchemaType } from '../../utils/sparkplugDatatype'
import { catalogPropertyEntry, isNumericType, rangeError } from '../../utils/schemaProperty'
import { groupCatalog } from '../../utils/metricGroup'
import { STANDARD_OPTIONS, LOCAL_EXTENSION_LABEL } from '../../utils/standards'
import { Modal } from '../common/Modal'
import { SemanticIdField } from '../common/SemanticIdField'
import { Tooltip } from '../common/Tooltip'

/** Sentinel for the standard filter's default. Not a `standard` value -- '' means local extension. */
const ANY_STANDARD = '__any__'

/** Border treatment for a field a save attempt found empty, or a range that cannot be saved. */
const INVALID_FIELD = { borderColor: 'var(--danger)' }

/** A metric picker's row, shared with a draft's editor: the label with its tick, then any range. */
export const PICKER_ROW = { display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--border)' }
export const PICKER_ROW_LABEL = {
  display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 auto', minWidth: 0, padding: '8px 12px', cursor: 'pointer'
}

/** The asterisk beside a label that must be filled in, with the convention spelled out on hover. */
function RequiredMark() {
  return (
    <Tooltip text="Required: the schema cannot be saved without it">
      <span style={{ color: 'var(--danger)', marginLeft: '3px' }} aria-hidden="true">*</span>
    </Tooltip>
  )
}

/** What a save attempt found missing, beneath the field it is about. */
function FieldError({ children }) {
  return (
    <div role="alert" style={{ fontSize: '11px', color: 'var(--danger)', marginTop: '4px' }}>
      {children}
    </div>
  )
}

/**
 * A group's band in a metric picker: the group's name, and how many of its listed metrics are
 * ticked once any are. Pinned to the top of the list while its metrics are in view.
 */
export function MetricGroupHeading({ group, picked, title }) {
  return (
    <Tooltip text={title}>
      <div className="metric-picker-group">
        <span className={`table-group-label${group.isUngrouped ? ' table-group-label-muted' : ''}`}>
          {group.label}
        </span>
        {picked > 0 && <span className="metric-picker-group-selected">{picked} selected</span>}
      </div>
    </Tooltip>
  )
}

const RANGE_HELP = 'The valid range of this reading in this schema. A device set to Enforce drops a '
  + 'reading outside it. Leave a side blank for no bound.'

/** A range as nobody has typed it. */
export const NO_RANGE = { minimum: '', maximum: '' }

/**
 * A numeric property's valid range, beside its row while it is ticked: what the schema writes as
 * `minimum` and `maximum`. Shared by the builder and a draft's editor. `range` is the typed
 * `{ minimum, maximum }`; `onChange` receives the next one.
 */
export function PropertyRange({ name, range, onChange }) {
  const error = rangeError(range)
  const field = (key, label, placeholder) => (
    <input
      type="number"
      step="any"
      className="form-control"
      aria-label={`${label} of ${name}`}
      placeholder={placeholder}
      value={range[key]}
      onChange={e => onChange({ ...range, [key]: e.target.value })}
      aria-invalid={error ? true : undefined}
      style={{ width: '84px', padding: '4px 8px', fontSize: '12px', ...(error ? INVALID_FIELD : {}) }}
    />
  )
  return (
    <Tooltip text={error || RANGE_HELP}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flex: '0 0 auto' }}>
        {field('minimum', 'Minimum', 'min')}
        <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>–</span>
        {field('maximum', 'Maximum', 'max')}
      </span>
    </Tooltip>
  )
}

/** "Name: what is wrong" for each range that cannot be saved, or [] when all can. */
export const rangeProblems = (entries) =>
  entries.map(([name, range]) => [name, rangeError(range)]).filter(([, error]) => error)
    .map(([name, error]) => `${name}: ${error}`)

/**
 * Build a schema from catalog metrics. Each metric's entry carries its type, and the catalog's
 * description and permitted values (as `enum`); a numeric one takes the range typed beside it. It
 * does this and nothing else: a device is given its schema on the Devices page, where the rest of
 * what a device needs -- its gateway, its cell, its conformance policy -- is also decided.
 */
export function SchemaBuilderModal({ catalog, onSubmit, onCancel }) {
  const [schemaName, setSchemaName] = useState('')
  const [description, setDescription] = useState('')
  const [search, setSearch] = useState('')
  const [standard, setStandard] = useState(ANY_STANDARD)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [semanticId, setSemanticId] = useState('')
  const [semanticIdType, setSemanticIdType] = useState('')
  // Metric name -> the range typed beside it. Kept when the metric is unticked, so ticking it again
  // brings the range back; only ticked metrics are written.
  const [ranges, setRanges] = useState({})
  // Set by a save attempt, not by typing: a form that turns red while a name is half-typed accuses
  // the reader of an error they are in the middle of not making.
  const [showRequired, setShowRequired] = useState(false)

  const activeCatalog = useMemo(() => (catalog || []).filter(m => !m.deprecated), [catalog])

  // The standard filter narrows what is listed, never what is selected: a schema legitimately mixes
  // standards, such as ISO KPIs beside the MTConnect observations they are computed from.
  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase()
    return activeCatalog.filter(m => {
      if (standard !== ANY_STANDARD && (m.standard || '') !== standard) return false
      if (!q) return true
      return m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q)
    })
  }, [activeCatalog, search, standard])

  const toggleMetric = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const selectedMetrics = activeCatalog.filter(m => selectedIds.has(m.metric_uuid))
  const takesRange = (m) => isNumericType(datatypeToJsonSchemaType(m.datatype))
  const rangeOf = (name) => ranges[name] || NO_RANGE
  const badRanges = rangeProblems(selectedMetrics.filter(takesRange).map(m => [m.name, ranges[m.name]]))

  // What is missing, in the order the fields appear, so the summary reads down the form. A schema
  // with no metrics constrains nothing, which is why the picker is required rather than merely
  // usual.
  const missing = [
    schemaName.trim() ? null : 'a name',
    selectedMetrics.length ? null : 'at least one metric',
    badRanges.length ? 'a valid range' : null
  ].filter(Boolean)
  const canSave = missing.length === 0
  const nameMissing = showRequired && !schemaName.trim()
  const metricsMissing = showRequired && selectedMetrics.length === 0

  const buildSchemaPayload = () => {
    const properties = {}
    selectedMetrics.forEach(m => {
      properties[m.name] = catalogPropertyEntry(m, { range: takesRange(m) ? ranges[m.name] : undefined })
    })
    return {
      schema_name: schemaName,
      description,
      // No `required`: a DDATA carries only the metrics that changed, so no single payload is the
      // instance JSON Schema's `required` describes. `properties` is what the schema models.
      schema_definition: {
        type: 'object',
        properties
      },
      // The AAS Submodel this schema corresponds to, if it is a known one (an IDTA submodel
      // template id). Optional: most schemas are local compositions.
      semantic_id: semanticId.trim(),
      semantic_id_type: semanticIdType
    }
  }

  const [submitting, runSubmit] = usePendingAction()

  /* Save stays clickable while the form is incomplete, and the click is what reveals what is
     missing. A disabled button cannot be clicked, so it cannot answer the question a reader who has
     just tried to save is actually asking. */
  const handleSave = () => {
    if (!canSave) { setShowRequired(true); return }
    runSubmit(() => onSubmit(buildSchemaPayload()))
  }

  return (
    // Wide, not the bare `.modal`: a two-column list of metric name against description, and the
    // description is what a reader chooses on.
    <Modal
      title="Build Schema from Catalog"
      icon={<IconFileCode size={18} />}
      size="wide"
      fill
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={submitting}>Cancel</button>
          {/* Never disabled while the form is incomplete: the click is what tells a reader what is
              missing, and a disabled button cannot be clicked. */}
          <ActionButton
            className="btn btn-primary"
            pending={submitting}
            pendingLabel="Saving…"
            onClick={handleSave}
            title={canSave ? undefined : `Still needed: ${missing.join(" and ")}`}
          >
            Save Schema
          </ActionButton>
        </>
      }
    >
      <div className="form-group">
        <label className="form-label" htmlFor="schema-builder-name">
          Schema Name <RequiredMark />
        </label>
        <input
          id="schema-builder-name"
          className="form-control"
          style={nameMissing ? INVALID_FIELD : undefined}
          aria-invalid={nameMissing || undefined}
          value={schemaName}
          onChange={e => setSchemaName(e.target.value)}
          placeholder="e.g. Six-Axis-Robot-Arm-Standard"
        />
        {nameMissing && <FieldError>Give the schema a name before saving it.</FieldError>}
      </div>

      <div className="form-group">
        <label className="form-label">Description</label>
        <input className="form-control" value={description} onChange={e => setDescription(e.target.value)} placeholder="What this schema is for" />
      </div>

      <SemanticIdField
        idPrefix="schema-builder"
        subject="schema"
        semanticId={semanticId}
        semanticIdType={semanticIdType}
        onChange={({ semanticId: id, semanticIdType: type }) => {
          setSemanticId(id)
          setSemanticIdType(type)
        }}
      />

      <div className="form-group modal-fill" style={{ display: 'flex', flexDirection: 'column', minHeight: '260px' }}>
        <label className="form-label">
          Metrics <RequiredMark />
          <span className="section-count">{selectedMetrics.length} selected</span>
        </label>
        {metricsMissing && <FieldError>Tick at least one metric. A schema with none constrains nothing.</FieldError>}
        {showRequired && badRanges.length > 0 && <FieldError>Fix the range of {badRanges.join(' ')}</FieldError>}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
          <input
            className="form-control"
            style={{ flex: '1 1 auto' }}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search catalog metrics…"
          />
          {/* Filters the list only; selections survive a change here. */}
          <Tooltip text="Metrics already selected stay selected.">
            <select
              className="form-control"
              style={{ flex: '0 0 165px' }}
              value={standard}
              onChange={e => setStandard(e.target.value)}
              aria-label="Standard"
            >
              <option value={ANY_STANDARD}>All standards</option>
              {STANDARD_OPTIONS.map(o => (
                <option key={o.label} value={o.value}>
                  {o.value === '' ? LOCAL_EXTENSION_LABEL : o.label}
                </option>
              ))}
            </select>
          </Tooltip>
        </div>
        {/* Takes the height the fields above leave, and scrolls inside itself. */}
        <div style={{ flex: '1 1 auto', minHeight: '160px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          {filteredCatalog.length === 0 ? (
            <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>No matching catalog metrics.</div>
          ) : (
            // Grouped as on the Metrics page, and applied to the search results so a filtered list
            // stays navigable.
            groupCatalog(filteredCatalog).map(group => (
              <div key={group.label}>
                <MetricGroupHeading
                  group={group}
                  picked={group.metrics.filter(m => selectedIds.has(m.metric_uuid)).length}
                  title={group.isUngrouped ? 'Metric names carrying no "Group/Metric" prefix' : `Metrics named "${group.label}/…"`}
                />
                {group.metrics.map(m => {
                  const ticked = selectedIds.has(m.metric_uuid)
                  return (
                    // The range sits outside the label, so typing in it never toggles the tick.
                    <div key={m.metric_uuid} style={{ ...PICKER_ROW, paddingRight: ticked && takesRange(m) ? '12px' : 0 }}>
                      <label style={PICKER_ROW_LABEL}>
                        <input type="checkbox" checked={ticked} onChange={() => toggleMetric(m.metric_uuid)} />
                        <span className="mono" style={{ fontSize: '12px' }}>{m.name}</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{datatypeLabel(m.datatype)}</span>
                        {/* Which standard a metric came from is what makes a mixed-standard schema
                            legible; the tick marks the ones carrying an AAS semantic id. */}
                        <Tooltip text={m.semantic_id ? `Semantic id ${m.semantic_id}` : null}>
                          <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                            {m.standard || LOCAL_EXTENSION_LABEL}{m.semantic_id ? ' ✓' : ''}
                          </span>
                        </Tooltip>
                        {m.description && <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 'auto' }}>{m.description}</span>}
                      </label>
                      {ticked && takesRange(m) && (
                        <PropertyRange
                          name={m.name}
                          range={rangeOf(m.name)}
                          onChange={range => setRanges(prev => ({ ...prev, [m.name]: range }))}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  )
}
