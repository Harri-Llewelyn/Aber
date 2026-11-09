/**
 * api.readAlertSubject: the name and place a desktop notification gives a device or gateway alert.
 * The reads are the tables the Devices and Gateways pages read, one round for the asset and one for
 * where it is; a read that fails leaves its part out and never throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const answers = {}
const asked = []

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'https://api.site.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: {
    auth: { getSession: vi.fn() },
    from: (table) => {
      const call = { table, select: null, eq: null }
      asked.push(call)
      const chain = {
        select: (columns) => { call.select = columns; return chain },
        eq: (column, value) => { call.eq = [column, value]; return chain },
        maybeSingle: () => {
          const answer = answers[table]
          if (answer instanceof Error) return Promise.reject(answer)
          return Promise.resolve(answer ?? { data: null, error: null })
        },
      }
      return chain
    },
  },
}))

const { api } = await import('../api')

const DEVICE = 'dddddddd-0000-4000-8000-000000000264'
const GATEWAY = 'cccccccc-0000-4000-8000-000000000264'
const CELL = 'ce110000-0000-4000-8000-000000000264'
const AREA = 'a4ea0000-0000-4000-8000-000000000264'

beforeEach(() => {
  asked.length = 0
  for (const key of Object.keys(answers)) delete answers[key]
})

describe('a device alert', () => {
  it('is named, with the area and cell the device is in now', async () => {
    answers.devices = { data: { name: 'Press 4' } }
    answers.device_locations = { data: { effective_cell_id: CELL, effective_area_id: AREA } }
    answers.cells = { data: { name: 'Cell 3', areas: { name: 'Machine Shop' } } }
    await expect(api.readAlertSubject({ entity_type: 'device', entity_id: DEVICE })).resolves.toEqual({
      name: 'Press 4', place: 'Machine Shop › Cell 3',
    })
    // The effective location, as the view resolves it, not the device's own cell_id.
    expect(asked.find(c => c.table === 'device_locations')).toMatchObject({ eq: ['device_id', DEVICE] })
    expect(asked.find(c => c.table === 'cells')).toMatchObject({ eq: ['id', CELL], select: 'name, areas(name)' })
  })

  it('has the area alone when it is area-wide, and no place when it is site-wide, simulated or unassigned', async () => {
    answers.devices = { data: { name: 'Chiller' } }
    answers.device_locations = { data: { effective_cell_id: null, effective_area_id: AREA } }
    answers.areas = { data: { name: 'Plant Room' } }
    await expect(api.readAlertSubject({ entity_type: 'device', entity_id: DEVICE })).resolves.toEqual({ name: 'Chiller', place: 'Plant Room' })

    answers.device_locations = { data: { effective_cell_id: null, effective_area_id: null } }
    await expect(api.readAlertSubject({ entity_type: 'device', entity_id: DEVICE })).resolves.toEqual({ name: 'Chiller', place: null })
  })

  it('is read for a row with no entity type, which the counter takes as a device', async () => {
    answers.devices = { data: { name: 'Press 4' } }
    await expect(api.readAlertSubject({ entity_id: DEVICE })).resolves.toEqual({ name: 'Press 4', place: null })
  })
})

describe('a gateway alert', () => {
  it('takes its place from the gateway\'s own cell, or its area when it is area-wide', async () => {
    answers.gateways = { data: { name: 'Line 2 gateway', cell_id: CELL, area_id: null, location_scope: 'cell' } }
    answers.cells = { data: { name: 'Cell 3', areas: { name: 'Machine Shop' } } }
    await expect(api.readAlertSubject({ entity_type: 'gateway', entity_id: GATEWAY })).resolves.toEqual({
      name: 'Line 2 gateway', place: 'Machine Shop › Cell 3',
    })

    answers.gateways = { data: { name: 'Plant gateway', cell_id: null, area_id: AREA, location_scope: 'area_wide' } }
    answers.areas = { data: { name: 'Plant Room' } }
    await expect(api.readAlertSubject({ entity_type: 'gateway', entity_id: GATEWAY })).resolves.toEqual({ name: 'Plant gateway', place: 'Plant Room' })

    answers.gateways = { data: { name: 'Site gateway', cell_id: CELL, area_id: AREA, location_scope: 'site_wide' } }
    await expect(api.readAlertSubject({ entity_type: 'gateway', entity_id: GATEWAY })).resolves.toEqual({ name: 'Site gateway', place: null })
  })
})

describe('anything else, or nothing to read', () => {
  it.each([
    ['a platform alert', { entity_type: 'platform', entity_id: null }],
    ['a machine identity alert', { entity_type: 'service_identity', entity_id: DEVICE }],
    ['a device with no id', { entity_type: 'device', entity_id: null }],
    ['an id that is not a UUID', { entity_type: 'device', entity_id: 'press-4' }],
  ])('reads nothing for %s', async (_label, alert) => {
    await expect(api.readAlertSubject(alert)).resolves.toBeNull()
    expect(asked).toEqual([])
  })

  it('leaves a read that fails out, and never throws', async () => {
    answers.devices = new Error('Failed to fetch')
    await expect(api.readAlertSubject({ entity_type: 'device', entity_id: DEVICE })).resolves.toBeNull()
    answers.devices = { data: null, error: { message: 'permission denied' } }
    answers.device_locations = { data: null, error: { message: 'permission denied' } }
    await expect(api.readAlertSubject({ entity_type: 'device', entity_id: DEVICE })).resolves.toEqual({ name: null, place: null })
  })
})
