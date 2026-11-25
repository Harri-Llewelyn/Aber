import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GET /api/v1/devices/:id/nameplate says what the template asks for, read from the rows the AAS
 * exporter reads, and gives the address elements Contact Information defines. A read that fails is
 * thrown: an empty form would look like a device with no nameplate, and saving it would clear one.
 */

const state = { responses: {}, calls: [] }

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn(table => {
      const call = { table, filters: [] }
      state.calls.push(call)
      const builder = {
        select: cols => { call.select = cols; return builder },
        eq: (col, val) => { call.filters.push([col, val]); return builder },
        in: (col, vals) => { call.filters.push([col, vals]); return builder },
        order: () => builder,
        then: (ok, fail) => Promise.resolve(state.responses[table] ?? { data: [], error: null }).then(ok, fail)
      }
      return builder
    })
  }
}))

const { api } = await import('../api')

const NAMEPLATE = 'https://admin-shell.io/idta/nameplate/3/0/Nameplate'
const CONTACT = 'https://admin-shell.io/zvei/nameplate/1/0/ContactInformations'
const row = (template_id, path, parent_path, ordinal, cardinality) => ({
  template_id, path, parent_path, ordinal, cardinality, id_short: path.split('.').pop(),
  semantic_id: `id:${path}`, semantic_id_type: 'IRDI', template_name: 'T', template_number: 'IDTA 0'
})
const ROWS = [
  row(CONTACT, 'ContactInformation', null, 1, 'OneToMany'),
  row(CONTACT, 'ContactInformation.Street', 'ContactInformation', 30, 'ZeroToOne'),
  row(CONTACT, 'ContactInformation.Phone.TelephoneNumber', 'ContactInformation.Phone', 9, 'One'),
  row(NAMEPLATE, 'OrderCodeOfManufacturer', null, 8, 'One'),
  row(NAMEPLATE, 'YearOfConstruction', null, 11, 'ZeroToOne'),
  row(NAMEPLATE, 'AddressInformation', null, 4, 'One'),
  row(NAMEPLATE, 'ManufacturerName', null, 2, 'One')
]
const read = () => api.get('/api/v1/devices/dev-1/nameplate')

beforeEach(() => {
  state.calls.length = 0
  state.responses = { idta_template_elements: { data: ROWS, error: null } }
})

describe('the Digital Nameplate reader', () => {
  it('says what the template asks for, in its order, with the four address elements', async () => {
    const { mandatory } = await read()
    expect(mandatory).toEqual(['ManufacturerName', 'AddressInformation.Street', 'AddressInformation.Zipcode',
      'AddressInformation.CityTown', 'AddressInformation.NationalCode', 'OrderCodeOfManufacturer'])
  })

  it('reads the two templates and no other, once', async () => {
    await read()
    const reads = state.calls.filter(c => c.table === 'idta_template_elements')
    expect(reads.map(c => c.filters)).toEqual([[['template_id', [NAMEPLATE, CONTACT]]]])
  })

  it('gives the address elements with their ids, and nothing else of Contact Information', async () => {
    const { address } = await read()
    expect(address.map(e => [e.id_short, e.semantic_id])).toEqual([['Street', 'id:ContactInformation.Street']])
  })

  it('gives the stored row, with the new columns in it', async () => {
    state.responses.device_nameplate = { data: [{ device_id: 'dev-1', address_street: '1 Example Road' }], error: null }
    expect((await read()).stored).toEqual({ device_id: 'dev-1', address_street: '1 Example Road' })
  })

  for (const table of ['device_nameplate', 'idta_submodel_templates', 'idta_template_elements']) {
    it(`throws when ${table} cannot be read`, async () => {
      state.responses[table] = { data: null, error: new Error(`permission denied for table ${table}`) }
      await expect(read()).rejects.toThrow(`permission denied for table ${table}`)
    })
  }
})
