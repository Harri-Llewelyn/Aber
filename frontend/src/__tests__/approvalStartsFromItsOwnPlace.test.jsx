import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Approve & Onboard starts from the device that is held. What is pinned: a device that was registered
 * before starts from its own location and its own gateway, so an approval that touches nothing moves
 * nothing; one nobody registered starts from Follow Gateway; a device held because it came through
 * another gateway says which, beside the picker, which stays where it was; and the texts for a held
 * device say it is unknown only where it is.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), automationsForEntity: vi.fn() } }
})
vi.mock('../lib/supabaseClient', () => ({ supabase: { functions: { invoke: vi.fn() } } }))

import { api } from '../api'
import { supabase } from '../lib/supabaseClient'
import { ApproveQuarantineModal } from '../components/modals/ApproveQuarantineModal'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { DEVICE_STATUS, deviceStatusTitle } from '../utils/deviceStatus'
import { approvalGatewayId, approvalLocation, cameThrough, cameThroughLine, isHeldAgain } from '../utils/quarantineHold'
import { tabLink } from '../test/tabBar'

const HELD_AT = '2026-11-24T09:00:00Z'
const DEVICE = 'cccccccc-0000-4000-8000-000000001658'
const OWN = 'aaaaaaaa-0000-4000-8000-000000001658'
const OTHER = 'bbbbbbbb-0000-4000-8000-000000001658'
const OTHER_NODE = 'gwybbbbbbbb0000400080001658'

const gateway = (id, name, over = {}) => ({
  gateway_id: id, gateway_name: name, sparkplug_id: `gwy-${name}`, status: 'ONLINE', is_archived: false, is_shadow: false,
  cell_id: 'cell-gw', location_scope: 'cell', ...over,
})
const GATEWAYS = [gateway('first', 'First Line'), gateway(OWN, 'Press Line'), gateway(OTHER, 'Paint Line', { sparkplug_id: OTHER_NODE })]
const CELLS = [
  { cell_id: 'cell-gw', cell_name: 'Assembly', area_id: 'area-1', is_archived: false },
  { cell_id: 'cell-own', cell_name: 'Machining', area_id: 'area-1', is_archived: false },
]
const AREAS = [{ area_id: 'area-1', area_name: 'Main Hall' }, { area_id: 'area-2', area_name: 'Stores' }]

const mismatch = (tail) => `GATEWAY_MISMATCH: ${tail}`
const THROUGH = mismatch(`device is bound to gateway '${OWN}' but the message was published by '${OTHER_NODE}'`)

const held = (over = {}) => ({
  asset_id: DEVICE, asset_name: 'CNC_01', reported_identity: 'devcccccccc', gateway_id: OWN, quarantine_reason: THROUGH,
  requarantined_at: HELD_AT, location_scope: 'gateway', cell_id: null, area_id: null, ...over,
})
const unknown = (over = {}) => held({ requarantined_at: null, quarantine_reason: 'UNKNOWN_DEVICE', gateway_id: OTHER, ...over })

const PLACES = [
  ['In a cell', { location_scope: 'cell', cell_id: 'cell-own' }, { location_scope: 'cell', cell_id: 'cell-own', area_id: '' }],
  ['Area-Wide', { location_scope: 'area_wide', area_id: 'area-2' }, { location_scope: 'area_wide', cell_id: '', area_id: 'area-2' }],
  ['Site-Wide', { location_scope: 'site_wide' }, { location_scope: 'site_wide', cell_id: '', area_id: '' }],
  ['Follow Gateway', { location_scope: 'gateway' }, { location_scope: 'gateway', cell_id: '', area_id: '' }],
]

beforeEach(() => vi.clearAllMocks())

