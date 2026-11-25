import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceNameplateModal } from '../components/modals/DeviceNameplateModal'
import { MANDATORY_ADDRESS_ELEMENTS, hasNameplateValue, mandatoryNameplatePaths } from '../utils/nameplate'
import { PROPOSAL_FORMS } from '../utils/proposeFromForm'
import { keyLabel } from '../components/tabs/ApprovalsTab'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'

/**
 * A nameplate's export names its template once every element the template asks for has a value. The
 * dialog says which are still empty, in the line above its buttons, and what is asked for is the
 * template's own list: Order Code is, and Year of Construction is not (version 3.0).
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }
})

const asset = { asset_id: 'dev-123', asset_name: 'Simulated_CNC_01' }

// What the API answers: the paths in the template's order, and Contact Information's address elements.
const MANDATORY = [
  'URIOfTheProduct', 'ManufacturerName', 'ManufacturerProductDesignation',
  'AddressInformation.Street', 'AddressInformation.Zipcode', 'AddressInformation.CityTown',
  'AddressInformation.NationalCode', 'OrderCodeOfManufacturer'
]
const ADDRESS = [
  ['Street', '0173-1#02-AAO128#002'], ['Zipcode', '0173-1#02-AAO129#002'], ['CityTown', '0173-1#02-AAO132#002'],
  ['StateCounty', '0173-1#02-AAO133#002'], ['NationalCode', '0173-1#02-AAO134#002']
].map(([id_short, semantic_id]) => ({ id_short, semantic_id, semantic_id_type: 'IRDI' }))

const COMPLETE = {
  device_id: 'dev-123', uri_of_the_product: 'https://example.com/p/1', manufacturer_name: 'Acme',
  manufacturer_product_designation: 'Lathe 42', address_street: '1 Example Road', address_zipcode: 'SA1 8EN',
  address_city_town: 'Swansea', address_national_code: 'GB', order_code_of_manufacturer: 'FMABC1234'
}

const respond = ({ stored = null, published = {}, mandatory = MANDATORY } = {}) =>
  api.get.mockResolvedValue({ stored, template: [], mandatory, address: ADDRESS, published })

const open = (props = {}) => {
  const onClose = vi.fn()
  render(<DeviceNameplateModal asset={asset} canManage onClose={onClose} showToast={vi.fn()} {...props} />)
  return onClose
}
const field = label => screen.getByLabelText(new RegExp(`^${label}`))
const line = () => document.querySelector('.modal-problem')
const standing = () => document.querySelector('.modal-problem > .nameplate-standing')
const primary = () => screen.getByRole('button', { name: /^(Save Nameplate|Propose a Change)$/ })

beforeEach(() => {
  vi.clearAllMocks()
  api.put.mockResolvedValue({})
  api.post.mockResolvedValue({ id: 'p-1' })
})

describe('which fields the template asks for', () => {
  const marked = label => {
    const name = screen.getByText(label, { selector: '.form-label' })
    return name.textContent.includes('*')
  }

  it('marks Order Code and the four address fields, and not Year of Construction', async () => {
    respond()
    open()
    await screen.findByLabelText(/^Order Code/)
    for (const label of ['Product URI', 'Manufacturer', 'Product Designation', 'Street', 'Postal Code',
      'Town or City', 'Country Code', 'Order Code']) {
      expect(marked(label), label).toBe(true)
    }
    for (const label of ['State or County', 'Product Type', 'Serial Number', 'Year of Construction',
      'Date of Manufacture', 'Hardware Version', 'Firmware Version', 'Software Version', 'Country of Origin']) {
      expect(marked(label), label).toBe(false)
    }
  })

  it('says on the asterisk that the claim depends on it, and that saving does not', async () => {
    respond()
    open()
    await screen.findByLabelText(/^Order Code/)
    const star = screen.getByText('Order Code', { selector: '.form-label' }).querySelector('span')
    const tip = tooltipOf(star)
    expect(tip).toContain('names the template once every field marked like this has a value')
    expect(tip).toContain('You can save without it.')
    expect(tip).not.toMatch(/does not claim conformance/)
  })

  it('no help text says the year is mandatory, and each names the fields by their labels', async () => {
    respond()
    open()
    await screen.findByLabelText(/^Order Code/)
    fireEvent.click(screen.getByRole('button', { name: 'What Year of Construction means' }))
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).not.toMatch(/mandatory/i)
    expect(tip.textContent).toMatch(/Date of Manufacture/)
  })

  it('tells the order code from the product type and the serial number', async () => {
    respond()
    open()
    await screen.findByLabelText(/^Order Code/)
    fireEvent.click(screen.getByRole('button', { name: 'What Product Type means' }))
    expect(screen.getByRole('tooltip').textContent).toMatch(/The code to order one by is Order Code/)
  })

  it('gives the address a name that says whose it is', async () => {
    respond()
    open()
    const group = await screen.findByRole('group', { name: 'Address of the Manufacturer' })
    expect(within(group).getAllByRole('textbox').map(el => el.id)).toEqual([
      'nameplate-address_street', 'nameplate-address_zipcode', 'nameplate-address_city_town',
      'nameplate-address_state_county', 'nameplate-address_national_code'
    ])
    fireEvent.click(screen.getByRole('button', { name: 'What Address of the Manufacturer means' }))
    expect(screen.getByRole('tooltip').textContent).toMatch(/Not where this machine stands/)
  })
})

describe('what is still missing is said above the buttons, from the open', () => {
  it('lists them by label, in the template’s order, and not as an error', async () => {
    respond()
    open()
    await screen.findByLabelText(/^Order Code/)
    expect(standing()).toHaveTextContent('The export names the template once these are filled in: '
      + 'Product URI, Manufacturer, Product Designation, Street, Postal Code, Town or City, Country Code, Order Code.')
    expect(document.querySelector('.modal-error')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops a field as it is filled in, and says so when nothing is left', async () => {
    const { address_city_town: _town, order_code_of_manufacturer: _order, ...most } = COMPLETE
    respond({ stored: most })
    open()
    await screen.findByLabelText(/^Order Code/)
    expect(standing()).toHaveTextContent('once these are filled in: Town or City, Order Code.')
    fireEvent.change(field('Town or City'), { target: { value: '   ' } })
    expect(standing()).toHaveTextContent('Town or City, Order Code.')
    fireEvent.change(field('Town or City'), { target: { value: 'Swansea' } })
    expect(standing()).toHaveTextContent('once these are filled in: Order Code.')
    fireEvent.change(field('Order Code'), { target: { value: 'FM1' } })
    expect(standing()).toHaveTextContent('Every field the template asks for is filled in, so the export names the template.')
  })

  it('counts a value the device publishes itself', async () => {
    const { manufacturer_name: _name, ...rest } = COMPLETE
    respond({ stored: rest, published: { manufacturer_name: 'Published GmbH' } })
    open()
    await screen.findByText('Published GmbH')
    expect(standing()).toHaveTextContent('Every field the template asks for is filled in')
  })

  it('says it to a reader too, who can do nothing about it here', async () => {
    respond({ stored: { ...COMPLETE, order_code_of_manufacturer: null } })
    open({ canManage: false })
    await screen.findByText('Acme')
    expect(standing()).toHaveTextContent('once these are filled in: Order Code.')
    expect(screen.getByText('Close', { selector: 'button' })).toBeEnabled()
    expect(screen.queryByText('Cancel', { selector: 'button' })).toBeNull()
  })

  it('shows the new fields as text to a reader, the address under its name', async () => {
    respond({ stored: COMPLETE })
    open({ canManage: false })
    const group = await screen.findByRole('group', { name: 'Address of the Manufacturer' })
    expect(within(group).getByText('1 Example Road')).toBeInTheDocument()
    expect(within(group).getByText('Not set')).toBeInTheDocument()
    expect(screen.getByText('FMABC1234')).toBeInTheDocument()
    expect(document.querySelector('.modal input')).toBeNull()
  })

  it('says nothing while it loads, and nothing where the template’s rows cannot be read', async () => {
    respond({ mandatory: [] })
    open()
    expect(standing()).toBeNull()
    await screen.findByLabelText(/^Order Code/)
    expect(standing()).toBeNull()
    expect(document.querySelector('.form-label').textContent).not.toContain('*')
  })
})

describe('the buttons', () => {
  it('a press that changes nothing says so and sends nothing', async () => {
    respond({ stored: COMPLETE })
    const onClose = open()
    await screen.findByLabelText(/^Order Code/)
    expect(primary()).toBeEnabled()
    fireEvent.click(primary())
    expect(line()).toHaveTextContent('Nothing has changed.')
    expect(api.put).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // The next edit takes it away again.
    fireEvent.change(field('Serial Number'), { target: { value: 'SN-1' } })
    expect(line()).not.toHaveTextContent('Nothing has changed.')
  })

  it('a press with a value the column would refuse goes to it and names it', async () => {
    respond()
    open()
    const year = await screen.findByLabelText(/^Year of Construction/)
    fireEvent.change(year, { target: { value: '24' } })
    expect(primary()).toBeEnabled()
    fireEvent.click(primary())
    expect(line()).toHaveTextContent('Check Year of Construction')
    expect(year).toHaveFocus()
    expect(api.put).not.toHaveBeenCalled()
    fireEvent.change(year, { target: { value: '2024' } })
    fireEvent.click(primary())
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
  })

  it('an incomplete nameplate saves, with the new fields', async () => {
    respond()
    open()
    await screen.findByLabelText(/^Order Code/)
    fireEvent.change(field('Order Code'), { target: { value: 'FM1' } })
    fireEvent.change(field('Street'), { target: { value: '1 Example Road' } })
    fireEvent.click(primary())
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
    expect(api.put.mock.calls[0][1]).toMatchObject({ order_code_of_manufacturer: 'FM1', address_street: '1 Example Road' })
  })

  it('proposes a new field as any other, and only what moved', async () => {
    respond({ stored: COMPLETE })
    open({ canManage: false, canPropose: true })
    await screen.findByLabelText(/^Order Code/)
    fireEvent.change(field('Country Code'), { target: { value: 'DE' } })
    fireEvent.click(primary())
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/proposals', expect.objectContaining({
      entity_type: 'device_nameplate', entity_id: 'dev-123', patch: { address_national_code: 'DE' }
    })))
  })

  it('a proposal that changes nothing is not sent', async () => {
    respond({ stored: COMPLETE })
    open({ canManage: false, canPropose: true })
    await screen.findByLabelText(/^Order Code/)
    fireEvent.change(screen.getByLabelText('Why (optional)'), { target: { value: 'because' } })
    fireEvent.click(primary())
    expect(line()).toHaveTextContent('Nothing has changed.')
    expect(api.post).not.toHaveBeenCalled()
  })

  it('stays open while it saves, by Cancel, the close button and Escape', async () => {
    let finish
    api.put.mockReturnValue(new Promise(resolve => { finish = resolve }))
    respond()
    const onClose = open()
    await screen.findByLabelText(/^Order Code/)
    fireEvent.change(field('Order Code'), { target: { value: 'FM1' } })
    fireEvent.click(primary())
    await screen.findByRole('button', { name: /Saving/ })
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    finish({})
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true))
  })

  it('a nameplate that cannot be read offers nothing to save over it', async () => {
    api.get.mockRejectedValue(new Error('permission denied for table device_nameplate'))
    open()
    expect(await screen.findByText('permission denied for table device_nameplate')).toBeInTheDocument()
    expect(document.querySelector('.modal input')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save Nameplate' })).toBeNull()
    expect(screen.getByText('Close', { selector: 'button' })).toBeEnabled()
  })
})

describe('the template’s own list', () => {
  const file = path.resolve(__dirname, '../../../scripts/vocabularies/idta-02006-3-0-3-digital-nameplate.json')
  const submodel = JSON.parse(fs.readFileSync(file, 'utf8')).submodels[0]
  const ID = submodel.semanticId.keys[0].value
  const rows = submodel.submodelElements.map((e, at) => ({
    template_id: ID, path: e.idShort, parent_path: null, ordinal: at + 1,
    cardinality: e.qualifiers.find(q => q.type === 'SMT/Cardinality')?.value ?? null
  }))

  it('is what the dialog asks for, in order, with the four address elements', () => {
    expect(mandatoryNameplatePaths([...rows].reverse(), ID)).toEqual(MANDATORY)
    expect(MANDATORY_ADDRESS_ELEMENTS).toHaveLength(4)
  })

  it('leaves out another template’s rows, a nested row and an optional one', () => {
    expect(mandatoryNameplatePaths([
      { template_id: 'x', path: 'A', parent_path: null, ordinal: 1, cardinality: 'One' },
      { template_id: ID, path: 'M[0].N', parent_path: 'M[0]', ordinal: 2, cardinality: 'One' },
      { template_id: ID, path: 'B', parent_path: null, ordinal: 3, cardinality: 'ZeroToOne' },
      { template_id: ID, path: 'C', parent_path: null, ordinal: 4, cardinality: 'OneToMany' }
    ], ID)).toEqual(['C'])
    expect(mandatoryNameplatePaths(undefined, ID)).toEqual([])
  })

  it('a value of spaces is none, as the export reads it', () => {
    expect([null, undefined, '', '  '].map(hasNameplateValue)).toEqual([false, false, false, false])
    expect(['x', 0].map(hasNameplateValue)).toEqual([true, true])
  })

  it('every field of the form can be proposed, and has a name on the Approvals page', () => {
    for (const column of Object.keys(PROPOSAL_FORMS.device_nameplate.fields)) {
      expect(keyLabel(column), column).not.toBe(column)
    }
  })
})
