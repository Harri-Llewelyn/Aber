import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'
import { metricUrl } from '../routes'
import { queryTabLink } from '../test/tabBar'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const OWN = 'nsu=http://opcfoundation.org/UA/Machinery/;i=6003'
const ECLASS = '0112/2///61987#ABA951#009'
const TEMPLATE_ID = 'https://admin-shell.io/idta/nameplate/3/0/Nameplate/SerialNumber'

const CATALOG = [
  {
    metric_uuid: 'm1', name: 'Machine/SERIAL_NUMBER', metric_group: 'Machine', datatype: 12, standard: 'OPC UA',
    semantic_id: OWN, semantic_id_type: 'ExpandedNodeId', deprecated: false,
    further_semantic_ids: [
      { semantic_id: ECLASS, semantic_id_type: 'IRDI', source: 'ECLASS 14.0' },
      { semantic_id: TEMPLATE_ID, semantic_id_type: 'IRI', source: null }
    ]
  },
  { metric_uuid: 'm2', name: 'Machine/MODEL', metric_group: 'Machine', datatype: 12, standard: 'OPC UA',
    semantic_id: 'nsu=http://opcfoundation.org/UA/Machinery/;i=6008', semantic_id_type: 'ExpandedNodeId', deprecated: false,
    further_semantic_ids: [] },
  { metric_uuid: 'm3', name: 'Machine/LOCAL', metric_group: 'Machine', datatype: 12, standard: null, semantic_id: null, deprecated: false }
]

const catalogTable = () => {
  const tab = queryTabLink('Metric Catalog')
  if (tab && tab.getAttribute('aria-current') !== 'page') fireEvent.click(tab)
  return document.querySelector('.card table')
}
const drawer = () => document.querySelector('.context-panel')

const setup = async (hasPermission = () => true) => {
  api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/metric-catalog') ? CATALOG : []))
  const showToast = vi.fn()
  render(<MetricsTab showToast={showToast} hasPermission={hasPermission} />)
  await waitFor(() => expect(catalogTable()).toBeTruthy())
  await waitFor(() => expect(within(catalogTable()).getAllByRole('button', { expanded: false }).length).toBeGreaterThan(0))
  for (const header of within(catalogTable()).queryAllByRole('button', { expanded: false })) fireEvent.click(header)
  return showToast
}

const select = (name) => {
  fireEvent.click(within(catalogTable()).getByText(name).closest('tr'))
  return within(drawer())
}

beforeEach(() => { vi.clearAllMocks() })

describe('Metrics: further semantic ids in the catalog and the drawer', () => {
  it('counts the further ids a row carries under its own id, and says nothing for a row with none', async () => {
    await setup()
    const rows = within(catalogTable())
    const cell = (name) => rows.getByText(name).closest('tr').querySelectorAll('td')[5]

    expect(cell('Machine/SERIAL_NUMBER')).toHaveTextContent('+2 further')
    expect(cell('Machine/MODEL')).not.toHaveTextContent('further')
    expect(cell('Machine/LOCAL')).not.toHaveTextContent('further')
  })

  it('lists them in the drawer as text, whoever opens it, with no control to change them', async () => {
    // A Shopfloor Manager does not hold the catalogue's write permission.
    await setup((p) => p !== PERMISSION_UUIDS.SCHEMA_MANAGE)
    const panel = select('Machine/SERIAL_NUMBER')
    const list = panel.getByRole('list', { name: 'Further semantic IDs' })

    expect(panel.getByText('Further Semantic IDs')).toBeTruthy()
    expect(list).toHaveTextContent(ECLASS)
    expect(list).toHaveTextContent('ECLASS 14.0')
    expect(list).toHaveTextContent(TEMPLATE_ID)
    expect(within(list).queryAllByRole('button')).toHaveLength(0)
    expect(within(list).queryAllByRole('textbox')).toHaveLength(0)
    expect(panel.getByRole('button', { name: 'Edit' }).disabled).toBe(true)
  })

  it('leaves the row out of the drawer for a metric with none', async () => {
    await setup()
    const panel = select('Machine/MODEL')
    expect(panel.queryByText('Further Semantic IDs')).toBeNull()
  })

  it('opens Edit with the list, and a save of an added id says what it saved and links to the metric', async () => {
    api.put.mockResolvedValue({ id: 'm2' })
    const showToast = await setup()
    const panel = select('Machine/MODEL')
    fireEvent.click(panel.getByRole('button', { name: 'Edit' }))
    const modal = within(document.querySelector('.modal'))

    fireEvent.click(modal.getByRole('button', { name: 'Add Further ID' }))
    fireEvent.change(modal.getByRole('textbox', { name: 'Further Semantic ID' }), { target: { value: ECLASS } })
    fireEvent.click(modal.getByRole('button', { name: 'Add' }))
    fireEvent.click(modal.getByRole('button', { name: 'Save Metric' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/v1/metric-catalog/m2', {
      further_semantic_ids: { add: [{ semantic_id: ECLASS, semantic_id_type: 'IRDI', source: null }], remove: [] }
    }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      "Further semantic ids of 'Machine/MODEL' saved", 'success', { to: metricUrl('m2') }
    ))
    expect(document.querySelector('.modal')).toBeNull()
  })

  it('says Metric saved when the own id and the further ids change together', async () => {
    api.put.mockResolvedValue({ id: 'm1' })
    const showToast = await setup()
    fireEvent.click(select('Machine/SERIAL_NUMBER').getByRole('button', { name: 'Edit' }))
    const modal = within(document.querySelector('.modal'))

    fireEvent.click(modal.getByRole('button', { name: `Remove further semantic id ${ECLASS}` }))
    fireEvent.change(modal.getByRole('textbox', { name: /^Semantic ID/ }), { target: { value: 'urn:example:serial' } })
    fireEvent.click(modal.getByRole('button', { name: 'Save Metric' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Metric 'Machine/SERIAL_NUMBER' saved", 'success', { to: metricUrl('m1') }))
  })

  it('reads the catalog again after a refusal that came part way, which the dialog shows as worded', async () => {
    api.put.mockRejectedValueOnce(new Error('urn:x is already one of the further semantic ids of Machine/SERIAL_NUMBER. Part of the save was made: the further ids you removed were removed.'))
    const showToast = await setup()
    fireEvent.click(select('Machine/SERIAL_NUMBER').getByRole('button', { name: 'Edit' }))
    const modal = within(document.querySelector('.modal'))
    const loads = () => api.get.mock.calls.filter(([p]) => p.startsWith('/api/v1/metric-catalog')).length
    const before = loads()

    fireEvent.click(modal.getByRole('button', { name: `Remove further semantic id ${ECLASS}` }))
    fireEvent.click(modal.getByRole('button', { name: 'Save Metric' }))

    expect(await modal.findByRole('alert')).toHaveTextContent(/Part of the save was made/)
    await waitFor(() => expect(loads()).toBeGreaterThan(before))
    expect(showToast).not.toHaveBeenCalledWith(expect.anything(), 'success', expect.anything())
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
