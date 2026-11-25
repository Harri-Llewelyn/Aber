import React from 'react'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
import { supabase } from '../lib/supabaseClient'
import { suggestMatches } from '../utils/quarantineMatching'
import { tabLink } from '../test/tabBar'

/**
 * A device that was registered before and is held again is offered no match: accepting one would delete
 * the device with everything set on it. `requarantined_at` on its row says so, as the database writes it
 * (0328), and the database refuses the merge in a sentence the question shows.
 */

vi.mock('../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() } }
}))

const HELD = 'cccccccc-0000-4000-8000-000000001615'
const PROVISIONED = 'aaaaaaaa-0000-4000-8000-000000001615'
const GATEWAY = { id: 'gw-1', name: 'Line_A_Gateway', cell_id: null, location_scope: 'cell' }

// Alike in name and in every metric it models, so a match is offered unless something rules it out.
const SCHEMA = {
  schema_uuid: 'sch-spindle', schema_name: 'Spindle',
  schema_definition: { type: 'object', properties: { 'Spindle/SPEED': { type: 'number' } } }
}
const candidate = {
  asset_id: PROVISIONED, asset_name: 'CNC_02', sparkplug_id: 'devaaaaaaaa000040008000', status: 'OFFLINE',
  is_quarantined: false, is_archived: false, first_dbirth_at: null, submodel_schema_ids: ['sch-spindle'],
  active_gateway_id: 'gw-1', cell_id: null, location_scope: 'gateway', created_at: '2026-11-20T12:00:00Z'
}
const held = (over = {}) => ({
  asset_id: HELD, asset_name: 'CNC_01', reported_metrics: ['Spindle/SPEED'], requarantined_at: null, ...over
})

/** A PostgREST read that answers `data`, whatever is chained on it. */
const answers = (data) => {
  const read = {
    select: () => read, eq: () => read, in: () => read, order: () => read, limit: () => read,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (done, failed) => Promise.resolve({ data, error: null }).then(done, failed)
  }
  return read
}

/** The row PostgREST sends for a device in Quarantine. */
const row = (over = {}) => ({
  id: HELD, name: 'CNC_01', sparkplug_id: 'devcccccccc000040008000', is_quarantined: true, is_archived: false,
  status: 'ONLINE', gateway_id: 'gw-1', gateways: GATEWAY, reported_identity: 'cnc-1',
  quarantine_reason: 'GATEWAY_MISMATCH: published by another gateway', created_at: '2026-11-01T12:00:00Z',
  location_scope: 'gateway', requarantined_at: null, ...over
})

beforeEach(() => vi.restoreAllMocks())

describe('suggestMatches', () => {
  it('offers a match for a device nobody registered', () => {
    const [match] = suggestMatches(held(), [candidate], [SCHEMA])
    expect(match).toMatchObject({ candidateId: PROVISIONED, candidateName: 'CNC_02' })
  })

  it('offers none for a device that was registered before it was held, however alike', () => {
    expect(suggestMatches(held({ requarantined_at: '2026-11-24T09:00:00Z' }), [candidate], [SCHEMA], { limit: 5 })).toEqual([])
  })

  it('goes by the time alone, not by the reason or the name', () => {
    const reasons = ['UNKNOWN_DEVICE: x', 'MALFORMED_IDENTITY: x', 'IDENTITY_MISMATCH: x', 'GATEWAY_MISMATCH: x']
    for (const quarantine_reason of reasons) {
      expect(suggestMatches(held({ quarantine_reason }), [candidate], [SCHEMA])).toHaveLength(1)
      expect(suggestMatches(held({ quarantine_reason, requarantined_at: '2026-11-24T09:00:00Z' }), [candidate], [SCHEMA])).toEqual([])
    }
  })
})

describe('the queue, as the API reads it', () => {
  const queue = async (over) => {
    supabase.from.mockImplementation((table) => answers(table === 'devices' ? [row(over)] : []))
    return api.get('/api/v1/quarantine')
  }

  it('carries when a registered device was held again', async () => {
    const [item] = await queue({ requarantined_at: '2026-11-24T09:00:00Z' })
    expect(item.requarantined_at).toBe('2026-11-24T09:00:00Z')
  })

  it('carries null for a device nobody registered, and from a database without the column', async () => {
    expect((await queue())[0].requarantined_at).toBeNull()
    expect((await queue({ requarantined_at: undefined }))[0].requarantined_at).toBeNull()
  })
})

describe('the Quarantine tab', () => {
  const open = async (over) => {
    const queued = {
      ...held(over), quarantine_id: HELD, reported_identity: 'cnc-1', gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway',
      quarantine_reason: 'GATEWAY_MISMATCH: published by another gateway', birth_payload: '[]', is_quarantined: true
    }
    vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(
      path.startsWith('/api/v1/quarantine') ? [queued]
        : path.startsWith('/api/v1/devices') ? [candidate]
          : path.startsWith('/api/v1/schemas') ? [SCHEMA] : []))
    render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
    fireEvent.click(tabLink('Quarantine'))
    fireEvent.click(await screen.findByRole('button', { name: /Approve & Onboard/ }))
    return screen.findByRole('dialog', { name: /Approve Discovered Device/ })
  }

  it('offers a device that was registered before no match, and still offers its approval', async () => {
    const dialog = await open({ requarantined_at: '2026-11-24T09:00:00Z' })
    expect(within(dialog).queryByRole('button', { name: 'Accept Match' })).toBeNull()
    expect(screen.queryByText(/Possible match/)).toBeNull()
    expect(within(dialog).getByRole('button', { name: /Approve & Onboard/ })).toBeEnabled()
  })

  it('offers a device nobody registered its match, and shows the database refusal as it is worded', async () => {
    const refusal = '"CNC_02" has already sent its first birth, so nothing was merged into it. It is a device of its own.'
    supabase.functions.invoke.mockResolvedValue({
      data: null,
      error: { message: 'Edge Function returned a non-2xx status code', context: { json: () => Promise.resolve({ error: refusal }) } }
    })
    const dialog = await open()
    expect(screen.getByText('Possible match: CNC_02')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Match' }))
    const question = screen.getByRole('dialog', { name: 'Accept Match' })
    fireEvent.click(within(question).getByRole('button', { name: 'Accept Match' }))
    expect(await within(question).findByRole('alert')).toHaveTextContent(refusal)
    expect(question).toBeInTheDocument()
  })
})
