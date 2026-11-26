import React from 'react'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
import { supabase } from '../lib/supabaseClient'
import { HELD_AGAIN_APPROVAL, HELD_AGAIN_ROW } from '../utils/quarantineHold'
import { tabLink } from '../test/tabBar'

/**
 * A registered device held again in Quarantine is offered no Reject: it would delete the device with its
 * schemas, nameplate and links. Its way out is Approve & Onboard, and its row and the dialog say why. A
 * device nobody registered is rejected as before. The database refuses the delete too (0337), and the
 * reject path passes its sentence on as it is worded.
 */

vi.mock('../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() } }
}))

const HELD = 'cccccccc-0000-4000-8000-000000001669'

const queued = (over = {}) => ({
  asset_id: HELD, quarantine_id: HELD, asset_name: 'CNC_01', reported_identity: 'cnc-1', gateway_id: 'gw-1',
  gateway_name: 'Line_A_Gateway', quarantine_reason: 'GATEWAY_MISMATCH: published by another gateway',
  reported_metrics: [], birth_payload: '[]', is_quarantined: true, requarantined_at: null, ...over
})
const REGISTERED = { requarantined_at: '2026-11-24T09:00:00Z' }

beforeEach(() => vi.restoreAllMocks())

async function openQueue(over) {
  vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(
    path.startsWith('/api/v1/quarantine') ? [queued(over)] : []))
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
  fireEvent.click(tabLink('Quarantine'))
  const approve = await screen.findByRole('button', { name: /Approve & Onboard/ })
  return approve.closest('tr')
}

describe('a registered device held again', () => {
  it('is offered Approve & Onboard and no Reject, and its row says why', async () => {
    const row = await openQueue(REGISTERED)
    expect(within(row).queryByRole('button', { name: 'Reject' })).toBeNull()
    expect(within(row).getByRole('button', { name: /Approve & Onboard/ })).toBeEnabled()
    expect(within(row).getByText(HELD_AGAIN_ROW).closest('.cell-flag')).not.toBeNull()
  })

  it('is told in the approval dialog that approving keeps what is set on it', async () => {
    const row = await openQueue(REGISTERED)
    fireEvent.click(within(row).getByRole('button', { name: /Approve & Onboard/ }))
    const dialog = await screen.findByRole('dialog', { name: /Approve Discovered Device/ })
    expect(within(dialog).getByText(HELD_AGAIN_APPROVAL)).toHaveClass('form-hint')
  })

  it('says the three things it keeps, and that it has no Reject, in each place', () => {
    for (const sentence of [HELD_AGAIN_ROW, HELD_AGAIN_APPROVAL]) {
      expect(sentence).toMatch(/[Rr]egistered/)
      expect(sentence).toMatch(/keeps its schemas, nameplate and links/)
      expect(sentence).toMatch(/no Reject/)
    }
  })
})

describe('a device nobody registered', () => {
  it('is offered Reject, which asks for its name, and its row says nothing of a registration', async () => {
    const row = await openQueue()
    expect(within(row).queryByText(HELD_AGAIN_ROW)).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'Reject' }))
    const dialog = await screen.findByRole('dialog', { name: /Reject Device/ })
    expect(dialog).toHaveTextContent('This deletes the device and the readings held for it')
  })

  it('is told nothing of a registration in the approval dialog', async () => {
    const row = await openQueue()
    fireEvent.click(within(row).getByRole('button', { name: /Approve & Onboard/ }))
    const dialog = await screen.findByRole('dialog', { name: /Approve Discovered Device/ })
    expect(within(dialog).queryByText(HELD_AGAIN_APPROVAL)).toBeNull()
  })
})

describe('the reject path', () => {
  it('passes the database\'s refusal on as it is worded', async () => {
    const refusal = '"CNC_01" is a registered device held in Quarantine again, so it was not deleted. '
      + 'Approve it on the Quarantine tab to let it in where it was, with its schemas, nameplate and links. '
      + 'Or archive it, and then delete it from Entities.'
    const write = {
      delete: () => write, eq: () => write,
      select: () => Promise.resolve({ data: null, error: { code: 'P0001', message: refusal } })
    }
    supabase.from.mockImplementation(() => write)
    await expect(api.post(`/api/v1/quarantine/${HELD}/reject`, {})).rejects.toMatchObject({ message: refusal })
  })
})
