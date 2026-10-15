import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const CATALOG = [
  { metric_uuid: 'm1', name: 'Hydraulic/FLOW', metric_group: 'Hydraulic', datatype: 10, standard: null, deprecated: false },
  { metric_uuid: 'm2', name: 'Axes/DISPLACEMENT', metric_group: 'Axes', datatype: 10, standard: 'MTConnect', deprecated: false }
]

const GROUPS = [
  { group_uuid: 'g1', name: 'Axes', standard: 'MTConnect' },
  { group_uuid: 'g4', name: 'Hydraulic', standard: null }
]

const lathes = (n) => Array.from({ length: n }, (_, i) => ({
  id: `lathe-${i + 1}`, name: `Lathe_0${i + 1}`, quarantined: false
}))

// As the view returns them, by name. `datatypes` are the codes the births carried.
const UNCATALOGUED = [
  {
    metric_name: 'Hydraulic/PRESSURE', device_count: 2,
    devices: [{ id: 'press-1', name: 'Press_01', quarantined: false }, { id: 'press-2', name: 'Press_02', quarantined: true }],
    last_declared_at: '2026-10-02T10:00:00Z', datatypes: [10]
  },
  {
    metric_name: 'Motor Speed', device_count: 1,
    devices: [{ id: 'fan-1', name: 'Fan_01', quarantined: false }],
    last_declared_at: '2026-10-01T09:00:00Z', datatypes: [10]
  },
  {
    metric_name: 'Spindle/2/LOAD', device_count: 6, devices: lathes(6),
    last_declared_at: '2026-10-03T08:00:00Z', datatypes: [3, 10]
  },
  {
    metric_name: 'vibration', device_count: 1,
    devices: [{ id: 'pump-1', name: 'Pump_01', quarantined: false }],
    last_declared_at: '2026-09-30T08:00:00Z', datatypes: []
  }
]

let uncatalogued

const mockReads = () => api.get.mockImplementation((path) => {
  if (path.startsWith('/api/v1/uncatalogued-metrics')) {
    return typeof uncatalogued === 'function' ? uncatalogued() : Promise.resolve(uncatalogued)
  }
  if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(CATALOG)
  if (path.startsWith('/api/v1/metric-groups')) return Promise.resolve(GROUPS)
  return Promise.resolve([])
})

const renderTab = (props = {}) => render(
  <MetricsTab showToast={vi.fn()} hasPermission={() => true} {...props} />
)

const uncataloguedTab = () => screen.getByRole('tab', { name: /^Uncatalogued/ })

/** Opens the tab once the list is read, and returns its table, or null when it shows none. */
const openTab = async () => {
  await waitFor(() => expect(uncataloguedTab().textContent).toMatch(/\(\d+\)/))
  fireEvent.click(uncataloguedTab())
  return document.querySelector('.card table')
}

const rowOf = (name) => within(document.querySelector('.card table')).getByText(name).closest('tr')
const catalogueButton = (name) => within(rowOf(name)).getByRole('button', { name: /Catalogue/ })

const standardSelect = () => screen.getByTitle(/Which vocabulary this metric is named from/)
const groupSelect = () => screen.getByTitle(/The component this metric belongs to/)
const instanceInput = () => screen.getByPlaceholderText('e.g. C')
const nameInput = () => screen.getByPlaceholderText('e.g. VIBRATION_RMS')
const datatypeSelect = () =>
  screen.getAllByTitle(/How the value is encoded on the wire/).find(el => el.tagName === 'SELECT')
const namePreview = () => screen.getByText(/Devices will publish this metric as/)

beforeEach(() => {
  vi.clearAllMocks()
  uncatalogued = UNCATALOGUED
  mockReads()
})

