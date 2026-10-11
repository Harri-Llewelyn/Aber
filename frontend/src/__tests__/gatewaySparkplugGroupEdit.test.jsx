import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { PERMISSION_UUIDS } from '../constants'
import { api } from '../api'

/**
 * The Edit Gateway dialog's Sparkplug group: refused as gateways_sparkplug_group_format refuses it,
 * saved with the rest of the form, offered in one click when the gateway publishes under another
 * group, and withheld from someone who may only propose.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const UUID = 'bbbbbbbb-0000-4000-8000-000000000810'

const gateway = (overrides = {}) => ({
  gateway_id: UUID,
  gateway_name: 'Line_A_Gateway',
  cell_id: 'cell-1',
  location_scope: 'cell',
  status: 'ONLINE',
  deployment: 'remote',
  is_archived: false,
  sparkplug_group: 'Aber',
  last_heartbeat: new Date().toISOString(),
  devices: [],
  ...overrides
})

const show = async (row, hasPermission = () => true) => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }])
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve([row])
    return Promise.resolve([])
  })
  api.put.mockResolvedValue({})
  render(<GatewaysTab showToast={vi.fn()} hasPermission={hasPermission} onClearFilter={vi.fn()} />)
  await waitFor(() => expect(screen.getAllByText(row.gateway_name).length).toBeGreaterThan(0))
  fireEvent.click(within(document.querySelector('.page-main')).getByText(row.gateway_name))
  fireEvent.click(within(document.querySelector('.context-panel')).getByRole('button', { name: /Edit Details|Propose a Change/ }))
  return screen.getByLabelText('Sparkplug Group')
}

const type = (field, value) => fireEvent.change(field, { target: { value } })
const save = () => screen.getByRole('button', { name: /^(Save|Propose a change)$/ })

beforeEach(() => vi.clearAllMocks())

describe('the Sparkplug group in the Edit Gateway dialog', () => {
  it('shows the gateway’s group, and is not offered when registering one', async () => {
    const field = await show(gateway())
    expect(field).toHaveValue('Aber')
    expect(field).not.toBeDisabled()

    fireEvent.click(screen.getByText('Cancel'))
    fireEvent.click(screen.getByText('New Gateway'))
    expect(screen.queryByLabelText('Sparkplug Group')).toBeNull()
  })

  it('refuses a separator or a wildcard, says why, and withholds Save', async () => {
    const field = await show(gateway())
    type(field, 'Plant/B')
    expect(screen.getByRole('alert')).toHaveTextContent('one level of the topic, so it cannot contain /')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(save()).toBeDisabled()

    type(field, '')
    expect(screen.getByRole('alert')).toHaveTextContent('A Sparkplug group cannot be empty.')
    expect(save()).toBeDisabled()
  })

  it('saves a new group with the rest of the form, having said what it moves', async () => {
    const field = await show(gateway())
    type(field, 'Plant-B')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(/Saving moves this gateway’s Factory\+ Directory address to Plant-B/))
      .toHaveTextContent('keeps the group written into its flow until it is set up again')

    fireEvent.click(save())
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
    const [path, body] = api.put.mock.calls[0]
    expect(path).toBe(`/api/v1/gateways/${UUID}`)
    expect(body).toMatchObject({ sparkplug_group: 'Plant-B', gateway_name: 'Line_A_Gateway' })
  })

  it('leaves the group out of a save that did not change it', async () => {
    // Sending the copy the dialog opened with would undo a change made since.
    const field = await show(gateway())
    fireEvent.change(screen.getByPlaceholderText('e.g. Sim_Gateway_Cell1_Machining'), { target: { value: 'Renamed' } })
    expect(field).toHaveValue('Aber')
    fireEvent.click(save())
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
    expect(api.put.mock.calls[0][1]).toMatchObject({ gateway_name: 'Renamed' })
    expect(api.put.mock.calls[0][1]).not.toHaveProperty('sparkplug_group')
  })

  it('tells a Host gateway to change the group on the edge node', async () => {
    const field = await show(gateway({ deployment: 'host' }))
    type(field, 'Plant-B')
    expect(screen.getByText(/The edge node does not move with it/))
      .toHaveTextContent('change the group on the edge node itself.')
  })

  it('offers the group the gateway publishes under in one click', async () => {
    const field = await show(gateway({ observed_sparkplug_group: 'Plant-B' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Plant-B' }))
    expect(field).toHaveValue('Plant-B')
    expect(screen.queryByRole('button', { name: 'Use Plant-B' })).toBeNull()
    expect(screen.getByText(/already publishes under Plant-B/)).toHaveTextContent('clears the warning')
  })

  it('offers nothing when the gateway publishes under its own group', async () => {
    await show(gateway({ observed_sparkplug_group: 'Aber' }))
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull()
  })

  it('is withheld, with the reason, from someone who may only propose', async () => {
    const field = await show(gateway({ observed_sparkplug_group: 'Plant-B' }),
      (uuid) => uuid === PERMISSION_UUIDS.PROPOSAL_CREATE)
    expect(field).toBeDisabled()
    expect(screen.getByText(/half of this gateway’s address/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use Plant-B' })).toBeNull()
  })
})