describe('where an approval starts', () => {
  it.each(PLACES)('is its own place for a device held again: %s', (_label, row, start) => {
    expect(approvalLocation(held(row))).toEqual(start)
  })

  it.each(PLACES)('is Follow Gateway for a device nobody registered, whatever its row says: %s', (_label, row) => {
    expect(approvalLocation(unknown(row))).toEqual({ location_scope: 'gateway', cell_id: '', area_id: '' })
  })

  it('goes by the time alone, never by the reason or the name', () => {
    expect(isHeldAgain(held())).toBe(true)
    expect(isHeldAgain(held({ quarantine_reason: 'UNKNOWN_DEVICE' }))).toBe(true)
    expect(isHeldAgain(unknown({ quarantine_reason: THROUGH }))).toBe(false)
    expect(isHeldAgain(null)).toBe(false)
  })

  it('is the gateway the device is on, and never one nobody chose for a registered device', () => {
    const accepts = g => !g.is_shadow
    expect(approvalGatewayId(held(), GATEWAYS, accepts)).toBe(OWN)
    expect(approvalGatewayId(held({ gateway_id: null }), GATEWAYS, accepts)).toBe('')
    expect(approvalGatewayId(held({ gateway_id: 'archived' }), GATEWAYS, accepts)).toBe('')
    expect(approvalGatewayId(unknown(), GATEWAYS, accepts)).toBe(OTHER)
    expect(approvalGatewayId(unknown({ gateway_id: null }), GATEWAYS, accepts)).toBe('first')
    expect(approvalGatewayId(unknown({ gateway_id: null }), [gateway('p', 'Playback', { is_shadow: true })], accepts)).toBe('')
  })
})

describe('the gateway a held device came through', () => {
  it.each([
    [THROUGH, OTHER_NODE],
    [mismatch("the publishing edge node 'gwyold' is ARCHIVED. Un-archive the gateway to accept its telemetry again"), 'gwyold'],
    [mismatch("device is bound to a gateway but the publishing edge node 'stranger' is not registered"), 'stranger'],
    ['UNKNOWN_DEVICE', null],
    ["IDENTITY_MISMATCH: the topic said 'a' but it was published by 'b'", null],
    [mismatch('test'), null],
    ['GATEWAY_MISMATCH', null],
    [null, null],
  ])('is read from the reason: %s', (reason, node) => {
    expect(cameThrough(reason)).toBe(node)
  })

  it('is named beside the picker, with what another choice does', () => {
    expect(cameThroughLine(held(), GATEWAYS))
      .toBe('It came through Paint Line. Choose it only if the device has moved there: with any other gateway, it is held again.')
  })

  it('says one that is archived, and one that is not registered', () => {
    const archived = GATEWAYS.map(g => (g.gateway_id === OTHER ? { ...g, is_archived: true } : g))
    expect(cameThroughLine(held(), archived))
      .toBe('It came through Paint Line, which is archived. Restore that gateway first: with any other, it is held again.')
    expect(cameThroughLine(held(), GATEWAYS.slice(0, 2)))
      .toBe(`It came through the edge node ${OTHER_NODE}, which is not registered. With any gateway chosen, it is held again.`)
  })

  it('says nothing once the device is on that gateway, nor of a device held for its identity', () => {
    expect(cameThroughLine(held({ gateway_id: OTHER }), GATEWAYS)).toBeNull()
    expect(cameThroughLine(held({ quarantine_reason: 'MALFORMED_IDENTITY: x' }), GATEWAYS)).toBeNull()
    expect(cameThroughLine(unknown(), GATEWAYS)).toBeNull()
  })
})

describe('the dialog', () => {
  const show = (item, onApprove = vi.fn()) => {
    render(
      <ApproveQuarantineModal item={item} cells={CELLS} areas={AREAS} gateways={GATEWAYS} suggestion={null}
        onApprove={onApprove} onMerge={vi.fn()} onCancel={vi.fn()} />
    )
    return onApprove
  }
  const approve = () => fireEvent.click(screen.getByRole('button', { name: /Approve & Onboard/ }))

  it.each(PLACES)('opens on a held device’s own place, and approves it there untouched: %s', async (label, row, start) => {
    const onApprove = show(held(row))
    expect(screen.getByLabelText(label)).toBeChecked()
    if (start.cell_id) expect(screen.getByLabelText('Cell')).toHaveValue(start.cell_id)
    if (start.area_id) expect(screen.getByLabelText('Area')).toHaveValue(start.area_id)

    approve()
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(DEVICE, { asset_name: 'CNC_01', active_gateway_id: OWN, ...start }))
  })

  it('opens on Follow Gateway for a device nobody registered', async () => {
    const onApprove = show(unknown())
    expect(screen.getByLabelText('Follow Gateway')).toBeChecked()

    approve()
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(DEVICE, expect.objectContaining({
      active_gateway_id: OTHER, location_scope: 'gateway', cell_id: '', area_id: '',
    })))
  })

  it('keeps the picker on the gateway it is bound to, and describes it with the one it came through', () => {
    show(held())
    const picker = screen.getByLabelText('Serving Gateway')
    expect(picker).toHaveValue(OWN)
    expect(picker).toHaveAccessibleDescription(/^It came through Paint Line\./)
    expect(document.querySelector('#approve-gateway-hint svg')).not.toBeNull()
  })

  it('draws no line for a device held for anything else', () => {
    show(unknown())
    expect(document.querySelector('#approve-gateway-hint')).toBeNull()
    expect(screen.getByLabelText('Serving Gateway')).not.toHaveAttribute('aria-describedby')
  })
})

