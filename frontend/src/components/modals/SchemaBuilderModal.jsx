import React, { useState, useMemo } from 'react'
import { IconFileCode } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { usePendingAction } from '../../hooks/usePendingAction'
import { datatypeLabel, datatypeToJsonSchemaType } from '../../utils/sparkplugDatatype'
import { groupCatalog } from '../../utils/metricGroup'
import {
  STANDARD_OPTIONS, SEMANTIC_ID_TYPES, inferSemanticIdType, LOCAL_EXTENSION_LABEL
} from '../../utils/standards'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { HelpTip } from '../common/HelpTip'

/** Sentinel for the standard filter's default. Not a `standard` value -- '' means local extension. */
const ANY_STANDARD = '__any__'

/** Border and text treatment for a field a save attempt found empty. */
const INVALID_FIELD = { borderColor: 'var(--danger)' }

/** The asterisk beside a label that must be filled in, with the convention spelled out on hover. */
function RequiredMark() {
  return (
    <span style={{ color: 'var(--danger)', marginLeft: '3px' }} title="Required — the schema cannot be saved without it" aria-hidden="true">*</span>
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

const SEMANTIC_ID_HELP = 'The identifier of the standard Submodel this schema corresponds to, so an '
  + 'AAS consumer can recognise it as, say, a Digital Nameplate rather than a set of metric names '
  + 'only this platform understands. Use the published id of an IDTA submodel template, for example '
  + 'https://admin-shell.io/idta/nameplate/3/0/Nameplate.\n\n'
  + 'Leave it blank for a schema you have composed yourself, which is most of them: a local '
  + 'composition matches no published template, and claiming one it does not match is worse than '
  + 'claiming none.\n\n'
  + 'The type beside it says how to read the id — IRI for a URL, IRDI for an ECLASS or IEC code, '
  + 'ModelReference for a pointer to another element in this shell. It is guessed from what you '
  + 'type and can be corrected.'

/**
 * Build a schema from catalog metrics. It does this and nothing else: a device is given its schema
 * on the Devices page, where the rest of what a device needs -- its gateway, its cell, its
 * conformance policy -- is also decided.
 */
export function SchemaBuilderModal({ catalog, onSubmit, onCancel }) {
  // Escape closes through the shared stack, so a ConfirmModal opened on top takes the keypress.
  useEscapeKey(onCancel)

  const [schemaName, setSchemaName] = useState('')
  const [description, setDescription] = useState('')
  const [search, setSearch] = useState('')
  const [standard, setStandard] = useState(ANY_STANDARD)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [semanticId, setSemanticId] = useState('')
  const [semanticIdType, setSemanticIdType] = useState('')
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

  // What is missing, in the order the fields appear, so the summary reads down the form. A schema
  // with no metrics constrains nothing, which is why the picker is required rather than merely
  // usual.
  const missing = [
    schemaName.trim() ? null : 'a name',
    selectedMetrics.length ? null : 'at least one metric'
  ].filter(Boolean)
  const canSave = missing.length === 0
  const nameMissing = showRequired && !schemaName.trim()
  const metricsMissing = showRequired && selectedMetrics.length === 0

  const buildSchemaPayload = () => {
    const properties = {}
    selectedMetrics.forEach(m => {
      properties[m.name] = { type: datatypeToJsonSchemaType(m.datatype) }
    })
    return {
      schema_name: schemaName,
      description,
      schema_definition: {
        type: 'object',
        properties,
        required: selectedMetrics.map(m => m.name)
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
    <div className="modal-overlay">
      {/* Wide, not the bare `.modal`: a two-column list of metric name against description, and the
          description is what a reader chooses on. */}
      <div className="modal modal-wide">
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconFileCode size={18} />
          <span>Build Schema from Catalog</span>
        </div>

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
            title="Unique schema name"
          />
          {nameMissing && <FieldError>Give the schema a name before saving it.</FieldError>}
        </div>

        <div className="form-group">
          <label className="form-label">Description</label>
          <input className="form-control" value={description} onChange={e => setDescription(e.target.value)} placeholder="What this schema is for" />
        </div>

        <div className="form-group">
          {/* The tip is a sibling of the label, never a child: a button inside a label answers to
              the label's name too, and the field stops being the only thing that does. */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '7px' }}>
            <label className="form-label" style={{ marginBottom: 0 }} htmlFor="schema-builder-semantic-id">
              Semantic ID <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>(optional)</span>
            </label>
            <HelpTip text={SEMANTIC_ID_HELP} label="What a semantic ID is for" />
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              id="schema-builder-semantic-id"
              className="form-control mono"
              style={{ flex: '1 1 auto', fontSize: '11px' }}
              value={semanticId}
              onChange={e => {
                setSemanticId(e.target.value)
                setSemanticIdType(t => t || inferSemanticIdType(e.target.value))
              }}
              placeholder="e.g. https://admin-shell.io/idta/SubmodelTemplate/…"
              title="AAS (IEC 63278) semanticId for the Submodel this schema corresponds to."
            />
            <select
              className="form-control"
              style={{ flex: '0 0 140px' }}
              value={semanticIdType}
              onChange={e => setSemanticIdType(e.target.value)}
              title="Which kind of AAS Reference the semantic id is"
            >
              <option value="">— None —</option>
              {SEMANTIC_ID_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">
            Metrics <RequiredMark />
            <span className="section-count">{selectedMetrics.length} selected</span>
          </label>
          {metricsMissing && <FieldError>Tick at least one metric. A schema with none constrains nothing.</FieldError>}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <input
              className="form-control"
              style={{ flex: '1 1 auto' }}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search catalog metrics…"
            />
            {/* Filters the list only; selections survive a change here. */}
            <select
              className="form-control"
              style={{ flex: '0 0 165px' }}
              value={standard}
              onChange={e => setStandard(e.target.value)}
              title="Show only metrics named from one standard. Metrics already selected stay selected."
            >
              <option value={ANY_STANDARD}>All standards</option>
              {STANDARD_OPTIONS.map(o => (
                <option key={o.label} value={o.value}>
                  {o.value === '' ? LOCAL_EXTENSION_LABEL : o.label}
                </option>
              ))}
            </select>
          </div>
          {/* Scales with the viewport but stays capped, since `.modal` caps its own height and an
              uncapped list would move the scrollbar outwards and take the search box off screen. */}
          <div style={{ maxHeight: 'min(46vh, 440px)', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            {filteredCatalog.length === 0 ? (
              <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>No matching catalog metrics.</div>
            ) : (
              // Grouped the same way as the Schemas page catalog table. Grouping applies to the
              // search results, so a filtered list stays navigable.
              groupCatalog(filteredCatalog).map(group => (
                <div key={group.label}>
                  <div
                    style={{ position: 'sticky', top: 0, background: 'var(--bg-glass)', backdropFilter: 'blur(4px)', padding: '5px 12px', borderBottom: '1px solid var(--border)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: group.isUngrouped ? 'var(--text-muted)' : 'var(--accent)' }}
                    title={group.isUngrouped ? 'Metric names carrying no "Group/Metric" prefix' : `Metrics named "${group.label}/…"`}
                  >
                    {group.label} <span style={{ opacity: 0.7 }}>({group.metrics.length})</span>
                  </div>
                  {group.metrics.map(m => (
                    <label key={m.metric_uuid} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={selectedIds.has(m.metric_uuid)} onChange={() => toggleMetric(m.metric_uuid)} />
                      <span className="mono" style={{ fontSize: '12px' }}>{m.name}</span>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{datatypeLabel(m.datatype)}</span>
                      {/* Which standard a metric came from is what makes a mixed-standard schema
                          legible; the tick marks the ones carrying an AAS semantic id. */}
                      <span
                        style={{ fontSize: '11px', color: 'var(--text-dim)' }}
                        title={m.semantic_id ? `${m.standard || LOCAL_EXTENSION_LABEL} — semantic id ${m.semantic_id}` : (m.standard || LOCAL_EXTENSION_LABEL)}
                      >
                        {m.standard || LOCAL_EXTENSION_LABEL}{m.semantic_id ? ' ✓' : ''}
                      </span>
                      {m.description && <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 'auto' }}>{m.description}</span>}
                    </label>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={submitting} title="Discard and close">Cancel</button>
          {/* Never disabled while the form is incomplete: the click is what tells a reader what is
              missing, and a disabled button cannot be clicked. */}
          <ActionButton
            className="btn btn-primary"
            pending={submitting}
            pendingLabel="Saving…"
            onClick={handleSave}
            title={canSave ? "Save this schema" : `Still needed: ${missing.join(" and ")}`}
          >
            Save Schema
          </ActionButton>
        </div>
      </div>
    </div>
  )
}
