/**
 * ==================================================================================================
 * PROPOSING A CHANGE FROM THE FORM THAT MAKES IT
 * ==================================================================================================
 *
 * THE PROBLEM THIS EXISTS TO REMOVE. The approvals page used to carry a composer of its own -- a
 * second form, listing the same fields as the Edit Details dialog for the same asset, built from
 * `proposable_columns()` and rendered as bare text inputs. Two forms describing one set of columns
 * is a drift generator: the day somebody adds a picker to Edit Details, or a hint, or a validation
 * rule, the composer keeps its text box and the two dialogs quietly start disagreeing about what a
 * device is. Worse, the composer's inputs had no idea a `cell_id` was a uuid with a dropdown behind
 * it, so proposing a relocation meant typing one.
 *
 * So there is ONE form per asset now -- the one that was always there -- and this module is what
 * lets it end in a proposal instead of a write. The footer button is the only thing that differs:
 * `Save` for somebody who may make the change, `Propose a change` for somebody who may not.
 *
 * ==================================================================================================
 * WHY A MAPPING TABLE, AND WHY IT IS SMALL
 * ==================================================================================================
 *
 * A form's field names are not a table's column names, and never were: the Devices form holds
 * `asset_name`, the Cells form holds `cell_name` and `access_url` where the column is `grafana_url`.
 * `api.js` already translates on the way to a PUT; this does the same translation on the way to a
 * proposal, so the two paths out of one form agree about what they are describing.
 *
 * IT IS DELIBERATELY NOT DERIVED FROM `proposable_columns()`. That function is the DATABASE's
 * answer to "what may be named", and it stays the authority -- the patch is filtered through it at
 * insert AND again at approval. This is a different question: "which box on this form is that
 * column". Only the form knows, and inventing the mapping by string-matching would fail silently
 * on exactly the three pairs above.
 *
 * ==================================================================================================
 * WHAT A NON-PROPOSABLE FIELD DOES
 * ==================================================================================================
 *
 * Some fields on these forms are not proposable and should not become so: a device's gateway is its
 * DATA PATH, its schema is what its telemetry is judged against, and a gateway's `deployment` says
 * where its connector runs. 0086's header withheld that class deliberately.
 *
 * They are DISABLED IN PROPOSE MODE, not hidden. Hiding them would make two different dialogs out
 * of one, which is the drift this module exists to prevent, and it would conceal that a gateway
 * assignment exists at all. `nonProposableFields()` tells the form which ones, so it can grey them
 * and say why.
 */
import { api } from '../api'

/**
 * One entry per asset kind: the proposal lane, and how this form's fields map onto its columns.
 *
 * `fields` is form key -> column name. A form key absent from it is not proposable, which is what
 * `nonProposableFields()` reports and what the diff below refuses to send.
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
      location_scope: 'location_scope'
    },
    // WHY EACH ONE IS OUT, in the words the form shows the reader.
    withheld: {
      active_gateway_id: 'The gateway is this device’s data path — an Administrator moves it.',
      schema_id: 'The schema is what this device’s telemetry is judged against — an Administrator changes it.',
      conformance_policy: 'Conformance policy decides what happens to unmodelled metrics — an Administrator sets it.'
    }
  },
  /*
   * THE ONE FORM WHOSE FIELDS ARE ALREADY COLUMN NAMES. `DeviceNameplateModal` builds itself from
   * a FIELDS table keyed by `device_nameplate`'s own columns, so the mapping is the identity -- and
   * it is written out rather than generated, because "every field is proposable" is a claim that
   * should be re-read when a column is added, not inherited by default.
   */
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
  cell: {
    lane: 'cells',
    idField: 'cell_id',
    // `access_url` is the form's name for `cells.grafana_url`, which is what api.js writes too.
    fields: {
      cell_name: 'name',
      access_url: 'grafana_url',
      icon: 'icon'
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

/** Whether a form key can be proposed at all. */
export function isProposable(kind, formKey) {
  return Boolean(PROPOSAL_FORMS[kind]?.fields?.[formKey])
}

/**
 * What this form would change, as a patch of database columns.
 *
 * ONLY WHAT ACTUALLY MOVED. A form is seeded from the current row, so sending every field would
 * make a patch of ten columns where the person changed one -- and an approver reading the diff
 * could not tell which. It would also be a row snapshot rather than a patch, reverting anything
 * that moved underneath it between proposing and approving.
 *
 * '' BECOMES null, because an emptied box means "clear this field" and that is a real proposal.
 * Dropping it would silently turn "remove the description" into a proposal that changes nothing.
 */
export function patchFromForm(kind, current, form) {
  const def = PROPOSAL_FORMS[kind]
  if (!def || !current || !form) return {}

  const patch = {}
  for (const [formKey, column] of Object.entries(def.fields)) {
    if (!(formKey in form)) continue

    const proposed = form[formKey] === '' ? null : form[formKey]
    const existing = current[formKey] === '' || current[formKey] === undefined ? null : current[formKey]

    // Compared as strings, because a form gives back strings and a row gives back typed values --
    // a uuid, an integer, a null. `String(null)` would collapse the two nulls onto "null", so they
    // are settled first, above.
    const same = proposed === null && existing === null
      ? true
      : proposed !== null && existing !== null && String(proposed) === String(existing)

    if (!same) patch[column] = proposed
  }
  return patch
}

/**
 * The reverse of `patchFromForm`: an open proposal's patch, expressed as this form's fields.
 *
 * NEEDED BECAUSE ADDING TO A PROPOSAL IS EDITING A FORM. Somebody who already asked for a rename
 * and now wants the description changed too must see their own earlier request in the boxes --
 * otherwise the second proposal silently drops the first, and the per-asset cap refuses it anyway.
 * Columns the form has no box for are ignored rather than dropped on the floor loudly: they cannot
 * be in a patch this form produced.
 */
export function formFromPatch(kind, patch) {
  const def = PROPOSAL_FORMS[kind]
  if (!def || !patch) return {}

  const byColumn = new Map(Object.entries(def.fields).map(([formKey, column]) => [column, formKey]))
  const form = {}
  for (const [column, value] of Object.entries(patch)) {
    const formKey = byColumn.get(column)
    // '' rather than null, because that is what an empty input holds -- and `patchFromForm` turns
    // it back into null on the way out, so a cleared field survives the round trip as a cleared
    // field rather than becoming the string "null".
    if (formKey) form[formKey] = value === null ? '' : value
  }
  return form
}

/**
 * File the proposal, or update one already open.
 *
 * `proposalId` is how the per-asset cap stays livable. 0086 allows one open proposal per asset per
 * person, so somebody who wants to change a second field on the same machine has to ADD to the
 * request they already have -- and the only sane place to do that is this same form, seeded with
 * their earlier patch already applied.
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

/**
 * Propose a document link against any of the three asset kinds.
 *
 * Kept beside the others because it is the same act from the reader's point of view -- "ask for
 * something I cannot do myself" -- but it takes a different shape: the patch is a row to CREATE in
 * `links`, so its fields are required rather than optional, and there is no current row to diff
 * against.
 */
export const LINK_LANES = { cell: 'cell_links', gateway: 'gateway_links', device: 'device_links' }

export async function submitLinkProposal({ kind, entityId, link, rationale }) {
  const lane = LINK_LANES[kind]
  if (!lane) throw new Error(`No document lane for "${kind}"`)
  return api.post('/api/v1/proposals', {
    entity_type: lane,
    entity_id: entityId,
    patch: {
      display_name: link.display_name,
      url: link.url,
      link_tag: link.link_tag || 'other'
    },
    rationale: rationale || null
  })
}
