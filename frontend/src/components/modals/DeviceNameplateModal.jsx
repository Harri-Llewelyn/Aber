import React, { useState, useEffect } from 'react'
import { api } from '../../api'
import { IconClipboardList, IconCheck, IconAlertTriangle } from '../common/Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'

/**
 * Edit a device's IDTA 02006 Digital Nameplate (migration 0011).
 *
 * WHY THIS IS NOT ON THE SCHEMAS PAGE. A nameplate is a fact about one physical asset. The Schemas
 * page is entirely type-level -- what a metric may be named, what a standard defines, what shape a
 * payload should take -- and none of it is about a particular machine. This sits two clicks from
 * the Export AAS button whose output it changes, which is the whole argument for its placement.
 *
 * THE READ-ONLY FIELDS ARE THE POINT, NOT A LIMITATION. The AAS exporter prefers a value the
 * device published at DBIRTH over anything stored here, joining on `semantic_id` rather than on
 * metric name. A form that let an operator type a serial number the device already publishes would
 * accept the edit, save it, and then never show it in the export -- with nothing on screen saying
 * why. So a field the device answers for itself is locked, and says so.
 */

/** Mirrors `device_nameplate`'s columns and the template's ordinal, so the form reads like the spec. */
const FIELDS = [
  { column: 'uri_of_the_product', idShort: 'URIOfTheProduct', label: 'Product URI', placeholder: 'https://manufacturer.example/products/…' },
  { column: 'manufacturer_name', idShort: 'ManufacturerName', label: 'Manufacturer' },
  { column: 'manufacturer_product_designation', idShort: 'ManufacturerProductDesignation', label: 'Product designation' },
  { column: 'manufacturer_product_type', idShort: 'ManufacturerProductType', label: 'Product type' },
  { column: 'serial_number', idShort: 'SerialNumber', label: 'Serial number' },
  { column: 'year_of_construction', idShort: 'YearOfConstruction', label: 'Year of construction', placeholder: '2024', inputMode: 'numeric' },
  { column: 'date_of_manufacture', idShort: 'DateOfManufacture', label: 'Date of manufacture', type: 'date' },
  { column: 'hardware_version', idShort: 'HardwareVersion', label: 'Hardware version' },
  { column: 'firmware_version', idShort: 'FirmwareVersion', label: 'Firmware version' },
  { column: 'software_version', idShort: 'SoftwareVersion', label: 'Software version' },
  { column: 'country_of_origin', idShort: 'CountryOfOrigin', label: 'Country of origin', placeholder: 'DE' }
]

const blankForm = () => Object.fromEntries(FIELDS.map(f => [f.column, '']))

