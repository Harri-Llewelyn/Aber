/**
 * The Audit Trail's Changed by filter (0222, 0227): people and machine identities, by the user ids
 * the trail stamps in `changed_by`. It is a list in the Filters popover, grouped People and Machine
 * identities, travels in the address as `changed_by=<id>,<id>`, and names its choice in a chip in
 * the bar while the popover is shut.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'
import { changesByUrl } from '../routes'
import { KNOWN_PRINCIPALS } from '../utils/serviceIdentities'
import { filterList, offered, ticked, toggleInList } from '../test/listFilters'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      listUserAccounts: vi.fn(),
      listMachinePrincipalNames: vi.fn(),
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
    },
  }
})

const OWAIN = 'a0000000-0000-4000-8000-000000000003'
const NIA = 'a0000000-0000-4000-8000-000000000004'
const LOADER = 'b0000000-0000-4000-8000-0000000000aa'
const STRANGER = 'c0000000-0000-4000-8000-000000000001'
const INGESTOR = 'b0000000-0000-4000-8000-000000000002'

const EVENTS = [
  {
    event_id: 1, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
    timestamp: '2026-08-02T12:00:00Z', description: 'Action UPDATE on devices [dev-1]',
    changed_by: OWAIN, actor_source: 'user',
    old_data: { id: 'dev-1', name: 'Simulated_CNC_01' }, new_data: { id: 'dev-1', name: 'Simulated_CNC_01' },
  },
]

const trailUrls = () => api.get.mock.calls.map(c => c[0]).filter(u => u.includes('/audit-trail'))
const lastTrailUrl = () => trailUrls()[trailUrls().length - 1]
const param = (name) => new URLSearchParams(window.location.search).get(name)

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/audit-trail')
  api.listUserAccounts.mockResolvedValue([
    { user_id: OWAIN, email: 'owain@site.test', display_name: 'Owain Operator' },
    { user_id: NIA, email: 'nia@site.test', display_name: null },
  ])
  api.listMachinePrincipalNames.mockResolvedValue(new Map([[LOADER, { principal_id: LOADER, name: 'Line 4 loader' }]]))
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/audit-trail')) return Promise.resolve(EVENTS)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve([{ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01' }])
    return Promise.resolve([])
  })
})

const show = async () => {
  render(<AuditTrailTab />)
  await waitFor(() => expect(screen.getAllByText('Simulated_CNC_01').length).toBeGreaterThan(0))
}

const changedByList = () => filterList('Changed by')
const groupOf = (name) => within(changedByList()).getByRole('group', { name })
const chip = () => document.querySelector('.trail-actor-chip')

describe('Changed by', () => {
  it('lists people by name and current address, and machine identities by name', async () => {
    await show()
    await waitFor(() => expect(within(changedByList()).getByRole('checkbox', { name: 'Owain Operator (owain@site.test)' })).toBeInTheDocument())
    expect(offered(groupOf('People'))).toEqual(['nia@site.test', 'Owain Operator (owain@site.test)'])
    const machines = offered(groupOf('Machine identities'))
    expect(machines).toContain('Line 4 loader')
    expect(machines).toContain(KNOWN_PRINCIPALS[INGESTOR].name)
    expect(ticked(changedByList())).toEqual([])
    expect(chip()).toBeNull()
  })

  it('puts the choice in the address and the request, names it in a chip and counts it', async () => {
    await show()
    await waitFor(() => expect(within(changedByList()).getByRole('checkbox', { name: /Owain Operator/ })).toBeInTheDocument())
    toggleInList('Changed by', 'Owain Operator (owain@site.test)')

    await waitFor(() => expect(lastTrailUrl()).toContain(`changed_by=${OWAIN}`))
    expect(param('changed_by')).toBe(OWAIN)
    expect(chip()).toHaveTextContent('Changed by Owain Operator (owain@site.test)')
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveTextContent('Filters (1)')
  })

  it('takes a person and a machine identity at once, and the chip names the first and how many more', async () => {
    await show()
    await waitFor(() => expect(within(changedByList()).getByRole('checkbox', { name: /Owain Operator/ })).toBeInTheDocument())
    toggleInList('Changed by', 'Owain Operator (owain@site.test)')
    toggleInList('Changed by', 'Line 4 loader')

    await waitFor(() => expect(param('changed_by')).toBe(`${OWAIN},${LOADER}`))
    await waitFor(() => expect(new URL(lastTrailUrl(), 'http://x').searchParams.get('changed_by')).toBe(`${OWAIN},${LOADER}`))
    expect(chip()).toHaveTextContent('Changed by Owain Operator (owain@site.test) and 1 more')
    // One filter, however many it holds.
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveTextContent('Filters (1)')
  })

  it('chooses every person from the People heading', async () => {
    await show()
    await waitFor(() => expect(within(changedByList()).getByRole('checkbox', { name: /Owain Operator/ })).toBeInTheDocument())
    fireEvent.click(within(changedByList()).getByRole('checkbox', { name: 'People' }))
    await waitFor(() => expect(param('changed_by')).toBe(`${NIA},${OWAIN}`))
  })

  it('arrives from a link carrying the id, as View Their Changes writes it', async () => {
    window.history.replaceState(null, '', changesByUrl(LOADER))
    await show()
    expect(trailUrls()[0]).toContain(`changed_by=${LOADER}`)
    await waitFor(() => expect(chip()).toHaveTextContent('Changed by Line 4 loader'))
    expect(ticked(changedByList())).toEqual(['Line 4 loader'])
  })

  it('selecting the chip shows everyone again', async () => {
    window.history.replaceState(null, '', changesByUrl(OWAIN))
    await show()
    await waitFor(() => expect(chip()).toHaveTextContent('Owain Operator'))
    fireEvent.click(chip())
    await waitFor(() => expect(param('changed_by')).toBeNull())
    await waitFor(() => expect(lastTrailUrl()).not.toContain('changed_by='))
    expect(chip()).toBeNull()
  })

  it('keeps an id neither list holds, shown by the id, for a role that may not read the lists', async () => {
    api.listUserAccounts.mockRejectedValue(new Error('insufficient privileges'))
    api.listMachinePrincipalNames.mockRejectedValue(new Error('insufficient privileges'))
    window.history.replaceState(null, '', changesByUrl(STRANGER))
    await show()
    expect(trailUrls()[0]).toContain(`changed_by=${STRANGER}`)
    expect(chip()).toHaveTextContent(`Changed by ${STRANGER}`)
    expect(ticked(changedByList())).toEqual([STRANGER])
    expect(offered(groupOf('Not listed'))).toEqual([STRANGER])
    // No people are listed to a role that may not read them.
    expect(within(changedByList()).queryByRole('group', { name: 'People' })).toBeNull()
  })

  it('tidies away a value that is not an id', async () => {
    window.history.replaceState(null, '', '/audit-trail?changed_by=owain%40site.test')
    await show()
    await waitFor(() => expect(param('changed_by')).toBeNull())
    expect(lastTrailUrl()).not.toContain('changed_by=')
    expect(chip()).toBeNull()
  })

  it('is cleared with the other filters', async () => {
    window.history.replaceState(null, '', `${changesByUrl(OWAIN)}&action=UPDATE`)
    await show()
    const clear = await screen.findByRole('button', { name: /Clear filters/ })
    expect(clear).toHaveTextContent('(2)')
    fireEvent.click(clear)
    await waitFor(() => expect(param('changed_by')).toBeNull())
    expect(param('action')).toBeNull()
  })
})