describe('Uncatalogued tab: the label', () => {
  it('carries the count once the list is read', async () => {
    renderTab()
    await waitFor(() => expect(uncataloguedTab().textContent).toBe('Uncatalogued (4)'))
    expect(api.get).toHaveBeenCalledWith('/api/v1/uncatalogued-metrics')
  })

  it('carries no count before the list is read, since none is known', async () => {
    uncatalogued = () => new Promise(() => {})
    renderTab()
    await waitFor(() => expect(document.querySelector('.card table')).toBeTruthy())
    expect(uncataloguedTab().textContent).toBe('Uncatalogued')
  })

  it('reads (0) when every declared name is catalogued, and says so in words', async () => {
    uncatalogued = []
    renderTab()
    await waitFor(() => expect(uncataloguedTab().textContent).toBe('Uncatalogued (0)'))
    fireEvent.click(uncataloguedTab())

    expect(screen.getByText('Every metric the devices declare is in the catalog.')).toBeTruthy()
    expect(document.querySelector('.card table')).toBeNull()
    expect(screen.queryByLabelText('Search the uncatalogued metrics')).toBeNull()
  })

  it('says a failed read on its tab, carries no count, and leaves the catalog working', async () => {
    uncatalogued = () => Promise.reject(new Error('permission denied for view uncatalogued_metrics'))
    renderTab()
    await waitFor(() => expect(within(document.querySelector('.card table')).getAllByTitle(/^Expand /).length).toBeGreaterThan(0))
    expect(uncataloguedTab().textContent).toBe('Uncatalogued')

    fireEvent.click(uncataloguedTab())
    await waitFor(() => expect(screen.getByText(/The uncatalogued metrics could not be read: permission denied/)).toBeTruthy())
  })

  it('has its own "?" in the tab bar', async () => {
    renderTab()
    await openTab()
    expect(screen.getByRole('button', { name: 'About uncatalogued metrics' })).toBeTruthy()
  })
})

describe('Uncatalogued tab: the rows', () => {
  it('lists each name with its device count, datatype and when it was last declared', async () => {
    renderTab()
    await openTab()

    const row = within(rowOf('Hydraulic/PRESSURE'))
    expect(row.getByText('2')).toBeTruthy()
    expect(row.getByText('Double')).toBeTruthy()
    expect(row.getByText(/2 Oct 2026/)).toBeTruthy()
    expect(within(rowOf('Spindle/2/LOAD')).getByText('Int32, Double')).toBeTruthy()
    expect(within(rowOf('vibration')).getByTitle(/so how it is encoded is not recorded/).textContent).toBe('—')
  })

  it('links each device to its device, and marks one in quarantine', async () => {
    renderTab()
    await openTab()

    const row = within(rowOf('Hydraulic/PRESSURE'))
    const press = row.getByRole('link', { name: /Press_01/ })
    expect(press.getAttribute('href')).toBe('/devices?search=press-1')

    const quarantined = row.getByRole('link', { name: /Press_02/ })
    expect(quarantined.getAttribute('href')).toBe('/devices?search=press-2')
    expect(quarantined.textContent).toMatch(/quarantined/)
    expect(quarantined.title).toMatch(/in quarantine/)

    // A plain click navigates in place.
    fireEvent.click(press, { button: 0 })
    expect(window.location.pathname + window.location.search).toBe('/devices?search=press-1')
  })

  it('breaks a long name after its slashes, not inside a segment', async () => {
    renderTab()
    await openTab()

    const name = within(rowOf('Spindle/2/LOAD')).getByText('Spindle/2/LOAD')
    expect(name.querySelectorAll('wbr')).toHaveLength(2)
  })

  it('keeps its search in the address', async () => {
    renderTab()
    await openTab()

    fireEvent.change(screen.getByPlaceholderText(/Search names/), { target: { value: 'spindle' } })
    expect(new URLSearchParams(window.location.search).get('name')).toBe('spindle')
    expect(rowOf('Spindle/2/LOAD')).toBeTruthy()
    expect(within(document.querySelector('.card table')).queryByText('vibration')).toBeNull()
  })

  it('shows three devices of a long list and the rest on request', async () => {
    renderTab()
    await openTab()

    const row = () => within(rowOf('Spindle/2/LOAD'))
    expect(row().getAllByRole('link', { name: /Lathe_/ })).toHaveLength(3)
    fireEvent.click(row().getByRole('button', { name: '3 more' }))
    expect(row().getAllByRole('link', { name: /Lathe_/ })).toHaveLength(6)
    expect(row().queryByRole('button', { name: /more$/ })).toBeNull()
  })

  it('narrows by name with its search box, and says when nothing matches', async () => {
    renderTab()
    await openTab()

    const search = screen.getByLabelText('Search the uncatalogued metrics')
    expect(search.closest('.filter-bar')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'spindle' } })
    expect(document.querySelectorAll('.card tbody tr')).toHaveLength(1)
    expect(rowOf('Spindle/2/LOAD')).toBeTruthy()

    // Device names are not searched: a match could be in a chip that is not shown.
    fireEvent.change(search, { target: { value: 'Lathe' } })
    expect(screen.getByText(/No uncatalogued metric matches/)).toBeTruthy()
  })
})