export function DeviceNameplateModal({ asset, onClose, showToast, canManage }) {
  // Escape closes. Via the shared stack rather than a listener of this component's own,
  // because a ConfirmModal can open on top of this one and a bare document listener on each
  // would let one keypress dismiss both.
  useEscapeKey(onClose)

  const [form, setForm] = useState(blankForm)
  const [template, setTemplate] = useState([])
  const [published, setPublished] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.get(`/api/v1/devices/${asset.asset_id}/nameplate`)
      .then(({ stored, template: elements, published: fromDevice }) => {
        if (cancelled) return
        setTemplate(elements || [])
        setPublished(fromDevice || {})
        // A device with no nameplate data has NO ROW, so an absent `stored` is the normal case for
        // a device nobody has filled in yet -- not an error and not an empty state worth flagging.
        setForm({
          ...blankForm(),
          ...Object.fromEntries(
            FIELDS.map(f => [f.column, stored?.[f.column] == null ? '' : String(stored[f.column])])
          )
        })
        setLoading(false)
      })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [asset.asset_id])

  const byIdShort = new Map(template.map(e => [e.id_short, e]))
  const set = (column, value) => setForm(prev => ({ ...prev, [column]: value }))

  const yearIsValid = !form.year_of_construction || /^[0-9]{4}$/.test(form.year_of_construction)
  // Matches device_nameplate_uri_shape: an absolute IRI, or nothing. A bare string exports as a
  // broken xs:anyURI that no consumer reports and every consumer mis-renders.
  const uriIsValid = !form.uri_of_the_product || /^[a-z][a-z0-9+.-]*:/i.test(form.uri_of_the_product)
  const canSave = canManage && !saving && yearIsValid && uriIsValid

  const save = async () => {
    setSaving(true)
    try {
      await api.put(`/api/v1/devices/${asset.asset_id}/nameplate`, form)
      // Clearing every field deletes the row, which is a real outcome rather than a no-op: it is
      // how a nameplate entered against the wrong device gets taken back off it.
      const cleared = FIELDS.every(f => !form[f.column]?.trim())
      showToast?.(cleared ? 'Nameplate cleared' : 'Nameplate saved', 'success')
      onClose(true)
    } catch (e) {
      setError(e.message)
      showToast?.(`Could not save nameplate: ${e.message}`, 'error')
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal modal-xl">
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconClipboardList size={18} />
          <span>Digital Nameplate — <span className="mono">{asset.asset_name}</span></span>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
          IDTA 02006 Digital Nameplate v3.0. These values are exported in this device's Asset
          Administration Shell, each carrying the identifier IDTA publishes for it. Every field is
          optional — a nameplate is filled in as it is discovered.
        </p>

        {loading && <div style={{ padding: '20px 0', color: 'var(--text-muted)' }}>Loading…</div>}

        {error && (
          <div className="alert alert-error" style={{ marginBottom: '12px' }}>
            <IconAlertTriangle size={14} /> {error}
          </div>
        )}

        {!loading && (
          <>
            {Object.keys(published).length > 0 && (
              <div
                style={{
                  display: 'flex', gap: '6px', alignItems: 'flex-start', fontSize: '12px',
                  color: 'var(--text-muted)', marginBottom: '12px'
                }}
              >
                <IconCheck size={13} />
                <span>
                  This device publishes {Object.keys(published).length} of these itself at DBIRTH.
                  Those fields are shown as the device reports them and cannot be edited here — the
                  exported shell always uses the device's own answer.
                </span>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px' }}>
              {FIELDS.map(field => {
                const element = byIdShort.get(field.idShort)
                const deviceValue = published[field.column]
                const isPublished = deviceValue !== undefined
                // Explicit htmlFor/id rather than a wrapping label: a disabled input inside a
                // label is not reliably announced, and these fields are disabled whenever the
                // device publishes them.
                const inputId = `nameplate-${field.column}`
                return (
                  <div key={field.column}>
                    <label
                      className="form-label"
                      htmlFor={inputId}
                      title={element
                        ? `${element.id_short} — ${element.semantic_id_type} ${element.semantic_id}\n\n${element.description || ''}`
                        : field.label}
                    >
                      {field.label}
                      {element?.is_mandatory && (
                        <span
                          style={{ color: 'var(--text-muted)', marginLeft: '4px' }}
                          title="Mandatory in the IDTA template. This platform does not require it — the exported submodel deliberately does not claim conformance to the template."
                        >
                          *
                        </span>
                      )}
                    </label>
                    {isPublished ? (
                      <input
                        id={inputId}
                        className="form-control"
                        value={String(deviceValue)}
                        readOnly
                        disabled
                        title="Published by the device at DBIRTH. The export uses this value, so it cannot be overridden here."
                      />
                    ) : (
                      <input
                        id={inputId}
                        className="form-control"
                        type={field.type || 'text'}
                        inputMode={field.inputMode}
                        placeholder={field.placeholder || ''}
                        value={form[field.column]}
                        disabled={!canManage}
                        onChange={e => set(field.column, e.target.value)}
                      />
                    )}
                  </div>
                )
              })}
            </div>

            {!yearIsValid && (
              <div style={{ fontSize: '12px', color: 'var(--warning-text)', marginTop: '10px' }}>
                Year of construction must be four digits. IDTA types it as a string, so a range or a
                week code would be legitimate on a plate — but the column accepts only a year.
              </div>
            )}
            {!uriIsValid && (
              <div style={{ fontSize: '12px', color: 'var(--warning-text)', marginTop: '10px' }}>
                Product URI must be an absolute IRI, including its scheme — <span className="mono">https://…</span>
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => onClose(false)} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={!canSave || loading}
            title={canManage ? 'Save this nameplate' : 'Requires Administrator or Shopfloor_Manager'}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
