import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'

/**
 * The Devices drawer's View in Automations: every role reads automations, so the action is always
 * there, with the number of automations that apply to the device (automations_for_entity(): those
 * that name it and the site-wide ones, each counted once) and a link to the Automations page
 * filtered to it. A read that fails leaves the action without its number.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), automationsForEntity: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const device = (overrides = {}) => ({
  asset_id: ID,
  asset_name: 'CNC_01',
  sparkplug_id: 'devaaaaaaaa000040008000',
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  cell_id: 'cell-1',
  first_dbirth_at: '2026-07-27T12:00:00Z',
  created_at: '2026-07-20T12:00:00Z',
  ...overrides,
})

const routeGet = (rows) => (path) => {
  if (path.startsWith('/api/v1/gateways')) {
    return Promise.resolve([{ gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', cell_id: 'cell-1', status: 'ONLINE', is_archived: false, devices: [] }])
  }
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Cell 1' }])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const open = async (rows, { permitted = () => true } = {}) => {
  api.get.mockImplementation(routeGet(rows))
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={permitted} />)
  await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
  fireEvent.click(within(document.querySelector('.page-main')).getByText('CNC_01'))
  return within(document.querySelector('.context-panel'))
}

beforeEach(() => vi.clearAllMocks())

describe("the Devices drawer's View in Automations", () => {
  it('says how many automations apply, counting an automation once however many reasons it has', async () => {
    api.automationsForEntity.mockResolvedValue([
      { automation_id: 'a', key: 'one', alias: 'One', enabled: true, reason: 'named' },
      { automation_id: 'a', key: 'one', alias: 'One', enabled: true, reason: 'site-wide' },
      { automation_id: 'b', key: 'two', alias: 'Two', enabled: false, reason: 'named' },
    ])
    const panel = await open([device()])
    const action = await panel.findByRole('link', { name: 'View in Automations (2)' })
    expect(api.automationsForEntity).toHaveBeenCalledWith(ID)
    // The page filtered to this device, which is a link: it opens in a new tab with Ctrl-click.
    expect(action).toHaveAttribute('href', `/automations?entity=${ID}`)
  })

  it('says 0 when none applies, and still opens the page, which says why nothing does', async () => {
    api.automationsForEntity.mockResolvedValue([])
    const panel = await open([device()])
    expect(await panel.findByRole('link', { name: 'View in Automations (0)' })).toHaveAttribute('href', `/automations?entity=${ID}`)
  })

  it('is offered to every role, since every role reads automations', async () => {
    api.automationsForEntity.mockResolvedValue([])
    const panel = await open([device()], { permitted: () => false })
    expect(await panel.findByRole('link', { name: /^View in Automations/ })).toBeInTheDocument()
  })

  it('follows its page\'s "View in" wording, after View History', async () => {
    api.automationsForEntity.mockResolvedValue([])
    const panel = await open([device()])
    await panel.findByRole('link', { name: /^View in Automations/ })
    const labels = [...document.querySelectorAll('.context-panel-actions .context-action')].map(b => b.textContent.trim())
    // Only the 3D model action sits between them.
    const history = labels.indexOf('View History')
    expect(labels.slice(history + 1, labels.indexOf('View in Automations (0)'))).toEqual(['Add 3D Model…'])
  })

  it('leaves the action without a number when the read fails', async () => {
    api.automationsForEntity.mockRejectedValue(new Error('permission denied'))
    const panel = await open([device()])
    expect(panel.getByRole('link', { name: 'View in Automations' })).toHaveAttribute('href', `/automations?entity=${ID}`)
    await waitFor(() => expect(api.automationsForEntity).toHaveBeenCalled())
    expect(panel.queryByRole('link', { name: /View in Automations \(/ })).toBeNull()
  })

  it('is left off a replay lane, which is a recording of a device and no device itself', async () => {
    api.automationsForEntity.mockResolvedValue([])
    // The Devices page hides replay lanes until asked.
    window.history.replaceState(null, '', '/devices?replay=1')
    const panel = await open([device({ shadow_of: 'aaaaaaaa-0000-4000-8000-0000000000ff' })])
    expect(panel.queryByRole('link', { name: /View in Automations/ })).toBeNull()
  })
})
