/**
 * Proposing a change from the form that makes it.
 *
 * There is one form per asset, the Edit Details dialog, and this module lets it end in a proposal
 * instead of a write for somebody who may not make the change. The footer button is the only thing
 * that differs.
 *
 * The mapping table translates form field names to column names, as api.js does on the way to a
 * PUT, so the two paths out of one form agree. It is deliberately not derived from
 * `proposable_columns()`: that is the database's answer to what may be named, and the patch is
 * filtered through it at insert and at approval. This answers which box on the form is that column.
 *
 * Fields that are not proposable (a device's gateway and schema, a gateway's `deployment`) are
 * disabled in propose mode, not hidden; `nonProposableFields()` tells the form which.
 */
import { api } from '../api'

/**
 * One entry per asset kind: the proposal lane, and how the form's fields map onto its columns. A
 * form key absent from `fields` is not proposable.
 */
export const PROPOSAL_FORMS = {
  device: {
    lane: 'devices',
    idField: 'asset_id',
    fields: {
      asset_name: 'name',
      description: 'description',
      connection_method: 'connection_method',
      cell_id: 'cell_id',
      area_id: 'area_id',
      location_scope: 'location_scope'
    },
    // WHY EACH ONE IS OUT, in the words the form shows the reader.
    withheld: {
      active_gateway_id: 'The gateway is this device’s data path — an Administrator moves it.',
      schema_id: 'The schema is what this device’s telemetry is judged against — an Administrator changes it.',
      conformance_policy: 'Conformance policy decides what happens to unmodelled metrics — an Administrator sets it.'
    }
  },
  /* The one form whose fields are already column names: DeviceNameplateModal builds itself from a
     FIELDS table keyed by `device_nameplate`'s columns. Written out rather than generated, so every
     field is proposable is re-read when a column is added. */
  device_nameplate: {
    lane: 'device_nameplate',
    idField: 'asset_id',
    fields: {
      uri_of_the_product: 'uri_of_the_product',
      manufacturer_name: 'manufacturer_name',
      manufacturer_product_designation: 'manufacturer_product_designation',
      manufacturer_product_type: 'manufacturer_product_type',
      serial_number: 'serial_number',
      year_of_construction: 'year_of_construction',
      date_of_manufacture: 'date_of_manufacture',
      hardware_version: 'hardware_version',
      firmware_version: 'firmware_version',
      software_version: 'software_version',
      country_of_origin: 'country_of_origin'
    },
    withheld: {}
  },
  /* Every column of an area a person chooses; `id` and `created_at` are the platform's. `area_name`
     is the form's name for `name`, which is what api.js writes on the direct path too. */
  area: {
    lane: 'areas',
    idField: 'area_id',
    fields: {
      area_name: 'name',
      description: 'description',
      icon: 'icon'
    },
    withheld: {}
  },
  cell: {
    lane: 'cells',
    idField: 'cell_id',
    // `access_url` is the form's name for `cells.grafana_url`, which is what api.js writes too.
    fields: {
      cell_name: 'name',
      access_url: 'grafana_url',
      icon: 'icon',
      area_id: 'area_id',
      plan_x: 'plan_x',
      plan_y: 'plan_y',
      description: 'description'
    },
    withheld: {}
  },
  gateway: {
    lane: 'gateways',
    idField: 'gateway_id',
    fields: {
      gateway_name: 'name',
      description: 'description',
      access_url: 'access_url',
      cell_id: 'cell_id',
      area_id: 'area_id',
      location_scope: 'location_scope'
    },
    withheld: {
      deployment: 'Deployment says where this gateway’s connector runs — an Administrator changes it.',
      is_simulated: 'Whether a gateway is simulated is what it IS, not a label — an Administrator changes it.'
    }
  }
}

/** The form keys this asset kind cannot propose, with the sentence to show beside each. */
export function nonProposableFields(kind) {
  return PROPOSAL_FORMS[kind]?.withheld || {}
}

/**
 * What this form would change, as a patch of database columns. Only what actually moved, so an
 * approver can see which column the person changed and the patch does not revert anything that
 * moved underneath it. '' becomes null: an emptied box means clear this field.
 */
export function patchFromForm(kind, current, form) {
  const def = PROPOSAL_FORMS[kind]
  if (!def || !current || !form) return {}

  const patch = {}
  for (const [formKey, column] of Object.entries(def.fields)) {
    if (!(formKey in form)) continue

    const proposed = form[formKey] === '' ? null : form[formKey]
    const existing = current[formKey] === '' || current[formKey] === undefined ? null : current[formKey]

    // Compared as strings, because a form gives back strings and a row gives back typed values.
    // Nulls are settled first, above, so `String(null)` cannot collapse them.
    const same = proposed === null && existing === null
      ? true
      : proposed !== null && existing !== null && String(proposed) === String(existing)

    if (!same) patch[column] = proposed
  }
  return patch
}

/**
 * The reverse of `patchFromForm`: an open proposal's patch as this form's fields, so somebody
 * adding to a proposal sees their earlier request in the boxes. Columns the form has no box for are
 * ignored.
 */
export function formFromPatch(kind, patch) {
  const def = PROPOSAL_FORMS[kind]
  if (!def || !patch) return {}

  const byColumn = new Map(Object.entries(def.fields).map(([formKey, column]) => [column, formKey]))
  const form = {}
  for (const [column, value] of Object.entries(patch)) {
    const formKey = byColumn.get(column)
    // '' rather than null, because that is what an empty input holds; `patchFromForm` turns it back
    // into null.
    if (formKey) form[formKey] = value === null ? '' : value
  }
  return form
}

/**
 * File the proposal, or update one already open. `proposalId` is how the per-asset cap stays
 * livable: one open proposal per asset per person, so a second field is added to the existing
 * request.
 */
export async function submitProposal({ kind, entityId, patch, rationale, proposalId }) {
  const def = PROPOSAL_FORMS[kind]
  if (!def) throw new Error(`No proposal lane for "${kind}"`)
  if (!Object.keys(patch).length) {
    // Refused here rather than by the database's own patch-is-not-empty constraint, because this
    // one can say the useful half: nothing on the form was changed.
    throw new Error('Change something first — a proposal with no changes has nothing to decide.')
  }

  const body = { entity_type: def.lane, entity_id: entityId, patch, rationale: rationale || null }
  if (proposalId) return api.put(`/api/v1/proposals/${proposalId}`, body)
  return api.post('/api/v1/proposals', body)
}
