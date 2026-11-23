import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'

/**
 * The Edit Gateway dialog's Type hint for a Remote gateway reads the credential the way the database
 * does (gateway_has_broker_credential(), 0308): an enrolment is a credential held only while no
 * revocation came after it. A gateway changed away from Remote and back has a stamp newer than its
 * enrolment, so saving a change of type ends nothing and the dialog must not say it does.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), enrolmentReadiness: vi.fn(), gatewayHoldsBrokerCredential: vi.fn() }
  }
})

const UUID = 'bbbbbbbb-0000-4000-8000-000000001556'

const gateway = (overrides = {}) => ({
  gateway_id: UUID,
  gateway_name: 'Production_Flow',
  sparkplug_id: 'gwybbbbbbbb00004000800001',
  sparkplug_group: 'Aber',
  status: 'OFFLINE',
  deployment: 'remote',
  is_simulated: false,
  is_shadow: false,
  is_archived: false,
  cell_id: 'cell-1',
  location_scope: 'cell',
  access_url: '',
  enrolled_at: '2026-11-01T09:00:00Z',
  credential_revoked_at: null,
  devices: [],
  ...overrides
})

const show = async (row) => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly' }])
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve([row])
    return Promise.resolve([])
  })
  api.enrolmentReadiness.mockResolvedValue({ ready: true, addresses: [] })
  const showToast = vi.fn()
  render(<GatewaysTab showToast={showToast} hasPermission={() => true} userRole="Shopfloor_Manager" />)
  await waitFor(() => expect(screen.getAllByText(row.gateway_name).length).toBeGreaterThan(0))
  return showToast
}

const openEdit = () => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText('Production_Flow'))
  fireEvent.click(within(document.querySelector('.context-panel')).getByRole('button', { name: /Edit Details/ }))
}
const choose = (type) => fireEvent.change(document.querySelector('#gateway-type'), { target: { value: type } })
const typeHint = () => document.querySelector('#gateway-type').closest('.form-group')

beforeEach(() => vi.clearAllMocks())

describe('the Type hint for a Remote gateway whose credential was revoked', () => {
  it('says nothing ends when a revocation came after the enrolment, and Save asks nothing', async () => {
    await show(gateway({ credential_revoked_at: '2026-11-02T09:00:00Z' }))
    api.put.mockResolvedValue({ id: UUID, status: 'OFFLINE', credential_revoked_at: '2026-11-02T09:00:00Z' })
    openEdit()
    choose('host')

    expect(typeHint()).toHaveTextContent('Once saved, issue it a broker credential from its drawer.')
    expect(typeHint()).not.toHaveTextContent('Saving ends')
    expect(typeHint().querySelector('.hint-warning')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Change type' })).toBeNull()
  })

  it('says it ends the credential when the appliance enrolled after the revocation', async () => {
    await show(gateway({ enrolled_at: '2026-11-03T09:00:00Z', credential_revoked_at: '2026-11-02T09:00:00Z' }))
    openEdit()
    choose('host')

    expect(typeHint().querySelector('.hint-warning'))
      .toHaveTextContent('Saving ends the broker credential its appliance holds, and the appliance is cut off.')
  })

  it('says it ends the credential when no revocation ever stood', async () => {
    await show(gateway())
    openEdit()
    choose('host')

    expect(typeHint().querySelector('.hint-warning'))
      .toHaveTextContent('Saving ends the broker credential its appliance holds, and the appliance is cut off.')
  })
})
