import { describe, it, expect } from 'vitest'
import { areaWideInService } from '../utils/inService'
import { overviewGroups } from '../utils/history'
import { unsSkipSentence } from '../utils/unsPath'
import { buildFacts } from '../utils/automationEditorHelp'
import { patchFromForm, formFromPatch } from '../utils/proposeFromForm'
import { locationIncomplete } from '../components/common/LocationPicker'
import { SCOPE_AREA_WIDE, SCOPE_CELL, SCOPE_GATEWAY } from '../utils/cellResolution'

/**
 * What reads a device's location follows a device that follows its gateway (0293): the place it
 * takes is the place every page files it under. Each helper here is the one a page calls.
 */

const AREA = 'area-1'
const device = (overrides) => ({
  asset_id: overrides.asset_name, asset_name: 'D', is_archived: false, is_quarantined: false,
  location_scope: SCOPE_GATEWAY, cell_id: null, effective_cell_id: null, effective_area_id: null, ...overrides
})

describe('the Area-Wide group of an area', () => {
  it('holds a device that follows an Area-Wide gateway beside one that is Area-Wide itself', () => {
    const devices = [
      device({ asset_name: 'own', location_scope: SCOPE_AREA_WIDE, location_source: 'area_wide', effective_area_id: AREA }),
      device({ asset_name: 'follows', location_source: 'followed_area', effective_area_id: AREA }),
      device({ asset_name: 'elsewhere', location_source: 'followed_area', effective_area_id: 'area-2' }),
      device({ asset_name: 'site', location_source: 'followed_site' })
    ]
    expect(areaWideInService(AREA, devices, []).devices.map(d => d.asset_name)).toEqual(['own', 'follows'])
  })
})

describe('History’s Overview groups', () => {
  const cells = [{ cell_id: 'c1', cell_name: 'Bay 1', area_id: AREA }]
  const areas = [{ area_id: AREA, area_name: 'Assembly' }]

  it('places a followed device where the Site Map does: its cell, its area’s Area-Wide group, or the Site-Wide lane', () => {
    const groups = overviewGroups([
      device({ asset_name: 'in-cell', location_source: 'followed_cell', effective_cell_id: 'c1', effective_area_id: AREA }),
      device({ asset_name: 'in-area', location_source: 'followed_area', effective_area_id: AREA }),
      device({ asset_name: 'on-site', location_source: 'followed_site' }),
      device({ asset_name: 'nowhere', location_source: 'unassigned' })
    ], cells, areas)
    const area = groups.find(g => g.label === 'Assembly')
    expect(area.groups.map(g => [g.label, g.devices.map(d => d.asset_name)])).toEqual([
      ['Bay 1', ['in-cell']],
      ['Area-Wide', ['in-area']]
    ])
    expect(groups.find(g => g.label === 'Site-Wide').devices.map(d => d.asset_name)).toEqual(['on-site'])
    expect(groups.find(g => g.label === 'Unassigned').devices.map(d => d.asset_name)).toEqual(['nowhere'])
  })

  it('puts a device that is Site-Wide itself in the same lane as one that follows a Site-Wide gateway', () => {
    const groups = overviewGroups([
      device({ asset_name: 'own', location_scope: 'site_wide', location_source: 'site_wide' }),
      device({ asset_name: 'follows', location_source: 'followed_site' })
    ], cells, areas)
    expect(groups.find(g => g.label === 'Site-Wide').devices.map(d => d.asset_name)).toEqual(['follows', 'own'])
  })
})

describe('the sentence a device with no topic gets', () => {
  it('tells a device that follows a gateway with no location to give the gateway one', () => {
    const sentence = unsSkipSentence('unassigned')
    expect(sentence).toMatch(/Give its gateway a location/)
    expect(sentence).toMatch(/Edit Details/)
  })
})

describe('the automation editor’s place for a device', () => {
  it('calls a device that follows a Site-Wide gateway Site-wide, as it calls a Site-Wide one', () => {
    const facts = buildFacts({ devices: [
      { asset_id: 'a', asset_name: 'A', location_source: 'followed_site' },
      { asset_id: 'b', asset_name: 'B', location_source: 'site_wide' },
      { asset_id: 'c', asset_name: 'C', location_source: 'followed_area', cell_name: null, area_name: 'Assembly' }
    ] })
    expect(facts.deviceById.get('a').place).toBe('Site-wide')
    expect(facts.deviceById.get('b').place).toBe('Site-wide')
    expect(facts.deviceById.get('c').place).toBe('Assembly')
  })
})

describe('a proposal that carries the value', () => {
  const current = { asset_name: 'D', cell_id: 'c1', area_id: '', location_scope: SCOPE_CELL }

  it('names the scope and clears the cell when a device goes back to following its gateway', () => {
    expect(patchFromForm('device', current, { ...current, cell_id: '', location_scope: SCOPE_GATEWAY }))
      .toEqual({ cell_id: null, location_scope: SCOPE_GATEWAY })
  })

  it('names the scope alone for a device that had no cell to clear', () => {
    expect(patchFromForm('device', { ...current, cell_id: '', location_scope: 'site_wide' }, { ...current, cell_id: '', location_scope: SCOPE_GATEWAY }))
      .toEqual({ location_scope: SCOPE_GATEWAY })
  })

  it('puts an open proposal’s scope and cleared cell back in the form', () => {
    expect(formFromPatch('device', { location_scope: SCOPE_GATEWAY, cell_id: null }))
      .toEqual({ location_scope: SCOPE_GATEWAY, cell_id: '' })
  })
})

describe('when a form cannot be saved for its location', () => {
  it('holds a cell scope with no cell where a cell is required, and lets a gateway be in no cell', () => {
    const form = { location_scope: SCOPE_CELL, cell_id: '', area_id: '' }
    expect(locationIncomplete(form, { cellRequired: true })).toBe(true)
    expect(locationIncomplete(form)).toBe(false)
    expect(locationIncomplete({ ...form, cell_id: 'c1' }, { cellRequired: true })).toBe(false)
  })

  it('never holds Follow Gateway, which names nothing', () => {
    expect(locationIncomplete({ location_scope: SCOPE_GATEWAY, cell_id: '', area_id: '' }, { cellRequired: true })).toBe(false)
  })

  it('still holds Area-Wide with no area', () => {
    expect(locationIncomplete({ location_scope: SCOPE_AREA_WIDE, cell_id: '', area_id: '' })).toBe(true)
  })
})
