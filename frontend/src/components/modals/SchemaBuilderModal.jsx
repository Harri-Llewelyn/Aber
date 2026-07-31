import React, { useState, useMemo } from 'react'
import { IconFileCode, IconDownload } from '../common/Icons'
import { datatypeLabel, datatypeToJsonSchemaType } from '../../utils/sparkplugDatatype'
import { groupCatalog } from '../../utils/metricGroup'

export function SchemaBuilderModal({ catalog, gateways, onSubmit, onCancel }) {
  const [schemaName, setSchemaName] = useState('')
  const [description, setDescription] = useState('')
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [deviceName, setDeviceName] = useState('')
  const [gatewayId, setGatewayId] = useState('')
  const [groupId, setGroupId] = useState('FactoryPlus')

  const activeCatalog = useMemo(() => (catalog || []).filter(m => !m.deprecated), [catalog])
  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return activeCatalog
    return activeCatalog.filter(m => m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q))
  }, [activeCatalog, search])

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
      }
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
          <label className="form-label">Metrics <span className="section-count">{selectedMetrics.length} selected</span></label>
          <input
            className="form-control"
            style={{ marginBottom: '8px' }}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search catalog metrics…"
          />
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
