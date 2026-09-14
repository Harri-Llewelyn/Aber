import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  PROPOSAL_FORMS,
  patchFromForm,
  formFromPatch,
  nonProposableFields,
  isProposable,
  submitProposal,
} from '../utils/proposeFromForm'
import { api } from '../api'

vi.mock('../api', () => ({ api: { post: vi.fn(), put: vi.fn() } }))

beforeEach(() => {
  vi.clearAllMocks()
  api.post.mockResolvedValue({})
  api.put.mockResolvedValue({})
})

/**
 * The translation layer between a form and a lane: there is one form per asset, and this is what
 * lets it end in a proposal instead of a write.
 */
describe('what a form would change', () => {
  const current = {
    asset_name: 'CNC_01',
    description: 'the old one',
    cell_id: 'cell-1',
    location_scope: 'cell',
    active_gateway_id: 'gw-1'
  }

  it('sends only what actually moved', () => {
    // A form is seeded from the current row, so the patch carries only what changed; sending every
    // field would make a row snapshot that reverts whatever moved underneath it.
    const patch = patchFromForm('device', current, { ...current, asset_name: 'CNC_01_renamed' })
    expect(patch).toEqual({ name: 'CNC_01_renamed' })
  })

  it('says nothing when nothing moved', () => {
    expect(patchFromForm('device', current, { ...current })).toEqual({})
  })

  it('translates the form’s names into the table’s', () => {
    // `asset_name` is the box; `name` is the column. api.js already translates on the way to a
    // PUT, and getting this wrong would produce a patch every proposal is refused for.
    const patch = patchFromForm('device', current, { ...current, asset_name: 'X' })
    expect(Object.keys(patch)).toEqual(['name'])
  })

  it('translates the cell form’s access_url onto grafana_url', () => {
    // The one pair a string-matching mapping would silently get wrong.
    const patch = patchFromForm('cell',
      { cell_name: 'Cell 1', access_url: 'https://old' },
      { cell_name: 'Cell 1', access_url: 'https://new' })
    expect(patch).toEqual({ grafana_url: 'https://new' })
  })

  it('treats an emptied box as a proposal to clear the field', () => {
    // Dropping it would silently turn "remove the description" into a proposal that changes
    // nothing -- which the database would then refuse as an empty patch.
    const patch = patchFromForm('device', current, { ...current, description: '' })
    expect(patch).toEqual({ description: null })
  })

  it('does not mistake an untouched empty field for a change', () => {
    const patch = patchFromForm('device', { ...current, description: null },
      { ...current, description: '' })
    expect(patch).toEqual({})
  })

  it('compares across the type boundary a form always crosses', () => {
    // A form gives back strings; a row gives back typed values. Compared naively, a year the
    // person never touched would look changed on every open.
    const patch = patchFromForm('device_nameplate',
      { year_of_construction: 2024 },
      { year_of_construction: '2024' })
    expect(patch).toEqual({})
  })

  it('refuses to carry a field that is not proposable', () => {
    // A device's gateway is its DATA PATH. It is disabled in the form, and it would be dropped
    // here even if that control were ever bypassed.
    const patch = patchFromForm('device', current, { ...current, active_gateway_id: 'gw-9' })
    expect(patch).toEqual({})
    expect(isProposable('device', 'active_gateway_id')).toBe(false)
  })
})

describe('seeding a form from a proposal already open', () => {
  it('puts the earlier request back in the boxes', () => {
    // One open proposal per asset per person, so a second field extends the request that exists.
    expect(formFromPatch('device', { name: 'CNC_01_renamed' }))
      .toEqual({ asset_name: 'CNC_01_renamed' })
  })

  it('round-trips a cleared field as cleared, not as the string "null"', () => {
    const form = formFromPatch('device', { description: null })
    expect(form).toEqual({ description: '' })
    expect(patchFromForm('device', { description: 'was here' }, form))
      .toEqual({ description: null })
  })

  it('ignores a column this form has no box for', () => {
    expect(formFromPatch('device', { model_3d_path: '/x.glb' })).toEqual({})
  })
})

describe('the fields a proposal may not name', () => {
  it('explains each one rather than only refusing it', () => {
    // Withheld, not hidden: hiding them would make two different dialogs out of one, and would
    // conceal that a gateway assignment exists at all.
    const withheld = nonProposableFields('device')
    expect(Object.keys(withheld).sort())
      .toEqual(['active_gateway_id', 'conformance_policy', 'schema_id'])
    for (const sentence of Object.values(withheld)) {
      expect(sentence.length, sentence).toBeGreaterThan(20)
    }
  })

  it('withholds what a gateway IS, not what it is called', () => {
    expect(Object.keys(nonProposableFields('gateway')).sort())
      .toEqual(['deployment', 'is_simulated'])
  })

  it('names every withheld field as one this form actually has', () => {
    // A sentence under a field that does not exist is furniture nobody sees; the failure is
    // silent, which is why it is asserted rather than eyeballed.
    for (const [kind, def] of Object.entries(PROPOSAL_FORMS)) {
      for (const key of Object.keys(def.withheld)) {
        expect(def.fields[key], `${kind}.${key} is both proposable and withheld`).toBeUndefined()
      }
    }
  })
})

describe('filing it', () => {
  it('posts a new proposal in the lane for that asset', async () => {
    await submitProposal({ kind: 'cell', entityId: 'c-1', patch: { name: 'X' }, rationale: 'why' })
    expect(api.post).toHaveBeenCalledWith('/api/v1/proposals', {
      entity_type: 'cells', entity_id: 'c-1', patch: { name: 'X' }, rationale: 'why'
    })
  })

  it('puts to the one already open rather than filing a second', async () => {
    await submitProposal({ kind: 'device', entityId: 'd-1', patch: { name: 'X' }, proposalId: 'p-9' })
    expect(api.put).toHaveBeenCalledWith('/api/v1/proposals/p-9', expect.objectContaining({
      entity_type: 'devices'
    }))
    expect(api.post).not.toHaveBeenCalled()
  })

  it('refuses an empty patch here, where the message can be useful', async () => {
    // The database refuses it too, as "patch is not an object or is empty". This one can say the
    // half that helps: nothing on the form was changed.
    await expect(submitProposal({ kind: 'device', entityId: 'd-1', patch: {} }))
      .rejects.toThrow(/change something first/i)
    expect(api.post).not.toHaveBeenCalled()
  })

  /* The two link-lane tests are gone with 0108. They proved submitLinkProposal() addressed the
     right lane -- a helper no page ever called, against lanes the database no longer admits. A
     link is attached through EntityLinksModal, whose own suite is entityLinks.test.jsx. */
})
