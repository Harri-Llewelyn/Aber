import React, { useState, useMemo } from 'react'
import { IconFileCode, IconDownload } from '../common/Icons'
import { datatypeLabel, datatypeToJsonSchemaType } from '../../utils/sparkplugDatatype'
import { groupCatalog } from '../../utils/metricGroup'
import {
  STANDARD_OPTIONS, SEMANTIC_ID_TYPES, inferSemanticIdType, LOCAL_EXTENSION_LABEL
} from '../../utils/standards'

/** Sentinel for the standard filter's default. Not a `standard` value -- '' means local extension. */
const ANY_STANDARD = '__any__'

export function SchemaBuilderModal({ catalog, gateways, onSubmit, onCancel }) {
  const [schemaName, setSchemaName] = useState('')
  const [description, setDescription] = useState('')
  const [search, setSearch] = useState('')
  const [standard, setStandard] = useState(ANY_STANDARD)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [semanticId, setSemanticId] = useState('')
  const [semanticIdType, setSemanticIdType] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [gatewayId, setGatewayId] = useState('')
  const [groupId, setGroupId] = useState('FactoryPlus')

  const activeCatalog = useMemo(() => (catalog || []).filter(m => !m.deprecated), [catalog])

  // The standard filter narrows what is *listed*, never what is selected. A schema legitimately
  // mixes standards -- an OEE submodel of ISO KPIs alongside the MTConnect observations they are
  // computed from is the normal case -- so clearing a selection on filter change would fight the
  // thing the filter exists to make easier.
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
  const canSave = schemaName.trim().length > 0 && selectedMetrics.length > 0
  const canUseDeviceActions = canSave && deviceName.trim().length > 0

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
      // The AAS Submodel this schema corresponds to, if it is a known one -- an IDTA submodel
      // template id, say. Optional: most schemas are local compositions with no template behind
      // them, and asserting one there would be a false claim.
      semantic_id: semanticId.trim(),
      semantic_id_type: semanticIdType
    }
  }

  const buildDeviceDetails = () => ({
    device_name: deviceName,
    gateway_id: gatewayId || null,
    group_id: groupId || 'FactoryPlus'
  })

  const handleSubmit = (action) => {
    onSubmit(buildSchemaPayload(), buildDeviceDetails(), action)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconFileCode size={18} />
          <span>Build Schema from Catalog</span>
        </div>

        <div className="form-group">
          <label className="form-label">Schema Name</label>
          <input className="form-control" value={schemaName} onChange={e => setSchemaName(e.target.value)} placeholder="e.g. Six-Axis-Robot-Arm-Standard" title="Unique schema name" />
        </div>

        <div className="form-group">
          <label className="form-label">Description</label>
          <input className="form-control" value={description} onChange={e => setDescription(e.target.value)} placeholder="What this schema is for" />
        </div>

        <div className="form-group">
          <label className="form-label">Semantic ID <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>(optional)</span></label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
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
          <label className="form-label">Metrics <span className="section-count">{selectedMetrics.length} selected</span></label>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <input
              className="form-control"
              style={{ flex: '1 1 auto' }}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search catalog metrics…"
            />
            {/* Filters the list only. A schema mixing standards is normal — ISO 22400 KPIs beside
                the MTConnect observations they are computed from — so selections survive a change
                here. */}
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
          <div style={{ maxHeight: '220px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            {filteredCatalog.length === 0 ? (
              <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>No matching catalog metrics.</div>
            ) : (
              // Grouped the same way as the Schemas page catalog table -- this is the same
              // registry, and a picker that ordered it differently would be its own puzzle.
              // Grouping applies to the search results, so a filtered list stays navigable.
              groupCatalog(filteredCatalog).map(group => (
                <div key={group.label}>
                  <div
                    style={{ position: 'sticky', top: 0, background: 'var(--bg-glass)', backdropFilter: 'blur(4px)', padding: '5px 12px', borderBottom: '1px solid var(--border)', fontSize: '10px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: group.isUngrouped ? 'var(--text-muted)' : 'var(--accent)' }}
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
                        style={{ fontSize: '10px', color: 'var(--text-dim)' }}
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

        {selectedMetrics.length > 0 && (
          <>
            <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0', paddingTop: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Fill these in to download a spec sheet or provision a device with this schema attached — not required just to save the schema.
            </div>

            <div className="form-group">
              <label className="form-label">Device Name</label>
              <input className="form-control" value={deviceName} onChange={e => setDeviceName(e.target.value)} placeholder="e.g. Robot_Arm_04" title="Friendly label for the device record" />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                A display label. The Sparkplug ID the device must publish under is issued when the record is created, and appears in the spec sheet.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Assigned Edge Gateway</label>
              <select className="form-control" value={gatewayId} onChange={e => setGatewayId(e.target.value)}>
                <option value="">— Unassigned Gateway —</option>
                {(gateways || []).filter(g => !g.is_archived).map(g => (
                  <option key={g.gateway_id} value={g.gateway_id}>{g.gateway_name}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Group ID</label>
              <input className="form-control" value={groupId} onChange={e => setGroupId(e.target.value)} title="Sparkplug B group id -- used only to render the topic string below" />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Not stored — only used to compute the topic string in a downloaded spec sheet.
              </div>
            </div>
          </>
        )}

        <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={onCancel} title="Discard and close">Cancel</button>
          <button className={`btn btn-primary ${!canSave ? 'btn-disabled' : ''}`} disabled={!canSave} onClick={() => canSave && handleSubmit('save')} title="Save the schema only">
            Save Schema Only
          </button>
          {/* There is no separate "Save & Provision Device" action: provisioning is now a
              prerequisite of the spec sheet, since the sheet has to quote the Sparkplug ID the
              platform issues to the device. The two buttons did the same thing. */}
          <button className={`btn btn-primary ${!canUseDeviceActions ? 'btn-disabled' : ''}`} disabled={!canUseDeviceActions} onClick={() => canUseDeviceActions && handleSubmit('download')} title={!canUseDeviceActions ? 'Enter a device name first' : 'Save the schema, provision the device, and download a spec sheet quoting its issued Sparkplug ID'}>
            <IconDownload size={13} /> Save, Provision & Download Spec
          </button>
        </div>
      </div>
    </div>
  )
}
