import React, { useState, useEffect } from 'react'
import { api } from '../../api'
import { IconLock, IconClipboardList, IconCheck, IconAlertTriangle } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { patchFromForm, submitProposal } from '../../utils/proposeFromForm'

/**
 * Edit a device's IDTA 02006 Digital Nameplate (archived migration 0011).
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

export function DeviceNameplateModal({ asset, onClose, showToast, canManage, canPropose }) {
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
  // What was on the row when this dialog opened, so the proposal can be a PATCH of what moved
  // rather than a snapshot of all eleven fields.
  const [stored, setStored] = useState({})
  const [rationale, setRationale] = useState('')

  /* THIS DIALOG FILES ITS OWN PROPOSAL. It used to hand over to a composer on the Approvals page,
     which listed these same eleven columns as bare text inputs -- a second form for one nameplate.
     The composer is gone; the footer button below changes what this form DOES instead. */
  const proposeMode = !canManage && canPropose

  useEffect(() => {
    let cancelled = false
    api.get(`/api/v1/devices/${asset.asset_id}/nameplate`)
      .then(({ stored, template: elements, published: fromDevice }) => {
        if (cancelled) return
        setTemplate(elements || [])
        setPublished(fromDevice || {})
        setStored(stored || {})
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
  // The same two rules gate a proposal: a year the column would refuse is refused here rather
  // than a week later, in front of an approver who cannot fix it.
  const canSend = proposeMode && !saving && yearIsValid && uriIsValid

  const propose = async () => {
    setSaving(true)
    try {
      const patch = patchFromForm('device_nameplate', stored, form)
      await submitProposal({
        kind: 'device_nameplate', entityId: asset.asset_id, patch, rationale
      })
      showToast?.('Proposed. An approver applies it, or says why not.', 'success')
      onClose(false)
    } catch (e) {
      showToast?.(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

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

        {/* NO BANNER FOR A READER WHO CAN PROPOSE.
            The first cut explained the read-only state in a strip above the form AND offered the
            route there, while a dead Save button sat at the bottom -- three pieces of furniture
            for one fact. The footer button below now carries the whole of it: it says "Propose a
            change" instead of "Save", which states what this dialog will do for this reader in
            the one place they were already going to look.

            THE STRIP SURVIVES ONLY WHERE THERE IS NOTHING TO OFFER. Without `onPropose` -- a role
            that holds neither `device:manage` nor `proposal:create` -- the footer has nothing to
            say, and a form whose only control is Cancel needs to explain itself somewhere. */}
        {!loading && !canManage && !proposeMode && (
          <div className="readonly-notice" role="status">
            <IconLock size={13} />
            <span>
              You are reading this nameplate. Changing it needs Administrator or Shopfloor_Manager
              — ask one of them to make the change.
            </span>
          </div>
        )}

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
                        disabled={!canManage && !proposeMode}
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

        {/* Only where there is somebody to read it: saving your own change explains itself, and
            proposing one is writing to an approver who has not stood in front of the machine. */}
        {proposeMode && !loading && (
          <div className="form-group" style={{ marginTop: '12px' }}>
            <label className="form-label" htmlFor="nameplate-rationale">Why (optional)</label>
            <textarea
              id="nameplate-rationale"
              className="form-control"
              rows={2}
              value={rationale}
              onChange={e => setRationale(e.target.value)}
              placeholder="e.g. read off the plate on the back of the cabinet"
            />
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => onClose(false)} disabled={saving}>
            Cancel
          </button>
          {/* Was a bare text swap to 'Saving…' with no spinner and no busy state. The label was
              already right; this puts it on the same standardized control as every other
              submission in the app, which is where the spinner and aria-busy come from. */}
          {/* ONE PRIMARY CONTROL, SAYING WHAT IT WILL ACTUALLY DO.
              A disabled Save is the right answer to a TEMPORARY refusal -- an invalid year, a save
              already in flight -- because it tells you the button becomes yours once you fix the
              thing. It is the wrong answer to a permanent one: it leaves the dialog's primary
              action sitting there dead, and the reader's own conclusion is that the app is broken.
              (It also never LOOKED disabled here, because `.btn:disabled` is not styled -- so the
              greyed-out state this was relying on was greyed out in name only.)

              Swapping the label instead means the footer is never dead and never lies. The
              proposer's route keeps the same shape as the manager's: fill nothing in here, press
              the button, and say what you want changed on the form it opens. */}
          {canManage ? (
            <ActionButton
              pending={saving}
              pendingLabel="Saving…"
              onClick={save}
              disabled={!canSave || loading}
              title="Save this nameplate"
            >
              Save
            </ActionButton>
          ) : proposeMode ? (
            <ActionButton
              pending={saving}
              pendingLabel="Proposing…"
              onClick={propose}
              disabled={!canSend || loading}
              title="Ask for these changes — an approver applies them, or says why not"
            >
              Propose a change
            </ActionButton>
          ) : null}
        </div>
      </div>
    </div>
  )
}
