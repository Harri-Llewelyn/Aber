import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { gatewayTypeChange, gatewayTypeChangeHint } from '../utils/gatewayType'
import { CREDENTIAL_STATES, credentialState, enrolmentStands } from '../utils/credentialState'
import { api } from '../api'

/**
 * Changing a gateway's type in the Edit Gateway dialog. The database ends what the old type held
 * (0252); the dialog says what that will be before Save, asks first where a broker credential ends,
 * and the toast names what ended. A gateway that has just become Remote can then be set up from its
 * drawer.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), enrolmentReadiness: vi.fn(), gatewayHoldsBrokerCredential: vi.fn() }
  }
})

const UUID = 'bbbbbbbb-0000-4000-8000-000000001415'

const gateway = (overrides = {}) => ({
  gateway_id: UUID,
  gateway_name: 'Production_Flow',
  sparkplug_id: 'gwybbbbbbbb00004000800000',
  sparkplug_group: 'Aber',
  status: 'OFFLINE',
  deployment: 'remote',
  is_simulated: false,
  is_shadow: false,
  is_archived: false,
  cell_id: 'cell-1',
  location_scope: 'cell',
  access_url: '',
  enrolled_at: null,
  credential_revoked_at: null,
  devices: [],
  ...overrides
})

const show = async (row, { holds = false } = {}) => {
  const showToast = vi.fn()
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly' }])
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve([row])
    return Promise.resolve([])
  })
  api.enrolmentReadiness.mockResolvedValue({ ready: true, addresses: [] })
  if (holds instanceof Error) api.gatewayHoldsBrokerCredential.mockRejectedValue(holds)
  else api.gatewayHoldsBrokerCredential.mockResolvedValue(holds)
  render(<GatewaysTab showToast={showToast} hasPermission={() => true} userRole="Shopfloor_Manager" />)
  await waitFor(() => expect(screen.getAllByText(row.gateway_name).length).toBeGreaterThan(0))
  return showToast
}

const openDrawer = () => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText('Production_Flow'))
  return within(document.querySelector('.context-panel'))
}

const openEdit = async (row) => {
  fireEvent.click(openDrawer().getByRole('button', { name: /Edit Details/ }))
  // The answer for a gateway that is not Remote arrives after the dialog opens.
  if (row.deployment !== 'remote') await waitFor(() => expect(api.gatewayHoldsBrokerCredential).toHaveBeenCalledWith(UUID))
}

const choose = (type) => fireEvent.change(document.querySelector('#gateway-type'), { target: { value: type } })
const typeHint = () => document.querySelector('#gateway-type').closest('.form-group')
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }))
const question = () => screen.queryByRole('button', { name: 'Change type' })

beforeEach(() => vi.clearAllMocks())

describe('what a change of type ends, from the stored row', () => {
  it('ends nothing when the type is kept', () => {
    expect(gatewayTypeChange(gateway({ status: 'PENDING_ENROLLMENT' }), 'remote', true)).toBeNull()
    expect(gatewayTypeChange(gateway({ deployment: 'host', is_simulated: true }), 'simulated', true)).toBeNull()
  })

  it('cancels a Remote gateway’s unused setup command, and ends its enrolment', () => {
    expect(gatewayTypeChange(gateway({ status: 'PENDING_ENROLLMENT' }), 'host', false))
      .toMatchObject({ crosses: true, toRemote: false, setup: true, credential: false })
    expect(gatewayTypeChange(gateway({ status: 'AWAITING_BIRTH' }), 'third_party', true))
      .toMatchObject({ setup: false, credential: true })
  })

  it('ends a dashboard-issued credential on the way into Remote, and counts an unknown as held', () => {
    for (const deployment of ['host', 'third_party']) {
      expect(gatewayTypeChange(gateway({ deployment }), 'remote', true)).toMatchObject({ toRemote: true, credential: true, setup: false })
      expect(gatewayTypeChange(gateway({ deployment }), 'remote', null)).toMatchObject({ credential: true })
      expect(gatewayTypeChange(gateway({ deployment }), 'remote', false)).toMatchObject({ credential: false })
    }
  })

  it('keeps the credential among Host, Simulated and Third-party', () => {
    const change = gatewayTypeChange(gateway({ deployment: 'host' }), 'third_party', true)
    expect(change).toMatchObject({ crosses: false, setup: false, credential: false, keeps: true })
    expect(gatewayTypeChangeHint(change, true)).toBe('Saving keeps the broker credential this gateway holds.')
    expect(gatewayTypeChangeHint(gatewayTypeChange(gateway({ deployment: 'host' }), 'simulated', false), false)).toBeNull()
  })

  it('says "any" credential when the row could not be asked', () => {
    const hint = gatewayTypeChangeHint(gatewayTypeChange(gateway({ deployment: 'host' }), 'remote', null), null)
    expect(hint).toContain('Saving ends any broker credential this gateway holds')
  })
})

describe('the Type hint in the Edit Gateway dialog', () => {
  it('says the setup command is cancelled, and Save saves without asking', async () => {
    const row = gateway({ status: 'PENDING_ENROLLMENT' })
    const showToast = await show(row)
    api.put.mockResolvedValue({ id: UUID, status: 'OFFLINE', credential_revoked_at: null })
    await openEdit(row)
    choose('host')

    expect(typeHint()).toHaveTextContent('Saving cancels the unused setup command.')
    expect(typeHint()).toHaveTextContent('Once saved, issue it a broker credential from its drawer.')
    save()

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
    expect(api.put.mock.calls[0][1]).toMatchObject({ deployment: 'host', is_simulated: false })
    expect(question()).toBeNull()
    expect(showToast).toHaveBeenCalledWith(
      "Gateway 'Production_Flow' saved — its unused setup command is cancelled",
      'success', { to: expect.stringContaining(UUID) }
    )
  })

  it('says nothing beyond the type when the type is kept', async () => {
    const row = gateway({ status: 'PENDING_ENROLLMENT' })
    await show(row)
    await openEdit(row)
    expect(typeHint().querySelectorAll('.form-hint')).toHaveLength(1)
    expect(typeHint()).not.toHaveTextContent('Saving')
  })

  it('says a dashboard-issued credential is kept between the host-issued types', async () => {
    const row = gateway({ deployment: 'host', status: 'ONLINE' })
    await show(row, { holds: true })
    await openEdit(row)
    choose('third_party')
    await waitFor(() => expect(typeHint()).toHaveTextContent('Saving keeps the broker credential this gateway holds.'))
    expect(typeHint().querySelector('.hint-warning')).toBeNull()
  })
})

describe('Save asks first where a credential ends', () => {
  it('asks before ending an enrolled appliance’s credential, and Cancel goes back to the form', async () => {
    const row = gateway({ status: 'AWAITING_BIRTH', enrolled_at: '2026-11-01T09:00:00Z' })
    await show(row)
    await openEdit(row)
    choose('third_party')

    expect(typeHint().querySelector('.hint-warning'))
      .toHaveTextContent('Saving ends the broker credential its appliance holds, and the appliance is cut off.')
    save()

    expect(question()).toHaveClass('btn-danger')
    expect(screen.getByText(/as Third-party ends/)).toHaveTextContent('its appliance holds, and the appliance is cut off at once')
    fireEvent.click(within(question().closest('.modal')).getByRole('button', { name: 'Cancel' }))

    expect(question()).toBeNull()
    expect(api.put).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('ends a Host gateway’s credential on the way to Remote, and the toast says so', async () => {
    const row = gateway({ deployment: 'host', status: 'ONLINE' })
    const showToast = await show(row, { holds: true })
    api.put.mockResolvedValue({ id: UUID, status: 'OFFLINE', credential_revoked_at: '2026-11-06T12:00:00Z' })
    await openEdit(row)
    choose('remote')

    await waitFor(() => expect(typeHint()).toHaveTextContent('Saving ends the broker credential this gateway holds, and whatever uses it is cut off.'))
    expect(typeHint()).toHaveTextContent('Once saved, set it up from its drawer')
    save()
    fireEvent.click(await screen.findByRole('button', { name: 'Change type' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
    expect(api.put.mock.calls[0][1]).toMatchObject({ deployment: 'remote', is_simulated: false })
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      "Gateway 'Production_Flow' saved — its broker credential is ended. Set it up from its drawer to finish",
      'success', { to: expect.stringContaining(UUID) }
    ))
    expect(question()).toBeNull()
  })

  it('asks when the credential could not be read, saying "any"', async () => {
    const row = gateway({ deployment: 'third_party' })
    await show(row, { holds: new Error('offline') })
    await openEdit(row)
    choose('remote')
    expect(typeHint()).toHaveTextContent('Saving ends any broker credential this gateway holds')
    save()
    expect(question()).toBeInTheDocument()
    expect(screen.getByText(/as Remote ends/)).toHaveTextContent('ends any broker credential it holds')
  })

  it('does not ask for a gateway that holds none', async () => {
    const row = gateway({ deployment: 'host' })
    const showToast = await show(row, { holds: false })
    api.put.mockResolvedValue({ id: UUID, status: 'OFFLINE', credential_revoked_at: null })
    await openEdit(row)
    choose('remote')
    await waitFor(() => expect(typeHint()).not.toHaveTextContent('Saving ends'))
    save()

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
    expect(question()).toBeNull()
    expect(showToast).toHaveBeenCalledWith(
      "Gateway 'Production_Flow' saved. Set it up from its drawer to finish",
      'success', { to: expect.stringContaining(UUID) }
    )
  })

  it('keeps a refusal in the question, and the form behind it', async () => {
    const row = gateway({ status: 'ONLINE', enrolled_at: '2026-11-01T09:00:00Z' })
    const showToast = await show(row)
    api.put.mockRejectedValue(new Error('permission denied for table gateways'))
    await openEdit(row)
    choose('host')
    save()
    fireEvent.click(screen.getByRole('button', { name: 'Change type' }))

    const dialog = await waitFor(() => {
      const found = screen.getByText('permission denied for table gateways').closest('.modal')
      expect(found).toBeTruthy()
      return found
    })
    expect(within(dialog).getByRole('button', { name: 'Change type' })).toBeInTheDocument()
    expect(showToast).not.toHaveBeenCalled()
  })
})

describe('a gateway that has just become Remote', () => {
  it('offers Set Up Gateway while no enrolment stands', async () => {
    await show(gateway({ status: 'OFFLINE' }))
    const panel = openDrawer()
    expect(panel.getByRole('button', { name: /Set Up Gateway/ })).toBeInTheDocument()
  })

  it('offers it again when the enrolment was revoked by an earlier change', async () => {
    await show(gateway({ enrolled_at: '2026-11-01T09:00:00Z', credential_revoked_at: '2026-11-02T09:00:00Z' }))
    expect(openDrawer().getByRole('button', { name: /Set Up Gateway/ })).toBeInTheDocument()
  })

  it('does not offer it to an enrolled gateway that has gone quiet, nor to one online', async () => {
    await show(gateway({ enrolled_at: '2026-11-01T09:00:00Z' }))
    expect(openDrawer().queryByRole('button', { name: /Set Up Gateway|Re-issue Setup/ })).toBeNull()
  })

  it('does not offer it to one that is online without an enrolment', async () => {
    await show(gateway({ status: 'ONLINE', last_heartbeat: new Date().toISOString() }))
    expect(openDrawer().queryByRole('button', { name: /Set Up Gateway|Re-issue Setup/ })).toBeNull()
  })
})

describe('the credential a type change revoked', () => {
  it('reads Revoked until the new type is issued or enrols one', () => {
    const left = { deployment: 'host', enrolled_at: '2026-11-01T09:00:00Z', credential_revoked_at: '2026-11-02T09:00:00Z' }
    expect(credentialState(left, null)).toBe(CREDENTIAL_STATES.REVOKED)
    expect(credentialState(left, '2026-11-03T09:00:00Z')).toBe(CREDENTIAL_STATES.ISSUED)

    const entered = { deployment: 'remote', status: 'PENDING_ENROLLMENT', credential_revoked_at: '2026-11-02T09:00:00Z' }
    expect(credentialState(entered, '2026-11-01T09:00:00Z')).toBe(CREDENTIAL_STATES.REVOKED)
    expect(credentialState({ ...entered, enrolled_at: '2026-11-03T09:00:00Z' }, '2026-11-01T09:00:00Z'))
      .toBe(CREDENTIAL_STATES.ISSUED)
  })

  it('says an enrolment stands only when no revocation came after it', () => {
    expect(enrolmentStands({ enrolled_at: '2026-11-01T09:00:00Z' })).toBe(true)
    expect(enrolmentStands({ enrolled_at: '2026-11-01T09:00:00Z', credential_revoked_at: '2026-11-02T09:00:00Z' })).toBe(false)
    expect(enrolmentStands({ enrolled_at: '2026-11-03T09:00:00Z', credential_revoked_at: '2026-11-02T09:00:00Z' })).toBe(true)
    expect(enrolmentStands({ enrolled_at: null })).toBe(false)
  })
})
