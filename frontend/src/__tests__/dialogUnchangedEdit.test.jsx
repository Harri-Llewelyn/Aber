import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { AreasTab } from '../components/tabs/AreasTab'
import { CellsTab } from '../components/tabs/CellsTab'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { ApplyAutomationsModal } from '../components/modals/ApplyAutomationsModal'
import { WebhookModal } from '../components/modals/WebhookModal'
import { PERMISSION_UUIDS } from '../constants'
import { pressHeld, wrongIn } from '../test/dialogs'

/**
 * An edit that changes nothing: its primary is pressable, and the press says so and sends nothing. A
 * field emptied is named before that. The devices page's is in deviceLocationUi.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    loadAreaPlanUrl: vi.fn(async () => 'blob:plan'),
    gatewayHoldsBrokerCredential: vi.fn(async () => false),
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), applyAutomations: vi.fn(),
      enrolmentReadiness: vi.fn(async () => ({ ready: true, addresses: [] })), gatewayHoldsBrokerCredential: vi.fn(async () => false),
    },
  }
})

const AREA = { area_id: 'area-1', area_name: 'North Shop', description: 'The old wing', icon: 'Factory', cells: [], cell_count: 0, plan_path: null, plan_aspect: null }
const CELL = { cell_id: 'cell-1', cell_name: 'Assembly Line 1', icon: 'Factory', is_archived: false, gateways: [], gateway_count: 0 }
const GATEWAY = {
  gateway_id: 'gw-1', gateway_name: 'Line 1 Gateway', cell_id: 'cell-1', location_scope: 'cell', status: 'ONLINE', is_archived: false,
  last_heartbeat: new Date().toISOString(), device_count: 0, deployment: 'host', sparkplug_group: 'Aber',
}

const everything = () => true
const mayPropose = (id) => id === PERMISSION_UUIDS.PROPOSAL_CREATE

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation(async (path) => {
    if (path.startsWith('/api/v1/areas')) return [AREA]
    if (path.startsWith('/api/v1/cells')) return [CELL]
    if (path.startsWith('/api/v1/gateways')) return [GATEWAY]
    return []
  })
})

async function edit(Page, name, hasPermission, action) {
  render(<Page showToast={vi.fn()} hasPermission={hasPermission} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
  const row = await waitFor(() => within(document.querySelector('.page-main')).getAllByText(name)[0])
  fireEvent.click(row.closest('tr') ?? row)
  const act = await waitFor(() => {
    const button = [...document.querySelectorAll('.context-panel-actions .context-action')].find(b => b.textContent.trim() === action)
    expect(button).toBeTruthy()
    return button
  })
  fireEvent.click(act)
  return screen.findByRole('dialog')
}

describe.each([
  ['an area', AreasTab, 'North Shop', 'Save Area', '#area-name', 'Give the area a name'],
  ['a cell', CellsTab, 'Assembly Line 1', 'Save Cell', '#cell-name', 'Give the cell a name'],
  ['a gateway', GatewaysTab, 'Line 1 Gateway', 'Save Gateway', '#gateway-name', 'Give the gateway a name'],
])('editing %s', (_, Page, name, save, field, missing) => {
  it('says that nothing has changed, and sends nothing', async () => {
    const dialog = await edit(Page, name, everything, 'Edit Details')
    expect(wrongIn(dialog)).toEqual([])
    pressHeld(dialog, save, 'Nothing has changed.')
    expect(wrongIn(dialog)).toEqual(['Nothing has changed.'])
    expect(api.put).not.toHaveBeenCalled()
  })

  it('names an emptied field beside it and above the buttons, and puts the focus on it', async () => {
    const dialog = await edit(Page, name, everything, 'Edit Details')
    fireEvent.change(dialog.querySelector(field), { target: { value: '  ' } })
    expect(wrongIn(dialog)).toEqual([])
    pressHeld(dialog, save, missing)
    expect(wrongIn(dialog)).toEqual([missing, missing])
    expect(document.activeElement).toBe(dialog.querySelector(field))
    expect(api.put).not.toHaveBeenCalled()
  })

  it('proposes nothing when nothing would change', async () => {
    const dialog = await edit(Page, name, mayPropose, 'Propose a Change')
    pressHeld(dialog, 'Propose a Change', 'Nothing has changed.')
    expect(api.post).not.toHaveBeenCalled()
  })
})

it('a new cell asks for its name, and a name that is only spaces is none', async () => {
  render(<CellsTab showToast={vi.fn()} hasPermission={everything} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: /New Cell/ }))
  const dialog = screen.getByRole('dialog')
  pressHeld(dialog, 'Save Cell', 'Give the cell a name')
  expect(api.post).not.toHaveBeenCalled()
})

it('the webhook says that nothing has changed until an address or a host is', () => {
  const saveHosts = vi.fn()
  const writeUrl = vi.fn()
  render(<WebhookModal webhook={{ urlSet: true, allowedHosts: ['hooks.example.net'] }} saveHosts={saveHosts} writeUrl={writeUrl} onClose={vi.fn()} />)
  const dialog = screen.getByRole('dialog')
  pressHeld(dialog, 'Save Webhook', 'Nothing has changed.')
  expect(saveHosts).not.toHaveBeenCalled()
  expect(writeUrl).not.toHaveBeenCalled()

  fireEvent.change(dialog.querySelector('#webhook-hosts'), { target: { value: 'hooks.example.net\nother.example.net' } })
  expect(wrongIn(dialog)).toEqual([])
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save Webhook' }))
  expect(saveHosts).toHaveBeenCalledWith(['hooks.example.net', 'other.example.net'])
})

it('a file of automations that would change none is checked, and not applied', async () => {
  api.applyAutomations.mockResolvedValue([{ index: 0, key: 'a', status: 'unchanged', changes: [], reasons: [] }])
  const text = 'id: a\nalias: A\ntriggers: []\nactions: []\n'
  render(<ApplyAutomationsModal text={text} showToast={vi.fn()} onApplied={vi.fn()} onClose={vi.fn()} />)
  const dialog = screen.getByRole('dialog')
  await waitFor(() => expect(api.applyAutomations).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Apply/ })).toBeEnabled())
  pressHeld(dialog, /^Apply/, 'Nothing has changed.')
  expect(api.applyAutomations).toHaveBeenCalledTimes(1)
  expect(api.applyAutomations.mock.calls[0][1]).toBe(true)
})
