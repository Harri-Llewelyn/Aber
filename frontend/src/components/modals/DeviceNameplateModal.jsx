import React, { useState, useEffect } from 'react'
import { api } from '../../api'
import { IconLock, IconTag, IconCheck } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { HelpTip } from '../common/HelpTip'
import { Modal } from '../common/Modal'
import { LoadingState } from '../common/LoadingState'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { PERMISSION_UUIDS } from '../../constants'
import { patchFromForm, submitProposal } from '../../utils/proposeFromForm'

/**
 * Edit a device's IDTA 02006 Digital Nameplate. On the device rather than the Schemas page, because
 * a nameplate is a fact about one physical asset. The read-only fields are the point: the AAS
 * exporter prefers a value the device published at DBIRTH, joining on `semantic_id`, so a field the
 * device answers for itself is locked and says so.
 */

/**
 * Mirrors `device_nameplate`'s columns and the template's ordinal, so the form reads like the spec.
 * `help` is carried only by fields a reader cannot answer from the label alone, such as the three
 * manufacturer identifiers.
 */
const FIELDS = [
  {
    column: 'uri_of_the_product', idShort: 'URIOfTheProduct', label: 'Product URI',
    placeholder: 'https://manufacturer.example/products/…',
    help: 'The manufacturer\'s own web address for this machine — theirs, not this platform\'s. '
      + 'It identifies the product INSTANCE, so where a manufacturer issues one per unit, that is '
      + 'the one to use rather than the address of the model\'s brochure page.\n\n'
      + 'It must be a full absolute address beginning with a scheme, such as https:. A bare '
      + 'string is refused, because it exports as a broken link that no AAS consumer reports and '
      + 'every consumer mis-renders.\n\n'
      + 'Leave it blank if the manufacturer publishes no such address. This is not the device\'s id '
      + 'on this platform — that is its Sparkplug ID, issued here and shown in the device drawer.'
  },
  { column: 'manufacturer_name', idShort: 'ManufacturerName', label: 'Manufacturer' },
  {
    column: 'manufacturer_product_designation', idShort: 'ManufacturerProductDesignation',
    label: 'Product designation',
    help: 'What the manufacturer CALLS this machine — the name on the brochure, the one an '
      + 'engineer would say out loud. For example "KR 10 R1100".\n\n'
      + 'The broadest of the three identifiers: every machine of this model shares it. Product '
      + 'type narrows it to a variant, and serial number narrows that to this individual unit.'
  },
  {
    column: 'manufacturer_product_type', idShort: 'ManufacturerProductType',
    label: 'Product type',
    help: 'The manufacturer\'s code for which VARIANT of the product this is — what you would quote '
      + 'to order another one exactly like it. Often an article or order number such as '
      + '"00-123-456".\n\n'
      + 'Two machines with the same product designation can differ here, if they were ordered with '
      + 'different options. If the manufacturer draws no such distinction, leave it blank rather '
      + 'than repeating the designation.'
  },
  {
    column: 'serial_number', idShort: 'SerialNumber', label: 'Serial number',
    help: 'The number identifying THIS machine and no other, as stamped on its physical plate. '
      + 'The narrowest of the three identifiers.\n\n'
      + 'Not the Sparkplug ID: that is issued by this platform and means nothing to the '
      + 'manufacturer. This is the number to quote in a warranty claim.'
  },
  {
    column: 'year_of_construction', idShort: 'YearOfConstruction', label: 'Year of construction',
    placeholder: '2024', inputMode: 'numeric',
    help: 'The four-digit year the machine was built. Mandatory in the IDTA template, and the one '
      + 'of this pair a nameplate almost always carries.\n\n'
      + 'Date of manufacture below is the same fact to the day, for the rarer plate that states '
      + 'one. Fill in whichever the plate gives; they do not have to agree to the day, and neither '
      + 'is derived from the other.'
  },
  {
    column: 'date_of_manufacture', idShort: 'DateOfManufacture', label: 'Date of manufacture',
    type: 'date',
    help: 'The exact date the machine was manufactured, where the plate states one. Optional, and '
      + 'usually blank: most plates give only the year, which belongs in the field above.'
  },
  { column: 'hardware_version', idShort: 'HardwareVersion', label: 'Hardware version' },
  { column: 'firmware_version', idShort: 'FirmwareVersion', label: 'Firmware version' },
  { column: 'software_version', idShort: 'SoftwareVersion', label: 'Software version' },
  {
    column: 'country_of_origin', idShort: 'CountryOfOrigin', label: 'Country of origin',
    placeholder: 'DE',
    help: 'Where the machine was manufactured, as a two-letter ISO 3166-1 country code — DE for '
      + 'Germany, GB for the United Kingdom, JP for Japan. Not the manufacturer\'s head office, '
      + 'and not the full country name.'
  }
]

