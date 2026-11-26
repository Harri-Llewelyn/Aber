import React, { useState, useEffect, useRef } from 'react'
import { api } from '../../api'
import { Callout } from '../common/Callout'
import { IconLock, IconTag } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { HelpTip } from '../common/HelpTip'
import { Modal } from '../common/Modal'
import { LoadingState } from '../common/LoadingState'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { PERMISSION_UUIDS } from '../../constants'
import { patchFromForm, submitProposal, proposalNotice } from '../../utils/proposeFromForm'
import { hasNameplateValue } from '../../utils/nameplate'
import { deviceUrl } from '../../routes'
import { Tooltip } from '../common/Tooltip'

/**
 * Edit a device's IDTA 02006 Digital Nameplate. On the device rather than the Schemas page, because
 * a nameplate is a fact about one physical asset. The read-only fields are the point: the AAS
 * exporter prefers a value the device published at DBIRTH, joining on `semantic_id`, so a field the
 * device answers for itself is locked and says so.
 */

/**
 * Mirrors `device_nameplate`'s columns and the template's order, so the form reads like the spec. `path`
 * is the element's idShortPath in the export. `help` is carried only by fields a reader cannot answer
 * from the label alone, such as the three manufacturer identifiers.
 */
const FIELDS = [
  {
    column: 'uri_of_the_product', path: 'URIOfTheProduct', label: 'Product URI',
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
  { column: 'manufacturer_name', path: 'ManufacturerName', label: 'Manufacturer' },
  {
    column: 'manufacturer_product_designation', path: 'ManufacturerProductDesignation',
    label: 'Product Designation',
    help: 'What the manufacturer CALLS this machine — the name on the brochure, the one an '
      + 'engineer would say out loud. For example "KR 10 R1100".\n\n'
      + 'The broadest of the three identifiers: every machine of this model shares it. Product '
      + 'Type narrows it to a variant, and Serial Number narrows that to this individual unit.'
  },
  { column: 'address_street', path: 'AddressInformation.Street', label: 'Street', placeholder: '1 Example Road' },
  { column: 'address_zipcode', path: 'AddressInformation.Zipcode', label: 'Postal Code' },
  { column: 'address_city_town', path: 'AddressInformation.CityTown', label: 'Town or City' },
  { column: 'address_state_county', path: 'AddressInformation.StateCounty', label: 'State or County' },
  {
    column: 'address_national_code', path: 'AddressInformation.NationalCode', label: 'Country Code',
    placeholder: 'DE',
    help: 'The country the manufacturer is in, as a two-letter ISO 3166-1 code such as DE. Where the '
      + 'machine was made is Country of Origin, below.'
  },
  {
    column: 'manufacturer_product_type', path: 'ManufacturerProductType',
    label: 'Product Type',
    help: 'The manufacturer\'s name or code for which VARIANT of the product this is, such as '
      + '"FM-ABC-1234".\n\n'
      + 'Two machines with the same product designation can differ here, if they were ordered with '
      + 'different options. The code to order one by is Order Code. If the manufacturer draws no such '
      + 'distinction, leave it blank rather than repeating the designation.'
  },
  {
    column: 'order_code_of_manufacturer', path: 'OrderCodeOfManufacturer', label: 'Order Code',
    help: 'The code the manufacturer takes an order for this product by, as its price list or the plate '
      + 'gives it. Every machine ordered the same way shares it, so it is not the serial number.'
  },
  {
    column: 'serial_number', path: 'SerialNumber', label: 'Serial Number',
    help: 'The number identifying THIS machine and no other, as stamped on its physical plate. '
      + 'The narrowest of the three identifiers.\n\n'
      + 'Not the Sparkplug ID: that is issued by this platform and means nothing to the '
      + 'manufacturer. This is the number to quote in a warranty claim.'
  },
  {
    column: 'year_of_construction', path: 'YearOfConstruction', label: 'Year of Construction',
    placeholder: '2024', inputMode: 'numeric',
    help: 'The four-digit year the machine was built, and the one of this pair a nameplate almost '
      + 'always carries.\n\n'
      + 'Date of Manufacture below is the same fact to the day, for the rarer plate that states '
      + 'one. Fill in whichever the plate gives; they do not have to agree to the day, and neither '
      + 'is derived from the other.'
  },
  {
    column: 'date_of_manufacture', path: 'DateOfManufacture', label: 'Date of Manufacture',
    type: 'date',
    help: 'The exact date the machine was manufactured, where the plate states one. Optional, and '
      + 'usually blank: most plates give only the year, which belongs in the field above.'
  },
  { column: 'hardware_version', path: 'HardwareVersion', label: 'Hardware Version' },
  { column: 'firmware_version', path: 'FirmwareVersion', label: 'Firmware Version' },
  { column: 'software_version', path: 'SoftwareVersion', label: 'Software Version' },
  {
    column: 'country_of_origin', path: 'CountryOfOrigin', label: 'Country of Origin',
    placeholder: 'DE',
    help: 'Where the machine was manufactured, as a two-letter ISO 3166-1 country code — DE for '
      + 'Germany, GB for the United Kingdom, JP for Japan. Not the manufacturer\'s head office, '
      + 'and not the full country name.'
  }
]

const ADDRESS = 'AddressInformation.'
const inAddress = field => field.path.startsWith(ADDRESS)
/** The fields as they are laid out: the address is a group of its own, where the template has it. */
const FIRST_ADDRESS = FIELDS.findIndex(inAddress)
const SECTIONS = {
  before: FIELDS.slice(0, FIRST_ADDRESS),
  address: FIELDS.filter(inAddress),
  after: FIELDS.slice(FIRST_ADDRESS).filter(f => !inAddress(f))
}

const blankForm = () => Object.fromEntries(FIELDS.map(f => [f.column, '']))
const inputIdOf = column => `nameplate-${column}`

export function DeviceNameplateModal({ asset, onClose, showToast, canManage, canPropose }) {
  const [form, setForm] = useState(blankForm)
  const [template, setTemplate] = useState([])
  const [address, setAddress] = useState([])
  const [mandatory, setMandatory] = useState([])
  const [published, setPublished] = useState({})
  const [loading, setLoading] = useState(true)
  // The read failed: there is nothing to show, and nothing to save over.
  const [unread, setUnread] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  // What was on the row when this dialog opened, so the proposal is a patch of what moved.
  const [stored, setStored] = useState({})
  const [rationale, setRationale] = useState('')
  // The primary was pressed and could not go ahead, until the next edit.
  const [pressed, setPressed] = useState(false)
  const body = useRef(null)

  // The footer button files a proposal for a reader who may not save.
  const proposeMode = !canManage && canPropose
  // Neither right: the values are shown as text, since there is nothing here to change them with.
  const reading = !canManage && !proposeMode

  useEffect(() => {
    let cancelled = false
    api.get(`/api/v1/devices/${asset.asset_id}/nameplate`)
      .then(({ stored, template: elements, mandatory: asked, address: addressElements, published: fromDevice }) => {
        if (cancelled) return
        setTemplate(elements || [])
        setAddress(addressElements || [])
        setMandatory(asked || [])
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
      .catch(e => { if (!cancelled) { setError(e.message); setUnread(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [asset.asset_id])

  const byIdShort = new Map(template.map(e => [e.id_short, e]))
  const addressByIdShort = new Map(address.map(e => [e.id_short, e]))
  const elementOf = field => (inAddress(field)
    ? addressByIdShort.get(field.path.slice(ADDRESS.length))
    : byIdShort.get(field.path))
  const set = (column, value) => {
    setPressed(false)
    setForm(prev => ({ ...prev, [column]: value }))
  }

  const yearIsValid = !form.year_of_construction || /^[0-9]{4}$/.test(form.year_of_construction)
  // Matches device_nameplate_uri_shape: an absolute IRI, or nothing. A bare string exports as a
  // broken xs:anyURI that no consumer reports and every consumer mis-renders.
  const uriIsValid = !form.uri_of_the_product || /^[a-z][a-z0-9+.-]*:/i.test(form.uri_of_the_product)
  // By column, said under its field as it is typed. The same two rules hold a save and a proposal, so
  // an approver is never asked about a value the column would refuse.
  const fieldErrors = {
    year_of_construction: yearIsValid ? null : 'Year of Construction must be four digits. IDTA types it as a '
      + 'string, so a range or a week code would be legitimate on a plate — but the column accepts only a year.',
    uri_of_the_product: uriIsValid ? null : (
      <>Product URI must be an absolute IRI, including its scheme — <span className="mono">https://…</span></>
    )
  }
  const firstWrong = FIELDS.find(f => fieldErrors[f.column])
  const unchanged = Object.keys(patchFromForm('device_nameplate', stored, form)).length === 0

  const valueOf = field => published[field.column] ?? form[field.column]
  const held = new Set(FIELDS.filter(f => hasNameplateValue(valueOf(f))).map(f => f.path))
  const labelByPath = new Map(FIELDS.map(f => [f.path, f.label]))
  // What the export still waits for before it names the template, by label and in the template's order.
  const missing = mandatory.filter(path => !held.has(path)).map(path => labelByPath.get(path) ?? path)

  /** Whether the primary may go ahead. Says why not in the problem line, and goes to the first field. */
  const mayGoAhead = () => {
    if (!firstWrong && !unchanged) return true
    setPressed(true)
    if (firstWrong) body.current?.querySelector(`#${inputIdOf(firstWrong.column)}`)?.focus()
    return false
  }

  const propose = async () => {
    if (!mayGoAhead()) return
    setSaving(true)
    try {
      const patch = patchFromForm('device_nameplate', stored, form)
      const filed = await submitProposal({
        kind: 'device_nameplate', entityId: asset.asset_id, patch, rationale
      })
      const { msg, to } = proposalNotice(`${asset.asset_name}'s nameplate`, filed?.id)
      showToast?.(msg, 'success', { to })
      onClose(false)
    } catch (e) {
      setError(e.message)
      showToast?.(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const save = async () => {
    if (!mayGoAhead()) return
    setSaving(true)
    try {
      await api.put(`/api/v1/devices/${asset.asset_id}/nameplate`, form)
      // Clearing every field deletes the row.
      const cleared = FIELDS.every(f => !form[f.column]?.trim())
      showToast?.(`Nameplate of '${asset.asset_name}' ${cleared ? 'cleared' : 'saved'}`, 'success', { to: deviceUrl(asset.asset_id) })
      onClose(true)
    } catch (e) {
      setError(e.message)
      showToast?.(`Could not save nameplate: ${e.message}`, 'error')
      setSaving(false)
    }
  }

  // The line above the buttons: what the press ran into, else what the template still asks for. The
  // second is no problem with the form, since a nameplate is filled in as it is discovered, so it has
  // the hint's own look and is there from the open.
  const refusal = !pressed ? null
    : firstWrong ? `Check ${firstWrong.label}`
    : unchanged ? 'Nothing has changed.' : null
  const standing = loading || unread || mandatory.length === 0 ? null : (
    <span className="nameplate-standing">
      {missing.length === 0
        ? 'Every field the template asks for is filled in, so the export names the template.'
        : <>The export names the template once these are filled in: <strong>{missing.join(', ')}</strong>.</>}
    </span>
  )

  const drawField = field => {
    const element = elementOf(field)
    const deviceValue = published[field.column]
    const isPublished = deviceValue !== undefined
    // Explicit htmlFor/id names the input. A value shown as text has no control to name, so
    // its label is a plain div.
    const inputId = inputIdOf(field.column)
    const fieldError = fieldErrors[field.column]
    const NameTag = isPublished || reading ? 'div' : 'label'
    return (
      <div key={field.column}>
        {/* The tip is a SIBLING of the label, not a child: a button inside a label is
            labelled by it too, so the input stops being the only thing that answers to
            the field's name. The row carries the label's bottom margin so the spacing
            is the same as a field without a tip. */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '7px' }}>
          {/* The template's wording on the label, for a pointer; the field's HelpTip,
              where it has one, is the keyboard's way to what tells it apart. */}
          <Tooltip text={element
            ? `${element.id_short} — ${element.semantic_id_type} ${element.semantic_id}${element.description ? `\n\n${element.description}` : ''}`
            : null}>
          <NameTag
            className="form-label"
            htmlFor={isPublished || reading ? undefined : inputId}
            style={{ marginBottom: 0 }}
          >
            {field.label}
            {mandatory.includes(field.path) && (
              <Tooltip text="Mandatory in the IDTA template. The exported nameplate names the template once every field marked like this has a value. You can save without it.">
                <span style={{ color: 'var(--text-muted)', marginLeft: '4px' }}>*</span>
              </Tooltip>
            )}
          </NameTag>
          </Tooltip>
          {/* Only on the fields whose label does not define them. The label's own hover
              text carries the template's wording; this carries how to tell the field
              from its neighbours, which is what the three identifiers actually need. */}
          {field.help && <HelpTip text={field.help} label={`What ${field.label} means`} />}
        </div>
        {isPublished ? (
          // What the device reported, as text with its reason: the exporter uses this value,
          // so it cannot be overridden here.
          <>
            <div className="mono" style={{ fontSize: '13px', overflowWrap: 'anywhere' }}>{String(deviceValue)}</div>
            <div className="form-hint">Published by the device at DBIRTH, so the export uses it.</div>
          </>
        ) : reading ? (
          // The reader's notice above says why: nothing here changes it.
          <div className="mono" style={{ fontSize: '13px', overflowWrap: 'anywhere' }}>
            {form[field.column] || <span style={{ color: 'var(--text-muted)' }}>Not set</span>}
          </div>
        ) : (
          <input
            id={inputId}
            className="form-control"
            type={field.type || 'text'}
            inputMode={field.inputMode}
            placeholder={field.placeholder || ''}
            value={form[field.column]}
            onChange={e => set(field.column, e.target.value)}
            {...fieldErrorProps(fieldError, `${inputId}-error`)}
          />
        )}
        <FieldError id={`${inputId}-error`} error={fieldError} />
      </div>
    )
  }

  return (
    <Modal
      title={<>Digital Nameplate — <span className="mono">{asset.asset_name}</span></>}
      icon={<IconTag size={18} />}
      size="xl"
      busy={saving}
      onClose={() => onClose(false)}
      lead="IDTA 02006 Digital Nameplate v3.0. These values are exported in this device's Asset Administration Shell, each carrying the identifier IDTA publishes for it. Every field is optional: a nameplate is filled in as it is discovered."
      problem={refusal ?? standing}
      error={error}
      dismiss={reading || unread ? 'Close' : 'Cancel'}
      // One primary control, saying what it will do. It stays pressable: the press says what is in the
      // way. The label swaps for a permanent refusal.
      footer={unread || reading ? null : canManage ? (
        <ActionButton pending={saving} pendingLabel="Saving…" onClick={save} disabled={loading}>
          Save Nameplate
        </ActionButton>
      ) : (
        <ActionButton
          pending={saving}
          pendingLabel="Proposing…"
          onClick={propose}
          disabled={loading}
          title="Ask for these changes — an approver applies them, or says why not"
        >
          Propose a Change
        </ActionButton>
      )}
    >

        {/* No banner for a reader who can propose: the footer button says Propose a Change. The
            strip survives only where there is nothing to offer, for a role holding neither
            `device:manage` nor `proposal:create`. */}
        {!loading && !unread && reading && (
          <div className="readonly-notice" role="status">
            <IconLock size={13} />
            <span>
              You are reading this nameplate. {requiresRolesTitle(PERMISSION_UUIDS.DEVICE_MANAGE)} to
              change it; ask one of them to make the change.
            </span>
          </div>
        )}

        {loading && <LoadingState label="nameplate" />}

        {!loading && !unread && (
          <div ref={body}>
            {Object.keys(published).length > 0 && (
              <Callout tone="info" className="nameplate-published">
                This device publishes {Object.keys(published).length} of these itself at DBIRTH.
                Those fields are shown as the device reports them and cannot be edited here — the
                exported shell always uses the device's own answer.
              </Callout>
            )}

            <div className="nameplate-fields">
              {SECTIONS.before.map(drawField)}
              <div className="nameplate-address" role="group" aria-labelledby="nameplate-address-label">
                <div className="nameplate-address-head">
                  <span className="eyebrow" id="nameplate-address-label">Address of the Manufacturer</span>
                  <HelpTip
                    text="Where the manufacturer is, as the plate or its papers give it. Not where this machine stands: that is its cell or its area."
                    label="What Address of the Manufacturer means"
                  />
                </div>
                <div className="nameplate-fields">{SECTIONS.address.map(drawField)}</div>
              </div>
              {SECTIONS.after.map(drawField)}
            </div>
          </div>
        )}

        {/* Only where there is somebody to read it: saving your own change explains itself, and
            proposing one is writing to an approver who has not stood in front of the machine. */}
        {proposeMode && !loading && !unread && (
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