describe('the Devices page', () => {
  const queued = held({
    quarantine_id: DEVICE, gateway_name: 'Press Line', reported_metrics: [], birth_payload: '[]', is_quarantined: true,
    location_scope: 'cell', cell_id: 'cell-own',
  })
  const answer = (path, devices = []) => Promise.resolve(
    path.startsWith('/api/v1/quarantine') ? [queued]
      : path.startsWith('/api/v1/gateways') ? GATEWAYS
        : path.startsWith('/api/v1/cells') ? CELLS
          : path.startsWith('/api/v1/areas') ? AREAS
            : path.startsWith('/api/v1/devices') ? devices : [])
  const open = async () => {
    api.get.mockImplementation(path => answer(path))
    render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
    fireEvent.click(tabLink('Quarantine'))
    fireEvent.click(await screen.findByRole('button', { name: /Approve & Onboard/ }))
    const dialog = await screen.findByRole('dialog', { name: /Approve Discovered Device/ })
    fireEvent.click(within(dialog).getByRole('button', { name: /Approve & Onboard/ }))
    return dialog
  }

  it('sends the place the device has, which the approval leaves as it was', async () => {
    supabase.functions.invoke.mockResolvedValue({ data: { success: true, data: {} }, error: null })
    await open()
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('approve-quarantine', {
      body: { device_id: DEVICE, gateway_id: OWN, asset_name: 'CNC_01', cell_id: 'cell-own', area_id: '', location_scope: 'cell' },
    }))
  })

  it('shows a refusal the database words, and stays open', async () => {
    const refusal = 'device "CNC_01" cannot be put in cell "Machining", which is archived. Restore the cell first, or choose another.'
    supabase.functions.invoke.mockResolvedValue({
      data: null,
      error: { message: 'Edge Function returned a non-2xx status code', context: { json: () => Promise.resolve({ error: refusal }) } },
    })
    const dialog = await open()
    expect(await within(dialog).findByText(refusal)).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
  })

  const drawer = async (over) => {
    const device = {
      asset_id: DEVICE, asset_name: 'CNC_01', sparkplug_id: 'devcccccccc', status: 'ONLINE', is_quarantined: true, is_archived: false,
      active_gateway_id: OWN, cell_id: null, location_scope: 'gateway', created_at: '2026-11-01T12:00:00Z', submodel_schema_ids: [], ...over,
    }
    api.get.mockImplementation(path => answer(path, [device]))
    api.automationsForEntity.mockResolvedValue([])
    window.history.replaceState(null, '', `/devices?device=${DEVICE}`)
    render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
    return screen.findByText(/^In quarantine:/)
  }

  it('says a registered device is held again', async () => {
    expect(await drawer({ requarantined_at: HELD_AT })).toHaveTextContent(
      'In quarantine: this device is registered, and is held again. The Quarantine tab says why. Its readings are dropped until it is approved there.')
  })

  it('says one nobody registered could not be matched', async () => {
    expect(await drawer({ requarantined_at: null })).toHaveTextContent(
      'In quarantine: Aber could not match it to a registered device. Its readings are dropped until it is approved on the Quarantine tab.')
  })
})

describe('the status of a held device', () => {
  it('names no cause, since a registered device is held too', () => {
    const title = deviceStatusTitle(DEVICE_STATUS.QUARANTINED)
    expect(title).not.toMatch(/nobody registered|unknown/i)
    expect(title).toBe('Quarantined — held until somebody approves it on the Quarantine tab, which says why. Its telemetry is being dropped until then')
  })
})