const blankForm = () => Object.fromEntries(FIELDS.map(f => [f.column, '']))

export function DeviceNameplateModal({ asset, onClose, showToast, canManage, canPropose }) {
  const [form, setForm] = useState(blankForm)
  const [template, setTemplate] = useState([])
  const [published, setPublished] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  // What was on the row when this dialog opened, so the proposal is a patch of what moved.
  const [stored, setStored] = useState({})
  const [rationale, setRationale] = useState('')

  // The footer button files a proposal for a reader who may not save.
  const proposeMode = !canManage && canPropose

  useEffect(() => {
    let cancelled = false
    api.get(`/api/v1/devices/${asset.asset_id}/nameplate`)
      .then(({ stored, template: elements, published: fromDevice }) => {
        if (cancelled) return
        setTemplate(elements || [])
        setPublished(fromDevice || {})
        setStored(stored || {})
        // A device with no nameplate data has no row, so an absent `stored` is normal.
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
  // The same two rules gate a proposal, so an approver is never asked about a value the column
  // would refuse.
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
      // Clearing every field deletes the row.
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
    <Modal
      title={<>Digital Nameplate — <span className="mono">{asset.asset_name}</span></>}
      icon={<IconTag size={18} />}
      size="xl"
      onClose={() => onClose(false)}
      lead="IDTA 02006 Digital Nameplate v3.0. These values are exported in this device's Asset Administration Shell, each carrying the identifier IDTA publishes for it. Every field is optional: a nameplate is filled in as it is discovered."
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => onClose(false)} disabled={saving}>
            Cancel
          </button>
          {/* One primary control, saying what it will do. A disabled Save is right for a temporary
              refusal and wrong for a permanent one, so the label swaps instead. */}
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
        </>
      }
    >

        {/* No banner for a reader who can propose: the footer button says Propose a change. The
            strip survives only where there is nothing to offer, for a role holding neither
            `device:manage` nor `proposal:create`. */}
        {!loading && !canManage && !proposeMode && (
          <div className="readonly-notice" role="status">
            <IconLock size={13} />
            <span>
              You are reading this nameplate. {requiresRolesTitle(PERMISSION_UUIDS.DEVICE_MANAGE)} to
              change it; ask one of them to make the change.
            </span>
          </div>
        )}

        {loading && <LoadingState label="nameplate" />}

        {!loading && (
          <>
            {Object.keys(published).length > 0 && (
              <div className="callout callout-info">
                <IconCheck size={13} className="callout-icon" />
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
                // Explicit htmlFor/id: a disabled input inside a wrapping label is not reliably
                // announced.
                const inputId = `nameplate-${field.column}`
                return (
                  <div key={field.column}>
                    {/* The tip is a SIBLING of the label, not a child: a button inside a label is
                        labelled by it too, so the input stops being the only thing that answers to
                        the field's name. The row carries the label's bottom margin so the spacing
                        is the same as a field without a tip. */}
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '7px' }}>
                      <label
                        className="form-label"
                        htmlFor={inputId}
                        style={{ marginBottom: 0 }}
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
                      {/* Only on the fields whose label does not define them. The label's own hover
                          text carries the template's wording; this carries how to tell the field
                          from its neighbours, which is what the three identifiers actually need. */}
                      {field.help && <HelpTip text={field.help} label={`What ${field.label} means`} />}
                    </div>
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
              <div className="form-hint hint-warning">
                Year of construction must be four digits. IDTA types it as a string, so a range or a
                week code would be legitimate on a plate — but the column accepts only a year.
              </div>
            )}
            {!uriIsValid && (
              <div className="form-hint hint-warning">
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
    </Modal>
  )
}