describe('Uncatalogued tab: Catalogue', () => {
  it('is offered only to a reader who may add a metric', async () => {
    renderTab({ hasPermission: (p) => p !== PERMISSION_UUIDS.SCHEMA_MANAGE })
    await openTab()

    expect(screen.queryByRole('button', { name: /Catalogue/ })).toBeNull()
    expect(document.querySelector('.card thead th.row-actions')).toBeNull()
  })

  it('opens Add Metric as a Custom metric under the declared name, in a group Custom lists', async () => {
    renderTab()
    await openTab()
    fireEvent.click(catalogueButton('Hydraulic/PRESSURE'))

    expect(screen.getByRole('dialog', { name: 'Add Metric' })).toBeTruthy()
    expect(standardSelect().value).toBe('')
    expect(groupSelect().value).toBe('Hydraulic')
    expect(instanceInput().value).toBe('')
    expect(nameInput().value).toBe('PRESSURE')
    expect(datatypeSelect().value).toBe('10')
    expect(namePreview().textContent).toMatch(/Hydraulic\/PRESSURE/)
    expect(screen.queryByText(/which they do not publish/)).toBeNull()
  })

  it('splits a deeper name into group, instance and name, and types a group Custom does not list', async () => {
    renderTab()
    await openTab()
    fireEvent.click(catalogueButton('Spindle/2/LOAD'))

    expect(groupSelect().value).toBe('__new__')
    expect(screen.getByPlaceholderText('e.g. Hydraulic').value).toBe('Spindle')
    expect(instanceInput().value).toBe('2')
    expect(nameInput().value).toBe('LOAD')
    expect(namePreview().textContent).toMatch(/Spindle\/2\/LOAD/)
  })

  it('leaves the datatype to the operator when the births disagree, and says why', async () => {
    renderTab()
    await openTab()
    fireEvent.click(catalogueButton('Spindle/2/LOAD'))

    expect(datatypeSelect().value).toBe('')
    expect(screen.getByText(/Its devices declare it as Int32 and Double/)).toBeTruthy()
  })

  it('leaves the datatype to the operator when no birth carried one, and says why', async () => {
    renderTab()
    await openTab()
    fireEvent.click(catalogueButton('vibration'))

    expect(groupSelect().value).toBe('')
    expect(nameInput().value).toBe('vibration')
    expect(datatypeSelect().value).toBe('')
    expect(screen.getByText(/so how it is encoded is not recorded/, { selector: '.modal span' })).toBeTruthy()
  })

  it('posts the declared name exactly, as a local extension, and reads the list again', async () => {
    api.post.mockResolvedValue({})
    renderTab()
    await openTab()
    fireEvent.click(catalogueButton('Hydraulic/PRESSURE'))
    const reads = api.get.mock.calls.filter(([p]) => p === '/api/v1/uncatalogued-metrics').length
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/metric-catalog',
      expect.objectContaining({ name: 'Hydraulic/PRESSURE', standard: '', datatype: 10 })
    ))
    expect(api.post).not.toHaveBeenCalledWith('/api/v1/metric-groups', expect.anything())
    await waitFor(() => expect(
      api.get.mock.calls.filter(([p]) => p === '/api/v1/uncatalogued-metrics').length
    ).toBeGreaterThan(reads))
  })

  it('warns when the name in the form is no longer the one the devices declare', async () => {
    renderTab()
    await openTab()
    fireEvent.click(catalogueButton('Hydraulic/PRESSURE'))
    fireEvent.change(nameInput(), { target: { value: 'PRESSURE_BAR' } })

    expect(screen.getByText(/which they do not publish/).textContent)
      .toMatch(/The devices declare Hydraulic\/PRESSURE\. This adds Hydraulic\/PRESSURE_BAR/)
  })

  it('is disabled for a name the catalog cannot hold, and says why', async () => {
    renderTab()
    await openTab()

    const button = catalogueButton('Motor Speed')
    expect(button.disabled).toBe(true)
    expect(button.title).toMatch(/cannot hold this name.*Remove: space.*Rename it on the devices/)
  })

  it('starts the next Add Metric blank', async () => {
    renderTab()
    await openTab()
    fireEvent.click(catalogueButton('Spindle/2/LOAD'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    fireEvent.click(screen.getByRole('tab', { name: 'Metric Catalog' }))
    fireEvent.click(screen.getByRole('button', { name: /Add Metric/ }))
    expect(standardSelect().value).toBe('MTConnect')
    expect(screen.queryByText(/Its devices declare it/)).toBeNull()
  })
})
